//! An SMTP listener: one TCP server whose connections are run by
//! `Connection` (`smtp/server.ts`).

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;

use super::connection::{Connection, ConnectionHandle, Io, Remote};
use super::types::SmtpServerOptions;
use crate::logger;
use crate::net::bind_all;
use crate::proxy_protocol::{read_proxy_header, unmapped, Peer, Prefixed};
use crate::sync::LockUnpoisoned;
use crate::tls::TlsError;

/// How long an implicit-TLS client may take to complete its handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

/// How long `close` waits for the connections it refused at the deadline to
/// have the refusal handed to their sockets.
const REFUSAL_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);

/// Context attached to a TLS handshake failure, mirroring where it happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeErrorMeta {
    pub protocol: &'static str,
    pub stage: &'static str,
    pub remote_address: Option<String>,
}

/// A connection failure a listener reports: what Node attaches to the
/// `Error` its `error` event carries, as far as the Bun server looks at it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SmtpServerError {
    pub message: String,
    /// The errno name (`ECONNRESET`), or `ERR_SSL_<reason>` from the TLS layer.
    pub code: Option<String>,
    /// The system call that failed: `read`, `write` or `accept`.
    pub syscall: Option<String>,
    /// `SSL routines` for an error of the TLS layer.
    pub library: Option<String>,
    /// OpenSSL's name for what the TLS layer reported, such as
    /// `SSLV3_ALERT_BAD_CERTIFICATE`.
    pub reason: Option<String>,
    /// Set for a failed TLS handshake.
    pub meta: Option<HandshakeErrorMeta>,
    /// The client, for an error raised inside a session.
    pub remote_address: Option<String>,
}

impl SmtpServerError {
    pub fn new(message: impl Into<String>) -> SmtpServerError {
        SmtpServerError { message: message.into(), ..Default::default() }
    }

    /// The error of a failed socket operation, as Node would describe it.
    pub(crate) fn from_io(syscall: &str, error: &io::Error) -> SmtpServerError {
        if let Some(tls) = error.get_ref().and_then(|inner| inner.downcast_ref::<TlsError>()) {
            let reason = tls.reason.to_uppercase().replace(' ', "_");
            return SmtpServerError {
                message: tls.message.clone(),
                code: Some(format!("ERR_SSL_{reason}")),
                library: Some("SSL routines".to_string()),
                reason: Some(reason),
                ..Default::default()
            };
        }
        match errno_name(error) {
            Some(code) => SmtpServerError {
                message: format!("{syscall} {code}"),
                code: Some(code.to_string()),
                syscall: Some(syscall.to_string()),
                ..Default::default()
            },
            None => SmtpServerError { message: error.to_string(), ..Default::default() },
        }
    }

    /// Tags a TLS handshake failure so listeners can tell it from a
    /// mid-session error. A client that closes mid-handshake is the "socket
    /// hang up" Bun reports; `None` is a socket that closed with no error.
    pub(crate) fn handshake(error: Option<&io::Error>, remote_address: Option<String>) -> SmtpServerError {
        let mut tagged = match error {
            Some(error) if error.kind() == io::ErrorKind::UnexpectedEof => SmtpServerError {
                message: "socket hang up".to_string(),
                code: Some("ECONNRESET".to_string()),
                ..Default::default()
            },
            Some(error) => SmtpServerError::from_io("read", error),
            None => SmtpServerError {
                message: "Socket closed while initiating TLS".to_string(),
                code: Some("SocketError".to_string()),
                ..Default::default()
            },
        };
        tagged.meta = Some(HandshakeErrorMeta { protocol: "smtp", stage: "connect", remote_address });
        tagged
    }
}

impl fmt::Display for SmtpServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SmtpServerError {}

fn errno_name(error: &io::Error) -> Option<&'static str> {
    let by_number = error.raw_os_error().and_then(|errno| match errno {
        libc::ECONNRESET => Some("ECONNRESET"),
        libc::EPIPE => Some("EPIPE"),
        libc::ETIMEDOUT => Some("ETIMEDOUT"),
        libc::EPROTO => Some("EPROTO"),
        libc::ECONNABORTED => Some("ECONNABORTED"),
        libc::ECONNREFUSED => Some("ECONNREFUSED"),
        libc::EHOSTUNREACH => Some("EHOSTUNREACH"),
        libc::ENETUNREACH => Some("ENETUNREACH"),
        libc::EMFILE => Some("EMFILE"),
        libc::ENFILE => Some("ENFILE"),
        libc::EADDRINUSE => Some("EADDRINUSE"),
        libc::EACCES => Some("EACCES"),
        _ => None,
    });
    by_number.or(match error.kind() {
        io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
        io::ErrorKind::BrokenPipe => Some("EPIPE"),
        io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
        io::ErrorKind::ConnectionAborted => Some("ECONNABORTED"),
        _ => None,
    })
}

type ErrorListener = Arc<dyn Fn(&SmtpServerError) + Send + Sync>;
type CloseListener = Arc<dyn Fn() + Send + Sync>;

/// What a listener's connections share with it.
pub(crate) struct ServerShared {
    pub options: SmtpServerOptions,
    pub name: String,
    /// The connections that count: accepted, greeted or about to be, and
    /// not yet closed from this side.
    connections: Mutex<HashMap<u64, Arc<ConnectionHandle>>>,
    next_connection: AtomicU64,
    closing: AtomicBool,
    listening: AtomicBool,
    /// Sockets accepted and not yet closed, connections or not.
    sockets: AtomicUsize,
    /// A socket closed, or the listener stopped.
    quiet: Notify,
    /// Stops the accept loop.
    stop: CancellationToken,
    /// Drops the sockets still in their PROXY header or TLS handshake.
    handshakes: CancellationToken,
    local_addr: Mutex<Option<SocketAddr>>,
    error_listeners: Mutex<Vec<ErrorListener>>,
    close_listeners: Mutex<Vec<CloseListener>>,
    close_emitted: AtomicBool,
}

impl ServerShared {
    pub fn tls_available(&self) -> bool {
        self.options.tls.is_some()
    }

    /// True once `close` has been called: new commands are answered 421.
    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    pub fn connection_count(&self) -> usize {
        self.connections.lock_unpoisoned().len()
    }

    pub fn add_connection(&self, handle: Arc<ConnectionHandle>) -> u64 {
        let id = self.next_connection.fetch_add(1, Ordering::Relaxed);
        self.connections.lock_unpoisoned().insert(id, handle);
        id
    }

    pub fn remove_connection(&self, id: u64) {
        self.connections.lock_unpoisoned().remove(&id);
    }

    pub fn emit_error(&self, error: &SmtpServerError) {
        let listeners = self.error_listeners.lock_unpoisoned().clone();
        for listener in listeners {
            listener(error);
        }
    }

    /// Answers every connection authenticated as `username` with a 421 and
    /// closes it. Returns how many there were.
    pub fn evict(&self, username: &str) -> usize {
        let evicted: Vec<Arc<ConnectionHandle>> = {
            let mut connections = self.connections.lock_unpoisoned();
            let ids: Vec<u64> = connections
                .iter()
                .filter(|(_, handle)| handle.user().as_deref() == Some(username))
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| connections.remove(id)).collect()
        };
        for handle in &evicted {
            handle.refuse("Credential changed, please re-authenticate", None);
        }
        evicted.len()
    }

    fn socket_closed(&self) {
        self.sockets.fetch_sub(1, Ordering::SeqCst);
        self.settled();
    }

    /// Emits `close` once the listener has stopped and its last socket is gone.
    fn settled(&self) {
        self.quiet.notify_waiters();
        let done = !self.listening.load(Ordering::SeqCst) && self.sockets.load(Ordering::SeqCst) == 0;
        if done && self.is_closing() && !self.close_emitted.swap(true, Ordering::SeqCst) {
            let listeners = self.close_listeners.lock_unpoisoned().clone();
            for listener in listeners {
                listener();
            }
        }
    }
}

/// An SMTP listener. Reports connection failures worth knowing about to its
/// `on_error` listeners, and tells its `on_close` listeners once it has shut
/// down.
#[derive(Clone)]
pub struct SmtpServer {
    shared: Arc<ServerShared>,
}

/// Creates an SMTP listener; call `listen` to start it.
pub fn create_smtp_server(options: SmtpServerOptions) -> SmtpServer {
    SmtpServer::new(options)
}

impl SmtpServer {
    pub fn new(options: SmtpServerOptions) -> SmtpServer {
        let name = options.name.clone().unwrap_or_else(hostname);
        SmtpServer {
            shared: Arc::new(ServerShared {
                options,
                name,
                connections: Mutex::new(HashMap::new()),
                next_connection: AtomicU64::new(1),
                closing: AtomicBool::new(false),
                listening: AtomicBool::new(false),
                sockets: AtomicUsize::new(0),
                quiet: Notify::new(),
                stop: CancellationToken::new(),
                handshakes: CancellationToken::new(),
                local_addr: Mutex::new(None),
                error_listeners: Mutex::new(Vec::new()),
                close_listeners: Mutex::new(Vec::new()),
                close_emitted: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn shared(&self) -> &Arc<ServerShared> {
        &self.shared
    }

    pub(crate) fn from_shared(shared: Arc<ServerShared>) -> SmtpServer {
        SmtpServer { shared }
    }

    pub fn options(&self) -> &SmtpServerOptions {
        &self.shared.options
    }

    /// The name in the greeting.
    pub fn name(&self) -> &str {
        &self.shared.name
    }

    pub fn tls_available(&self) -> bool {
        self.shared.tls_available()
    }

    /// True once [`SmtpServer::close`] has been called: new commands are answered 421.
    pub fn is_closing(&self) -> bool {
        self.shared.is_closing()
    }

    /// The connections that count against `max_clients`.
    pub fn connection_count(&self) -> usize {
        self.shared.connection_count()
    }

    /// The bytes of replies waiting for clients to read them, over every
    /// connection. A connection stops taking commands while it holds more
    /// than a socket buffer's worth.
    pub fn queued_reply_bytes(&self) -> usize {
        self.shared.connections.lock_unpoisoned().values().map(|connection| connection.queued_reply_bytes()).sum()
    }

    /// Calls `listener` for every connection failure worth reporting.
    pub fn on_error(&self, listener: impl Fn(&SmtpServerError) + Send + Sync + 'static) {
        self.shared.error_listeners.lock_unpoisoned().push(Arc::new(listener));
    }

    /// Calls `listener` once the listener has stopped and every socket it
    /// accepted has closed.
    pub fn on_close(&self, listener: impl Fn() + Send + Sync + 'static) {
        self.shared.close_listeners.lock_unpoisoned().push(Arc::new(listener));
    }

    /// Starts accepting connections on `port`, on every address; port 0
    /// picks a free one. Returns the address bound.
    pub async fn listen(&self, port: u16) -> io::Result<SocketAddr> {
        let listener = bind_all(port).await?;
        let address = listener.local_addr()?;
        *self.shared.local_addr.lock_unpoisoned() = Some(address);
        self.shared.listening.store(true, Ordering::SeqCst);
        crate::alarm::spawn_essential("SMTP accept loop", accept_loop(self.shared.clone(), listener));
        Ok(address)
    }

    /// The address `listen` bound.
    pub fn address(&self) -> Option<SocketAddr> {
        *self.shared.local_addr.lock_unpoisoned()
    }

    /// Stops accepting connections, at once: from this call on every command
    /// is answered `421 Server shutting down`. The future it returns is done
    /// once every open connection has ended, or after `close_timeout` —
    /// whichever comes first. Connections still open at the deadline are
    /// answered the same 421 and closed.
    pub fn close(&self) -> impl Future<Output = ()> + Send + 'static {
        let shared = self.shared.clone();
        shared.closing.store(true, Ordering::SeqCst);
        shared.stop.cancel();
        if !shared.listening.load(Ordering::SeqCst) {
            shared.settled();
        }
        let deadline = tokio::time::Instant::now() + shared.options.close_timeout;
        async move { shared.drain(deadline).await }
    }
}

impl ServerShared {
    /// Waits for the last socket to close, and at `deadline` refuses the
    /// connections that are still open.
    async fn drain(&self, deadline: tokio::time::Instant) {
        let deadline = tokio::time::sleep_until(deadline);
        tokio::pin!(deadline);
        loop {
            let quiet = self.quiet.notified();
            tokio::pin!(quiet);
            quiet.as_mut().enable();
            if !self.listening.load(Ordering::SeqCst) && self.sockets.load(Ordering::SeqCst) == 0 {
                return;
            }
            tokio::select! {
                _ = quiet => {}
                _ = &mut deadline => break,
            }
        }

        let connections: Vec<Arc<ConnectionHandle>> =
            self.connections.lock_unpoisoned().drain().map(|(_, handle)| handle).collect();
        let refusals: Vec<oneshot::Receiver<()>> = connections
            .iter()
            .map(|connection| {
                let (done, refused) = oneshot::channel();
                connection.refuse("Server shutting down", Some(done));
                refused
            })
            .collect();
        self.handshakes.cancel();
        // The Bun server writes the refusals before its callback runs; a
        // caller that exits right after this returns must not cut them off.
        let _ = tokio::time::timeout(REFUSAL_FLUSH_TIMEOUT, futures_util::future::join_all(refusals)).await;
    }
}

/// `os.hostname()`.
fn hostname() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its length, and one byte is kept back
    // so the name is terminated even if it was truncated.
    let failed = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len() - 1) } != 0;
    if failed {
        return "localhost".to_string();
    }
    let end = buffer.iter().position(|&byte| byte == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

/// An accepted socket, counted until its task is over — however it ends.
struct OpenSocket(Arc<ServerShared>);

impl Drop for OpenSocket {
    fn drop(&mut self) {
        self.0.socket_closed();
    }
}

async fn accept_loop(shared: Arc<ServerShared>, listener: TcpListener) {
    loop {
        let accepted = tokio::select! {
            _ = shared.stop.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok((socket, address)) => {
                shared.sockets.fetch_add(1, Ordering::SeqCst);
                let open = OpenSocket(shared.clone());
                tokio::spawn(async move {
                    accept(open.0.clone(), socket, address).await;
                });
            }
            Err(error) => {
                shared.emit_error(&SmtpServerError::from_io("accept", &error));
                // Out of descriptors, most likely: give the open ones time to close.
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    drop(listener);
    shared.listening.store(false, Ordering::SeqCst);
    shared.settled();
}

/// Takes one accepted socket through its PROXY header and TLS handshake, as
/// the listener asks for them, and runs its connection.
async fn accept(shared: Arc<ServerShared>, mut socket: TcpStream, address: SocketAddr) {
    let _ = socket.set_nodelay(true);
    let own = Peer { address: unmapped(&address.ip().to_string()), port: address.port() };
    let local = socket.local_addr().ok();

    let (peer, stream) = if shared.options.proxy_protocol {
        let header = tokio::select! {
            header = read_proxy_header(&mut socket, &own) => header,
            _ = shared.handshakes.cancelled() => return,
        };
        match header {
            Ok((peer, rest)) => (peer, Prefixed::new(rest, socket)),
            Err(error) => {
                logger::warn(
                    "SMTP: connection dropped before its PROXY header",
                    json!({ "component": "smtp", "from": own.address, "reason": error.to_string() }),
                );
                return;
            }
        }
    } else {
        (own, Prefixed::new(Bytes::new(), socket))
    };

    let remote = Remote {
        address: peer.address,
        port: peer.port,
        local: local.map(|local| unmapped(&local.ip().to_string())).unwrap_or_default(),
        local_port: local.map(|local| local.port()).unwrap_or(0),
    };

    let io = if !shared.options.secure {
        Io::Plain(stream)
    } else {
        let Some(source) = shared.options.tls.as_ref() else {
            return;
        };
        // The certificate is read now, for this handshake.
        let acceptor = match source() {
            Ok(acceptor) => acceptor,
            Err(error) => {
                logger::error_with("SMTP: connection dropped, the certificate could not be loaded", json!({}), &error);
                return;
            }
        };
        let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream));
        let outcome = tokio::select! {
            outcome = handshake => outcome,
            _ = shared.handshakes.cancelled() => return,
        };
        match outcome {
            Ok(Ok(stream)) => Io::Tls(Box::new(stream)),
            Ok(Err(error)) => {
                shared.emit_error(&SmtpServerError::handshake(Some(&error), Some(remote.address)));
                return;
            }
            Err(_) => {
                let mut error = SmtpServerError::handshake(None, Some(remote.address));
                error.message = "TLS handshake timeout".to_string();
                error.code = None;
                shared.emit_error(&error);
                return;
            }
        }
    };

    Connection::new(shared, io, remote).run().await;
}
