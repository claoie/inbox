//! The SMTP listeners of this server: which ports open, with which options,
//! and what becomes of the failures they report (the transport half of
//! `smtp.ts`).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::json;

use super::registry::{register_smtp_server, unregister_smtp_server};
use super::server::{create_smtp_server, SmtpServer, SmtpServerError};
use super::types::{SharedSmtpHandler, SmtpServerOptions, SmtpTlsSource};
use crate::proxy_protocol::is_proxy_protocol_enabled;
use crate::tls::{get_tls_credentials, TlsCredentials};
use crate::{alarm, env, logger};

pub const SMTP_MAX_CLIENTS: usize = 100;

/// How long `SmtpServer::close` waits on open connections before it answers the
/// rest `421 Server shutting down` and returns. It has to fit inside compose's
/// 10s stop grace, which an idle client would otherwise hold for all of it —
/// long enough for the SIGKILL to land before the pool drains.
///
/// The window is for a transaction already in DATA: once `close` runs, any new
/// command is answered 421 on arrival, so only a message still streaming in
/// needs it. One cut off here gets a transient reply and is retried by the
/// sender, so the bound costs a redelivery, never a message.
pub const SMTP_CLOSE_TIMEOUT_MS: u64 = 5 * 1000;

/// The largest message accepted (`message-size.ts`): advertised as `SIZE` and
/// enforced against a `MAIL FROM ... SIZE=` declaration.
pub const MAX_MESSAGE_BYTES: u64 = 35 * 1024 * 1024;

// A peer rejecting our certificate (expired, wrong hostname, unknown CA) is a
// server-side defect even though it surfaces as a TLS-layer error, so it pages
// when the peer asked, by SNI, for a host in the zone this server serves: that
// is a client trying to reach us. One that asked for no host or a host
// elsewhere, as a scanner dialing the address does, refuses whatever it is
// given and is logged at warn. A client that checks certificates but sends no
// SNI goes unpaged too; mail apps send it.
const PEER_CERT_REJECTION_ALERTS: [&str; 6] = [
    "ALERT_BAD_CERTIFICATE",
    "ALERT_UNSUPPORTED_CERTIFICATE",
    "ALERT_CERTIFICATE_REVOKED",
    "ALERT_CERTIFICATE_EXPIRED",
    "ALERT_CERTIFICATE_UNKNOWN",
    "ALERT_UNKNOWN_CA",
];

/// Whether the TLS client asked, by SNI, for a host in the zone this server serves.
fn asked_for_a_served_host(error: &SmtpServerError) -> bool {
    error.server_name.as_deref().is_some_and(|name| crate::domains::is_in_served_zone(name.trim_end_matches('.')))
}

/// Whether the peer refused this server's certificate (`peer-cert-rejection.ts`).
pub fn is_peer_cert_rejection(error: &SmtpServerError) -> bool {
    let text = format!("{} {}", error.reason.as_deref().unwrap_or(""), error.message).to_uppercase().replace(' ', "_");
    PEER_CERT_REJECTION_ALERTS.iter().any(|alert| text.contains(alert))
}

// On an implicit-TLS server, handshake errors are tagged with meta.stage
// "connect" before the connection exists, so the tag means "before any SMTP
// command". A STARTTLS handshake carries the same tag but happens inside a
// session, so only the implicit-TLS listener treats it as scanner noise.
fn is_implicit_tls_handshake_failure(secure: bool, error: &SmtpServerError) -> bool {
    secure && error.meta.as_ref().is_some_and(|meta| meta.stage == "connect")
}

// Errors from the TLS layer carry library "SSL routines" and an ERR_SSL_* code.
fn is_tls_layer_error(error: &SmtpServerError) -> bool {
    error.library.as_deref() == Some("SSL routines")
        || error.code.as_deref().is_some_and(|code| code.starts_with("ERR_SSL_"))
}

// A remote client dropping or stalling its connection, matched by syscall and
// errno code because the message differs by runtime.
const PEER_DROP_SYSCALL_ERRORS: [&str; 5] =
    ["read ECONNRESET", "read ETIMEDOUT", "write ECONNRESET", "write EPIPE", "write EPROTO"];

fn is_peer_drop_error(error: &SmtpServerError) -> bool {
    let (Some(syscall), Some(code)) = (error.syscall.as_deref(), error.code.as_deref()) else {
        return false;
    };
    PEER_DROP_SYSCALL_ERRORS.contains(&format!("{syscall} {code}").as_str())
}

// Noise from external port scanners and misconfigured clients, by what the
// message says. The OpenSSL function names are what the Bun server matches on
// Node; they stay so an error worded that way is treated the same here.
const SUPPRESSED_MESSAGE_FRAGMENTS: [&str; 17] = [
    "tls_early_post_process_client_hello", // ClientHello stage rejections
    "tls_post_process_client_hello",       // post-ClientHello cipher/extension failures
    "tls_parse_ctos_",                     // malformed ClientHello extension
    "tls_collect_extensions",              // duplicate or malformed ClientHello extension block
    "tls_validate_record_header",          // malformed/wrong-protocol record header
    "extract_keyshares",                   // TLS 1.3 key exchange failure (bad key share)
    "final_key_share",                     // TLS 1.3 key exchange failure (no suitable key share)
    "tls_choose_sigalg",                   // signature algorithm negotiation failure
    "tls_get_more_records",                // oversized/malformed TLS record
    "Socket closed",                       // client disconnected before TLS handshake
    "Failed to establish TLS session",     // generic TLS failure wrapper
    "read ECONNRESET",                     // client dropped connection mid-handshake
    "read ETIMEDOUT",                      // client connected but stopped responding
    "write EPROTO",                        // protocol error writing to socket
    // The connection itself swallows a write ECONNRESET/EPIPE silently once a
    // transaction is complete (no open envelope), so by the time either
    // reaches here the client abandoned an in-flight transaction and reset
    // the socket before a pending write landed.
    "write ECONNRESET",
    "write EPIPE",
    "TLS handshake timeout", // implicit-TLS client connected but never completed the handshake
];

/// What a listener does about a failure it was told of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerErrorReport {
    /// A client's doing: logged at warn, nobody paged.
    Warn,
    /// Logged at error and sent to the alarm channel.
    Alarm { remote_address: Option<String>, detail: String },
}

/// Sorts a failure the listener on `port` reported: noise from the remote
/// side failing TLS negotiation or dropping its connection is only logged,
/// anything else pages.
pub fn classify_server_error(port: u16, secure: bool, error: &SmtpServerError) -> ServerErrorReport {
    let message = error.message.as_str();
    let suppressed = !(is_peer_cert_rejection(error) && asked_for_a_served_host(error))
        && (is_implicit_tls_handshake_failure(secure, error)
            || is_tls_layer_error(error)
            || is_peer_drop_error(error)
            || SUPPRESSED_MESSAGE_FRAGMENTS.iter().any(|fragment| message.contains(fragment)));
    if suppressed {
        return ServerErrorReport::Warn;
    }
    // Handshake failures carry the peer in meta; session errors set it on the error.
    let remote_address = match error.meta.as_ref().and_then(|meta| meta.remote_address.clone()) {
        Some(address) => Some(address),
        None => error.remote_address.clone(),
    };
    let remote_line = remote_address.as_ref().map(|address| format!("**Remote:** {address}\n")).unwrap_or_default();
    let name_line = error.server_name.as_ref().map(|name| format!("**Server name:** {name}\n")).unwrap_or_default();
    let detail = format!("**Port:** {port}\n{remote_line}{name_line}**Error:** Error: {message}");
    ServerErrorReport::Alarm { remote_address, detail }
}

fn report_server_error(port: u16, secure: bool, error: &SmtpServerError) {
    match classify_server_error(port, secure, error) {
        // Still logged (at warn, not error) so a real failure hiding in this
        // bucket leaves a trace — only the page is suppressed.
        ServerErrorReport::Warn => {
            let context = match &error.server_name {
                Some(name) => json!({ "serverName": name }),
                None => json!({}),
            };
            logger::warn_with(format!("SMTP Server({port}) Error"), context, error)
        }
        ServerErrorReport::Alarm { remote_address, detail } => {
            let mut context = match remote_address {
                Some(address) => json!({ "remoteAddress": address }),
                None => json!({}),
            };
            if let Some(name) = &error.server_name {
                context["serverName"] = json!(name);
            }
            logger::error_with(format!("SMTP Server({port}) Error"), context, error);
            alarm::spawn_alarm("SMTP Server Error", detail);
        }
    }
}

/// Opens one listener on `port` and wires up its registry entry, error
/// handling and logging.
async fn start_listener(options: SmtpServerOptions, port: u16) -> Result<SmtpServer> {
    let secure = options.secure;
    let server = create_smtp_server(options);
    register_smtp_server(&server);
    server.on_error(move |error| report_server_error(port, secure, error));
    let registered = Arc::downgrade(server.shared());
    server.on_close(move || {
        if let Some(shared) = registered.upgrade() {
            unregister_smtp_server(&SmtpServer::from_shared(shared));
        }
        logger::info(format!("SMTP Server({port}) closed"), json!({}));
    });

    if let Err(error) = server.listen(port).await {
        // The Bun server reports a failed listen like any other server error.
        report_server_error(port, secure, &SmtpServerError::from_io("listen", &error));
        unregister_smtp_server(&server);
        return Err(anyhow!(error)).with_context(|| format!("SMTP server could not listen on port {port}"));
    }
    logger::info(format!("SMTP server listening on port {port}"), json!({}));
    Ok(server)
}

fn port_setting(name: &str, default: u16) -> Result<u16> {
    env::port(name, default).ok_or_else(|| anyhow!("{name} is not a port number"))
}

/// What [`initialize_smtp`] needs from the rest of the server.
#[derive(Clone)]
pub struct SmtpListeners {
    /// The mail handling behind every listener.
    pub handler: SharedSmtpHandler,
    /// Whether single sign-on is on. With it an app password is a full
    /// credential for the protocol, so the submission port too takes no AUTH
    /// before STARTTLS.
    pub single_sign_on: bool,
}

/// Starts the SMTP listeners: the cleartext port (`SMTP_PORT`, 25) always,
/// and with a readable certificate the implicit-TLS port (`SMTPS_PORT`, 465)
/// and the STARTTLS submission port (`SMTP_SUBMISSION_PORT`, 587).
pub async fn initialize_smtp(listeners: SmtpListeners) -> Result<Vec<SmtpServer>> {
    let mut servers = Vec::new();

    let credentials = get_tls_credentials();
    let tls: Option<SmtpTlsSource> = match &credentials {
        TlsCredentials::Unreadable { cert, key } => {
            // TLS was configured and cannot be served, so this is an operator
            // error that has to page rather than sit in a warn line while the
            // server accepts plaintext auth.
            logger::error(
                "SMTP: SSL certificate files not readable — starting without TLS",
                json!({ "cert": cert, "key": key }),
            );
            alarm::spawn_alarm_keyed(
                "TLS certificate not readable",
                format!(
                    "SMTP is configured for TLS but cannot read its certificate, and is serving cleartext only.\n**cert:** {cert}\n**key:** {key}"
                ),
                "tls-cert-unreadable-smtp",
            );
            None
        }
        TlsCredentials::Unconfigured => {
            logger::warn("SMTP: SSL certificate not configured.", json!({}));
            None
        }
        TlsCredentials::Available { .. } => {
            // The Bun server builds its TLS context here and does not start
            // with a certificate it cannot use. Each handshake then reads the
            // certificate again, so a renewed one is served without a restart.
            crate::tls::acceptor().context("SMTP: the SSL certificate could not be loaded")?;
            Some(Arc::new(crate::tls::acceptor))
        }
    };

    let options = SmtpServerOptions {
        secure: false,
        proxy_protocol: is_proxy_protocol_enabled(),
        allow_insecure_auth: false,
        name: None,
        tls,
        size: MAX_MESSAGE_BYTES,
        max_clients: SMTP_MAX_CLIENTS,
        close_timeout: Duration::from_millis(SMTP_CLOSE_TIMEOUT_MS),
        socket_timeout: None,
        handler: listeners.handler,
    };

    servers.push(start_listener(options.clone(), port_setting("SMTP_PORT", 25)?).await?);

    if options.tls.is_some() {
        let implicit = SmtpServerOptions { secure: true, ..options.clone() };
        servers.push(start_listener(implicit, port_setting("SMTPS_PORT", 465)?).await?);

        let submission = SmtpServerOptions { allow_insecure_auth: !listeners.single_sign_on, ..options };
        servers.push(start_listener(submission, port_setting("SMTP_SUBMISSION_PORT", 587)?).await?);
    }

    Ok(servers)
}

/// Closes every listener at once; done when the slowest has drained or hit
/// its close timeout.
pub async fn close_smtp_servers(servers: &[SmtpServer]) {
    futures_util::future::join_all(servers.iter().map(|server| server.close())).await;
}

#[cfg(test)]
mod tests {
    //! The cases of "registerListeners error handler" in `smtp.test.ts`.

    use super::*;
    use crate::smtp::server::HandshakeErrorMeta;

    const PORT: u16 = 2525;

    fn error(message: &str) -> SmtpServerError {
        SmtpServerError::new(message)
    }

    /// An errno error as Bun words it: `ECONNRESET: connection reset by peer, read`.
    fn errno(code: &str, description: &str, syscall: &str) -> SmtpServerError {
        SmtpServerError {
            code: Some(code.to_string()),
            syscall: Some(syscall.to_string()),
            ..error(&format!("{code}: {description}, {syscall}"))
        }
    }

    fn meta(stage: &'static str, remote_address: Option<&str>) -> Option<HandshakeErrorMeta> {
        Some(HandshakeErrorMeta { protocol: "smtp", stage, remote_address: remote_address.map(str::to_string) })
    }

    fn reset(message: &str, stage: Option<&'static str>) -> SmtpServerError {
        SmtpServerError {
            code: Some("ECONNRESET".to_string()),
            meta: stage.and_then(|stage| meta(stage, None)),
            ..error(message)
        }
    }

    fn boring_ssl(reason: &str) -> SmtpServerError {
        SmtpServerError {
            library: Some("SSL routines".to_string()),
            reason: Some(reason.to_string()),
            code: Some(format!("ERR_SSL_{reason}")),
            meta: meta("connect", None),
            ..error(&format!("error:100000b8:SSL routines:OPENSSL_internal:{reason}"))
        }
    }

    fn warns(secure: bool, error: &SmtpServerError) -> bool {
        classify_server_error(PORT, secure, error) == ServerErrorReport::Warn
    }

    fn detail(secure: bool, error: &SmtpServerError) -> Option<String> {
        match classify_server_error(PORT, secure, error) {
            ServerErrorReport::Warn => None,
            ServerErrorReport::Alarm { detail, .. } => Some(detail),
        }
    }

    #[test]
    fn suppresses_the_alarm_for_tls_handshake_function_names() {
        for message in [
            "tls_early_post_process_client_hello: unsupported protocol",
            "extract_keyshares: bad key share",
            "tls_choose_sigalg: no suitable signature algorithm",
            "Socket closed before TLS handshake",
            "read ECONNRESET",
            "TLS handshake timeout",
            "write ECONNRESET",
            "write EPIPE",
            "C0BC3644C57F0000:error:0A00006E:SSL routines:tls_parse_ctos_maxfragmentlen:bad extension:../deps/openssl/openssl/ssl/statem/extensions_srvr.c:184:\n",
            "SSL routines:tls_collect_extensions:bad extension",
            "tls_post_process_client_hello: no shared cipher",
            "tls_validate_record_header: wrong version number",
            "final_key_share: no suitable key share",
            "tls_get_more_records: packet length too long",
            "Failed to establish TLS session",
            "read ETIMEDOUT",
            "write EPROTO",
        ] {
            assert!(warns(false, &error(message)), "{message}");
        }
    }

    #[test]
    fn suppresses_the_alarm_for_peer_drop_errno_codes_in_buns_message_format() {
        for dropped in [
            errno("ETIMEDOUT", "connection timed out", "read"),
            errno("ECONNRESET", "connection reset by peer", "read"),
            errno("EPIPE", "broken pipe", "write"),
            errno("ECONNRESET", "connection reset by peer", "write"),
            errno("EPROTO", "protocol error", "write"),
        ] {
            assert!(warns(false, &dropped), "{}", dropped.message);
        }
    }

    #[test]
    fn still_alarms_on_errno_codes_outside_the_peer_drop_syscalls() {
        assert!(!warns(false, &errno("EMFILE", "too many open files", "accept")));
        assert!(!warns(false, &errno("EPROTO", "protocol error", "read")));
    }

    #[test]
    fn suppresses_any_implicit_tls_handshake_error_whatever_its_wording() {
        assert!(warns(true, &reset("socket hang up", Some("connect"))));
        assert!(warns(true, &reset("some future runtime wording", Some("connect"))));
    }

    #[test]
    fn still_pages_for_the_same_error_when_it_was_not_raised_by_the_implicit_tls_handshake() {
        assert!(!warns(true, &reset("socket hang up", None)));
        assert!(!warns(true, &reset("socket hang up", Some("data"))));
        assert!(!warns(false, &reset("socket hang up", Some("connect"))));
    }

    #[test]
    fn suppresses_tls_layer_errors_on_the_starttls_servers() {
        assert!(warns(false, &boring_ssl("NO_SHARED_CIPHER")));
        assert!(warns(false, &boring_ssl("UNSUPPORTED_PROTOCOL")));
        let by_code_alone = SmtpServerError {
            code: Some("ERR_SSL_WRONG_VERSION_NUMBER".to_string()),
            ..error("OPENSSL_internal:WRONG_VERSION_NUMBER")
        };
        assert!(warns(false, &by_code_alone));
    }

    #[test]
    fn still_pages_for_a_socket_error_tagged_by_the_starttls_upgrade_handler() {
        let refused = SmtpServerError {
            code: Some("ECONNREFUSED".to_string()),
            meta: meta("connect", None),
            ..error("connect ECONNREFUSED")
        };
        assert!(!warns(false, &refused));
        let not_the_tls_library = SmtpServerError {
            library: Some("SSL".to_string()),
            code: Some("ERR_SSLX".to_string()),
            ..error("SSL is not a library")
        };
        assert!(!warns(false, &not_the_tls_library));
    }

    /// A host in the zone this server serves.
    fn served_host() -> String {
        format!("mail.{}", crate::domains::served_zone())
    }

    /// A failure from a client that asked, by SNI, for `host`.
    fn asking_for(host: &str, error: SmtpServerError) -> SmtpServerError {
        SmtpServerError { server_name: Some(host.to_string()), ..error }
    }

    /// A failure from a client that asked for a host this server serves.
    fn named(error: SmtpServerError) -> SmtpServerError {
        asking_for(&served_host(), error)
    }

    #[test]
    fn pages_when_the_peer_rejects_our_certificate() {
        assert!(!warns(false, &named(boring_ssl("SSLV3_ALERT_BAD_CERTIFICATE"))));
        assert!(!warns(false, &named(boring_ssl("TLSV1_ALERT_UNKNOWN_CA"))));
        let open_ssl_1 = SmtpServerError {
            library: Some("SSL routines".to_string()),
            reason: Some("sslv3 alert bad certificate".to_string()),
            code: Some("ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE".to_string()),
            ..error("error:14094412:SSL routines:ssl3_read_bytes:sslv3 alert bad certificate")
        };
        assert!(!warns(false, &named(open_ssl_1)));
        let open_ssl_3 = SmtpServerError {
            library: Some("SSL routines".to_string()),
            reason: Some("ssl/tls alert bad certificate".to_string()),
            code: Some("ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE".to_string()),
            ..error("error:0A000412:SSL routines::ssl/tls alert bad certificate")
        };
        assert!(!warns(false, &named(open_ssl_3)));
        assert!(warns(false, &named(boring_ssl("NO_SHARED_CIPHER"))));
        // It pages on the implicit-TLS listener too, where any other handshake failure is noise.
        assert!(!warns(true, &named(boring_ssl("SSLV3_ALERT_CERTIFICATE_EXPIRED"))));
    }

    #[test]
    fn a_certificate_refused_by_a_client_that_asked_for_another_host_or_none_is_noise() {
        let zone = crate::domains::served_zone();
        for reason in ["SSLV3_ALERT_BAD_CERTIFICATE", "TLSV1_ALERT_UNKNOWN_CA", "SSLV3_ALERT_CERTIFICATE_EXPIRED"] {
            for secure in [true, false] {
                assert!(warns(secure, &boring_ssl(reason)), "{reason}, no SNI, secure={secure}");
                assert!(warns(secure, &asking_for("other.example", boring_ssl(reason))), "{reason}, secure={secure}");
                // Ends with the zone's text without being under it.
                assert!(warns(secure, &asking_for(&format!("evil{zone}"), boring_ssl(reason))), "{reason}, secure={secure}");
            }
        }
    }

    #[test]
    fn a_certificate_refused_by_a_client_that_asked_for_any_served_host_pages_whether_or_not_the_certificate_names_it() {
        let zone = crate::domains::served_zone();
        // The zone itself, a host under it that no certificate need name, and
        // the same written in capitals with the root's trailing dot.
        for host in [zone.clone(), format!("imap.{zone}"), format!("MAIL.{}.", zone.to_uppercase())] {
            assert!(!warns(true, &asking_for(&host, boring_ssl("SSLV3_ALERT_BAD_CERTIFICATE"))), "{host}");
        }
    }

    #[test]
    fn names_the_peer_of_a_certificate_rejected_during_the_implicit_tls_handshake() {
        let rejected = SmtpServerError {
            meta: meta("connect", Some("203.0.113.7")),
            ..named(boring_ssl("SSLV3_ALERT_BAD_CERTIFICATE"))
        };
        let report = classify_server_error(PORT, true, &rejected);
        let ServerErrorReport::Alarm { remote_address, detail } = report else {
            panic!("a rejected certificate pages");
        };
        assert_eq!(remote_address.as_deref(), Some("203.0.113.7"));
        assert!(detail.contains("**Remote:** 203.0.113.7\n"), "{detail}");
        assert!(detail.contains(&format!("**Server name:** {}\n", served_host())), "{detail}");
    }

    #[test]
    fn names_the_peer_of_an_error_raised_inside_a_session() {
        let failure = SmtpServerError {
            remote_address: Some("203.0.113.8".to_string()),
            ..error("unexpected internal failure")
        };
        assert_eq!(
            classify_server_error(PORT, false, &failure),
            ServerErrorReport::Alarm {
                remote_address: Some("203.0.113.8".to_string()),
                detail: "**Port:** 2525\n**Remote:** 203.0.113.8\n**Error:** Error: unexpected internal failure"
                    .to_string(),
            }
        );
    }

    #[test]
    fn leaves_the_line_out_when_the_error_has_no_peer() {
        let detail = detail(false, &error("listen EADDRINUSE")).expect("a failed listen pages");
        assert_eq!(detail, "**Port:** 2525\n**Error:** Error: listen EADDRINUSE");
    }

    #[test]
    fn keeps_the_peer_out_of_suppressed_warnings() {
        let noise = SmtpServerError {
            meta: meta("connect", Some("203.0.113.9")),
            remote_address: Some("203.0.113.9".to_string()),
            ..boring_ssl("NO_SHARED_CIPHER")
        };
        assert_eq!(classify_server_error(PORT, true, &noise), ServerErrorReport::Warn);
    }

    #[test]
    fn pages_on_non_suppressible_failures() {
        assert!(detail(false, &error("unexpected internal failure")).is_some());
    }

    /// What the TLS stream reports for an OpenSSL failure, by its reason.
    fn openssl_error(reason: &str) -> SmtpServerError {
        openssl_failure(reason, None)
    }

    /// The same, from a client that asked by SNI for `server_name`.
    fn openssl_failure(reason: &str, server_name: Option<String>) -> SmtpServerError {
        let message = format!("error:0A000000:SSL routines:ssl3_read_bytes:{reason}");
        let error = crate::tls::TlsError { reason: reason.to_string(), message, server_name };
        SmtpServerError::from_io("read", &std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }

    #[test]
    fn sorts_what_openssl_reports_the_way_the_bun_server_does() {
        // A client that speaks no TLS, or none this server shares: noise.
        let garbage = openssl_error("wrong version number");
        assert_eq!(garbage.library.as_deref(), Some("SSL routines"));
        assert_eq!(garbage.code.as_deref(), Some("ERR_SSL_WRONG_VERSION_NUMBER"));
        assert_eq!(garbage.reason.as_deref(), Some("WRONG_VERSION_NUMBER"));
        assert!(warns(false, &garbage));
        assert!(warns(false, &openssl_error("no shared cipher")));
        assert!(warns(false, &openssl_error("sslv3 alert handshake failure")));
        assert!(warns(false, &openssl_error("tlsv1 alert protocol version")));

        // A client that asked for a host this server serves and refuses its
        // certificate: a defect here. One that asked for none: noise.
        for reason in [
            "sslv3 alert bad certificate",
            "sslv3 alert unsupported certificate",
            "sslv3 alert certificate revoked",
            "sslv3 alert certificate expired",
            "sslv3 alert certificate unknown",
            "tlsv1 alert unknown ca",
        ] {
            let rejected = openssl_failure(reason, Some(served_host()));
            assert_eq!(rejected.server_name, Some(served_host()), "{reason}");
            assert!(is_peer_cert_rejection(&rejected), "{reason}");
            assert!(!warns(false, &rejected), "{reason}");
            assert!(!warns(true, &rejected), "{reason}");
            let unnamed = openssl_failure(reason, None);
            assert!(warns(false, &unnamed), "{reason}");
            assert!(warns(true, &unnamed), "{reason}");
        }
        assert!(!is_peer_cert_rejection(&openssl_error("sslv3 alert handshake failure")));
    }

    #[test]
    fn describes_socket_failures_as_node_does() {
        let reset = SmtpServerError::from_io("read", &std::io::Error::from_raw_os_error(libc::ECONNRESET));
        assert_eq!(reset.message, "read ECONNRESET");
        assert_eq!((reset.code.as_deref(), reset.syscall.as_deref()), (Some("ECONNRESET"), Some("read")));
        assert!(warns(false, &reset));

        let pipe = SmtpServerError::from_io("write", &std::io::Error::from(std::io::ErrorKind::BrokenPipe));
        assert_eq!(pipe.message, "write EPIPE");
        assert!(warns(false, &pipe));

        let in_use = SmtpServerError::from_io("listen", &std::io::Error::from_raw_os_error(libc::EADDRINUSE));
        assert_eq!(in_use.message, "listen EADDRINUSE");
        assert!(!warns(false, &in_use));

        let closed = SmtpServerError::handshake(None, Some("203.0.113.7".to_string()));
        assert_eq!(closed.message, "Socket closed while initiating TLS");
        assert_eq!(closed.code.as_deref(), Some("SocketError"));
        assert_eq!(closed.meta, meta("connect", Some("203.0.113.7")));
        assert!(warns(true, &closed));
        assert!(warns(false, &closed));

        // A client that leaves mid-handshake: noise before a session exists,
        // worth a page inside one — where the connection only reports it
        // when it cuts a transaction short.
        let hung_up = std::io::Error::from(std::io::ErrorKind::UnexpectedEof);
        let hung_up = SmtpServerError::handshake(Some(&hung_up), Some("203.0.113.7".to_string()));
        assert_eq!(hung_up.message, "socket hang up");
        assert_eq!(hung_up.code.as_deref(), Some("ECONNRESET"));
        assert_eq!(hung_up.meta, meta("connect", Some("203.0.113.7")));
        assert!(warns(true, &hung_up));
        assert!(!warns(false, &hung_up));
    }
}
