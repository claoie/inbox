//! The OpenID Connect provider client (auth-client.ts).
//!
//! The app side of single sign-on. It speaks the standard parts (discovery,
//! the code flow with PKCE, JWKS) to any OpenID Connect provider, plus the
//! parts no standard library does: introspection of app passwords with its
//! cache, and the provider's signed events.
//!
//! It knows nothing of HTTP requests or sessions. A sign-in is two calls that
//! take and return plain values:
//!
//! ```ignore
//! let started = client.start_login(&StartLoginOptions { return_to, ..Default::default() }).await?;
//! // 302 to started.redirect_url, Set-Cookie: started.login_cookie
//!
//! let login = client.finish_login(request_url, cookie_header).await?;
//! // login.claims.sub, login.refresh_token, 302 to login.return_to, Set-Cookie: login.clear_cookie
//! ```
//!
//! Every failure is an [`AuthError`], whose variant says what the caller
//! should do about it.

use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD, URL_SAFE_NO_PAD};
use base64::engine::DecodePaddingMode;
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use crate::js;
use crate::sync::LockUnpoisoned;

const LEEWAY_S: f64 = 30.0;
/// The cookie a sign-in's state travels in between its two requests.
pub const LOGIN_COOKIE: &str = "__Host-login";
const LOGIN_TTL_S: i64 = 300;
const TIMEOUT_MS: u64 = 5_000;
const JWKS_TTL_MS: i64 = 3_600_000;
const JWKS_MIN_INTERVAL_MS: i64 = 30_000;
const FRESH_MS: i64 = 60_000;
const STALE_MS: i64 = 600_000;
const CACHE_MAX: usize = 10_000;
const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
const COOKIE_ATTRIBUTES: &str = "Path=/; Secure; HttpOnly; SameSite=Lax";
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Why the callback cannot complete a sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginErrorCode {
    NoLoginCookie,
    LoginExpired,
    StateMismatch,
    AuthorizationError,
    MissingCode,
}

impl LoginErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginErrorCode::NoLoginCookie => "no_login_cookie",
            LoginErrorCode::LoginExpired => "login_expired",
            LoginErrorCode::StateMismatch => "state_mismatch",
            LoginErrorCode::AuthorizationError => "authorization_error",
            LoginErrorCode::MissingCode => "missing_code",
        }
    }
}

/// A failure of the provider client. The variant is the classification the
/// rest of the server acts on; the text is for logs only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// The callback can't complete this sign-in; start a new one. `error` is
    /// the provider's `error` parameter, for `authorization_error`.
    Login { code: LoginErrorCode, error: Option<String> },
    /// The provider refused a code or refresh token: end the session.
    InvalidGrant(String),
    /// The provider could not be reached, timed out, or failed on its side.
    Unavailable(String),
    /// A token or event failed verification.
    InvalidToken(String),
    /// Anything else: a refusal that is not about this grant, a provider
    /// without an endpoint, settings the client cannot work with.
    Other(String),
}

impl AuthError {
    fn login(code: LoginErrorCode) -> AuthError {
        AuthError::Login { code, error: None }
    }

    fn invalid_token(message: impl Into<String>) -> AuthError {
        AuthError::InvalidToken(message.into())
    }

    fn unavailable(message: impl Into<String>) -> AuthError {
        AuthError::Unavailable(message.into())
    }

    fn other(message: impl Into<String>) -> AuthError {
        AuthError::Other(message.into())
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, AuthError::Unavailable(_))
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Login { code, error: Some(error) } if !error.is_empty() => {
                write!(f, "{}: {error}", code.as_str())
            }
            AuthError::Login { code, .. } => f.write_str(code.as_str()),
            AuthError::InvalidGrant(message)
            | AuthError::Unavailable(message)
            | AuthError::InvalidToken(message)
            | AuthError::Other(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for AuthError {}

/// One request to the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRequest {
    /// `GET` or `POST`.
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    /// A form-encoded body, on a `POST`.
    pub body: Option<String>,
}

/// The provider's answer. `body` is `None` when the status arrived but the
/// body could not be read to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderResponse {
    pub status: u16,
    pub body: Option<Vec<u8>>,
}

/// How the client reaches the provider. An `Err` means the provider could not
/// be reached or did not answer in time; a redirect must be returned, not
/// followed. The default sends over HTTP with a five-second limit per request;
/// tests put a fake provider here.
pub trait Transport: Send + Sync + 'static {
    fn send(&self, request: ProviderRequest) -> BoxFuture<'static, Result<ProviderResponse, String>>;
}

/// Provider calls over HTTP: a redirect is an answer, not followed, and a
/// request that takes longer than five seconds has failed.
struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    fn new() -> HttpTransport {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(TIMEOUT_MS))
            .build()
            .expect("the provider HTTP client builds");
        HttpTransport { client }
    }
}

impl Transport for HttpTransport {
    fn send(&self, request: ProviderRequest) -> BoxFuture<'static, Result<ProviderResponse, String>> {
        let mut builder = match request.method {
            "POST" => self.client.post(&request.url),
            _ => self.client.get(&request.url),
        };
        for (name, value) in &request.headers {
            builder = builder.header(*name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        async move {
            let response = builder.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response.bytes().await.ok().map(|bytes| bytes.to_vec());
            Ok(ProviderResponse { status, body })
        }
        .boxed()
    }
}

/// Milliseconds since the epoch.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Clone, Default)]
pub struct AuthClientOptions {
    /// The issuer URL, exactly as tokens carry it in `iss`.
    pub issuer: String,
    /// A private-network URL for the same service, used for every server-to-server call.
    pub back_channel_url: Option<String>,
    pub client_id: String,
    /// Leave out for a public client.
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    /// The `aud` of this app's access tokens and events: its service name. Defaults to `client_id`.
    pub audience: Option<String>,
    /// For tests: a fake provider in place of HTTP.
    pub transport: Option<Arc<dyn Transport>>,
    /// For tests: the clock.
    pub now: Option<Clock>,
}

/// The claims of a verified access token.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessClaims {
    pub sub: String,
    /// The provider's session id.
    pub sid: String,
    pub username: String,
    pub name: String,
    pub role: String,
    /// Every claim of the token.
    pub all: Map<String, Value>,
}

/// The claims of a verified ID token.
#[derive(Debug, Clone, PartialEq)]
pub struct IdClaims {
    pub sub: String,
    pub nonce: String,
    /// Every claim of the token.
    pub all: Map<String, Value>,
}

impl IdClaims {
    /// The `email` claim as the token carries it: usually a string or null,
    /// `Value::Null` when absent.
    pub fn email(&self) -> &Value {
        self.all.get("email").unwrap_or(&Value::Null)
    }

    /// Whether the token marks the address verified: the claim is exactly `true`.
    pub fn email_verified(&self) -> bool {
        self.all.get("email_verified") == Some(&Value::Bool(true))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    None,
    Login,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartLoginOptions {
    /// A local path to land on after sign-in. Anything else is replaced with "/".
    pub return_to: Option<String>,
    /// The oldest sign-in at the provider that will do, in seconds.
    pub max_age: Option<i64>,
    pub prompt: Option<Prompt>,
    pub login_hint: Option<String>,
}

/// Where to send the browser, and the cookie to send it there with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedLogin {
    pub redirect_url: String,
    /// A complete `Set-Cookie` value.
    pub login_cookie: String,
}

/// A completed sign-in.
#[derive(Debug, Clone, PartialEq)]
pub struct Login {
    pub claims: AccessClaims,
    pub id_claims: IdClaims,
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// The local path the sign-in started from, or "/".
    pub return_to: String,
    /// A `Set-Cookie` value that deletes the login cookie.
    pub clear_cookie: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refreshed {
    pub claims: AccessClaims,
    pub access_token: String,
    /// Present when the provider rotated the refresh token (public clients).
    pub refresh_token: Option<String>,
}

/// What the provider vouches for about an app password or API key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Introspection {
    pub sub: String,
    pub username: String,
    pub role: String,
    pub scopes: Vec<String>,
    /// The credential's id (`apw_…`, `key_…`), which `credential.revoked` names.
    pub id: Option<String>,
}

/// One verified provider event. Known types: `session.ended`,
/// `access.changed`, `user.disabled`, `invite.accepted`, `user.deleted`,
/// `credential.revoked`. Others come back with `event_type` and `jti` only,
/// so an app can acknowledge and ignore them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthEvent {
    pub event_type: String,
    pub jti: String,
    pub sub: Option<String>,
    pub sid: Option<String>,
    /// On `access.changed`: `Some(Some(role))` for the new role, `Some(None)`
    /// when access was removed. `None` on every other event.
    pub role: Option<Option<String>>,
    pub id: Option<String>,
    pub invite: Option<String>,
}

#[derive(Debug)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
    introspection_endpoint: Option<String>,
    end_session_endpoint: Option<String>,
}

/// A load every concurrent caller shares, failure included.
type SharedLoad<T> = Shared<BoxFuture<'static, Result<T, AuthError>>>;

/// Runs `load` to its end whoever is still waiting for it, as a promise does.
fn detached<T>(load: impl std::future::Future<Output = Result<T, AuthError>> + Send + 'static) -> SharedLoad<T>
where
    T: Clone + Send + Sync + 'static,
{
    let task = tokio::spawn(load);
    async move { task.await.unwrap_or_else(|_| Err(AuthError::unavailable("auth is unreachable"))) }.boxed().shared()
}

#[derive(Default)]
struct KeyState {
    keys: HashMap<String, VerifyingKey>,
    /// `None` until a key set was fetched once.
    fetched_at: Option<i64>,
    last_attempt: Option<i64>,
    loading: Option<SharedLoad<()>>,
}

struct CacheEntry {
    answer: Introspection,
    at: i64,
    order: u64,
}

/// Introspection answers by the digest of the secret, oldest first.
#[derive(Default)]
struct IntrospectionCache {
    entries: HashMap<String, CacheEntry>,
    oldest_first: BTreeMap<u64, String>,
    next_order: u64,
}

impl IntrospectionCache {
    fn get(&self, key: &str) -> Option<(Introspection, i64)> {
        self.entries.get(key).map(|entry| (entry.answer.clone(), entry.at))
    }

    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.oldest_first.remove(&entry.order);
        }
    }

    fn insert(&mut self, key: String, answer: Introspection, at: i64) {
        self.remove(&key);
        let order = self.next_order;
        self.next_order += 1;
        self.oldest_first.insert(order, key.clone());
        self.entries.insert(key, CacheEntry { answer, at, order });
        if self.entries.len() > CACHE_MAX {
            if let Some((_, oldest)) = self.oldest_first.pop_first() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn forget(&mut self, sub: Option<&str>, id: Option<&str>) {
        let matching: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                sub.is_some_and(|sub| entry.answer.sub == sub)
                    || id.is_some_and(|id| entry.answer.id.as_deref() == Some(id))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in matching {
            self.remove(&key);
        }
    }
}

struct Inner {
    issuer: String,
    issuer_base: String,
    back_base: Option<String>,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
    audience: String,
    transport: Arc<dyn Transport>,
    now: Clock,
    discovery: Mutex<Option<(u64, SharedLoad<Arc<Discovery>>)>>,
    load_ids: AtomicU64,
    keys: Mutex<KeyState>,
    cache: Mutex<IntrospectionCache>,
}

/// The provider client. Cheap to clone; every clone shares the discovery
/// document, the key set and the introspection cache.
#[derive(Clone)]
pub struct AuthClient {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for AuthClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthClient")
            .field("issuer", &self.inner.issuer)
            .field("client_id", &self.inner.client_id)
            .finish_non_exhaustive()
    }
}

struct Answer {
    status: u16,
    body: Option<Vec<u8>>,
}

impl Answer {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body as a JSON object; anything else is the provider misbehaving.
    fn json(&self) -> Result<Map<String, Value>, AuthError> {
        let malformed = || AuthError::unavailable(format!("auth answered {} with a malformed body", self.status));
        let bytes = self.body.as_deref().ok_or_else(malformed)?;
        let text = String::from_utf8_lossy(bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(object)) => Ok(object),
            _ => Err(malformed()),
        }
    }
}

impl Inner {
    fn now(&self) -> i64 {
        (self.now)()
    }

    fn via_back_channel(&self, endpoint: &str) -> String {
        if let Some(back_base) = &self.back_base {
            let under_issuer = endpoint == self.issuer_base
                || endpoint.strip_prefix(&self.issuer_base).is_some_and(|rest| rest.starts_with('/'));
            if under_issuer {
                return format!("{back_base}{}", &endpoint[self.issuer_base.len()..]);
            }
        }
        endpoint.to_string()
    }

    async fn call(&self, request: ProviderRequest) -> Result<Answer, AuthError> {
        let response = self.transport.send(request).await.map_err(|_| AuthError::unavailable("auth is unreachable"))?;
        if response.status >= 500 {
            return Err(AuthError::unavailable(format!("auth answered {}", response.status)));
        }
        Ok(Answer { status: response.status, body: response.body })
    }

    async fn get(&self, endpoint: &str) -> Result<Answer, AuthError> {
        self.call(ProviderRequest {
            method: "GET",
            url: self.via_back_channel(endpoint),
            headers: vec![("Accept", "application/json".to_string())],
            body: None,
        })
        .await
    }

    async fn post(
        &self,
        endpoint: &str,
        params: &[(&str, &str)],
        extra: Vec<(&'static str, String)>,
    ) -> Result<Answer, AuthError> {
        let mut headers = vec![
            ("Content-Type", "application/x-www-form-urlencoded".to_string()),
            ("Accept", "application/json".to_string()),
        ];
        headers.extend(extra);
        let body = {
            let mut body = url::form_urlencoded::Serializer::new(String::new());
            for (name, value) in params {
                body.append_pair(name, value);
            }
            match &self.client_secret {
                None => {
                    body.append_pair("client_id", &self.client_id);
                }
                Some(secret) => {
                    // RFC 6749 §2.3.1: each part is form-encoded before Basic encoding.
                    let pair = format!("{}:{}", form_encode(&self.client_id), form_encode(secret));
                    headers.push(("Authorization", format!("Basic {}", STANDARD.encode(pair))));
                }
            }
            body.finish()
        };
        self.call(ProviderRequest { method: "POST", url: self.via_back_channel(endpoint), headers, body: Some(body) })
            .await
    }

    async fn fetch_discovery(&self) -> Result<Discovery, AuthError> {
        let url = format!("{}/.well-known/openid-configuration", self.issuer_base);
        let answer = self.get(&url).await?;
        if !answer.ok() {
            return Err(AuthError::unavailable(format!("discovery answered {}", answer.status)));
        }
        let doc = answer.json()?;
        // OIDC Discovery §4.3: a document naming another issuer is refused.
        if doc.get("issuer").and_then(Value::as_str) != Some(self.issuer.as_str()) {
            return Err(AuthError::other("the discovery document names a different issuer"));
        }
        let required = |field: &str| {
            doc.get(field)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| AuthError::other(format!("the discovery document has no {field}")))
        };
        let optional = |field: &str| {
            doc.get(field).and_then(Value::as_str).filter(|endpoint| !endpoint.is_empty()).map(str::to_string)
        };
        Ok(Discovery {
            authorization_endpoint: required("authorization_endpoint")?,
            token_endpoint: required("token_endpoint")?,
            jwks_uri: required("jwks_uri")?,
            revocation_endpoint: optional("revocation_endpoint"),
            introspection_endpoint: optional("introspection_endpoint"),
            end_session_endpoint: optional("end_session_endpoint"),
        })
    }

    fn forget_discovery(&self, id: u64) {
        let mut slot = self.discovery.lock_unpoisoned();
        if slot.as_ref().is_some_and(|(current, _)| *current == id) {
            *slot = None;
        }
    }

    /// The discovery document: fetched on first use, kept once it was
    /// accepted, and asked for again after a failure.
    async fn discover(self: &Arc<Self>) -> Result<Arc<Discovery>, AuthError> {
        let (id, load) = {
            let mut slot = self.discovery.lock_unpoisoned();
            match slot.as_ref() {
                Some((id, load)) => (*id, load.clone()),
                None => {
                    let id = self.load_ids.fetch_add(1, Ordering::Relaxed);
                    let inner = Arc::clone(self);
                    let load = detached(async move {
                        let result = inner.fetch_discovery().await.map(Arc::new);
                        if result.is_err() {
                            inner.forget_discovery(id);
                        }
                        result
                    });
                    *slot = Some((id, load.clone()));
                    (id, load)
                }
            }
        };
        let result = load.await;
        if result.is_err() {
            self.forget_discovery(id);
        }
        result
    }

    async fn token_request(self: &Arc<Self>, params: &[(&str, &str)]) -> Result<Map<String, Value>, AuthError> {
        let discovery = self.discover().await?;
        let answer = self.post(&discovery.token_endpoint, params, Vec::new()).await?;
        let body = answer.json()?;
        if answer.ok() {
            return Ok(body);
        }
        if body.get("error").and_then(Value::as_str) == Some("invalid_grant") {
            return Err(AuthError::InvalidGrant("the provider refused the grant".into()));
        }
        if answer.status == 429 {
            return Err(AuthError::unavailable("the token endpoint is rate limiting this client"));
        }
        Err(AuthError::other(format!("the token endpoint refused the request ({})", error_code(&body, answer.status))))
    }

    async fn fetch_keys(self: &Arc<Self>) -> Result<(), AuthError> {
        let discovery = self.discover().await?;
        let answer = self.get(&discovery.jwks_uri).await?;
        if !answer.ok() {
            return Err(AuthError::unavailable(format!("the key set answered {}", answer.status)));
        }
        let doc = answer.json()?;
        let mut next = HashMap::new();
        if let Some(Value::Array(keys)) = doc.get("keys") {
            for jwk in keys {
                if let Some((kid, key)) = import_key(jwk) {
                    next.insert(kid, key);
                }
            }
        }
        let now = self.now();
        let mut state = self.keys.lock_unpoisoned();
        state.keys = next;
        state.fetched_at = Some(now);
        Ok(())
    }

    /// Fetches the key set, at most once at a time and once every thirty
    /// seconds: without that floor, tokens with made-up key ids could make
    /// every request fetch.
    async fn load_keys(self: &Arc<Self>) -> Result<(), AuthError> {
        let load = {
            let mut state = self.keys.lock_unpoisoned();
            if let Some(loading) = &state.loading {
                loading.clone()
            } else {
                let now = self.now();
                if state.last_attempt.is_some_and(|at| now - at < JWKS_MIN_INTERVAL_MS) {
                    return Ok(());
                }
                state.last_attempt = Some(now);
                let inner = Arc::clone(self);
                let load = detached(async move {
                    let result = inner.fetch_keys().await;
                    inner.keys.lock_unpoisoned().loading = None;
                    result
                });
                state.loading = Some(load.clone());
                load
            }
        };
        load.await
    }

    async fn key_for(self: &Arc<Self>, kid: &str) -> Result<VerifyingKey, AuthError> {
        let needs_load = {
            let state = self.keys.lock_unpoisoned();
            let expired = state.fetched_at.is_none_or(|at| self.now() - at >= JWKS_TTL_MS);
            expired || !state.keys.contains_key(kid)
        };
        if needs_load {
            match self.load_keys().await {
                // Keep verifying with the keys we have while auth is unreachable.
                Ok(()) | Err(AuthError::Unavailable(_)) => {}
                Err(error) => return Err(error),
            }
            if self.keys.lock_unpoisoned().fetched_at.is_none() {
                return Err(AuthError::unavailable("auth's signing keys are unavailable"));
            }
        }
        self.keys
            .lock_unpoisoned()
            .keys
            .get(kid)
            .copied()
            .ok_or_else(|| AuthError::invalid_token("signed with an unknown key"))
    }

    async fn verify_jwt(
        self: &Arc<Self>,
        token: &str,
        typ: &str,
        aud: &str,
        check_exp: bool,
    ) -> Result<Map<String, Value>, AuthError> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 || !parts.iter().all(|part| is_b64url(part)) {
            return Err(AuthError::invalid_token("not a JWT"));
        }
        let (h, p, s) = (parts[0], parts[1], parts[2]);
        let header = parse_segment(h)?;
        let payload = parse_segment(p)?;
        // The algorithm is pinned: the header can only confirm it, never choose it.
        if header.get("alg").and_then(Value::as_str) != Some("EdDSA") {
            return Err(AuthError::invalid_token("unexpected alg"));
        }
        if header.get("typ").and_then(Value::as_str).map(str::to_lowercase).as_deref() != Some(typ) {
            return Err(AuthError::invalid_token("unexpected typ"));
        }
        if header.contains_key("crit") {
            return Err(AuthError::invalid_token("unsupported critical header"));
        }
        let Some(kid) = header.get("kid").and_then(Value::as_str) else {
            return Err(AuthError::invalid_token("no kid"));
        };
        let key = self.key_for(kid).await?;
        let signature = b64url_decode(s);
        let verified = <[u8; 64]>::try_from(signature.as_slice())
            .map(|bytes| Signature::from_bytes(&bytes))
            .is_ok_and(|signature| key.verify(format!("{h}.{p}").as_bytes(), &signature).is_ok());
        if !verified {
            return Err(AuthError::invalid_token("bad signature"));
        }
        if payload.get("iss").and_then(Value::as_str) != Some(self.issuer.as_str()) {
            return Err(AuthError::invalid_token("wrong issuer"));
        }
        let aud_ok = match payload.get("aud") {
            Some(Value::String(only)) => only == aud,
            Some(Value::Array(list)) => list.iter().any(|entry| entry.as_str() == Some(aud)),
            _ => false,
        };
        if !aud_ok {
            return Err(AuthError::invalid_token("wrong audience"));
        }
        let t = self.now() as f64 / 1000.0;
        match payload.get("iat").and_then(Value::as_f64) {
            Some(iat) if iat <= t + LEEWAY_S => {}
            _ => return Err(AuthError::invalid_token("issued in the future")),
        }
        if check_exp {
            match payload.get("exp").and_then(Value::as_f64) {
                Some(exp) if t <= exp + LEEWAY_S => {}
                _ => return Err(AuthError::invalid_token("expired")),
            }
        }
        Ok(payload)
    }

    async fn verify_access_token(self: &Arc<Self>, jwt: &str) -> Result<AccessClaims, AuthError> {
        let claims = self.verify_jwt(jwt, "at+jwt", &self.audience, true).await?;
        let claim = |name: &str| {
            claims
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| AuthError::invalid_token(format!("no {name} claim")))
        };
        Ok(AccessClaims {
            sub: claim("sub")?,
            sid: claim("sid")?,
            username: claim("username")?,
            name: claim("name")?,
            role: claim("role")?,
            all: claims,
        })
    }

    fn forget(&self, sub: Option<&str>, id: Option<&str>) {
        if sub.is_none() && id.is_none() {
            return;
        }
        self.cache.lock_unpoisoned().forget(sub, id);
    }
}

impl AuthClient {
    /// Builds the client. Contacts nothing: the provider's discovery document
    /// is fetched on first use. An `Err` names what is wrong with `options`.
    pub fn new(options: AuthClientOptions) -> Result<AuthClient, AuthError> {
        check_options(&options)?;
        let AuthClientOptions {
            issuer,
            back_channel_url,
            client_id,
            client_secret,
            redirect_uri,
            audience,
            transport,
            now,
        } = options;
        Ok(AuthClient {
            inner: Arc::new(Inner {
                issuer_base: issuer.trim_end_matches('/').to_string(),
                issuer,
                back_base: back_channel_url.map(|url| url.trim_end_matches('/').to_string()),
                audience: audience.unwrap_or_else(|| client_id.clone()),
                client_id,
                client_secret,
                redirect_uri,
                transport: transport.unwrap_or_else(|| Arc::new(HttpTransport::new())),
                now: now.unwrap_or_else(|| Arc::new(js::now_ms)),
                discovery: Mutex::new(None),
                load_ids: AtomicU64::new(0),
                keys: Mutex::new(KeyState::default()),
                cache: Mutex::new(IntrospectionCache::default()),
            }),
        })
    }

    /// Starts a sign-in: the provider URL to send the browser to, and the
    /// login cookie that carries the sign-in to [`AuthClient::finish_login`].
    pub async fn start_login(&self, options: &StartLoginOptions) -> Result<StartedLogin, AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let state = random();
        let nonce = random();
        let verifier = random();
        let mut url = Url::parse(&discovery.authorization_endpoint)
            .map_err(|_| AuthError::other("the authorization endpoint is not a URL"))?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut params: Vec<(&str, String)> = vec![
            ("response_type", "code".to_string()),
            ("client_id", inner.client_id.clone()),
            ("redirect_uri", inner.redirect_uri.clone()),
            ("scope", "openid profile email".to_string()),
            ("state", state.clone()),
            ("nonce", nonce.clone()),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".to_string()),
        ];
        if let Some(prompt) = options.prompt {
            let value = match prompt {
                Prompt::None => "none",
                Prompt::Login => "login",
            };
            params.push(("prompt", value.to_string()));
        }
        if let Some(max_age) = options.max_age {
            if !(0..=MAX_SAFE_INTEGER).contains(&max_age) {
                return Err(AuthError::other("maxAge must be a whole number of seconds"));
            }
            params.push(("max_age", max_age.to_string()));
        }
        if let Some(login_hint) = &options.login_hint {
            params.push(("login_hint", login_hint.clone()));
        }
        set_query_params(&mut url, &params);

        let return_to = options.return_to.as_deref().filter(|path| is_local_path(path)).unwrap_or("/");
        // What was asked of the sign-in travels with the cookie: the browser
        // carries the request and can drop max_age or prompt from it, so the
        // ID token's auth_time is checked against them at the callback.
        let mut login = Map::new();
        login.insert("state".into(), Value::from(state));
        login.insert("nonce".into(), Value::from(nonce));
        login.insert("verifier".into(), Value::from(verifier));
        login.insert("returnTo".into(), Value::from(return_to));
        login.insert("iat".into(), Value::from(inner.now().div_euclid(1000)));
        if let Some(max_age) = options.max_age {
            login.insert("maxAge".into(), Value::from(max_age));
        }
        login.insert("fresh".into(), Value::from(options.prompt == Some(Prompt::Login)));
        let value = URL_SAFE_NO_PAD.encode(Value::Object(login).to_string());
        Ok(StartedLogin {
            redirect_url: url.into(),
            login_cookie: format!("{LOGIN_COOKIE}={value}; {COOKIE_ATTRIBUTES}; Max-Age={LOGIN_TTL_S}"),
        })
    }

    /// Completes a sign-in at the callback. `request_url` is the URL the
    /// provider sent the browser back to, absolute or just path and query;
    /// `cookie_header` is the request's `Cookie` header.
    pub async fn finish_login(&self, request_url: &str, cookie_header: Option<&str>) -> Result<Login, AuthError> {
        let inner = &self.inner;
        let saved = match read_cookie(cookie_header, LOGIN_COOKIE) {
            Some(raw) if is_b64url(raw) => parse_segment(raw)?,
            _ => Map::new(),
        };
        let text = |field: &str| saved.get(field).and_then(Value::as_str);
        let (Some(state), Some(nonce), Some(verifier), Some(iat)) =
            (text("state"), text("nonce"), text("verifier"), saved.get("iat").and_then(Value::as_f64))
        else {
            return Err(AuthError::login(LoginErrorCode::NoLoginCookie));
        };
        let max_age = saved.get("maxAge").and_then(Value::as_f64);
        let fresh = saved.get("fresh") == Some(&Value::Bool(true));

        let t = inner.now() as f64 / 1000.0;
        if t - iat > LOGIN_TTL_S as f64 || iat > t + LEEWAY_S {
            return Err(AuthError::login(LoginErrorCode::LoginExpired));
        }
        let query = query_of(request_url);
        let param = |name: &str| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        };
        if let Some(error) = param("error") {
            return Err(AuthError::Login {
                code: LoginErrorCode::AuthorizationError,
                error: Some(js::utf16_truncate(&error, 64)),
            });
        }
        if !same_digest(&param("state").unwrap_or_default(), state) {
            return Err(AuthError::login(LoginErrorCode::StateMismatch));
        }
        let Some(code) = param("code").filter(|code| !code.is_empty()) else {
            return Err(AuthError::login(LoginErrorCode::MissingCode));
        };
        let answer = inner
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &inner.redirect_uri),
                ("code_verifier", verifier),
            ])
            .await?;
        let (Some(access_token), Some(id_token)) =
            (answer.get("access_token").and_then(Value::as_str), answer.get("id_token").and_then(Value::as_str))
        else {
            return Err(AuthError::unavailable("the token endpoint answered without an access token or ID token"));
        };
        let claims = inner.verify_access_token(access_token).await?;
        let id_claims = inner.verify_jwt(id_token, "jwt", &inner.client_id, true).await?;
        let several_audiences = matches!(id_claims.get("aud"), Some(Value::Array(list)) if list.len() > 1);
        if several_audiences && id_claims.get("azp").and_then(Value::as_str) != Some(inner.client_id.as_str()) {
            return Err(AuthError::invalid_token("wrong authorized party"));
        }
        let id_nonce = match id_claims.get("nonce").and_then(Value::as_str) {
            Some(id_nonce) if same_digest(id_nonce, nonce) => id_nonce.to_string(),
            _ => return Err(AuthError::invalid_token("nonce mismatch")),
        };
        if id_claims.get("sub").and_then(Value::as_str) != Some(claims.sub.as_str()) {
            return Err(AuthError::invalid_token("the ID token names another subject"));
        }
        // OIDC Core §3.1.3.7: with max_age or prompt=login, the sign-in must be
        // as recent as asked, whatever the authorization request ended up as.
        if max_age.is_some() || fresh {
            let Some(auth_time) = id_claims.get("auth_time").and_then(Value::as_f64) else {
                return Err(AuthError::invalid_token("no auth_time"));
            };
            if max_age.is_some_and(|max_age| t - auth_time > max_age + LEEWAY_S) {
                return Err(AuthError::invalid_token("the sign-in is older than max_age"));
            }
            if fresh && auth_time < iat - LEEWAY_S {
                return Err(AuthError::invalid_token("the sign-in is older than the login request"));
            }
        }
        let return_to = text("returnTo").filter(|path| is_local_path(path)).unwrap_or("/");
        Ok(Login {
            id_claims: IdClaims { sub: claims.sub.clone(), nonce: id_nonce, all: id_claims },
            claims,
            access_token: access_token.to_string(),
            refresh_token: answer.get("refresh_token").and_then(Value::as_str).map(str::to_string),
            return_to: return_to.to_string(),
            clear_cookie: format!("{LOGIN_COOKIE}=; {COOKIE_ATTRIBUTES}; Max-Age=0"),
        })
    }

    /// Exchanges a refresh token for a new access token. `InvalidGrant` means
    /// the provider no longer accepts the session.
    pub async fn refresh(&self, refresh_token: &str) -> Result<Refreshed, AuthError> {
        let inner = &self.inner;
        let answer = inner.token_request(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)]).await?;
        let Some(access_token) = answer.get("access_token").and_then(Value::as_str) else {
            return Err(AuthError::unavailable("the token endpoint answered without an access token"));
        };
        let claims = inner.verify_access_token(access_token).await?;
        Ok(Refreshed {
            claims,
            access_token: access_token.to_string(),
            refresh_token: answer.get("refresh_token").and_then(Value::as_str).map(str::to_string),
        })
    }

    pub async fn verify_access_token(&self, jwt: &str) -> Result<AccessClaims, AuthError> {
        self.inner.verify_access_token(jwt).await
    }

    /// Asks the provider about an app password or API key. `None` when the
    /// provider does not vouch for it, or is rate limiting the question.
    /// An answer is served from memory for a minute, and for ten while the
    /// provider cannot be reached. `ip` is the address of whoever presented
    /// the secret, for the provider's own limits.
    pub async fn introspect(&self, secret: &str, ip: Option<&str>) -> Result<Option<Introspection>, AuthError> {
        let inner = &self.inner;
        if inner.client_secret.is_none() {
            return Err(AuthError::other("introspection needs a confidential client"));
        }
        if ip.is_some_and(|ip| !is_ip(ip)) {
            return Err(AuthError::other("ip must be an IP address"));
        }
        // Keyed by digest, so the cache never holds a usable secret.
        let key = hex::encode(Sha256::digest(secret.as_bytes()));
        let hit = inner.cache.lock_unpoisoned().get(&key);
        if let Some((answer, at)) = &hit {
            if inner.now() - at < FRESH_MS {
                return Ok(Some(answer.clone()));
            }
        }
        let asked: Result<(Answer, Option<Map<String, Value>>), AuthError> = async {
            let discovery = inner.discover().await?;
            let Some(endpoint) = &discovery.introspection_endpoint else {
                return Err(AuthError::other("the provider has no introspection endpoint"));
            };
            let extra = match ip.filter(|ip| !ip.is_empty()) {
                Some(ip) => vec![("X-Real-IP", ip.to_string())],
                None => Vec::new(),
            };
            let answer = inner.post(endpoint, &[("token", secret)], extra).await?;
            let body = if answer.status == 429 { None } else { Some(answer.json()?) };
            Ok((answer, body))
        }
        .await;
        let (answer, body) = match asked {
            Ok(asked) => asked,
            Err(error) => {
                if let (true, Some((stale, at))) = (error.is_unavailable(), &hit) {
                    if inner.now() - at < STALE_MS {
                        return Ok(Some(stale.clone()));
                    }
                }
                return Err(error);
            }
        };
        if answer.status == 429 {
            return Ok(None);
        }
        let body = body.unwrap_or_default();
        if !answer.ok() {
            return Err(AuthError::other(format!(
                "introspection refused the request ({})",
                error_code(&body, answer.status)
            )));
        }
        if body.get("active") != Some(&Value::Bool(true)) {
            inner.cache.lock_unpoisoned().remove(&key);
            return Ok(None);
        }
        let text = |field: &str| body.get(field).and_then(Value::as_str).map(str::to_string);
        let (Some(sub), Some(username), Some(role)) = (text("sub"), text("username"), text("role")) else {
            return Err(AuthError::unavailable("introspection answered without sub, username or role"));
        };
        let result = Introspection {
            sub,
            username,
            role,
            scopes: body
                .get("scope")
                .and_then(Value::as_str)
                .map(|scope| scope.split(' ').filter(|s| !s.is_empty()).map(str::to_string).collect())
                .unwrap_or_default(),
            id: text("jti"),
        };
        inner.cache.lock_unpoisoned().insert(key, result.clone(), inner.now());
        Ok(Some(result))
    }

    /// Drops remembered introspection answers for a person (`sub`) or one
    /// credential (`id`), so the next check asks the provider.
    pub fn forget(&self, sub: Option<&str>, id: Option<&str>) {
        self.inner.forget(sub, id);
    }

    /// Revokes a refresh token at the provider.
    pub async fn revoke(&self, refresh_token: &str) -> Result<(), AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let Some(endpoint) = &discovery.revocation_endpoint else {
            return Err(AuthError::other("the provider has no revocation endpoint"));
        };
        let answer =
            inner.post(endpoint, &[("token", refresh_token), ("token_type_hint", "refresh_token")], Vec::new()).await?;
        if !answer.ok() {
            return Err(AuthError::other(format!("revocation refused the request ({})", answer.status)));
        }
        Ok(())
    }

    /// Verifies a security event token and returns the event it carries.
    /// `InvalidToken` for anything that is not a verified, well-formed event;
    /// `Unavailable` when the provider's keys cannot be had.
    pub async fn read_event(&self, body: &str) -> Result<AuthEvent, AuthError> {
        let inner = &self.inner;
        let set = inner.verify_jwt(js_trim(body), "secevent+jwt", &inner.audience, false).await?;
        let jti = match set.get("jti").and_then(Value::as_str) {
            Some(jti) if !jti.is_empty() => jti.to_string(),
            _ => return Err(AuthError::invalid_token("no jti")),
        };
        let events = set.get("events").and_then(Value::as_object);
        let (event_type, payload) = match events.map(|events| events.iter().collect::<Vec<_>>()).as_deref() {
            Some([(event_type, payload)]) => (event_type.to_string(), *payload),
            _ => return Err(AuthError::invalid_token("a SET carries exactly one event")),
        };
        let Some(payload) = payload.as_object() else {
            return Err(AuthError::invalid_token("malformed event payload"));
        };
        let mut event = AuthEvent { event_type: event_type.clone(), jti, ..Default::default() };
        let Some(required) = event_fields(&event_type)? else {
            return Ok(event);
        };
        for field in required {
            let Some(value) = payload.get(*field).and_then(Value::as_str) else {
                return Err(AuthError::invalid_token(format!("{event_type} without {field}")));
            };
            let slot = match *field {
                "sub" => &mut event.sub,
                "sid" => &mut event.sid,
                "id" => &mut event.id,
                _ => &mut event.invite,
            };
            *slot = Some(value.to_string());
        }
        if event_type == "access.changed" {
            event.role = Some(match payload.get("role") {
                Some(Value::Null) => None,
                Some(Value::String(role)) => Some(role.clone()),
                _ => return Err(AuthError::invalid_token("access.changed without role")),
            });
        }
        match event_type.as_str() {
            "credential.revoked" => inner.forget(None, event.id.as_deref()),
            "access.changed" | "user.disabled" | "user.deleted" => inner.forget(event.sub.as_deref(), None),
            _ => {}
        }
        Ok(event)
    }

    /// Where to send the browser to end the provider's session too.
    pub async fn logout_url(&self, post_logout_redirect: Option<&str>) -> Result<String, AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let Some(endpoint) = &discovery.end_session_endpoint else {
            return Err(AuthError::other("the provider has no end_session_endpoint"));
        };
        let mut url = Url::parse(endpoint).map_err(|_| AuthError::other("the end-session endpoint is not a URL"))?;
        let mut params = vec![("client_id", inner.client_id.clone())];
        if let Some(redirect) = post_logout_redirect {
            params.push(("post_logout_redirect_uri", redirect.to_string()));
        }
        set_query_params(&mut url, &params);
        Ok(url.into())
    }
}

/// Names `Object.prototype` gives every JavaScript object. The Bun server
/// looks an event type up in a plain object, so these names find something
/// that is not a list of fields and the event fails as a server fault rather
/// than being acknowledged as unknown.
const OBJECT_PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// The fields a known event type must carry; `None` for an unknown type.
fn event_fields(event_type: &str) -> Result<Option<&'static [&'static str]>, AuthError> {
    Ok(Some(match event_type {
        "session.ended" => &["sid"],
        "access.changed" => &["sub"],
        "user.disabled" => &["sub"],
        "invite.accepted" => &["invite", "sub"],
        "user.deleted" => &["sub"],
        "credential.revoked" => &["sub", "id"],
        name if OBJECT_PROTOTYPE_NAMES.contains(&name) => {
            return Err(AuthError::other(format!("{name} is not an event type that can be read")));
        }
        _ => return Ok(None),
    }))
}

fn check_options(options: &AuthClientOptions) -> Result<(), AuthError> {
    let issuer = parse_url(&options.issuer, "issuer")?;
    let has_query_or_fragment = |url: &Url| {
        url.query().is_some_and(|query| !query.is_empty()) || url.fragment().is_some_and(|hash| !hash.is_empty())
    };
    let loopback = issuer.host_str().is_some_and(|host| LOOPBACK.contains(&host));
    if !(issuer.scheme() == "https" || (issuer.scheme() == "http" && loopback)) {
        return Err(AuthError::other("issuer must be an https URL (http only for localhost)"));
    }
    if has_query_or_fragment(&issuer) {
        return Err(AuthError::other("issuer must have no query or fragment"));
    }
    if let Some(back_channel_url) = &options.back_channel_url {
        let back = parse_url(back_channel_url, "backChannelUrl")?;
        if back.scheme() != "https" && back.scheme() != "http" {
            return Err(AuthError::other("backChannelUrl must be an http or https URL"));
        }
        if has_query_or_fragment(&back) {
            return Err(AuthError::other("backChannelUrl must have no query or fragment"));
        }
    }
    if options.client_id.is_empty() {
        return Err(AuthError::other("clientId is required"));
    }
    parse_url(&options.redirect_uri, "redirectUri")?;
    if options.client_secret.as_deref() == Some("") {
        return Err(AuthError::other("clientSecret must be a non-empty string when set"));
    }
    if options.audience.as_deref() == Some("") {
        return Err(AuthError::other("audience must be a non-empty string when set"));
    }
    Ok(())
}

fn parse_url(value: &str, name: &str) -> Result<Url, AuthError> {
    if value.is_empty() {
        return Err(AuthError::other(format!("{name} is required")));
    }
    Url::parse(value).map_err(|_| AuthError::other(format!("{name} must be an absolute URL")))
}

/// `url.searchParams.set(name, value)` for each parameter: the first existing
/// value is replaced and later ones dropped, a new name is appended, and the
/// whole query is written back form-encoded.
fn set_query_params(url: &mut Url, params: &[(&str, String)]) {
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    for (name, value) in params {
        match pairs.iter().position(|(existing, _)| existing == name) {
            Some(first) => {
                pairs[first].1 = value.clone();
                let mut index = 0;
                pairs.retain(|(existing, _)| {
                    index += 1;
                    index - 1 == first || existing != name
                });
            }
            None => pairs.push((name.to_string(), value.clone())),
        }
    }
    url.query_pairs_mut().clear().extend_pairs(&pairs);
}

fn import_key(jwk: &Value) -> Option<(String, VerifyingKey)> {
    let jwk = jwk.as_object()?;
    if jwk.get("kty").and_then(Value::as_str) != Some("OKP")
        || jwk.get("crv").and_then(Value::as_str) != Some("Ed25519")
    {
        return None;
    }
    let x = jwk.get("x")?.as_str()?;
    let kid = jwk.get("kid")?.as_str()?;
    let absent_or = |field: &str, expected: &str| match jwk.get(field) {
        None => true,
        Some(value) => value.as_str() == Some(expected),
    };
    if !absent_or("use", "sig") || !absent_or("alg", "EdDSA") {
        return None;
    }
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(x.trim_end_matches('=')).ok()?.try_into().ok()?;
    Some((kid.to_string(), VerifyingKey::from_bytes(&bytes).ok()?))
}

/// `/^[A-Za-z0-9_-]+$/`
fn is_b64url(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Decodes base64url the way `Buffer.from(value, "base64url")` does for text
/// in that alphabet: leftover bits are dropped rather than refused.
fn b64url_decode(value: &str) -> Vec<u8> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let usable = if value.len() % 4 == 1 { &value[..value.len() - 1] } else { value };
    LENIENT.decode(usable).unwrap_or_default()
}

/// A base64url segment holding a JSON object: a token's header or payload,
/// or the login cookie.
fn parse_segment(segment: &str) -> Result<Map<String, Value>, AuthError> {
    let bytes = b64url_decode(segment);
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(AuthError::invalid_token("malformed segment")),
    }
}

/// The value of the first cookie called `name`, as sent: not unquoted, not decoded.
fn read_cookie<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    header?.split(';').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (!key.is_empty() && js_trim(key) == name).then(|| js_trim(value))
    })
}

/// The query string of a URL, absolute or not, without its `?` and fragment.
fn query_of(request_url: &str) -> &str {
    let without_fragment = request_url.split('#').next().unwrap_or("");
    without_fragment.split_once('?').map_or("", |(_, query)| query)
}

/// A path on the app's own origin. URL parsers drop tabs and newlines and read
/// a backslash as a slash, so "/\t/evil.example" would lead off-site: any
/// control character, space or backslash is refused, and the path must still
/// resolve to the same origin.
fn is_local_path(path: &str) -> bool {
    if js::utf16_len(path) > 2048 || !path.starts_with('/') || path.starts_with("//") {
        return false;
    }
    if path.chars().any(|c| c <= '\u{20}' || c == '\u{7f}' || c == '\\') {
        return false;
    }
    static BASE: OnceLock<Url> = OnceLock::new();
    let base = BASE.get_or_init(|| Url::parse("https://app.invalid").expect("a valid URL"));
    base.join(path).is_ok_and(|resolved| resolved.origin().ascii_serialization() == "https://app.invalid")
}

fn same_digest(a: &str, b: &str) -> bool {
    Sha256::digest(a.as_bytes()).ct_eq(&Sha256::digest(b.as_bytes())).into()
}

/// 32 random bytes, base64url.
fn random() -> String {
    let bytes: [u8; 32] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `encodeURIComponent(s).replace(/%20/g, "+")`
fn form_encode(value: &str) -> String {
    js::encode_uri_component(value).replace("%20", "+")
}

/// The provider's `error` code when it is one, otherwise the status.
fn error_code(answer: &Map<String, Value>, status: u16) -> String {
    match answer.get("error").and_then(Value::as_str) {
        Some(error)
            if (1..=64).contains(&error.len())
                && error.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) =>
        {
            error.to_string()
        }
        _ => status.to_string(),
    }
}

/// `net.isIP(value) !== 0`
pub(crate) fn is_ip(value: &str) -> bool {
    if value.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    let (address, zone) = match value.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (value, None),
    };
    let zone_ok = zone
        .is_none_or(|zone| !zone.is_empty() && zone.bytes().all(|b| b.is_ascii_alphanumeric() || b"-.:".contains(&b)));
    zone_ok && address.parse::<Ipv6Addr>().is_ok()
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `value.trim()`: JavaScript's idea of white space, which is not Unicode's.
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> AuthClientOptions {
        AuthClientOptions {
            issuer: "https://auth.example.test".into(),
            client_id: "mail".into(),
            client_secret: Some("test_key_not_real_do_not_use".into()),
            redirect_uri: "https://mail.example.test/api/auth/callback".into(),
            ..Default::default()
        }
    }

    fn refusal(change: impl FnOnce(&mut AuthClientOptions)) -> String {
        let mut options = options();
        change(&mut options);
        match AuthClient::new(options) {
            Ok(_) => panic!("expected the options to be refused"),
            Err(error) => {
                assert!(matches!(error, AuthError::Other(_)));
                error.to_string()
            }
        }
    }

    #[test]
    fn accepts_the_options_it_can_work_with() {
        assert!(AuthClient::new(options()).is_ok());
        for issuer in [
            "http://localhost:3000",
            "http://127.0.0.1:3000/",
            "http://[::1]:3000",
            "https://auth.example.test/realms/mail",
            "https://auth.example.test/?",
            "https://auth.example.test/#",
        ] {
            let mut accepted = options();
            accepted.issuer = issuer.into();
            assert!(AuthClient::new(accepted).is_ok(), "{issuer}");
        }
        let mut public = options();
        public.client_secret = None;
        public.back_channel_url = Some("http://auth.internal:3000/".into());
        public.audience = Some("mailbox".into());
        assert!(AuthClient::new(public).is_ok());
    }

    #[test]
    fn refuses_options_it_cannot_work_with() {
        assert_eq!(refusal(|o| o.issuer = String::new()), "issuer is required");
        assert_eq!(refusal(|o| o.issuer = "auth.example.test".into()), "issuer must be an absolute URL");
        assert_eq!(
            refusal(|o| o.issuer = "http://auth.example.test".into()),
            "issuer must be an https URL (http only for localhost)"
        );
        assert_eq!(
            refusal(|o| o.issuer = "ftp://localhost".into()),
            "issuer must be an https URL (http only for localhost)"
        );
        assert_eq!(
            refusal(|o| o.issuer = "https://auth.example.test/?tenant=1".into()),
            "issuer must have no query or fragment"
        );
        assert_eq!(
            refusal(|o| o.issuer = "https://auth.example.test/#top".into()),
            "issuer must have no query or fragment"
        );
        assert_eq!(refusal(|o| o.back_channel_url = Some(String::new())), "backChannelUrl is required");
        assert_eq!(
            refusal(|o| o.back_channel_url = Some("auth.internal".into())),
            "backChannelUrl must be an absolute URL"
        );
        assert_eq!(
            refusal(|o| o.back_channel_url = Some("ftp://auth.internal".into())),
            "backChannelUrl must be an http or https URL"
        );
        assert_eq!(
            refusal(|o| o.back_channel_url = Some("http://auth.internal/?x=1".into())),
            "backChannelUrl must have no query or fragment"
        );
        assert_eq!(refusal(|o| o.client_id = String::new()), "clientId is required");
        assert_eq!(refusal(|o| o.redirect_uri = String::new()), "redirectUri is required");
        assert_eq!(refusal(|o| o.redirect_uri = "/api/auth/callback".into()), "redirectUri must be an absolute URL");
        assert_eq!(
            refusal(|o| o.client_secret = Some(String::new())),
            "clientSecret must be a non-empty string when set"
        );
        assert_eq!(refusal(|o| o.audience = Some(String::new())), "audience must be a non-empty string when set");
    }

    #[test]
    fn login_errors_read_as_their_code_and_the_provider_error() {
        assert_eq!(AuthError::login(LoginErrorCode::StateMismatch).to_string(), "state_mismatch");
        let denied = AuthError::Login { code: LoginErrorCode::AuthorizationError, error: Some("access_denied".into()) };
        assert_eq!(denied.to_string(), "authorization_error: access_denied");
        let empty = AuthError::Login { code: LoginErrorCode::AuthorizationError, error: Some(String::new()) };
        assert_eq!(empty.to_string(), "authorization_error");
        assert_eq!(AuthError::unavailable("auth is unreachable").to_string(), "auth is unreachable");
    }

    #[test]
    fn local_paths() {
        for path in ["/", "/mail/42", "/mail/42?view=thread#m3", "/a/b/../c", "/x//y", "/mail/é", "/@user:1"] {
            assert!(is_local_path(path), "{path}");
        }
        assert!(is_local_path(&format!("/{}", "a".repeat(2047))));
        for path in [
            "",
            "mail",
            "//evil.example",
            "///evil.example",
            "/\\evil.example",
            "/mail\\42",
            "\\/evil.example",
            "https://evil.example/",
            "/mail 42",
            "/mail\t42",
            "/mail\n42",
            "/mail\u{0}",
            "/mail\u{7f}",
            " /mail",
            "javascript:alert(1)",
        ] {
            assert!(!is_local_path(path), "{path:?}");
        }
        assert!(!is_local_path(&format!("/{}", "a".repeat(2048))));
        // The limit counts UTF-16 code units, as `string.length` does.
        assert!(is_local_path(&format!("/{}", "é".repeat(2047))));
        assert!(!is_local_path(&format!("/{}", "😀".repeat(1024))));
    }

    #[test]
    fn cookies_are_read_as_sent() {
        let header = "theme=dark;  __Host-login = abc ; other=1; __Host-login=second";
        assert_eq!(read_cookie(Some(header), LOGIN_COOKIE), Some("abc"));
        assert_eq!(read_cookie(Some("__Host-login="), LOGIN_COOKIE), Some(""));
        assert_eq!(read_cookie(Some("__Host-login=\"abc\""), LOGIN_COOKIE), Some("\"abc\""));
        assert_eq!(read_cookie(Some("__Host-login=a=b"), LOGIN_COOKIE), Some("a=b"));
        assert_eq!(read_cookie(Some("x__Host-login=abc"), LOGIN_COOKIE), None);
        assert_eq!(read_cookie(Some("__host-login=abc"), LOGIN_COOKIE), None);
        assert_eq!(read_cookie(Some("__Host-login"), LOGIN_COOKIE), None);
        assert_eq!(read_cookie(Some(""), LOGIN_COOKIE), None);
        assert_eq!(read_cookie(None, LOGIN_COOKIE), None);
    }

    #[test]
    fn query_strings() {
        assert_eq!(query_of("/api/auth/callback?code=c&state=s"), "code=c&state=s");
        assert_eq!(query_of("https://mail.example.test/api/auth/callback?code=c#frag"), "code=c");
        assert_eq!(query_of("/api/auth/callback"), "");
        assert_eq!(query_of("/api/auth/callback?"), "");
        assert_eq!(query_of("/a?b=1?c=2"), "b=1?c=2");
    }

    #[test]
    fn segments_decode_like_buffer_from_base64url() {
        assert_eq!(b64url_decode("QUJD"), b"ABC");
        assert_eq!(b64url_decode("QUI"), b"AB");
        assert_eq!(b64url_decode("QQ"), b"A");
        // Leftover bits and a lone trailing character are dropped, not refused.
        assert_eq!(b64url_decode("QUJDR"), b"ABC");
        assert_eq!(b64url_decode("QR"), b"A");
        assert_eq!(b64url_decode("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(b64url_decode(""), b"");

        let object = URL_SAFE_NO_PAD.encode(r#"{"a":1}"#);
        assert_eq!(parse_segment(&object).unwrap().get("a"), Some(&Value::from(1)));
        for not_an_object in ["[]", "\"text\"", "null", "42", "{ not json", ""] {
            let segment = URL_SAFE_NO_PAD.encode(not_an_object);
            assert_eq!(parse_segment(&segment), Err(AuthError::invalid_token("malformed segment")));
        }
        assert!(is_b64url("abc-_09AZ"));
        for not_b64url in ["", "a.b", "a=", "a b", "a+b", "a/b", "é"] {
            assert!(!is_b64url(not_b64url), "{not_b64url}");
        }
    }

    #[test]
    fn query_parameters_are_set_the_way_search_params_sets_them() {
        let mut url =
            Url::parse("https://auth.example.test/authorize?tenant=a%20b&scope=old&x=1&scope=again#top").unwrap();
        set_query_params(&mut url, &[("scope", "openid profile".into()), ("client_id", "mail app/1+é&=?".into())]);
        assert_eq!(
            url.as_str(),
            "https://auth.example.test/authorize?tenant=a+b&scope=openid+profile&x=1&client_id=mail+app%2F1%2B%C3%A9%26%3D%3F#top"
        );
        let mut bare = Url::parse("https://auth.example.test/logout").unwrap();
        set_query_params(&mut bare, &[("client_id", "mail".into())]);
        assert_eq!(bare.as_str(), "https://auth.example.test/logout?client_id=mail");
    }

    #[test]
    fn credentials_are_form_encoded() {
        assert_eq!(form_encode("a b+c/d:e=f~!*'()&%é"), "a+b%2Bc%2Fd%3Ae%3Df~!*'()%26%25%C3%A9");
    }

    #[test]
    fn error_codes_are_the_providers_only_when_they_look_like_one() {
        let answer = |error: Value| Map::from_iter([("error".to_string(), error)]);
        assert_eq!(error_code(&answer("invalid_client".into()), 401), "invalid_client");
        assert_eq!(error_code(&answer("a.b-c_9".into()), 400), "a.b-c_9");
        assert_eq!(error_code(&answer("has space".into()), 400), "400");
        assert_eq!(error_code(&answer("".into()), 400), "400");
        assert_eq!(error_code(&answer("x".repeat(65).into()), 400), "400");
        assert_eq!(error_code(&answer("x".repeat(64).into()), 400), "x".repeat(64));
        assert_eq!(error_code(&answer(Value::from(7)), 403), "403");
        assert_eq!(error_code(&Map::new(), 404), "404");
    }

    #[test]
    fn ip_addresses() {
        for ip in ["203.0.113.7", "0.0.0.0", "::1", "2001:db8::1", "::ffff:198.51.100.4", "fe80::1%eth0"] {
            assert!(is_ip(ip), "{ip}");
        }
        for not_ip in
            ["", "unknown", "203.0.113", "203.0.113.256", "01.2.3.4", "localhost", "::g", "fe80::1%", "1.2.3.4%eth0"]
        {
            assert!(!is_ip(not_ip), "{not_ip}");
        }
    }

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(js_trim(" \t\r\n\u{a0}\u{feff}\u{2028}token\u{3000}\u{b} "), "token");
        // U+0085 is white space to Unicode and not to JavaScript.
        assert_eq!(js_trim("\u{85}token\u{85}"), "\u{85}token\u{85}");
        assert_eq!(js_trim("   "), "");
    }

    #[test]
    fn only_ed25519_signing_keys_are_imported() {
        let x = URL_SAFE_NO_PAD.encode(ed25519_dalek::SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes());
        let jwk = |change: fn(&mut Map<String, Value>)| {
            let mut jwk = Map::new();
            jwk.insert("kty".into(), "OKP".into());
            jwk.insert("crv".into(), "Ed25519".into());
            jwk.insert("x".into(), x.clone().into());
            jwk.insert("kid".into(), "k1".into());
            change(&mut jwk);
            import_key(&Value::Object(jwk))
        };
        assert_eq!(jwk(|_| {}).map(|(kid, _)| kid), Some("k1".to_string()));
        assert!(jwk(|jwk| {
            jwk.insert("use".into(), "sig".into());
            jwk.insert("alg".into(), "EdDSA".into());
        })
        .is_some());
        assert!(jwk(|jwk| void(jwk.insert("use".into(), "enc".into()))).is_none());
        assert!(jwk(|jwk| void(jwk.insert("use".into(), Value::Null))).is_none());
        assert!(jwk(|jwk| void(jwk.insert("alg".into(), "ES256".into()))).is_none());
        assert!(jwk(|jwk| void(jwk.insert("kty".into(), "RSA".into()))).is_none());
        assert!(jwk(|jwk| void(jwk.insert("crv".into(), "X25519".into()))).is_none());
        assert!(jwk(|jwk| void(jwk.remove("kid"))).is_none());
        assert!(jwk(|jwk| void(jwk.insert("kid".into(), Value::from(1)))).is_none());
        assert!(jwk(|jwk| void(jwk.remove("x"))).is_none());
        assert!(jwk(|jwk| void(jwk.insert("x".into(), "AAAA".into()))).is_none());
        assert!(import_key(&Value::Null).is_none());
        assert!(import_key(&Value::from("a string")).is_none());
    }

    fn void<T>(_: T) {}

    #[test]
    fn the_introspection_cache_evicts_its_oldest_answer() {
        let answer = |sub: &str, id: &str| Introspection {
            sub: sub.into(),
            username: sub.into(),
            role: "user".into(),
            scopes: vec!["imap".into()],
            id: Some(id.into()),
        };
        let mut cache = IntrospectionCache::default();
        for n in 0..CACHE_MAX {
            cache.insert(format!("key{n}"), answer("usr_a", &format!("apw_{n}")), n as i64);
        }
        // Written again, the first key is the newest; the second is now the oldest.
        cache.insert("key0".into(), answer("usr_a", "apw_0"), 99);
        cache.insert("one-more".into(), answer("usr_b", "apw_b"), 100);
        assert_eq!(cache.entries.len(), CACHE_MAX);
        assert_eq!(cache.get("key0").map(|(_, at)| at), Some(99));
        assert!(cache.get("key1").is_none());
        assert!(cache.get("key2").is_some());

        cache.forget(None, Some("apw_2"));
        assert!(cache.get("key2").is_none());
        cache.forget(Some("usr_a"), None);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.oldest_first.len(), 1);
        assert!(cache.get("one-more").is_some());
    }

    #[test]
    fn event_types_named_like_object_members_are_a_fault_as_they_are_for_bun() {
        assert_eq!(event_fields("session.ended"), Ok(Some(&["sid"][..])));
        assert_eq!(event_fields("something.new"), Ok(None));
        assert!(matches!(event_fields("constructor"), Err(AuthError::Other(_))));
        assert!(matches!(event_fields("__proto__"), Err(AuthError::Other(_))));
    }
}
