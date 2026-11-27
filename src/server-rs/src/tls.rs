//! TLS for the mail listeners: whether this process can serve it, from
//! `SSL_CERTIFICATE` / `SSL_CERTIFICATE_KEY`, and the acceptor every SMTP and
//! IMAP listener and both STARTTLS commands shake hands with.
//!
//! The handshake is the system OpenSSL's, set up to take what the Bun
//! server's BoringSSL takes, as measured listener by listener with
//! `openssl s_client`: TLS 1.2 and 1.3; at TLS 1.2 the AES-GCM, ChaCha20 and
//! AES-CBC suites, with ECDHE or RSA key exchange; X25519, P-256 and P-384;
//! and SHA-1 signatures for a client that offers nothing newer, or no
//! `signature_algorithms` at all. Old mail servers and Windows 7-era clients
//! offer no more than that.
//!
//! The certificate and key are read for every handshake, so a renewed
//! certificate is served without a restart, and parsed again when they have
//! changed.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::task::{Context, Poll};

use anyhow::{bail, Context as _};
use foreign_types::ForeignTypeRef;
use openssl::error::ErrorStack;
use openssl::ex_data::Index;
use openssl::pkey::PKey;
use openssl::sha::Sha256;
use openssl::ssl::{
    self, ClientHelloResponse, ErrorCode, Ssl, SslAlert, SslContext, SslMethod, SslOptions, SslRef,
    NameType, SslSessionCacheMode, SslVersion,
};
use openssl::x509::X509;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::env;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsCredentials {
    /// The pair is unset: a deliberate plaintext deployment.
    Unconfigured,
    /// The pair is set but names files this process cannot read.
    Unreadable { cert: String, key: String },
    Available { cert: String, key: String },
}

fn is_readable(path: &str) -> bool {
    File::open(path).is_ok()
}

pub fn get_tls_credentials() -> TlsCredentials {
    let (Some(cert), Some(key)) = (env::non_empty("SSL_CERTIFICATE"), env::non_empty("SSL_CERTIFICATE_KEY")) else {
        return TlsCredentials::Unconfigured;
    };
    if !is_readable(&cert) || !is_readable(&key) {
        return TlsCredentials::Unreadable { cert, key };
    }
    TlsCredentials::Available { cert, key }
}

pub fn is_tls_available() -> bool {
    matches!(get_tls_credentials(), TlsCredentials::Available { .. })
}

/// A TLS client that accepts any certificate, for probing this server's own
/// listeners over loopback.
pub fn insecure_connector() -> tokio_rustls::TlsConnector {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, SignatureScheme};

    #[derive(Debug)]
    struct AcceptAny(Arc<rustls::crypto::CryptoProvider>);

    impl ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the default protocol versions are valid")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

// ---------------------------------------------------------------------------
// What the handshake accepts
// ---------------------------------------------------------------------------

/// The TLS 1.2 suites Bun accepts, by IANA number, in its order: Node's
/// default list as BoringSSL reads it. The SMTP listeners' own list
/// (`HIGH:!aNULL:…`) comes to the same suites.
const TLS12_SUITES: [(u16, &str); 14] = [
    (0xC02F, "ECDHE-RSA-AES128-GCM-SHA256"),
    (0xC02B, "ECDHE-ECDSA-AES128-GCM-SHA256"),
    (0xC030, "ECDHE-RSA-AES256-GCM-SHA384"),
    (0xC02C, "ECDHE-ECDSA-AES256-GCM-SHA384"),
    (0xCCA9, "ECDHE-ECDSA-CHACHA20-POLY1305"),
    (0xCCA8, "ECDHE-RSA-CHACHA20-POLY1305"),
    (0xC009, "ECDHE-ECDSA-AES128-SHA"),
    (0xC013, "ECDHE-RSA-AES128-SHA"),
    (0xC00A, "ECDHE-ECDSA-AES256-SHA"),
    (0xC014, "ECDHE-RSA-AES256-SHA"),
    (0x009C, "AES128-GCM-SHA256"),
    (0x009D, "AES256-GCM-SHA384"),
    (0x002F, "AES128-SHA"),
    (0x0035, "AES256-SHA"),
];

const TLS13_SUITES: [(u16, &str); 3] =
    [(0x1301, "TLS_AES_128_GCM_SHA256"), (0x1302, "TLS_AES_256_GCM_SHA384"), (0x1303, "TLS_CHACHA20_POLY1305_SHA256")];

/// Key-exchange groups, in Bun's order.
const GROUPS: [(u16, &str); 3] = [(0x001D, "X25519"), (0x0017, "P-256"), (0x0018, "P-384")];

/// What the server signs with, in BoringSSL's order, which it follows
/// whatever order the client lists them in. SHA-1 is last: only for a client
/// that offers nothing else.
const SIGNATURE_ALGORITHMS: &str = "ed25519:ECDSA+SHA256:rsa_pss_rsae_sha256:RSA+SHA256:ECDSA+SHA384:\
    rsa_pss_rsae_sha384:RSA+SHA384:ECDSA+SHA512:rsa_pss_rsae_sha512:RSA+SHA512:ECDSA+SHA1:RSA+SHA1";

/// `SSL_OP_NO_ENCRYPT_THEN_MAC`, which `openssl-sys` does not name. BoringSSL
/// does not do encrypt-then-MAC, so a CBC suite is MAC-then-encrypt on both.
const NO_ENCRYPT_THEN_MAC: SslOptions = SslOptions::from_bits_retain(0x0008_0000);

/// `SSL_R_UNEXPECTED_EOF_WHILE_READING`: the peer closed without a
/// close_notify.
const UNEXPECTED_EOF_WHILE_READING: i32 = 294;

/// The `supported_groups` ClientHello extension.
const SUPPORTED_GROUPS: u32 = 10;

/// Whose order picks the suite and the group of a TLS 1.2 handshake.
///
/// Bun's own TLS listener (`tls.createServer`, the IMAP implicit-TLS port
/// without a proxy in front) takes its own order; a socket it wraps in TLS
/// later (SMTP, both STARTTLS commands, IMAP behind a proxy) takes the
/// client's. A TLS 1.3 suite is the client's choice either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preference {
    Client,
    Server,
}

fn names(table: &[(u16, &str)]) -> String {
    table.iter().map(|(_, name)| *name).collect::<Vec<_>>().join(":")
}

/// The names of the entries of `table` in `codes`, in that order, or `None`
/// when there are none.
fn ordered_as(codes: &[u16], table: &[(u16, &str)]) -> Option<String> {
    let known = |code: &u16| table.iter().find(|(known, _)| known == code).map(|(_, name)| *name);
    let chosen: Vec<&str> = codes.iter().filter_map(known).collect();
    (!chosen.is_empty()).then(|| chosen.join(":"))
}

fn u16_list(bytes: &[u8]) -> Vec<u16> {
    bytes.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect()
}

/// The body of a ClientHello extension. Only inside the ClientHello callback.
fn client_hello_extension(ssl: &SslRef, kind: u32) -> Option<&[u8]> {
    let mut data = std::ptr::null();
    let mut len = 0;
    // SAFETY: called from the ClientHello callback, while the ClientHello the
    // returned bytes point into is alive; they are borrowed for `ssl`'s
    // lifetime, which outlives that call.
    unsafe {
        if openssl_sys::SSL_client_hello_get0_ext(ssl.as_ptr(), kind, &mut data, &mut len) != 1 || data.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(data, len))
    }
}

fn set_groups(ssl: &mut SslRef, groups: &str) -> Result<(), ErrorStack> {
    let groups = std::ffi::CString::new(groups).expect("group names hold no NUL");
    // SAFETY: a live SSL and a NUL-terminated list, which OpenSSL copies.
    if unsafe { openssl_sys::SSL_set1_groups_list(ssl.as_ptr(), groups.as_ptr()) } != 1 {
        return Err(ErrorStack::get());
    }
    Ok(())
}

fn preference_index() -> Result<Index<Ssl, Preference>, ErrorStack> {
    static INDEX: OnceLock<Result<Index<Ssl, Preference>, ErrorStack>> = OnceLock::new();
    INDEX.get_or_init(Ssl::new_ex_index).clone()
}

/// Sets what this handshake may pick from, in the order BoringSSL would.
///
/// The context takes the server's order, so it signs as BoringSSL does.
/// Where Bun takes the client's order, the suites and groups are set to the
/// client's offer, in its order: the server's order is then the client's.
fn on_client_hello(ssl: &mut SslRef, _alert: &mut SslAlert) -> Result<ClientHelloResponse, ErrorStack> {
    let preference = ssl.ex_data(preference_index()?).copied().unwrap_or(Preference::Client);
    let offered = u16_list(ssl.client_hello_ciphers().unwrap_or_default());
    if let Some(suites) = ordered_as(&offered, &TLS13_SUITES) {
        ssl.set_ciphersuites(&suites)?;
    }
    if preference == Preference::Client {
        if let Some(suites) = ordered_as(&offered, &TLS12_SUITES) {
            ssl.set_cipher_list(&suites)?;
        }
        // A list of 16-bit groups behind its 16-bit length.
        let groups = client_hello_extension(ssl, SUPPORTED_GROUPS).map(|body| u16_list(body.get(2..).unwrap_or(&[])));
        if let Some(groups) = groups.and_then(|groups| ordered_as(&groups, &GROUPS)) {
            set_groups(ssl, &groups)?;
        }
    }
    Ok(ClientHelloResponse::SUCCESS)
}

/// The handshake settings, with the certificate chain and key in `cert_pem`
/// and `key_pem` (read from `cert` and `key`).
fn build_context(cert: &str, cert_pem: &[u8], key: &str, key_pem: &[u8]) -> anyhow::Result<SslContext> {
    let chain = X509::stack_from_pem(cert_pem).with_context(|| format!("no certificate found in {cert}"))?;
    let Some((leaf, intermediates)) = chain.split_first() else {
        bail!("no certificate found in {cert}");
    };
    // An empty passphrase, so an encrypted key fails instead of prompting.
    let private_key =
        PKey::private_key_from_pem_passphrase(key_pem, b"").with_context(|| format!("no private key found in {key}"))?;
    if !leaf.public_key()?.public_eq(&private_key) {
        bail!("the key in {key} is not the certificate's key in {cert}");
    }

    let mut builder = SslContext::builder(SslMethod::tls_server())?;
    builder.set_min_proto_version(Some(SslVersion::TLS1_2))?;
    builder.set_max_proto_version(Some(SslVersion::TLS1_3))?;
    // BoringSSL has no security levels. At OpenSSL's default level a
    // SHA-1 signature is refused, which Bun makes for a client that offers no
    // other; the lists below are what bounds the handshake.
    builder.set_security_level(0);
    builder.set_cipher_list(&names(&TLS12_SUITES))?;
    builder.set_ciphersuites(&names(&TLS13_SUITES))?;
    builder.set_groups_list(&names(&GROUPS))?;
    builder.set_sigalgs_list(SIGNATURE_ALGORITHMS)?;
    builder.set_options(SslOptions::CIPHER_SERVER_PREFERENCE | SslOptions::NO_RENEGOTIATION | NO_ENCRYPT_THEN_MAC);
    // Sessions resume from a ticket, as on Bun, and not by session ID.
    builder.set_session_cache_mode(SslSessionCacheMode::OFF);
    builder.set_client_hello_callback(on_client_hello);
    builder.set_certificate(leaf)?;
    builder.set_private_key(&private_key)?;
    for intermediate in intermediates {
        builder.add_extra_chain_cert(intermediate.clone())?;
    }
    Ok(builder.build())
}

// ---------------------------------------------------------------------------
// The acceptor
// ---------------------------------------------------------------------------

/// The handshake settings for one certificate and key, and a digest of the
/// files they were read from.
struct Loaded {
    files: [u8; 32],
    context: SslContext,
}

/// What was last loaded, by the certificate and key paths it came from.
type LoadedByPaths = HashMap<(String, String), Arc<Loaded>>;

/// The settings for the certificate and key in these files now. Both are
/// read every time; they are parsed, and the settings built, only when what
/// they hold has changed: that costs OpenSSL 3 milliseconds.
fn load(cert: &str, key: &str) -> anyhow::Result<Arc<Loaded>> {
    static LOADED: LazyLock<Mutex<LoadedByPaths>> = LazyLock::new(Default::default);
    let cert_pem = fs::read(cert).with_context(|| format!("reading {cert}"))?;
    let key_pem = fs::read(key).with_context(|| format!("reading {key}"))?;
    let mut files = Sha256::new();
    for pem in [&cert_pem, &key_pem] {
        files.update(&(pem.len() as u64).to_be_bytes());
        files.update(pem);
    }
    let files = files.finish();

    let paths = (cert.to_string(), key.to_string());
    let current = LOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&paths).cloned();
    if let Some(loaded) = current.filter(|loaded| loaded.files == files) {
        return Ok(loaded);
    }
    let loaded = Arc::new(Loaded { files, context: build_context(cert, &cert_pem, key, &key_pem)? });
    LOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(paths, loaded.clone());
    Ok(loaded)
}

/// The server side of one TLS handshake, with the certificate on disk when it
/// was made.
#[derive(Clone)]
pub struct TlsAcceptor {
    loaded: Arc<Loaded>,
    preference: Preference,
}

impl TlsAcceptor {
    /// The same certificate, with `preference` picking a TLS 1.2 suite.
    pub fn with_preference(self, preference: Preference) -> TlsAcceptor {
        TlsAcceptor { preference, ..self }
    }

    fn ssl(&self) -> anyhow::Result<Ssl> {
        let mut ssl = Ssl::new(&self.loaded.context)?;
        ssl.set_ex_data(preference_index()?, self.preference);
        Ok(ssl)
    }

    /// Runs the server side of a handshake on `stream`.
    pub async fn accept<S: AsyncRead + AsyncWrite + Unpin>(&self, stream: S) -> io::Result<TlsStream<S>> {
        let ssl = self.ssl().map_err(io::Error::other)?;
        let mut stream = tokio_openssl::SslStream::new(ssl, stream).map_err(io::Error::other)?;
        match Pin::new(&mut stream).accept().await {
            Ok(()) => Ok(TlsStream(stream)),
            // A close_notify before the handshake is through: a hang-up.
            Err(error) if error.code() == ErrorCode::ZERO_RETURN => Err(io::ErrorKind::UnexpectedEof.into()),
            Err(error) => {
                let server_name = stream.ssl().servername(NameType::HOST_NAME).map(str::to_owned);
                Err(with_server_name(io_error(error), server_name))
            }
        }
    }
}

/// Records on a handshake's TLS failure the host the client asked for by SNI.
fn with_server_name(error: io::Error, server_name: Option<String>) -> io::Error {
    if server_name.is_none() || error.get_ref().and_then(|inner| inner.downcast_ref::<TlsError>()).is_none() {
        return error;
    }
    let kind = error.kind();
    match error.into_inner().map(|inner| inner.downcast::<TlsError>()) {
        Some(Ok(mut tls)) => {
            tls.server_name = server_name;
            io::Error::new(kind, *tls)
        }
        Some(Err(other)) => io::Error::new(kind, other),
        None => kind.into(),
    }
}

/// A TLS acceptor for one connection, from the certificate on disk now.
pub fn acceptor() -> anyhow::Result<TlsAcceptor> {
    let TlsCredentials::Available { cert, key } = get_tls_credentials() else {
        bail!("SSL certificate not configured");
    };
    acceptor_for(&cert, &key)
}

/// A TLS acceptor serving the certificate and key at the given paths.
pub fn acceptor_for(cert: &str, key: &str) -> anyhow::Result<TlsAcceptor> {
    Ok(TlsAcceptor { loaded: load(cert, key)?, preference: Preference::Client })
}

// ---------------------------------------------------------------------------
// The stream and its errors
// ---------------------------------------------------------------------------

/// A failure of the TLS layer, as OpenSSL words it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsError {
    /// OpenSSL's reason: `sslv3 alert bad certificate`, `no shared cipher`.
    pub reason: String,
    /// The whole error line, with the function that raised it.
    pub message: String,
    /// For a failed handshake, the host the client asked for by SNI.
    pub server_name: Option<String>,
}

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TlsError {}

/// What an OpenSSL failure is to the listeners: the socket's own error, a
/// peer that hung up mid-handshake (`UnexpectedEof`, the client leaving), or
/// a [`TlsError`]. After the handshake, a hang-up without a close_notify
/// reads as the end of the stream.
fn io_error(error: ssl::Error) -> io::Error {
    let first = error.ssl_error().and_then(|stack| stack.errors().first().cloned());
    if let Some(errno) = first.as_ref().and_then(system_errno) {
        return io::Error::from_raw_os_error(errno);
    }
    if (error.code() == ErrorCode::SYSCALL && error.io_error().is_none() && first.is_none())
        || first.as_ref().is_some_and(|first| first.reason_code() == UNEXPECTED_EOF_WHILE_READING)
    {
        return io::ErrorKind::UnexpectedEof.into();
    }
    if let Some(first) = first {
        let reason = first.reason().unwrap_or("unknown").to_string();
        return io::Error::new(
            io::ErrorKind::InvalidData,
            TlsError { reason, message: first.to_string(), server_name: None },
        );
    }
    error.into_io_error().unwrap_or_else(io::Error::other)
}

/// The errno of a failed system call that OpenSSL 3 put on its error stack: it
/// sets the code's top bit and keeps the errno below it. Read as that OS error, a
/// peer that went away mid-write is a broken pipe or a reset, not a TLS fault.
fn system_errno(error: &openssl::error::Error) -> Option<i32> {
    const SYSTEM_FLAG: std::ffi::c_ulong = 1 << 31;
    let code = error.code();
    // A transport error that no system call raised is pushed with errno 0.
    (code & SYSTEM_FLAG != 0).then(|| (code & !SYSTEM_FLAG) as i32).filter(|&errno| errno != 0)
}

/// The same, for an error the OpenSSL stream already made an `io::Error`.
fn map_io_error(error: io::Error) -> io::Error {
    if !error.get_ref().is_some_and(|inner| inner.is::<ssl::Error>()) {
        return error;
    }
    match error.into_inner().map(|inner| inner.downcast::<ssl::Error>()) {
        Some(Ok(inner)) => io_error(*inner),
        Some(Err(inner)) => io::Error::other(inner),
        None => io::ErrorKind::Other.into(),
    }
}

/// A connection after its handshake.
pub struct TlsStream<S>(tokio_openssl::SslStream<S>);

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for TlsStream<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf).map_err(map_io_error)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for TlsStream<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf).map_err(map_io_error)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx).map_err(map_io_error)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx).map_err(map_io_error)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use openssl::asn1::Asn1Time;
    use openssl::hash::MessageDigest;
    use openssl::pkey::Private;
    use openssl::rsa::Rsa;
    use openssl::ssl::{SslConnector, SslConnectorBuilder, SslVerifyMode};
    use openssl::x509::X509NameBuilder;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    use super::*;

    /// Writes a self-signed certificate for `localhost` with `key`, and the
    /// key, to `dir`. The paths.
    fn write_identity(dir: &Path, key: &PKey<Private>) -> (String, String) {
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_text("CN", "localhost").unwrap();
        let name = name.build();
        let mut cert = X509::builder().unwrap();
        cert.set_version(2).unwrap();
        cert.set_subject_name(&name).unwrap();
        cert.set_issuer_name(&name).unwrap();
        cert.set_pubkey(key).unwrap();
        cert.set_not_before(&Asn1Time::days_from_now(0).unwrap()).unwrap();
        cert.set_not_after(&Asn1Time::days_from_now(1).unwrap()).unwrap();
        cert.sign(key, MessageDigest::sha256()).unwrap();
        let (cert_path, key_path) = (dir.join("cert.pem"), dir.join("key.pem"));
        fs::write(&cert_path, cert.build().to_pem().unwrap()).unwrap();
        fs::write(&key_path, key.private_key_to_pem_pkcs8().unwrap()).unwrap();
        (cert_path.to_str().unwrap().to_string(), key_path.to_str().unwrap().to_string())
    }

    fn rsa_key() -> PKey<Private> {
        static KEY: OnceLock<PKey<Private>> = OnceLock::new();
        KEY.get_or_init(|| PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap()).clone()
    }

    fn rsa_acceptor() -> TlsAcceptor {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = write_identity(dir.path(), &rsa_key());
        acceptor_for(&cert, &key).unwrap()
    }

    /// An OpenSSL client that takes any certificate and offers what
    /// `configure` sets, from a TLS 1.0 floor.
    fn client(configure: impl FnOnce(&mut SslConnectorBuilder)) -> SslConnector {
        let mut builder = SslConnector::builder(SslMethod::tls_client()).unwrap();
        builder.set_verify(SslVerifyMode::NONE);
        builder.set_security_level(0);
        builder.set_min_proto_version(Some(SslVersion::TLS1)).unwrap();
        configure(&mut builder);
        builder.build()
    }

    fn connecting(connector: &SslConnector, io: DuplexStream) -> tokio_openssl::SslStream<DuplexStream> {
        let ssl = connector.configure().unwrap().verify_hostname(false).into_ssl("localhost").unwrap();
        tokio_openssl::SslStream::new(ssl, io).unwrap()
    }

    /// Runs both sides of a handshake. The client's side is the negotiated
    /// `version suite`, or the error it saw.
    async fn handshake(
        acceptor: &TlsAcceptor,
        connector: &SslConnector,
    ) -> (io::Result<TlsStream<DuplexStream>>, Result<String, String>) {
        let (server, client) = tokio::io::duplex(1 << 16);
        let mut client = connecting(connector, client);
        let (server, connected) = tokio::join!(acceptor.accept(server), Pin::new(&mut client).connect());
        let client = connected.map(|()| {
            let ssl = client.ssl();
            format!("{} {}", ssl.version_str(), ssl.current_cipher().map(|cipher| cipher.name()).unwrap_or("-"))
        });
        (server, client.map_err(|error| error.to_string()))
    }

    async fn negotiated(acceptor: &TlsAcceptor, configure: impl FnOnce(&mut SslConnectorBuilder)) -> Result<String, String> {
        handshake(acceptor, &client(configure)).await.1
    }

    fn tls12(suites: &'static str) -> impl Fn(&mut SslConnectorBuilder) {
        move |builder| {
            builder.set_max_proto_version(Some(SslVersion::TLS1_2)).unwrap();
            builder.set_cipher_list(suites).unwrap();
        }
    }

    fn tls_error(error: &io::Error) -> &TlsError {
        error.get_ref().and_then(|inner| inner.downcast_ref::<TlsError>()).expect("a TLS-layer error")
    }

    /// What the server's handshake reports when a client that checks
    /// certificates (and trusts none of this test's) refuses it, having asked
    /// for `server_name` by SNI, or for nothing.
    async fn refusal_seen_by_the_server(server_name: Option<&str>) -> TlsError {
        let acceptor = rsa_acceptor();
        let connector = SslConnector::builder(SslMethod::tls_client()).unwrap().build();
        let (server, client) = tokio::io::duplex(1 << 16);
        let config = connector.configure().unwrap().verify_hostname(false).use_server_name_indication(server_name.is_some());
        let ssl = config.into_ssl(server_name.unwrap_or("localhost")).unwrap();
        let mut client = tokio_openssl::SslStream::new(ssl, client).unwrap();
        let (server, connected) = tokio::join!(acceptor.accept(server), Pin::new(&mut client).connect());
        assert!(connected.is_err(), "the client refuses a certificate it can't verify");
        tls_error(&server.err().expect("the server sees the refusal")).clone()
    }

    #[tokio::test]
    async fn a_refused_handshake_records_the_host_the_client_asked_for() {
        let asked = refusal_seen_by_the_server(Some("localhost")).await;
        assert!(asked.reason.contains("unknown ca"), "{}", asked.message);
        assert_eq!(asked.server_name.as_deref(), Some("localhost"));
        assert_eq!(refusal_seen_by_the_server(Some("other.example")).await.server_name.as_deref(), Some("other.example"));
        assert_eq!(refusal_seen_by_the_server(None).await.server_name, None);
    }

    #[tokio::test]
    async fn a_write_to_a_client_that_hung_up_fails_as_the_os_error() {
        let acceptor = rsa_acceptor();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let connector = client(|_| {});
        let hang_up = tokio::spawn(async move {
            let tcp = tokio::net::TcpStream::connect(address).await.unwrap();
            let ssl = connector.configure().unwrap().verify_hostname(false).into_ssl("localhost").unwrap();
            let mut stream = tokio_openssl::SslStream::new(ssl, tcp).unwrap();
            Pin::new(&mut stream).connect().await.unwrap();
        });
        let (tcp, _) = listener.accept().await.unwrap();
        let mut server = acceptor.accept(tcp).await.unwrap();
        hang_up.await.unwrap();
        let mut failed = None;
        for _ in 0..200 {
            if let Err(error) = server.write_all(&[b'.'; 4096]).await {
                failed = Some(error);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let error = failed.expect("writing to a closed connection fails");
        assert!(
            matches!(error.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset),
            "{:?}: {error}",
            error.kind()
        );
    }

    #[tokio::test]
    async fn a_transport_error_no_system_call_raised_stays_a_tls_error() {
        let acceptor = rsa_acceptor();
        let (server_io, client_io) = tokio::io::duplex(1 << 16);
        let mut peer = connecting(&client(|_| {}), client_io);
        let (server, connected) = tokio::join!(acceptor.accept(server_io), Pin::new(&mut peer).connect());
        connected.unwrap();
        let mut server = server.unwrap();
        drop(peer);
        let error = server.write_all(b"* OK\r\n").await.expect_err("the other half is gone");
        assert_eq!(error.raw_os_error(), None, "{error}");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{error}");
    }

    #[tokio::test]
    async fn takes_the_legacy_tls12_handshakes_bun_takes() {
        let acceptor = rsa_acceptor();
        // CBC only, as a Postfix pinned to an old list offers.
        let cbc = tls12("ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-SHA:AES256-SHA");
        assert_eq!(negotiated(&acceptor, cbc).await, Ok("TLSv1.2 ECDHE-RSA-AES128-SHA".to_string()));
        // RSA key exchange only.
        let rsa = tls12("AES256-SHA:AES128-GCM-SHA256");
        assert_eq!(negotiated(&acceptor, rsa).await, Ok("TLSv1.2 AES256-SHA".to_string()));
        // SHA-1 signatures only.
        let sha1 = |builder: &mut SslConnectorBuilder| {
            tls12("ECDHE-RSA-AES128-GCM-SHA256")(builder);
            builder.set_sigalgs_list("RSA+SHA1").unwrap();
        };
        assert_eq!(negotiated(&acceptor, sha1).await, Ok("TLSv1.2 ECDHE-RSA-AES128-GCM-SHA256".to_string()));
        // And TLS 1.3 for everyone else.
        assert_eq!(negotiated(&acceptor, |_| {}).await, Ok("TLSv1.3 TLS_AES_256_GCM_SHA384".to_string()));
    }

    #[tokio::test]
    async fn refuses_what_bun_refuses() {
        let acceptor = rsa_acceptor();
        for version in [SslVersion::TLS1, SslVersion::TLS1_1] {
            let old = move |builder: &mut SslConnectorBuilder| {
                builder.set_max_proto_version(Some(version)).unwrap();
                builder.set_cipher_list("ALL:@SECLEVEL=0").unwrap();
            };
            let (server, client) = handshake(&acceptor, &client(old)).await;
            assert!(client.unwrap_err().contains("alert protocol version"));
            assert_eq!(tls_error(&server.err().unwrap()).reason, "unsupported protocol");
        }
        // CBC with SHA-256, and finite-field Diffie-Hellman.
        let other = tls12("ECDHE-RSA-AES128-SHA256:AES128-SHA256:DHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0");
        assert!(negotiated(&acceptor, other).await.is_err());
        let p521 = |builder: &mut SslConnectorBuilder| builder.set_groups_list("P-521").unwrap();
        assert!(negotiated(&acceptor, p521).await.is_err());
    }

    #[tokio::test]
    async fn picks_the_suite_by_the_clients_order_or_the_servers() {
        let acceptor = rsa_acceptor();
        let offer = tls12("AES256-SHA:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256");
        assert_eq!(negotiated(&acceptor, &offer).await, Ok("TLSv1.2 AES256-SHA".to_string()));
        let own_order = acceptor.clone().with_preference(Preference::Server);
        assert_eq!(negotiated(&own_order, &offer).await, Ok("TLSv1.2 ECDHE-RSA-AES128-GCM-SHA256".to_string()));

        // A TLS 1.3 suite is the client's choice either way.
        let chacha = |builder: &mut SslConnectorBuilder| {
            builder.set_ciphersuites("TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256").unwrap();
        };
        for acceptor in [&acceptor, &own_order] {
            assert_eq!(negotiated(acceptor, chacha).await, Ok("TLSv1.3 TLS_CHACHA20_POLY1305_SHA256".to_string()));
        }
    }

    #[tokio::test]
    async fn carries_data_both_ways_and_reads_a_hang_up_as_the_end() {
        let acceptor = rsa_acceptor();
        let (server, io) = tokio::io::duplex(1 << 16);
        let mut client = connecting(&client(|_| {}), io);
        let (server, connected) = tokio::join!(acceptor.accept(server), Pin::new(&mut client).connect());
        connected.unwrap();
        let mut server = server.unwrap();
        client.write_all(b"EHLO there\r\n").await.unwrap();
        let mut line = [0; 12];
        server.read_exact(&mut line).await.unwrap();
        assert_eq!(&line, b"EHLO there\r\n");
        server.write_all(b"250 OK\r\n").await.unwrap();
        server.flush().await.unwrap();
        let mut reply = [0; 8];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"250 OK\r\n");

        // The client's socket closes without a close_notify: the end of the
        // stream, as on Bun.
        drop(client);
        assert_eq!(server.read(&mut [0; 16]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn names_the_alert_of_a_client_that_refuses_the_certificate() {
        let acceptor = rsa_acceptor();
        let verifying = client(|builder| builder.set_verify(SslVerifyMode::PEER));
        let (server, client) = handshake(&acceptor, &verifying).await;
        assert!(client.is_err());
        let error = server.err().unwrap();
        assert_eq!(tls_error(&error).reason, "tlsv1 alert unknown ca");
        assert!(error.to_string().contains("tlsv1 alert unknown ca"), "{error}");
    }

    #[tokio::test]
    async fn reports_a_client_that_hangs_up_mid_handshake_as_end_of_file() {
        let acceptor = rsa_acceptor();
        let (server, mut client) = tokio::io::duplex(1 << 16);
        // A ClientHello's record header, and nothing after it.
        client.write_all(&[0x16, 0x03, 0x01, 0x00, 0x40]).await.unwrap();
        drop(client);
        let error = acceptor.accept(server).await.err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn serves_a_renewed_certificate_from_the_next_handshake_on() {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = write_identity(dir.path(), &rsa_key());
        let first = acceptor_for(&cert, &key).unwrap();
        // Files that did not change are not parsed again.
        assert!(Arc::ptr_eq(&first.loaded, &acceptor_for(&cert, &key).unwrap().loaded));

        let renewed_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        write_identity(dir.path(), &renewed_key);
        let renewed = acceptor_for(&cert, &key).unwrap();
        let served = |acceptor: TlsAcceptor| async move {
            let (server, io) = tokio::io::duplex(1 << 16);
            let mut client = connecting(&client(|_| {}), io);
            let (_, connected) = tokio::join!(acceptor.accept(server), Pin::new(&mut client).connect());
            connected.unwrap();
            client.ssl().peer_certificate().unwrap().public_key().unwrap()
        };
        assert!(served(renewed).await.public_eq(&renewed_key));
        // An acceptor serves what was on disk when it was made.
        assert!(served(first).await.public_eq(&rsa_key()));
    }

    #[test]
    fn refuses_a_key_that_is_not_the_certificates() {
        let dir = tempfile::tempdir().unwrap();
        let (cert, _) = write_identity(dir.path(), &rsa_key());
        let other = dir.path().join("other-key.pem");
        let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        fs::write(&other, key.private_key_to_pem_pkcs8().unwrap()).unwrap();
        let error = acceptor_for(&cert, other.to_str().unwrap()).err().unwrap();
        assert!(error.to_string().contains("is not the certificate's key"), "{error}");
        assert!(acceptor_for(&cert, &cert).is_err());
    }
}
