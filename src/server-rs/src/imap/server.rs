//! The IMAP listeners (imap/index.ts): the plain port, with STARTTLS when a
//! certificate is readable, and the implicit-TLS port.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::future::BoxFuture;
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::close_socket::CLOSE_FLUSH_TIMEOUT_MS;
use super::handler::serve_connection;
use super::idle_manager::idle_manager;
use super::session_registry::shutdown_imap_sessions;
use super::socket::BoxedStream;
use crate::alarm::spawn_alarm_keyed;
use crate::proxy_protocol::{is_proxy_protocol_enabled, read_proxy_header, unmapped, Peer, Prefixed};
use crate::tls::{get_tls_credentials, Preference, TlsAcceptor, TlsCredentials};
use crate::{env, js, logger};

/// How long an implicit-TLS client behind a TCP proxy may take to complete
/// its handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

/// The same for a direct client: the default the Bun server's TLS listener
/// applies.
const DIRECT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

/// Connections one port serves at once. One more is closed as it arrives,
/// without a greeting.
const IMAP_MAX_CONNECTIONS: u32 = 100;

/// How long shutdown waits for the IMAP listeners to close. Every session the
/// sweep reaches is destroyed by the flush timeout at the latest; the margin
/// lets those closes land. Anything still open after it belongs to no
/// session: a TLS handshake or a PROXY header still in flight.
pub const IMAP_SHUTDOWN_TIMEOUT_MS: u64 = CLOSE_FLUSH_TIMEOUT_MS + 1000;

/// `Number(value) || fallback`, as a port to listen on: unset, empty, zero
/// or not a number is the fallback. A number that is no port is an error, as
/// it is when the Bun server is told to listen on it.
fn port_setting(value: Option<&str>, fallback: u16) -> Result<u16> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let number = js::number_from_str(value);
    if number.is_nan() || number == 0.0 {
        return Ok(fallback);
    }
    if number.fract() != 0.0 || !(1.0..=65535.0).contains(&number) {
        bail!("{value} is not a port");
    }
    Ok(number as u16)
}

pub fn get_imap_port() -> Result<u16> {
    port_setting(env::var("IMAP_PORT").as_deref(), 143).context("IMAP_PORT")
}

pub fn get_imap_tls_port() -> Result<u16> {
    port_setting(env::var("IMAP_TLS_PORT").as_deref(), 993).context("IMAP_TLS_PORT")
}

/// Where an implicit-TLS listener takes its certificate from, once per
/// connection, so a renewed certificate is picked up without a restart.
type AcceptorSource = Arc<dyn Fn() -> Result<TlsAcceptor> + Send + Sync>;

/// What a connection is handed to once IMAP can be spoken on it: the stream,
/// the client it is from, and whether it is inside TLS.
type Serve = Arc<dyn Fn(BoxedStream, Peer, bool) -> BoxFuture<'static, ()> + Send + Sync>;

/// The IMAP connection driver.
fn serve_imap() -> Serve {
    Arc::new(|stream, peer, is_tls| Box::pin(serve_connection(stream, peer, is_tls)))
}

struct ImapServer {
    stop: CancellationToken,
    /// One permit per connection the port may still take.
    connections: Arc<Semaphore>,
    accepting: JoinHandle<()>,
}

/// The running IMAP listeners, for [`close_imap_servers`].
pub struct ImapServers {
    servers: Vec<ImapServer>,
}

/// Takes one accepted connection to the point where IMAP is spoken on it —
/// the PROXY header when a TCP proxy is in front, then the TLS handshake on
/// the implicit-TLS port — and serves it.
async fn accept_connection(
    mut stream: TcpStream,
    address: SocketAddr,
    tls: Option<AcceptorSource>,
    proxied: bool,
    serve: Serve,
) {
    let _ = stream.set_nodelay(true);

    if !proxied {
        let peer = Peer { address: address.ip().to_string(), port: address.port() };
        let Some(tls) = tls else {
            serve(Box::new(stream), peer, false).await;
            return;
        };
        let Ok(acceptor) = tls() else {
            return;
        };
        // Bun serves this port with its own TLS listener, which picks a TLS
        // 1.2 suite by its order; everywhere else it takes the client's.
        let acceptor = acceptor.with_preference(Preference::Server);
        if let Ok(Ok(stream)) = tokio::time::timeout(DIRECT_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
            serve(Box::new(stream), peer, true).await;
        }
        return;
    }

    // Behind a TCP proxy: the header names the client, and whatever follows
    // it belongs to the handshake or to IMAP.
    let from = unmapped(&address.ip().to_string());
    let own = Peer { address: from.clone(), port: address.port() };
    let (peer, rest) = match read_proxy_header(&mut stream, &own).await {
        Ok(read) => read,
        Err(error) => {
            logger::warn(
                "IMAP: connection dropped before its PROXY header",
                json!({ "component": "imap", "from": from, "reason": error.to_string() }),
            );
            return;
        }
    };
    let stream = Prefixed::new(rest, stream);
    let Some(tls) = tls else {
        serve(Box::new(stream), peer, false).await;
        return;
    };
    let Ok(acceptor) = tls() else {
        return;
    };
    if let Ok(Ok(stream)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
        serve(Box::new(stream), peer, true).await;
    }
}

async fn accept_loop(
    listener: TcpListener,
    tls: Option<AcceptorSource>,
    proxied: bool,
    stop: CancellationToken,
    connections: Arc<Semaphore>,
    serve: Serve,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let (stream, address) = match accepted {
            Ok(connection) => connection,
            Err(_) => {
                // Out of descriptors, or the peer was gone before it was
                // accepted: nothing to serve, and no reason to spin.
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let Ok(slot) = connections.clone().try_acquire_owned() else {
            // At the limit: closed at once, without a word.
            drop(stream);
            continue;
        };
        let (tls, serve) = (tls.clone(), serve.clone());
        tokio::spawn(async move {
            accept_connection(stream, address, tls, proxied, serve).await;
            drop(slot);
        });
    }
}

/// Starts accepting on `listener`.
fn start(listener: TcpListener, tls: Option<AcceptorSource>, proxied: bool, serve: Serve) -> ImapServer {
    let stop = CancellationToken::new();
    let connections = Arc::new(Semaphore::new(IMAP_MAX_CONNECTIONS as usize));
    let accepting =
        crate::alarm::spawn_essential("IMAP accept loop", accept_loop(listener, tls, proxied, stop.clone(), connections.clone(), serve));
    ImapServer { stop, connections, accepting }
}

async fn listen(port: u16, tls: Option<AcceptorSource>) -> Result<ImapServer> {
    let listener = crate::net::bind_all(port).await.with_context(|| format!("IMAP could not listen on port {port}"))?;
    Ok(start(listener, tls, is_proxy_protocol_enabled(), serve_imap()))
}

/// Opens the IMAP listeners: the plain port always, the implicit-TLS port
/// when a certificate is readable.
pub async fn initialize_imap() -> Result<ImapServers> {
    idle_manager().start_heartbeat();

    let mut servers = Vec::new();

    let port = get_imap_port()?;
    servers.push(listen(port, None).await?);
    logger::info("IMAP server listening", json!({ "component": "imap", "port": port }));

    match get_tls_credentials() {
        TlsCredentials::Unreadable { cert, key } => {
            // Loud, not a warn line: TLS was explicitly configured and cannot
            // be served, so the deployment is about to run cleartext-only
            // while believing it is encrypted. `/health` reports the TLS
            // ports as `not_configured` and stays 200, so nothing else pages
            // for this.
            logger::error(
                "IMAP: SSL certificate files not readable — TLS server not started",
                json!({ "component": "imap", "cert": cert, "key": key }),
            );
            spawn_alarm_keyed(
                "TLS certificate not readable",
                format!(
                    "IMAP is configured for TLS but cannot read its certificate, and is serving cleartext only.\n**cert:** {cert}\n**key:** {key}"
                ),
                "tls-cert-unreadable-imap",
            );
        }
        TlsCredentials::Available { .. } => {
            // A pair that is there but is not a key pair stops the start,
            // as it does when the Bun server builds its TLS listener.
            crate::tls::acceptor().context("IMAP could not load its TLS certificate")?;
            let port = get_imap_tls_port()?;
            servers.push(listen(port, Some(Arc::new(crate::tls::acceptor))).await?);
            logger::info("IMAP server listening over TLS", json!({ "component": "imap", "port": port }));
        }
        TlsCredentials::Unconfigured => {
            logger::warn(
                "IMAP: SSL certificate not configured, TLS server not started",
                json!({ "component": "imap" }),
            );
        }
    }

    Ok(ImapServers { servers })
}

/// Stops the IMAP listeners and ends every connection on them.
///
/// Every live session is sent an untagged BYE (RFC 3501 §7.1.5) and closed
/// through the flush-then-destroy teardown, so the listeners drain once the
/// flush window has run instead of once each client idles out. The wait is
/// still bounded: the process exit that follows takes down whatever the
/// sweep could not reach.
///
/// Returns whether every connection was gone within the bound.
pub async fn close_imap_servers(servers: ImapServers) -> bool {
    for server in &servers.servers {
        server.stop.cancel();
    }
    let sessions = shutdown_imap_sessions();
    logger::info("IMAP sessions closed for shutdown", json!({ "component": "imap", "sessions": sessions }));

    let all_closed = async {
        for server in servers.servers {
            let _ = server.accepting.await;
            let _ = server.connections.acquire_many(IMAP_MAX_CONNECTIONS).await;
        }
    };
    tokio::time::timeout(Duration::from_millis(IMAP_SHUTDOWN_TIMEOUT_MS), all_closed).await.is_ok()
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
