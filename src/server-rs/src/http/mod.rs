//! The HTTP server: the request pipeline, the `/api` routes, mail-client
//! autoconfig, and the built web client with its single-page fallback.

pub mod error_handler;
pub mod head_stream;
pub mod issue_session;
pub mod mime_types;
pub mod rate_limit;
pub mod request;
pub mod respond;
pub mod routes;
pub mod session;
pub mod session_secret;
pub mod sso_hooks;
pub mod static_files;
pub mod upload;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{stream, TryStreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

use self::error_handler::{error_handler, report_middleware_error, FailedRequest};
use self::request::{
    has_body, is_secure_request, read_json_body, resolve_client_ip, trust_loopback_and_private, trust_no_proxy,
    HttpRequest, ProxyTrust, Query, RawBody,
};
use self::respond::{conditional, send, text, Body, Response};
use self::routes::auth::is_raw_body_path;
use self::routes::route::mounted_path;
use self::session::{HttpSession, SessionOptions};
use crate::postgres::repositories::sessions::PostgresSessionStore;
use crate::util::get_domain;
use crate::{env, logger};

type WireBody = BoxBody<Bytes, std::io::Error>;

/// Security response headers, applied to every response. This is the single
/// place they are defined.
fn security_headers(production: bool) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        (
            "Content-Security-Policy",
            [
                "default-src 'self'",
                "script-src 'self'",
                // 'unsafe-inline' for styles is required by React.
                "style-src 'self' 'unsafe-inline'",
                // blob: for inline email images, https: for external ones; plain http: is left out.
                "img-src 'self' data: blob: https:",
                "connect-src 'self'",
                // The sandboxed email iframes are same-origin documents.
                "frame-src 'self'",
                "font-src 'self' data:",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
            ]
            .join("; "),
        ),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("X-Frame-Options", "DENY".to_string()),
        ("Referrer-Policy", "strict-origin-when-cross-origin".to_string()),
    ];
    if production {
        headers.push(("Strict-Transport-Security", "max-age=31536000; includeSubDomains".to_string()));
    }
    headers
}

fn is_autoconfig_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let lower = lower.strip_suffix('/').unwrap_or(&lower);
    lower == "/.well-known/autoconfig/mail/config-v1.1.xml"
}

/// IMAP/SMTP auto-discovery for mail clients (Thunderbird and others).
fn autoconfig() -> Response {
    let email_domain = get_domain();
    // The hostname clients connect to, which is not always the mail domain.
    let server_hostname = env::non_empty("APP_HOSTNAME").unwrap_or_else(|| email_domain.clone());
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="{email_domain}">
    <domain>{email_domain}</domain>
    <displayName>{email_domain} Mail</displayName>
    <displayShortName>{email_domain}</displayShortName>
    <incomingServer type="imap">
      <hostname>{server_hostname}</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>{server_hostname}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>"#
    );
    send(xml, 200, "application/xml; charset=utf-8")
}

/// Everything the pipeline resolves once at boot.
pub struct HttpApp {
    store: PostgresSessionStore,
    session_secret: String,
    production: bool,
    trust: ProxyTrust,
    headers: Vec<(&'static str, String)>,
    client_path: PathBuf,
}

impl HttpApp {
    pub fn new(store: PostgresSessionStore) -> anyhow::Result<HttpApp> {
        let production = env::is_production();
        Ok(HttpApp {
            store,
            session_secret: session_secret::resolve_session_secret()?,
            production,
            // The proxy is trusted by address, not by hop count: a request
            // that reaches the port without passing the proxy cannot name
            // its own address through a forwarding header.
            trust: if production { trust_loopback_and_private } else { trust_no_proxy },
            headers: security_headers(production),
            client_path: env::non_empty("CLIENT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("build/client")),
        })
    }

    async fn route(&self, req: &mut HttpRequest) -> anyhow::Result<Response> {
        let path = req.path.clone();
        if let Some(api_path) = mounted_path(&path, "/api") {
            return routes::handle_api(req, api_path).await;
        }
        if req.method != "GET" && req.method != "HEAD" {
            return Ok(text("Not Found", 404));
        }
        if is_autoconfig_path(&path) {
            return Ok(autoconfig());
        }
        let ranged = req.headers.contains_key("range");
        if let Some(file) = static_files::serve_static(&self.client_path, &path, ranged).await {
            return Ok(file);
        }
        Ok(static_files::serve_index(&self.client_path, ranged)
            .await
            .unwrap_or_else(|| text("Not Found", 404)))
    }

    /// Handles one request; `peer_address` is the remote address of its connection.
    pub async fn handle(
        &self,
        method: String,
        target: RequestTarget,
        headers: http::HeaderMap,
        body: Incoming,
        peer_address: &str,
    ) -> Response {
        let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        let ip = resolve_client_ip(peer_address, header("x-forwarded-for"), self.trust);
        let secure = is_secure_request(peer_address, header("x-forwarded-proto"), self.trust);
        let request_has_body = has_body(&method, &headers, &body);
        let failed = |session_id: Option<&str>, error: &anyhow::Error| {
            error_handler(error, &FailedRequest { method: &method, path: &target.pathname, session_id })
        };

        // The body is read before the session is loaded, as a client error
        // there must not cost a store round trip.
        let parsed = if is_raw_body_path(&target.pathname) {
            Ok(request::JsonBody::empty(RawBody::Unread(body)))
        } else {
            read_json_body(&headers, body, request_has_body).await
        };
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) => return self.finish(&method, &headers, failed(None, &error.into())),
        };

        let options = SessionOptions { secret: self.session_secret.clone(), secure: self.production };
        let mut session = match HttpSession::load(header("cookie"), self.store, options).await {
            Ok(session) => session,
            Err(error) => return self.finish(&method, &headers, failed(None, &error.into())),
        };

        let mut response = match sso_hooks::enforce_sso_session(&mut session).await {
            Err(error) => {
                let response = failed(Some(session.session_id()), &error);
                (response, session)
            }
            Ok(()) => {
                let mut req = HttpRequest {
                    method: method.clone(),
                    path: target.pathname.clone(),
                    url: format!("{}{}", target.pathname, target.search),
                    query: Query::parse(&target.search),
                    headers: headers.clone(),
                    params: Default::default(),
                    body: parsed.value,
                    files: None,
                    ip,
                    secure,
                    session,
                    raw: parsed.raw,
                    has_body: request_has_body,
                    non_finite: parsed.non_finite,
                };
                let response = match self.route(&mut req).await {
                    Ok(response) => response,
                    Err(error) => failed(Some(req.session.session_id()), &error),
                };
                // A body the route never read is read out before the answer,
                // as the Bun server does: closing on a client that is still
                // sending would reset the connection under its reply.
                drain_unread(std::mem::replace(&mut req.raw, RawBody::Taken)).await;
                (response, req.session)
            }
        };
        let (response, session) = (&mut response.0, &mut response.1);

        let (cookie, save_error) = session.commit(secure).await;
        if let Some(error) = save_error {
            report_middleware_error(
                &error.into(),
                &FailedRequest { method: &method, path: &target.pathname, session_id: Some(session.session_id()) },
            );
        }
        if let Some(cookie) = cookie {
            response.append_header("Set-Cookie", cookie);
        }
        self.finish(&method, &headers, std::mem::replace(response, Response::empty()))
    }

    fn finish(&self, method: &str, request_headers: &http::HeaderMap, mut response: Response) -> Response {
        for (name, value) in &self.headers {
            response.set_header(name, value.clone());
        }
        conditional(method, request_headers, response)
    }
}

/// How long reading out an unread request body may take.
const BODY_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

/// Reads and discards what is left of a request body, up to the largest body
/// the server accepts and for at most [`BODY_DRAIN_TIMEOUT`].
async fn drain_unread(raw: RawBody) {
    let RawBody::Unread(mut body) = raw else { return };
    let drain = async {
        let mut read: u64 = 0;
        while let Some(Ok(frame)) = body.frame().await {
            if let Ok(data) = frame.into_data() {
                read += data.len() as u64;
                if read > upload::MAX_REQUEST_BODY_SIZE {
                    return;
                }
            }
        }
    };
    let _ = tokio::time::timeout(BODY_DRAIN_TIMEOUT, drain).await;
}

/// The path and query string a request asked for.
pub struct RequestTarget {
    pub pathname: String,
    pub search: String,
}

/// Normalizes the request target the way a URL parser does — dot segments
/// resolved, `%2e` treated as a dot, backslashes as slashes — and splits it
/// at the first `?`. The Host header plays no part in the result.
fn request_target(uri: &http::Uri) -> RequestTarget {
    let raw = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let normalized = url::Url::parse(&format!("http://localhost{raw}"))
        .ok()
        .map(|url| url.as_str()["http://localhost".len()..].to_string())
        .unwrap_or_else(|| raw.to_string());
    let (pathname, search) = match normalized.find('?') {
        Some(at) => (normalized[..at].to_string(), normalized[at..].to_string()),
        None => (normalized, String::new()),
    };
    RequestTarget { pathname: if pathname.is_empty() { "/".to_string() } else { pathname }, search }
}

/// One satisfiable byte range of a file of `size` bytes.
enum ByteRange {
    /// Not a single well-formed range: answer with the whole file.
    Ignore,
    Unsatisfiable,
    Partial { start: u64, end: u64 },
}

/// Reads a `Range` header the way the Bun server's own file serving does:
/// one range of the form `bytes=a-b`, `bytes=a-` or `bytes=-n`, the unit in
/// any letter case, spaces and tabs allowed between the parts, the numbers
/// plain digits that fit 64 bits. Anything else, several ranges included, is
/// not a range request at all.
fn parse_range(header: &str, size: u64) -> ByteRange {
    let bytes = header.as_bytes();
    let mut at = 0;
    let skip_blanks = |at: &mut usize| {
        while matches!(bytes.get(*at), Some(b' ' | b'\t')) {
            *at += 1;
        }
    };
    // `Some(None)` when there are no digits here, `None` when they overflow.
    let digits = |at: &mut usize| -> Option<Option<u64>> {
        let start = *at;
        while matches!(bytes.get(*at), Some(b'0'..=b'9')) {
            *at += 1;
        }
        if *at == start {
            return Some(None);
        }
        header[start..*at].parse::<u64>().ok().map(Some)
    };
    let expect = |at: &mut usize, byte: u8| {
        let found = bytes.get(*at) == Some(&byte);
        *at += usize::from(found);
        found
    };

    skip_blanks(&mut at);
    if !header.get(at..at + 5).is_some_and(|unit| unit.eq_ignore_ascii_case("bytes")) {
        return ByteRange::Ignore;
    }
    at += 5;
    skip_blanks(&mut at);
    if !expect(&mut at, b'=') {
        return ByteRange::Ignore;
    }
    skip_blanks(&mut at);
    let Some(first) = digits(&mut at) else {
        return ByteRange::Ignore;
    };
    skip_blanks(&mut at);
    if !expect(&mut at, b'-') {
        return ByteRange::Ignore;
    }
    skip_blanks(&mut at);
    let Some(last) = digits(&mut at) else {
        return ByteRange::Ignore;
    };
    skip_blanks(&mut at);
    if at != bytes.len() {
        return ByteRange::Ignore;
    }

    match (first, last) {
        (None, None) => ByteRange::Ignore,
        // The last `n` bytes: none at all is never satisfiable, and an empty
        // file has no last bytes to ask for.
        (None, Some(0)) => ByteRange::Unsatisfiable,
        (None, Some(_)) if size == 0 => ByteRange::Ignore,
        (None, Some(suffix)) => ByteRange::Partial { start: size.saturating_sub(suffix), end: size - 1 },
        (Some(start), end) => {
            if end.is_some_and(|end| end < start) {
                return ByteRange::Ignore;
            }
            if start >= size {
                return ByteRange::Unsatisfiable;
            }
            ByteRange::Partial { start, end: end.map_or(size - 1, |end| end.min(size - 1)) }
        }
    }
}

/// Whether a browser shows a body of this type itself. The Bun server offers
/// every other file body as a download by naming it in `Content-Disposition`.
fn is_viewable_type(content_type: &str) -> bool {
    let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match essence.split_once('/') {
        Some(("text" | "image" | "audio" | "video" | "font", _)) => true,
        Some(("application", subtype)) => matches!(subtype, "json" | "geo+json" | "wasm"),
        _ => false,
    }
}

/// `filename="<base name>"` for a file body that is not viewable, as the Bun
/// server adds it. A name that would break the header (a quote, a line
/// break) gets none; nor does one this server's HTTP library cannot send (a
/// control character, or bytes that are not UTF-8).
fn content_disposition(path: &std::path::Path, content_type: Option<&str>) -> Option<String> {
    let content_type = content_type.unwrap_or_else(|| static_files::content_type_of(path));
    if is_viewable_type(content_type) {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    let sendable = name.bytes().all(|byte| byte == b'\t' || (byte >= 0x20 && byte != 0x7f && byte != b'"'));
    (!name.is_empty() && sendable).then(|| format!("filename=\"{name}\""))
}

/// Bodies built in pieces are streamed: below this many bytes the Bun server
/// has the whole body before it writes anything and sends its length, from
/// here on it sends chunks and no length.
const STREAM_BUFFER_BYTES: u64 = 256;

fn full(bytes: Bytes) -> WireBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

async fn file_body(path: PathBuf, start: u64, length: u64) -> std::io::Result<WireBody> {
    let mut file = tokio::fs::File::open(path).await?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await?;
    }
    let frames = ReaderStream::new(file.take(length)).map_ok(Frame::data);
    Ok(BodyExt::boxed(StreamBody::new(frames)))
}

/// What the framing of a response depends on besides the response itself.
struct WireRequest<'a> {
    method: &'a str,
    /// The request's headers as they arrived: of a repeated `Range`, the
    /// first line counts.
    headers: &'a http::HeaderMap,
    /// HTTP/1.1, where a body of unknown length is sent in chunks.
    http_11: bool,
}

/// Puts a response on the wire: explicit `Content-Length`, no body for HEAD,
/// byte ranges and `Content-Disposition` for a file body, and chunks for a
/// body that was built in pieces.
async fn into_wire(request: &WireRequest<'_>, mut response: Response) -> hyper::Response<WireBody> {
    let method = request.method;
    let mut status = response.status;
    let mut length = response.body.len();
    let mut range = None;

    if let Body::File { size, .. } = &response.body {
        let header = |name: &str| request.headers.get(name).and_then(|value| value.to_str().ok());
        // `If-Range` lets the range through only when it is the file's exact
        // Last-Modified. Its ETag is a weak one, which never satisfies it.
        let current = match header("if-range").map(str::trim).filter(|validator| !validator.is_empty()) {
            Some(validator) => response.header("last-modified") == Some(validator),
            None => true,
        };
        let requested = header("range").filter(|_| current);
        if let (true, 200, Some(requested)) = (method == "GET", status, requested) {
            match parse_range(requested, *size) {
                ByteRange::Ignore => {}
                ByteRange::Unsatisfiable => {
                    status = 416;
                    length = 0;
                    response.set_header("Content-Range", format!("bytes */{size}"));
                    response.set_header("Accept-Ranges", "bytes");
                    response.body = Body::Empty;
                }
                ByteRange::Partial { start, end } => {
                    status = 206;
                    length = end - start + 1;
                    range = Some((start, length));
                    response.set_header("Content-Range", format!("bytes {start}-{end}/{size}"));
                    response.set_header("Accept-Ranges", "bytes");
                }
            }
        }
    }

    // Only with the file itself: not for HEAD, a 304 or a 416.
    if method == "GET" && matches!(status, 200 | 206) && response.header("content-disposition").is_none() {
        if let Body::File { path, .. } = &response.body {
            if let Some(disposition) = content_disposition(path, response.header("content-type")) {
                response.append_header("Content-Disposition", disposition);
            }
        }
    }

    // A body built in pieces is streamed, unless all of it is so small that
    // it is complete before anything is written. HEAD never gets that far:
    // it is answered as a stream whatever the size.
    let pieces = matches!(&response.body, Body::Chunks(chunks) if !chunks.is_empty());
    let streamed = pieces && status != 304 && (method == "HEAD" || length >= STREAM_BUFFER_BYTES);

    let body: WireBody = if method == "HEAD" || status == 304 {
        full(Bytes::new())
    } else {
        match response.body {
            Body::Empty => full(Bytes::new()),
            Body::Bytes(bytes) => full(bytes),
            Body::Chunks(chunks) if streamed => {
                let frames = stream::iter(chunks.into_iter().map(|chunk| Ok(Frame::data(chunk))));
                BodyExt::boxed(StreamBody::new(frames))
            }
            Body::Chunks(chunks) => {
                let mut whole = bytes::BytesMut::with_capacity(length as usize);
                for chunk in &chunks {
                    whole.extend_from_slice(chunk);
                }
                full(whole.freeze())
            }
            Body::File { path, size } => {
                let (start, take) = range.unwrap_or((0, size));
                match file_body(path, start, take).await {
                    Ok(body) => body,
                    Err(error) => {
                        // The file vanished between the stat and the open.
                        logger::error_with("Unhandled HTTP server error", json!({}), &error);
                        crate::alarm::spawn_alarm("Unhandled HTTP Server Error", format!("**Error:** {error}"));
                        let fallback = text("Internal server error", 500);
                        let Body::Bytes(bytes) = fallback.body else { unreachable!("text bodies are bytes") };
                        status = 500;
                        length = bytes.len() as u64;
                        response.headers = fallback.headers;
                        full(bytes)
                    }
                }
            }
        }
    };

    let mut builder = hyper::Response::builder().status(status);
    for (name, value) in &response.headers {
        if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("transfer-encoding") {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_str());
    }
    if status == 304 {
        // No body and nothing said about one.
    } else if !streamed {
        builder = builder.header("Content-Length", length);
    } else if method == "HEAD" && request.http_11 {
        // For GET the HTTP library names the encoding as it applies it. From
        // a HEAD answer it would drop the header, so a stand-in travels to
        // the connection's writer, which puts the real name back.
        builder = builder.header(head_stream::stand_in_header(), "chunked");
    }
    builder.body(body).unwrap_or_else(|_| {
        let mut fallback = hyper::Response::new(full(Bytes::from_static(b"Internal server error")));
        *fallback.status_mut() = http::StatusCode::INTERNAL_SERVER_ERROR;
        fallback
    })
}

/// The request methods the Bun server's HTTP parser knows. A request with
/// any other is not answered at all: the connection is closed.
const KNOWN_METHODS: [&str; 35] = [
    "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE",
    "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH",
    "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK",
    "UNLOCK", "UNSUBSCRIBE",
];

/// Why a connection is dropped without an answer.
#[derive(Debug)]
struct UnknownMethod;

impl std::fmt::Display for UnknownMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the request method is not one this server answers")
    }
}

impl std::error::Error for UnknownMethod {}

/// The request's headers as the Bun server's `Headers` object presents them:
/// the lines of a repeated header are one value, joined with `, ` — or with
/// `; ` for `Cookie`.
fn joined_headers(headers: &http::HeaderMap) -> http::HeaderMap {
    let mut joined = http::HeaderMap::with_capacity(headers.keys_len());
    for name in headers.keys() {
        let mut lines = headers.get_all(name).iter();
        let Some(first) = lines.next() else { continue };
        let separator: &[u8] = if name == http::header::COOKIE { b"; " } else { b", " };
        let mut bytes = first.as_bytes().to_vec();
        let mut repeated = false;
        for line in lines {
            bytes.extend_from_slice(separator);
            bytes.extend_from_slice(line.as_bytes());
            repeated = true;
        }
        let value = match repeated {
            true => http::HeaderValue::from_bytes(&bytes).unwrap_or_else(|_| first.clone()),
            false => first.clone(),
        };
        joined.insert(name.clone(), value);
    }
    joined
}

async fn serve(
    app: Arc<HttpApp>,
    request: hyper::Request<Incoming>,
    peer: SocketAddr,
) -> Result<hyper::Response<WireBody>, UnknownMethod> {
    let (parts, body) = request.into_parts();
    if !KNOWN_METHODS.contains(&parts.method.as_str()) {
        return Err(UnknownMethod);
    }
    // An HTTP/1.1 request without Host is refused outright.
    if parts.version == http::Version::HTTP_11 && !parts.headers.contains_key("host") {
        let mut response = hyper::Response::new(full(Bytes::new()));
        *response.status_mut() = http::StatusCode::BAD_REQUEST;
        response.headers_mut().insert("connection", http::HeaderValue::from_static("close"));
        return Ok(response);
    }
    // A declared body past the largest the server reads is refused before
    // any of it is read, as the Bun server's `maxRequestBodySize` refuses it.
    let declared = parts.headers.get(http::header::CONTENT_LENGTH).and_then(|value| value.to_str().ok());
    let declared = declared.and_then(|value| value.trim().parse::<u64>().ok());
    if declared.is_some_and(|length| length > upload::MAX_REQUEST_BODY_SIZE) {
        let mut response = hyper::Response::new(full(Bytes::new()));
        *response.status_mut() = http::StatusCode::PAYLOAD_TOO_LARGE;
        response.headers_mut().insert("connection", http::HeaderValue::from_static("close"));
        return Ok(response);
    }
    let method = parts.method.as_str().to_string();
    let target = request_target(&parts.uri);
    let peer_address = match peer.ip() {
        std::net::IpAddr::V6(ip) => ip.to_ipv4_mapped().map(|v4| v4.to_string()).unwrap_or_else(|| ip.to_string()),
        std::net::IpAddr::V4(ip) => ip.to_string(),
    };
    let headers = joined_headers(&parts.headers);
    let response = app.handle(method.clone(), target, headers, body, &peer_address).await;
    let wire = WireRequest { method: &method, headers: &parts.headers, http_11: parts.version == http::Version::HTTP_11 };
    Ok(into_wire(&wire, response).await)
}

/// The running HTTP server.
pub struct HttpServer {
    shutdown: CancellationToken,
    accept_loop: tokio::task::JoinHandle<()>,
}

impl HttpServer {
    /// Stops accepting connections and waits for in-flight requests to finish.
    pub async fn stop(self) {
        self.shutdown.cancel();
        let _ = self.accept_loop.await;
    }
}

// How long an idle keep-alive connection is kept.
const IDLE_TIMEOUT: Duration = Duration::from_secs(255);

/// How long a stop waits for in-flight requests before dropping them.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// Binds the HTTP port (`PORT`, default 3004) and starts serving.
pub async fn initialize_http() -> anyhow::Result<HttpServer> {
    let app = Arc::new(HttpApp::new(PostgresSessionStore::start())?);
    let port: u16 = match env::non_empty("PORT") {
        Some(value) => crate::js::number_from_str(&value) as u16,
        None => 3004,
    };
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    logger::info(format!("{} mail server is listening", get_domain()), json!({}));
    rate_limit::start_cleanup_scheduler();

    let shutdown = CancellationToken::new();
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let accept_loop = crate::alarm::spawn_essential("HTTP accept loop", {
        let shutdown = shutdown.clone();
        async move {
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder.timer(TokioTimer::new()).header_read_timeout(IDLE_TIMEOUT).title_case_headers(true);
            loop {
                let (stream, peer) = tokio::select! {
                    _ = shutdown.cancelled() => break,
                    accepted = listener.accept() => match accepted {
                        Ok(accepted) => accepted,
                        Err(_) => continue,
                    },
                };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                let connection = builder
                    .serve_connection(TokioIo::new(head_stream::HeadStream::new(stream)), service_fn(move |request| serve(app.clone(), request, peer)));
                let connection = graceful.watch(connection);
                tokio::spawn(async move {
                    let _ = connection.await;
                });
            }
            drop(listener);
            let _ = tokio::time::timeout(DRAIN_TIMEOUT, graceful.shutdown()).await;
        }
    });
    Ok(HttpServer { shutdown, accept_loop })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(raw: &str) -> (String, String) {
        let target = request_target(&raw.parse().unwrap());
        (target.pathname, target.search)
    }

    #[test]
    fn targets_are_normalized_like_a_url() {
        assert_eq!(target("/api/users/../users/login"), ("/api/users/login".into(), "".into()));
        assert_eq!(target("/%2e%2e/package.json"), ("/package.json".into(), "".into()));
        assert_eq!(target("/api//ping?x=1&y"), ("/api//ping".into(), "?x=1&y".into()));
        assert_eq!(target("/a%20b"), ("/a%20b".into(), "".into()));
        assert_eq!(target("/"), ("/".into(), "".into()));
    }

    #[test]
    fn ranges() {
        assert!(matches!(parse_range("bytes=0-4", 67), ByteRange::Partial { start: 0, end: 4 }));
        assert!(matches!(parse_range("bytes=5-", 67), ByteRange::Partial { start: 5, end: 66 }));
        assert!(matches!(parse_range("bytes=-5", 67), ByteRange::Partial { start: 62, end: 66 }));
        assert!(matches!(parse_range("bytes=0-99999", 67), ByteRange::Partial { start: 0, end: 66 }));
        assert!(matches!(parse_range("bytes=9999-", 67), ByteRange::Unsatisfiable));
        assert!(matches!(parse_range("bytes=4-2", 67), ByteRange::Ignore));
        assert!(matches!(parse_range("bytes=0-0,2-3", 67), ByteRange::Ignore));
        assert!(matches!(parse_range("garbage", 67), ByteRange::Ignore));
    }

    #[test]
    fn ranges_as_the_bun_server_reads_them() {
        // The unit in any letter case, blanks between the parts.
        for header in ["BYTES=1-2", "Bytes=1-2", "bytes = 1 - 2", "bytes=\t1-2", "bytes=1 -2", "bytes=1- 2", " bytes=1-2 ", "bytes=01-02"] {
            assert!(matches!(parse_range(header, 10), ByteRange::Partial { start: 1, end: 2 }), "{header:?}");
        }
        assert!(matches!(parse_range("bytes= -2", 10), ByteRange::Partial { start: 8, end: 9 }));
        // No last bytes at all is never satisfiable; an empty file has none to ask for.
        assert!(matches!(parse_range("bytes=-0", 10), ByteRange::Unsatisfiable));
        assert!(matches!(parse_range("bytes=-00", 10), ByteRange::Unsatisfiable));
        assert!(matches!(parse_range("bytes=-0", 0), ByteRange::Unsatisfiable));
        assert!(matches!(parse_range("bytes=-1", 0), ByteRange::Ignore));
        assert!(matches!(parse_range("bytes=0-", 0), ByteRange::Unsatisfiable));
        assert!(matches!(parse_range("bytes=10-", 10), ByteRange::Unsatisfiable));
        // Numbers are 64 bits wide; wider ones make the header no range at all.
        assert!(matches!(parse_range("bytes=0-18446744073709551615", 10), ByteRange::Partial { start: 0, end: 9 }));
        assert!(matches!(parse_range("bytes=18446744073709551615-", 10), ByteRange::Unsatisfiable));
        assert!(matches!(parse_range("bytes=-9223372036854775807", 10), ByteRange::Partial { start: 0, end: 9 }));
        assert!(matches!(parse_range("bytes=18446744073709551616-", 10), ByteRange::Ignore));
        assert!(matches!(parse_range("bytes=0-99999999999999999999999", 10), ByteRange::Ignore));
        for header in [
            "bytes", "bytes=", "bytes=-", "bytes=a-b", "bytes=+1-2", "bytes=1.0-2", "bytes 1-2", "bytes:1-2", "items=1-2",
            "byte=1-2", "bytes=1-2;q=1", "bytes=--1", "bytes=1-2-3", "bytes=1", "1-2", "=1-2", "bytes=1-2,", "bytes=,1-2", "",
        ] {
            assert!(matches!(parse_range(header, 10), ByteRange::Ignore), "{header:?}");
        }
    }

    #[test]
    fn viewable_types_get_no_content_disposition() {
        for viewable in [
            "text/html;charset=utf-8", "text/markdown", "image/png", "audio/mpeg", "video/mp4", "font/woff2",
            "application/json;charset=utf-8", "application/json", "application/geo+json", "application/wasm", "Text/Plain",
        ] {
            assert!(is_viewable_type(viewable), "{viewable}");
        }
        for download in [
            "application/octet-stream", "application/pdf", "application/xml", "application/manifest+json",
            "application/ld+json", "application/zip", "model/obj", "message/rfc822", "", "nonsense",
        ] {
            assert!(!is_viewable_type(download), "{download}");
        }
    }

    #[test]
    fn content_dispositions() {
        let disposition = |path: &str, content_type: Option<&str>| content_disposition(std::path::Path::new(path), content_type);
        assert_eq!(disposition("/a/b/report.pdf", Some("application/pdf")).as_deref(), Some("filename=\"report.pdf\""));
        assert_eq!(disposition("/a/noext", Some("application/octet-stream")).as_deref(), Some("filename=\"noext\""));
        assert_eq!(disposition("/a/with space;é.bin", Some("application/octet-stream")).as_deref(), Some("filename=\"with space;é.bin\""));
        // The type decides, whatever the name says; without one the name does.
        assert_eq!(disposition("/a/photo.png", Some("application/octet-stream")).as_deref(), Some("filename=\"photo.png\""));
        assert_eq!(disposition("/a/photo.png", Some("image/png")), None);
        assert_eq!(disposition("/a/photo.png", None), None);
        assert_eq!(disposition("/a/data.bin", None).as_deref(), Some("filename=\"data.bin\""));
        // A name that would break the header gets none.
        assert_eq!(disposition("/a/quo\"te.bin", Some("application/octet-stream")), None);
        assert_eq!(disposition("/a/line\nfeed.bin", Some("application/octet-stream")), None);
        assert_eq!(disposition("/a/carriage\rreturn.bin", Some("application/octet-stream")), None);
    }

    #[test]
    fn repeated_request_headers_are_joined() {
        let mut headers = http::HeaderMap::new();
        headers.append("x-forwarded-for", "1.1.1.1".parse().unwrap());
        headers.append("x-forwarded-for", "2.2.2.2".parse().unwrap());
        headers.append("cookie", "a=1".parse().unwrap());
        headers.append("cookie", "b=2".parse().unwrap());
        headers.append("content-type", "application/json".parse().unwrap());
        let joined = joined_headers(&headers);
        assert_eq!(joined.get("x-forwarded-for").unwrap(), "1.1.1.1, 2.2.2.2");
        assert_eq!(joined.get("cookie").unwrap(), "a=1; b=2");
        assert_eq!(joined.get("content-type").unwrap(), "application/json");
        assert_eq!(joined.len(), 3);
    }

    /// Sends `request` to a connection whose every answer is `response`, and
    /// returns what the HTTP library puts on the wire.
    async fn on_the_wire(request: &str, response: Response) -> String {
        use tokio::io::AsyncWriteExt;
        let (client, server) = tokio::io::duplex(1 << 20);
        let service = service_fn(move |request: hyper::Request<Incoming>| {
            let response = response.clone();
            async move {
                let (parts, _body) = request.into_parts();
                let method = parts.method.as_str().to_string();
                let wire = WireRequest { method: &method, headers: &parts.headers, http_11: parts.version == http::Version::HTTP_11 };
                Ok::<_, std::convert::Infallible>(into_wire(&wire, response).await)
            }
        });
        let io = TokioIo::new(head_stream::HeadStream::new(server));
        let connection = tokio::spawn(hyper::server::conn::http1::Builder::new().serve_connection(io, service));
        let (mut read, mut write) = tokio::io::split(client);
        write.write_all(request.as_bytes()).await.unwrap();
        let mut wire = Vec::new();
        read.read_to_end(&mut wire).await.unwrap();
        let _ = connection.await;
        String::from_utf8_lossy(&wire).to_lowercase()
    }

    fn list_of(bytes: usize) -> Response {
        let mut list = respond::JsonList::new(None);
        // `{"status":"success","body":[` … `]}` is 30 bytes around the items.
        list.push(&"x".repeat(bytes - 32));
        list.finish()
    }

    #[tokio::test]
    async fn a_small_list_is_sent_with_its_length() {
        let wire = on_the_wire("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", list_of(255)).await;
        assert!(wire.contains("content-length: 255\r\n"), "{wire}");
        assert!(!wire.contains("transfer-encoding"), "{wire}");
        assert!(wire.ends_with("\"]}"), "{wire}");
    }

    #[tokio::test]
    async fn a_list_of_256_bytes_or_more_is_chunked_without_a_length() {
        let wire = on_the_wire("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", list_of(256)).await;
        assert!(wire.contains("transfer-encoding: chunked\r\n"), "{wire}");
        assert!(!wire.contains("content-length"), "{wire}");
        assert!(wire.contains("\r\n\r\n100\r\n{\"status\":\"success\""), "{wire}");
        assert!(wire.ends_with("\r\n0\r\n\r\n"), "{wire}");
    }

    #[tokio::test]
    async fn a_list_over_http_1_0_is_ended_by_closing() {
        let wire = on_the_wire("GET / HTTP/1.0\r\n\r\n", list_of(300)).await;
        assert!(!wire.contains("transfer-encoding"), "{wire}");
        assert!(!wire.contains("content-length"), "{wire}");
        assert!(wire.ends_with("\"]}"), "{wire}");
    }

    #[tokio::test]
    async fn head_of_a_list_has_no_length_and_no_body() {
        for size in [100, 5000] {
            let wire = on_the_wire("HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", list_of(size)).await;
            assert!(!wire.contains("content-length"), "{wire}");
            assert!(wire.contains("transfer-encoding: chunked\r\n"), "{wire}");
            assert!(wire.ends_with("\r\n\r\n"), "{wire}");
        }
    }

    #[tokio::test]
    async fn a_not_modified_list_says_nothing_about_a_body() {
        let mut request_headers = http::HeaderMap::new();
        request_headers.insert("if-none-match", "*".parse().unwrap());
        let not_modified = conditional("GET", &request_headers, list_of(5000));
        let wire = on_the_wire("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", not_modified).await;
        assert!(wire.starts_with("http/1.1 304"), "{wire}");
        assert!(!wire.contains("content-length") && !wire.contains("transfer-encoding"), "{wire}");
    }

    #[tokio::test]
    async fn whole_bodies_keep_their_length() {
        let wire = on_the_wire("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", text(&"x".repeat(5000), 200)).await;
        assert!(wire.contains("content-length: 5000\r\n"), "{wire}");
        assert!(!wire.contains("transfer-encoding"), "{wire}");
        let head = on_the_wire("HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", text(&"x".repeat(5000), 200)).await;
        assert!(head.contains("content-length: 5000\r\n"), "{head}");
        assert!(head.ends_with("\r\n\r\n"), "{head}");
    }

    #[test]
    fn autoconfig_paths() {
        assert!(is_autoconfig_path("/.well-known/autoconfig/mail/config-v1.1.xml"));
        assert!(is_autoconfig_path("/.WELL-KNOWN/autoconfig/mail/config-v1.1.xml/"));
        assert!(!is_autoconfig_path("/.well-known/autoconfig/mail/config-v1.1.xml/x"));
    }
}
