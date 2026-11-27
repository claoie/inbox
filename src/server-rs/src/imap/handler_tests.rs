//! Tests of the connection driver: handler-literal, handler-literal-cap,
//! handler-literal-chain-pacing, handler-append-spool, handler-throttle,
//! handler-serial-drain, handler-idle, handler-socket-error,
//! handler-command-diag, starttls-pipelining and session-close-flush.
//!
//! A connection runs over an in-memory duplex stream, with a dispatch that
//! records each parsed command instead of (or before) running it. What the
//! Bun fixtures read off a mock socket's `writes` is read here off the
//! client end of the stream.
//!
//! Where the Bun handler pauses its socket, this one stops reading: a fixture
//! sees that as the client's writes no longer being taken, so those tests
//! run over a small stream and watch how much a background writer got in.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, WriteHalf};
use tokio::sync::{Notify, RwLockReadGuard};
use tokio::task::JoinHandle;

use super::*;
use crate::imap::literal_spool::{spool_dirs, spool_test_lock};
use crate::imap::test_support;
use crate::imap::types::{AppendRequest, LoginRequest, SearchCriterion, SearchRequest, SelectRequest};

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/// Everything journaled so far, as one text to search. Tests run side by
/// side, so each one looks for markers only it uses.
fn journal_text() -> String {
    let entries = test_support::journal_entries();
    entries.iter().map(|(level, message, context)| format!("{level} {message} {context}\n")).collect()
}

/// The journal entries of one connection, by the `remote` they name.
fn journal_of(remote: &str) -> Vec<(String, String, Value)> {
    let entries = test_support::journal_entries();
    entries.iter().filter(|(_, _, context)| context.get("remote").and_then(Value::as_str) == Some(remote)).cloned().collect()
}

/// The raw wire text the DEBUG lines carry (`input` of a parse failure,
/// `command` of a received command) that contains `marker`.
fn journaled_wire_text(marker: &str) -> Vec<String> {
    let entries = test_support::journal_entries();
    entries
        .iter()
        .filter(|(level, _, _)| level == "debug")
        .flat_map(|(_, _, context)| {
            ["input", "command"].into_iter().filter_map(|field| context.get(field).and_then(Value::as_str).map(str::to_string))
        })
        .filter(|text| text.contains(marker))
        .collect()
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Recorded {
    tag: String,
    request: ImapRequest,
    /// The spooled APPEND message, read while the command is dispatched.
    message: Option<Vec<u8>>,
}

impl Recorded {
    fn message_text(&self) -> String {
        String::from_utf8_lossy(self.message.as_deref().expect("an APPEND message")).into_owned()
    }

    fn append(&self) -> &AppendRequest {
        match &self.request {
            ImapRequest::Append(append) => append,
            other => panic!("expected APPEND, got {other:?}"),
        }
    }
}

type Hook = Arc<dyn Fn(Arc<ImapSession>, String, ImapRequest) -> BoxFuture<'static, ()> + Send + Sync>;

/// Records every dispatched command; `real` also runs it on the session, and
/// `hook` stands in for the session (it runs after the recording, with the
/// spooled file still in place).
#[derive(Clone, Default)]
struct Recorder {
    dispatched: Arc<Mutex<Vec<Recorded>>>,
    real: bool,
    hook: Option<Hook>,
    /// Lines taken as the response to an AUTHENTICATE challenge, by tag.
    sasl: Arc<Mutex<Vec<(String, String)>>>,
}

impl Recorder {
    fn real() -> Recorder {
        Recorder { real: true, ..Recorder::default() }
    }

    fn with_hook(
        hook: impl Fn(Arc<ImapSession>, String, ImapRequest) -> BoxFuture<'static, ()> + Send + Sync + 'static,
    ) -> Recorder {
        Recorder { hook: Some(Arc::new(hook)), ..Recorder::default() }
    }
}

impl Dispatch for Recorder {
    async fn handle_request(&mut self, session: &Arc<ImapSession>, tag: &str, request: ImapRequest) {
        let message = match &request {
            ImapRequest::Append(append) => std::fs::read(&append.message.path).ok(),
            _ => None,
        };
        self.dispatched.lock().unwrap().push(Recorded { tag: tag.to_string(), request: request.clone(), message });
        if self.real {
            handle_request(session, tag, request.clone()).await;
        }
        if let Some(hook) = self.hook.clone() {
            hook(session.clone(), tag.to_string(), request).await;
        }
    }

    async fn sasl_response(&mut self, _session: &Arc<ImapSession>, tag: &str, response: &str) {
        self.sasl.lock().unwrap().push((tag.to_string(), response.to_string()));
    }
}

/// A hook that parks the first command until released.
fn parking_hook() -> (Recorder, Arc<Notify>) {
    let release = Arc::new(Notify::new());
    let parked = Arc::new(AtomicBool::new(false));
    let recorder = Recorder::with_hook({
        let release = release.clone();
        move |_, _, _| {
            let release = release.clone();
            let first = !parked.swap(true, Ordering::SeqCst);
            Box::pin(async move {
                if first {
                    release.notified().await;
                }
            })
        }
    });
    (recorder, release)
}

static NEXT_PORT: AtomicU16 = AtomicU16::new(20_000);

#[derive(Default)]
struct Setup {
    authenticated: bool,
    selected: Option<&'static str>,
    /// Octets the stream holds in each direction; small to see a stop.
    capacity: Option<usize>,
    /// Opened by a test that holds the process-wide lock exclusively.
    unlocked: bool,
}

/// One connection, seen from the client.
struct Wire {
    writer: Arc<tokio::sync::Mutex<WriteHalf<DuplexStream>>>,
    received: Arc<Mutex<Vec<u8>>>,
    closed: Arc<AtomicBool>,
    greeting: usize,
    dispatched: Arc<Mutex<Vec<Recorded>>>,
    session: Arc<ImapSession>,
    remote: String,
    _shared: Option<RwLockReadGuard<'static, ()>>,
}

/// A writer that keeps sending in the background, counting what was taken.
struct Flood {
    written: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl Flood {
    fn written(&self) -> usize {
        self.written.load(Ordering::SeqCst)
    }

    fn is_done(&self) -> bool {
        self.task.is_finished()
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

async fn tick() {
    tokio::time::sleep(Duration::from_millis(2)).await;
}

/// Polls `condition` until it holds or `timeout` ran out.
async fn wait_for(timeout: Duration, condition: impl Fn() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while !condition() {
        if tokio::time::Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    true
}

impl Wire {
    async fn open(recorder: Recorder) -> Wire {
        Wire::open_with(recorder, Setup::default()).await
    }

    async fn open_authenticated(recorder: Recorder) -> Wire {
        Wire::open_with(recorder, Setup { authenticated: true, ..Setup::default() }).await
    }

    async fn open_with(recorder: Recorder, setup: Setup) -> Wire {
        let shared = if setup.unlocked { None } else { Some(test_support::shared().await) };
        let (server, client) = tokio::io::duplex(setup.capacity.unwrap_or(4 << 20));
        let port = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
        let peer = Peer { address: "203.0.113.7".into(), port };
        let dispatched = recorder.dispatched.clone();
        let handler = ImapRequestHandler::with_dispatch(Box::new(server), peer, false, recorder);
        let session = handler.session().clone();
        if setup.authenticated {
            session.sign_in_for_test("tester", setup.selected);
        }
        tokio::spawn(handler.run());

        let (mut reader, writer) = tokio::io::split(client);
        let received = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(AtomicBool::new(false));
        tokio::spawn({
            let (received, closed) = (received.clone(), closed.clone());
            async move {
                let mut chunk = vec![0u8; 64 * 1024];
                loop {
                    match reader.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => received.lock().unwrap().extend_from_slice(&chunk[..read]),
                    }
                }
                closed.store(true, Ordering::SeqCst);
            }
        });

        let greeted = wait_for(Duration::from_secs(5), || received.lock().unwrap().windows(2).any(|w| w == b"\r\n")).await;
        assert!(greeted, "the server greets");
        let greeting = received.lock().unwrap().windows(2).position(|w| w == b"\r\n").unwrap() + 2;
        assert!(String::from_utf8_lossy(&received.lock().unwrap()[..greeting]).starts_with("* OK [CAPABILITY "));

        Wire {
            writer: Arc::new(tokio::sync::Mutex::new(writer)),
            received,
            closed,
            greeting,
            dispatched,
            session,
            remote: format!("203.0.113.7:{port}"),
            _shared: shared,
        }
    }

    async fn send(&self, data: impl AsRef<[u8]>) {
        self.writer.lock().await.write_all(data.as_ref()).await.expect("the server reads");
    }

    /// Sends each piece in its own write, with a turn of the clock between.
    async fn send_pieces(&self, pieces: &[&[u8]]) {
        for piece in pieces {
            self.send(piece).await;
            tick().await;
        }
    }

    /// Sends `data` unless the server has gone; true when it was taken.
    async fn try_send(&self, data: impl AsRef<[u8]>) -> bool {
        self.writer.lock().await.write_all(data.as_ref()).await.is_ok()
    }

    /// Keeps writing `chunks` in the background.
    fn flood(&self, chunks: Vec<Vec<u8>>) -> Flood {
        let written = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let (writer, written) = (self.writer.clone(), written.clone());
            async move {
                for chunk in chunks {
                    if writer.lock().await.write_all(&chunk).await.is_err() {
                        return;
                    }
                    written.fetch_add(chunk.len(), Ordering::SeqCst);
                }
            }
        });
        Flood { written, task }
    }

    /// The client closes its side.
    async fn hang_up(&self) {
        let _ = self.writer.lock().await.shutdown().await;
    }

    /// Everything the server wrote after its greeting.
    fn output(&self) -> String {
        String::from_utf8_lossy(&self.received.lock().unwrap()[self.greeting..]).into_owned()
    }

    /// The server's lines after its greeting.
    fn lines(&self) -> Vec<String> {
        self.output().split_inclusive("\r\n").map(str::to_string).collect()
    }

    fn dispatched(&self) -> Vec<Recorded> {
        self.dispatched.lock().unwrap().clone()
    }

    fn tags(&self) -> Vec<String> {
        self.dispatched().into_iter().map(|recorded| recorded.tag).collect()
    }

    /// The server ended the connection: the client read the end of it.
    fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    async fn wait_for_dispatches(&self, count: usize) {
        let dispatched = self.dispatched.clone();
        assert!(
            wait_for(Duration::from_secs(10), || dispatched.lock().unwrap().len() >= count).await,
            "{count} dispatches, got {:?}",
            self.tags()
        );
    }

    async fn wait_for_output(&self, text: &str) {
        let received = self.received.clone();
        let text = text.to_string();
        assert!(
            wait_for(Duration::from_secs(10), || String::from_utf8_lossy(&received.lock().unwrap()).contains(&text)).await,
            "waiting for {text:?}, got {:?}",
            self.output()
        );
    }

    async fn wait_for_close(&self) {
        let closed = self.closed.clone();
        assert!(wait_for(Duration::from_secs(10), || closed.load(Ordering::SeqCst)).await, "the server closes");
    }
}

fn login(username: &str, password: &str) -> ImapRequest {
    ImapRequest::Login(LoginRequest { username: username.into(), password: password.into() })
}

fn subject_from(subject: &str, from: &str) -> ImapRequest {
    ImapRequest::Search(SearchRequest {
        criteria: vec![SearchCriterion::Subject(subject.into()), SearchCriterion::From(from.into())],
    })
}

/// The spool directories created since `before`.
fn new_spool_dirs(before: &[String]) -> Vec<String> {
    spool_dirs().into_iter().filter(|dir| !before.contains(dir)).collect()
}

/// Waits for the spool directories created since `before` to be gone.
async fn assert_spool_cleaned(before: &[String]) {
    let before = before.to_vec();
    let cleaned = wait_for(Duration::from_secs(5), || new_spool_dirs(&before).is_empty()).await;
    assert!(cleaned, "spool directories left behind: {:?}", new_spool_dirs(&before));
}

// Mirrors the constants in handler.rs. Re-stated rather than imported: a test
// that reads the symbol it checks cannot catch a cap being widened.
const SMALL_CAP: usize = 8 * 1024;
const APPEND_CAP: usize = 35 * 1024 * 1024;
const UNCONSUMED_CAP: usize = 64 * 1024;
const CHAIN_CAP: usize = 64;
const PENDING_CAP: usize = APPEND_CAP + 64 * 1024;
// Mirrors the line cap in trace.rs.
const TRACE_LINE_CAP: usize = 512;
const TAG_CAP: usize = 128;

// ---------------------------------------------------------------------------
// Literal continuation (handler-literal.test.ts)
// ---------------------------------------------------------------------------

mod literal_continuation {
    use super::*;

    #[tokio::test]
    async fn reassembles_a_literal_plus_login_instead_of_parsing_its_credentials_as_commands() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].tag, "A1");
        assert_eq!(dispatched[0].request, login("admin", "password"));
        // A non-synchronizing literal needs no continuation, and nothing about
        // this command is an error: the wire stays silent.
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn prompts_once_per_synchronizing_literal_and_still_reassembles() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5}\r\n").await;
        wire.wait_for_output("+ go ahead\r\n").await;
        settle().await;
        assert_eq!(wire.output(), "+ go ahead\r\n");

        wire.send("admin {8}\r\n").await;
        wire.wait_for_output("+ go ahead\r\n+ go ahead\r\n").await;
        settle().await;
        assert_eq!(wire.output(), "+ go ahead\r\n+ go ahead\r\n");

        wire.send("password\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;
        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "password"));
    }

    #[tokio::test]
    async fn reassembles_across_arbitrary_tcp_segmentation() {
        let wire = Wire::open(Recorder::default()).await;
        for octet in b"A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n" {
            wire.send([*octet]).await;
            tick().await;
        }
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "password"));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn keeps_octets_a_quoted_string_could_not_carry() {
        let wire = Wire::open(Recorder::default()).await;
        // 12 octets: quotes, a backslash, a brace, a space.
        wire.send("A1 LOGIN {5+}\r\nadmin {12+}\r\np@ss \"w\\d {}\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "p@ss \"w\\d {}"));
    }

    #[tokio::test]
    async fn answers_an_unparseable_literal_command_on_its_own_tag_never_on_the_payload() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 FOOBAR {5+}\r\nadmin\r\n").await;
        settle().await;

        assert!(wire.dispatched().is_empty());
        assert_eq!(wire.output(), "A1 BAD Unknown command: FOOBAR\r\n");
    }

    #[tokio::test]
    async fn still_reassembles_an_append_literal() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        wire.send("a1 APPEND INBOX (\\Seen) {11}\r\n").await;
        wire.wait_for_output("+ go ahead\r\n").await;
        settle().await;
        assert_eq!(wire.output(), "+ go ahead\r\n");

        wire.send("Hello World\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].tag, "a1");
        assert_eq!(dispatched[0].append().mailbox, "INBOX");
        assert_eq!(dispatched[0].message_text(), "Hello World");
    }

    #[tokio::test]
    async fn counts_a_literal_in_octets_not_utf16_code_units() {
        let wire = Wire::open(Recorder::default()).await;
        // "pässword" is 8 code units and 9 octets. A code-unit count takes 8
        // characters, the password loses its last letter and swallows the
        // CR, and the pipelined A2 is never answered.
        let payload = "pässword".as_bytes();
        assert_eq!(payload.len(), 9);
        wire.send([b"A1 LOGIN {5+}\r\nadmin {9+}\r\n".as_slice(), payload, b"\r\nA2 NOOP\r\n"].concat()).await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1", "A2"]);
        assert_eq!(wire.dispatched()[0].request, login("admin", "pässword"));
    }

    #[tokio::test]
    async fn reassembles_a_multi_byte_character_split_across_tcp_segments() {
        let wire = Wire::open(Recorder::default()).await;
        let payload = "café".as_bytes(); // 5 octets, 4 code units
        wire.send_pieces(&[b"A1 SELECT {5+}\r\n", &payload[..4], &[payload[4], b'\r', b'\n']]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, ImapRequest::Select(SelectRequest { mailbox: "café".into() }));
    }

    #[tokio::test]
    async fn carries_an_append_payload_through_byte_for_byte_trailing_crlf_included() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        let message = "Subject: x\r\n\r\nbody\r\n";
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", message.len())).await;
        tick().await;
        wire.send(format!("{message}\r\n")).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message_text(), message);
    }

    #[tokio::test]
    async fn dispatches_when_the_payload_consumed_its_own_terminator_instead_of_wedging() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        // The client counted the CRLF into {N} and sent nothing after it.
        wire.send("a1 APPEND INBOX {13+}\r\nHello World\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message_text(), "Hello World\r\n");
    }

    #[tokio::test]
    async fn accepts_a_zero_length_literal() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {0+}\r\n\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message_text(), "");
    }

    #[tokio::test]
    async fn does_not_read_a_trailing_brace_number_inside_an_argument_as_a_literal_declaration() {
        let wire = Wire::open(Recorder::default()).await;
        // `p@ss{5}` is a password that happens to end in brace-digits.
        wire.send("A1 LOGIN admin p@ss{5}\r\nA2 NOOP\r\n").await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1", "A2"]);
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn waits_for_the_rest_of_the_line_when_a_non_final_payload_is_flushed_on_its_own() {
        let wire = Wire::open(Recorder::default()).await;
        // An empty buffer means "nothing more has arrived YET": `admin` is not
        // the last argument, so the tail is still in flight.
        wire.send_pieces(&[b"A1 LOGIN {5+}\r\n", b"admin"]).await;
        settle().await;
        assert!(wire.dispatched().is_empty());
        wire.send(" \"hunter2\"\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "hunter2"));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn reassembles_two_literals_when_the_first_payload_is_flushed_on_its_own() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 LOGIN {5+}\r\n", b"admin", b" {8+}\r\n", b"password\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "password"));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn emits_exactly_one_continuation_per_synchronizing_declaration() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 LOGIN {5}\r\n", b"admin", b" {8}\r\n", b"password\r\n"]).await;
        wire.wait_for_output("+ go ahead\r\n+ go ahead\r\n").await;
        settle().await;

        assert_eq!(wire.output(), "+ go ahead\r\n+ go ahead\r\n");
        assert_eq!(wire.tags(), ["A1"]);
    }

    #[tokio::test]
    async fn reassembles_a_two_literal_rename_whose_first_payload_is_flushed_on_its_own() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 RENAME {5+}\r\n", b"Oldie", b" {5+}\r\n", b"Newie\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, ImapRequest::Rename { old_name: "Oldie".into(), new_name: "Newie".into() });
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn keeps_a_final_append_payload_dispatching_when_its_trailing_crlf_arrives_separately() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        let message = "Subject: x\r\n\r\nbody";
        let header = format!("a1 APPEND INBOX {{{}+}}\r\n", message.len());
        wire.send_pieces(&[header.as_bytes(), message.as_bytes(), b"\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message_text(), message);
    }

    #[tokio::test]
    async fn waits_for_the_tail_when_a_non_final_payloads_own_octets_end_in_crlf() {
        let wire = Wire::open(Recorder::default()).await;
        // A literal carries octets a quoted string cannot, CRLF included, so a
        // payload ending in CRLF says nothing about whether the command is
        // over. The parser does: `A1 LOGIN {7+}` + ["admin\r\n"] does not parse.
        wire.send_pieces(&[b"A1 LOGIN {7+}\r\n", b"admin\r\n"]).await;
        settle().await;
        assert!(wire.dispatched().is_empty());
        wire.send(" \"hunter2-crlf-tail\"\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin\r\n", "hunter2-crlf-tail"));
        assert_eq!(wire.output(), "");
        assert!(!journal_text().contains("hunter2-crlf-tail"));
    }

    #[tokio::test]
    async fn emits_no_extra_continuation_for_a_crlf_ending_payload_in_the_synchronizing_form() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 LOGIN {7}\r\n", b"admin\r\n", b" {8}\r\n", b"password\r\n"]).await;
        wire.wait_for_output("+ go ahead\r\n+ go ahead\r\n").await;
        settle().await;

        assert_eq!(wire.output(), "+ go ahead\r\n+ go ahead\r\n");
        assert_eq!(wire.tags(), ["A1"]);
    }

    #[tokio::test]
    async fn waits_for_the_tail_of_a_rename_whose_first_payload_ends_in_crlf() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 RENAME {7+}\r\n", b"Oldie\r\n", b" {5+}\r\n", b"Newie\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, ImapRequest::Rename { old_name: "Oldie\r\n".into(), new_name: "Newie".into() });
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn answers_a_command_pipelined_behind_a_payload_that_consumed_its_own_terminator() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        // RFC 3501 §7 requires a tagged completion for every command.
        wire.send("a1 APPEND INBOX {13+}\r\nHello World\r\na2 NOOP\r\n").await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(wire.tags(), ["a1", "a2"]);
        assert_eq!(dispatched[0].message_text(), "Hello World\r\n");
        assert_eq!(dispatched[1].request, ImapRequest::Noop);
    }

    #[tokio::test]
    async fn answers_a_literal_declaring_command_pipelined_behind_a_self_terminated_payload() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {13+}\r\nHello World\r\na2 SELECT {5+}\r\nINBOX\r\n").await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert_eq!(wire.tags(), ["a1", "a2"]);
        assert_eq!(wire.dispatched()[1].request, ImapRequest::Select(SelectRequest { mailbox: "INBOX".into() }));
    }

    #[tokio::test]
    async fn still_chains_a_separated_literal_onto_a_command_that_already_parses() {
        let wire = Wire::open(Recorder::default()).await;
        // `SEARCH SUBJECT {3+}` + ["foo"] is complete on its own; the
        // separating SP is what marks the tail as its continuation.
        wire.send("A1 SEARCH SUBJECT {3+}\r\nfoo FROM {3+}\r\nbar\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.dispatched()[0].request, subject_from("foo", "bar"));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn still_chains_a_separated_literal_when_the_first_payload_arrives_alone() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 SEARCH SUBJECT {3+}\r\nfoo", b" FROM {3+}\r\nbar\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.dispatched()[0].request, subject_from("foo", "bar"));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn draws_one_continuation_per_declaration_for_a_chained_search_flushed_alone() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 SEARCH SUBJECT {3}\r\n", b"foo", b" FROM {3}\r\n", b"bar\r\n"]).await;
        wire.wait_for_output("+ go ahead\r\n+ go ahead\r\n").await;
        settle().await;

        assert_eq!(wire.output(), "+ go ahead\r\n+ go ahead\r\n");
        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.dispatched()[0].request, subject_from("foo", "bar"));
    }

    #[tokio::test]
    async fn chains_a_separated_literal_onto_a_search_whose_payload_spans_two_segments() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 SEARCH SUBJECT {6+}\r\nfoo", b"bar", b" FROM {3+}\r\nbaz\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.dispatched()[0].request, subject_from("foobar", "baz"));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn chains_through_the_uid_wrapper_when_the_payload_arrives_alone() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 UID SEARCH SUBJECT {3+}\r\nfoo", b" FROM {3+}\r\nbar\r\n"]).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.dispatched()[0].request, ImapRequest::Uid(UidRequest::new("SEARCH", subject_from("foo", "bar"))));
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn keeps_an_unseparated_literal_tail_chaining_while_the_command_is_incomplete() {
        let wire = Wire::open(Recorder::default()).await;
        // `A1 LOGIN {5+}` + ["admin"] does not parse yet, so this tail is still
        // an argument even though it sits flush against the buffer start.
        wire.send("A1 LOGIN {5+}\r\nadminA2 LOGIN {8+}\r\nhunter22\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn processes_a_command_pipelined_behind_a_literal_command() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\nA2 NOOP\r\n").await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1", "A2"]);
        assert_eq!(wire.dispatched()[1].request, ImapRequest::Noop);
    }
}

// ---------------------------------------------------------------------------
// Credential logging (handler-literal.test.ts)
// ---------------------------------------------------------------------------

mod credential_logging {
    use super::*;

    #[tokio::test]
    async fn never_writes_a_literal_credential_to_the_journal() {
        let wire = Wire::open(Recorder::default()).await;
        // Missing password: forces the parse-failure line.
        wire.send("A1 LOGIN {11+}\r\nadmin-lit-1\r\n").await;
        settle().await;

        let journal = journal_text();
        assert!(!journal.contains("admin-lit-1"));
        assert!(journal.contains("A1 LOGIN [REDACTED]"));
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn never_writes_a_plain_argument_password_to_the_journal() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN admin hunter2-plain-1\r\n").await;
        settle().await;

        let journal = journal_text();
        assert!(!journal.contains("hunter2-plain-1"));
        assert!(journal.contains("A1 LOGIN [REDACTED]"));
    }

    #[tokio::test]
    async fn redacts_an_untagged_login_which_only_ever_reaches_the_failure_log() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("LOGIN admin hunter2-untagged-1\r\n").await;
        settle().await;

        let journal = journal_text();
        assert!(!journal.contains("hunter2-untagged-1"));
        assert!(journal.contains("LOGIN [REDACTED]"));
    }

    // A credential that non-conformant framing strands on a line of its own is
    // a bare astring, with no LOGIN prefix for the anchored redactor to key
    // on, so it reaches the journal and the wire verbatim. Pinned as the Bun
    // server has it.
    #[tokio::test]
    async fn leaves_a_credential_stranded_on_its_own_line_un_redacted() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\nadmin\r\nhunter2-stranded-1\r\n").await;
        settle().await;

        assert!(journal_text().contains("hunter2-stranded-1"));
        assert!(wire.output().contains("hunter2-stranded-1 BAD Invalid command\r\n"));
    }
}

// ---------------------------------------------------------------------------
// Literal ceilings (handler-literal-cap.test.ts)
// ---------------------------------------------------------------------------

fn toobig(tag: &str, cap: usize) -> String {
    format!("{tag} NO [TOOBIG] Literal exceeds {cap} octets\r\n")
}

mod literal_ceiling {
    use super::*;

    #[tokio::test]
    async fn refuses_an_over_cap_synchronizing_literal_without_prompting_for_it() {
        let wire = Wire::open(Recorder::default()).await;
        // Withholding the continuation keeps the payload off the wire: the
        // client is still waiting for a permission it never gets.
        wire.send(format!("A1 SELECT {{{}}}\r\n", SMALL_CAP + 1)).await;
        wire.wait_for_output(&toobig("A1", SMALL_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));
        assert!(wire.dispatched().is_empty());
        assert!(!wire.closed());
    }

    #[tokio::test]
    async fn keeps_serving_the_session_after_refusing_a_synchronizing_literal() {
        let wire = Wire::open(Recorder::default()).await;
        // A conforming client sends no payload, so nothing may be swallowed.
        wire.send(format!("A1 SELECT {{{}}}\r\nA2 NOOP\r\n", SMALL_CAP + 1)).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A2"]);
        assert_eq!(wire.dispatched()[0].request, ImapRequest::Noop);
    }

    #[tokio::test]
    async fn does_not_echo_back_a_synchronizing_payload_the_peer_sent_anyway() {
        let wire = Wire::open(Recorder::default()).await;
        // The payload of a refused literal, sent anyway, is read as a command
        // line. Its first token is far over the tag ceiling, so it is answered
        // untagged rather than echoed.
        let declared = SMALL_CAP + 810;
        wire.send(format!("A1 LOGIN admin {{{declared}}}\r\n")).await;
        settle().await;
        let marker = "S3cretEcho1";
        wire.send([marker.as_bytes(), &vec![b'x'; declared - marker.len()], b"\r\n"].concat()).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines[0], toobig("A1", SMALL_CAP));
        assert!(!wire.output().contains(marker));
        for line in &lines {
            assert!(line.len() < 256, "{line:?}");
        }
        // Every DEBUG field carrying raw wire text is clipped, not only the
        // parse failure's.
        let journaled = journaled_wire_text(marker);
        assert!(!journaled.is_empty());
        for entry in journaled {
            assert!(entry.len() <= TRACE_LINE_CAP + 16, "{} octets", entry.len());
        }
    }

    #[tokio::test]
    async fn answers_a_tag_at_the_ceiling_with_that_tag_not_an_untagged_bad() {
        let wire = Wire::open(Recorder::default()).await;
        let uuid_tag = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
        let ceiling_tag = "T".repeat(TAG_CAP);
        wire.send(format!("{uuid_tag} FROBNICATE\r\n")).await;
        settle().await;
        wire.send(format!("{ceiling_tag} FROBNICATE\r\n")).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with(&format!("{uuid_tag} BAD ")));
        assert!(lines[1].starts_with(&format!("{ceiling_tag} BAD ")));
        assert!(!wire.closed());
    }

    #[tokio::test]
    async fn does_not_echo_a_refused_payloads_first_token_past_the_tag_ceiling() {
        let wire = Wire::open(Recorder::default()).await;
        let declared = SMALL_CAP + 810;
        wire.send(format!("A1 LOGIN admin {{{declared}}}\r\n")).await;
        settle().await;

        let marker = "S3cretTok";
        let over_cap_token = format!("{marker}{}", "x".repeat(TAG_CAP + 1 - marker.len()));
        assert_eq!(over_cap_token.len(), TAG_CAP + 1);
        let tail = format!(" notthetag {}", "y".repeat(declared - over_cap_token.len() - 11));
        wire.send(format!("{over_cap_token}{tail}\r\n")).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines[0], toobig("A1", SMALL_CAP));
        // The untagged completion, and the payload's SECOND token, which is
        // what reaches the peer once the first is refused as a tag.
        assert_eq!(lines[1], "* BAD Unknown command: NOTTHETAG\r\n");
        assert!(!wire.output().contains(marker));
        for line in &lines {
            assert!(line.len() < 256);
        }
    }

    #[tokio::test]
    async fn does_not_echo_a_refused_payloads_second_token_inside_the_parse_error() {
        let wire = Wire::open(Recorder::default()).await;
        let declared = SMALL_CAP + 810;
        wire.send(format!("A1 LOGIN admin {{{declared}}}\r\n")).await;
        settle().await;

        let short_token = "S3cret";
        wire.send([format!("{short_token} ").as_bytes(), &vec![b'x'; declared - short_token.len() - 1], b"\r\n"].concat())
            .await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines[0], toobig("A1", SMALL_CAP));
        assert!(lines[1].starts_with(&format!("{short_token} BAD Unknown command: ")));
        assert!(lines[1].contains("…[+"));
        for line in &lines {
            assert!(line.len() < TRACE_LINE_CAP + TAG_CAP + 64);
        }
    }

    #[tokio::test]
    async fn does_not_echo_a_non_ascii_first_token_whose_octets_exceed_the_tag_ceiling() {
        let wire = Wire::open(Recorder::default()).await;
        let wide_tag = "é".repeat(TAG_CAP);
        assert_eq!(wide_tag.chars().count(), TAG_CAP);
        assert_eq!(wide_tag.len(), TAG_CAP * 2);
        wire.send(format!("{wide_tag} FROBNICATE\r\n")).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("* BAD "));
        assert!(!lines[0].contains('é'));
        assert!(lines[0].len() <= TAG_CAP);
    }

    #[tokio::test]
    async fn does_not_echo_a_refused_payload_whose_tail_parses_back_inside_the_completion() {
        let wire = Wire::open(Recorder::real()).await;
        let declared = SMALL_CAP + 810;
        wire.send(format!("A1 LOGIN admin {{{declared}}}\r\n")).await;
        settle().await;
        let verb = " NOOP";
        wire.send([vec![b'A'; declared - verb.len()].as_slice(), verb.as_bytes(), b"\r\n"].concat()).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines[0], toobig("A1", SMALL_CAP));
        // The line parses and is still refused: a completion the peer cannot
        // match to a tag it sent completes nothing.
        assert!(wire.dispatched().is_empty());
        assert_eq!(lines[1], "* BAD Command tag too long\r\n");
        for line in &lines {
            assert!(line.len() < TRACE_LINE_CAP + TAG_CAP + 64);
        }
    }

    #[tokio::test]
    async fn bounds_the_tag_of_a_parsing_line_that_declares_no_literal_at_all() {
        let wire = Wire::open(Recorder::real()).await;
        let line = format!("{} NOOP\r\n", "A".repeat(65_000));
        assert!(line.len() < UNCONSUMED_CAP);
        wire.send(line).await;
        settle().await;

        assert!(wire.dispatched().is_empty());
        assert_eq!(wire.output(), "* BAD Command tag too long\r\n");
        assert!(!wire.closed());
    }

    #[tokio::test]
    async fn clips_what_a_line_puts_back_by_octets_not_by_utf16_code_units() {
        let wire = Wire::open(Recorder::default()).await;
        // Each octet that is not valid UTF-8 decodes to one U+FFFD: one code
        // unit inbound, three octets again on the way out.
        wire.send([b"C1oct ".as_slice(), &[0xff; 3000], b"\r\n"].concat()).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("C1oct BAD Unknown command: "));
        assert!(lines[0].contains("…[+"));
        assert!(lines[0].len() < TRACE_LINE_CAP + TAG_CAP + 64);

        // 200 replacement characters: 200 code units, 600 octets. Under the
        // cap by the wrong measure, over it by the named one.
        wire.send([b"C2oct ".as_slice(), &[0xff; 200], b"\r\n"].concat()).await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].starts_with("C2oct BAD Unknown command: "));
        assert!(lines[1].contains("…[+"));
        assert!(lines[1].len() < TRACE_LINE_CAP + TAG_CAP + 64);

        let journaled: Vec<String> = journaled_wire_text("C1oct").into_iter().chain(journaled_wire_text("C2oct")).collect();
        assert!(!journaled.is_empty());
        for entry in journaled {
            assert!(entry.len() <= TRACE_LINE_CAP + 16, "{} octets", entry.len());
        }
    }

    #[tokio::test]
    async fn discards_an_over_cap_literal_plus_payload_instead_of_accumulating_it() {
        let wire = Wire::open(Recorder::default()).await;
        let declared = SMALL_CAP + 1024;
        wire.send(format!("A1 SELECT {{{declared}+}}\r\n")).await;
        wire.wait_for_output(&toobig("A1", SMALL_CAP)).await;
        settle().await;
        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));

        // The octets are already in flight; they can only be counted out.
        wire.send(vec![b'A'; declared]).await;
        wire.send("\r\nA2 NOOP\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        // The discarded payload produced no commands of its own.
        assert_eq!(wire.tags(), ["A2"]);
        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));
    }

    #[tokio::test]
    async fn counts_a_refused_literal_plus_payload_out_across_tcp_segments() {
        let wire = Wire::open(Recorder::default()).await;
        let declared = SMALL_CAP + 3000;
        wire.send(format!("A1 SELECT {{{declared}+}}\r\n")).await;
        settle().await;
        let mut sent = 0;
        while sent < declared {
            let chunk = 1000.min(declared - sent);
            wire.send(vec![b'B'; chunk]).await;
            sent += chunk;
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        wire.send("\r\nA2 NOOP\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A2"]);
    }

    #[tokio::test]
    async fn never_lets_a_refused_literal_plus_tail_reach_the_journal_or_the_wire() {
        let wire = Wire::open(Recorder::default()).await;
        // If the discard stopped at the payload, the remaining arguments
        // would be read as a command of their own: for LOGIN, the password.
        let declared = SMALL_CAP + 16;
        wire.send(format!("A1 LOGIN {{{declared}+}}\r\n")).await;
        settle().await;
        wire.send(vec![b'C'; declared]).await;
        wire.send(" \"hunter2-refused-tail\"\r\nA2 NOOP\r\n").await;
        settle().await;

        assert!(!journal_text().contains("hunter2-refused-tail"));
        assert!(!wire.output().contains("hunter2-refused-tail"));
        assert_eq!(wire.tags(), ["A2"]);
    }

    #[tokio::test]
    async fn gives_an_authenticated_append_a_message_sized_ceiling_not_the_small_argument_one() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        let message = "x".repeat(SMALL_CAP + 4096);
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", message.len())).await;
        settle().await;
        wire.send(&message).await;
        tick().await;
        wire.send("\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message_text(), message);
        assert_eq!(wire.output(), "");
    }

    #[tokio::test]
    async fn refuses_an_append_past_the_message_ceiling() {
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // Refused on the declaration, before a single payload octet is held.
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", APPEND_CAP + 1)).await;
        wire.wait_for_output(&toobig("a1", APPEND_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("a1", APPEND_CAP));
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn ends_the_session_on_a_literal_plus_declaration_past_the_command_ceiling() {
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // No command fits above the ceiling, so counting the payload out
        // would buy nothing: the session ends as the chain cap ends it.
        wire.send("a1 APPEND INBOX {4000000000+}\r\n").await;
        wire.wait_for_close().await;

        assert_eq!(wire.output(), "* BYE Command too long\r\n");
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn still_refuses_rather_than_closes_when_the_payload_was_never_invited() {
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // Synchronizing: the continuation is withheld, nothing is in flight.
        wire.send("a1 APPEND INBOX {4000000000}\r\n").await;
        wire.wait_for_output(&toobig("a1", APPEND_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("a1", APPEND_CAP));
        assert!(!wire.closed());
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn holds_an_unauthenticated_append_to_the_small_argument_ceiling() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", SMALL_CAP + 4096)).await;
        wire.wait_for_output(&toobig("a1", SMALL_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("a1", SMALL_CAP));
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn holds_an_authenticated_appends_mailbox_name_literal_to_the_small_argument_ceiling() {
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send(format!("a1 APPEND {{{}}}\r\n", SMALL_CAP + 1)).await;
        wire.wait_for_output(&toobig("a1", SMALL_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("a1", SMALL_CAP));
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn holds_a_literal_chained_after_an_appends_message_to_the_small_argument_ceiling() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send(format!("a1 APPEND INBOX {{5+}}\r\nhello {{{}}}\r\n", SMALL_CAP + 1)).await;
        wire.wait_for_output(&toobig("a1", SMALL_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("a1", SMALL_CAP));
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn gives_the_message_after_a_mailbox_name_literal_the_message_sized_ceiling() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        let message = "x".repeat(SMALL_CAP + 4096);
        wire.send(format!("a1 APPEND {{6+}}\r\nDrafts {{{}+}}\r\n", message.len())).await;
        settle().await;
        wire.send(format!("{message}\r\n")).await;
        settle().await;

        assert_eq!(wire.output(), "");
        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].append().mailbox, "Drafts");
        assert_eq!(dispatched[0].message_text(), message);
    }

    #[tokio::test]
    async fn caps_the_second_literal_of_a_chain_on_the_commands_own_verb_and_tag() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\n").await;
        settle().await;
        wire.send("admin").await;
        tick().await;
        wire.send(format!(" {{{}}}\r\n", SMALL_CAP + 1)).await;
        wire.wait_for_output(&toobig("A1", SMALL_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));
        assert!(wire.dispatched().is_empty());
    }
}

// ---------------------------------------------------------------------------
// Unread command text (handler-literal-cap.test.ts)
// ---------------------------------------------------------------------------

/// The stream size the reading-stops tests run over: small, so a server
/// that stops reading blocks the client's writes almost at once.
const NARROW: usize = 4096;

fn pausing_lines(wire: &Wire) -> usize {
    journal_of(&wire.remote).iter().filter(|(_, message, _)| message.contains("pausing socket")).count()
}

mod unread_command_text_ceiling {
    use super::*;

    #[tokio::test]
    async fn stops_reading_from_a_peer_whose_line_never_terminates() {
        let wire = Wire::open_with(Recorder::default(), Setup { capacity: Some(NARROW), ..Setup::default() }).await;
        wire.send("A1 SELECT ").await;
        settle().await;
        let flood = wire.flood(vec![vec![b'A'; 4096]; 64]);
        tokio::time::sleep(Duration::from_millis(300)).await;

        // No literal bounds this: only the unread-text ceiling does. Past it
        // the server takes no more, and the peer is told nothing.
        assert!(!flood.is_done(), "the server kept reading");
        assert!(flood.written() <= UNCONSUMED_CAP + 3 * NARROW, "{} octets taken", flood.written());
        assert_eq!(pausing_lines(&wire), 1);
        assert_eq!(wire.output(), "");
        assert!(!wire.closed());
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn stops_reading_a_flood_whose_every_line_terminates() {
        let (recorder, release) = parking_hook();
        let wire = Wire::open_with(recorder, Setup { capacity: Some(NARROW), ..Setup::default() }).await;
        wire.send("A1 NOOP\r\n").await;
        wire.wait_for_dispatches(1).await;

        // Every line ends in CRLF, so no line ceiling sees this; the command
        // in progress is what holds the rest unread.
        let line = format!("A2 SELECT {}\r\n", "x".repeat(1012)).into_bytes();
        let flood = wire.flood(vec![line.clone(); 512]);
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(!flood.is_done(), "the server kept reading");
        assert!(flood.written() <= UNCONSUMED_CAP + line.len());
        assert!(!wire.closed());
        release.notify_one();
    }

    #[tokio::test]
    async fn stops_reading_while_a_command_is_parked_mid_drain() {
        let (recorder, release) = parking_hook();
        let wire = Wire::open_with(recorder, Setup { capacity: Some(NARROW), ..Setup::default() }).await;
        wire.send("A1 NOOP\r\n").await;
        wire.wait_for_dispatches(1).await;
        assert_eq!(wire.tags(), ["A1"]);

        let flood = wire.flood(vec![b"A2 SELECT ".to_vec(), vec![b'A'; UNCONSUMED_CAP + 1]]);
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(!flood.is_done(), "the server kept reading");
        assert!(!wire.closed());
        release.notify_one();
    }

    #[tokio::test]
    async fn reads_again_once_the_drain_has_consumed_what_was_held() {
        let (recorder, release) = parking_hook();
        let wire = Wire::open_with(recorder, Setup { capacity: Some(NARROW), ..Setup::default() }).await;
        wire.send("A1 NOOP\r\n").await;
        wire.wait_for_dispatches(1).await;

        // Under the ceiling here: a line still incomplete past it is a line
        // the server will never finish reading, on either server.
        let flood = wire.flood(vec![[b"A2 SELECT ".as_slice(), &vec![b'A'; UNCONSUMED_CAP - 100], b"\r\n"].concat()]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!flood.is_done());

        // Not a wedge: once the command in progress is over, the client that
        // merely outran it is read again.
        release.notify_one();
        wire.wait_for_dispatches(2).await;
        assert!(wait_for(Duration::from_secs(5), || flood.is_done()).await);
        assert!(!wire.closed());
        assert_eq!(wire.tags(), ["A1", "A2"]);
    }

    #[tokio::test]
    async fn keeps_the_bound_after_an_over_cap_declaration_armed_the_discard() {
        let wire = Wire::open_with(Recorder::default(), Setup { capacity: Some(NARROW), ..Setup::default() }).await;
        wire.send(format!("A1 LOGIN {{{PENDING_CAP}+}}\r\n")).await;
        wire.wait_for_output(&toobig("A1", SMALL_CAP)).await;
        settle().await;
        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));

        // What is counted out is never held: the discard consumes as it
        // reads, and the connection is read on.
        let flood = wire.flood(vec![vec![b'Z'; 32 * 1024]; 64]);
        assert!(wait_for(Duration::from_secs(10), || flood.is_done()).await, "the discard is not wedged");
        assert_eq!(pausing_lines(&wire), 0);
        assert!(!wire.closed());
        assert!(wire.dispatched().is_empty());
        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));
    }

    #[tokio::test]
    async fn leaves_a_long_but_legal_command_line_alone() {
        let wire = Wire::open(Recorder::default()).await;
        // A UID set naming thousands of messages is a real command.
        let uids: Vec<String> = (1..=4000).map(|uid| uid.to_string()).collect();
        let uids = uids.join(",");
        assert!(uids.len() < UNCONSUMED_CAP);
        wire.send(format!("A1 UID FETCH {uids} (FLAGS)\r\n")).await;
        settle().await;

        assert_eq!(pausing_lines(&wire), 0);
        assert!(!wire.closed());
        assert_eq!(wire.tags(), ["A1"]);
        assert!(matches!(wire.dispatched()[0].request, ImapRequest::Uid(_)));
    }

    #[tokio::test]
    async fn does_not_count_an_announced_append_payload_as_unread_command_text() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // An APPEND body is octets, not a command line, and it legitimately
        // runs past the bound.
        let message = "y".repeat(UNCONSUMED_CAP + 4096);
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", message.len())).await;
        settle().await;
        wire.send(&message).await;
        tick().await;
        wire.send("\r\n").await;
        settle().await;

        assert!(!wire.closed());
        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message_text(), message);
    }

    #[tokio::test]
    async fn delivers_a_fragmented_append_whose_declaration_is_queued_behind_a_parked_drain() {
        let _spool = spool_test_lock().await;
        let (recorder, release) = parking_hook();
        let wire =
            Wire::open_with(recorder, Setup { authenticated: true, capacity: Some(NARROW), ..Setup::default() }).await;
        wire.send("a1 NOOP\r\n").await;
        wire.wait_for_dispatches(1).await;

        // Until the declaration is read the payload is indistinguishable from
        // unread command text, and it arrives in pieces with no CRLF.
        let message = "z".repeat(200_000);
        let mut chunks = vec![format!("a2 APPEND INBOX {{{}+}}\r\n", message.len()).into_bytes()];
        chunks.extend(message.as_bytes().chunks(32 * 1024).map(<[u8]>::to_vec));
        chunks.push(b"\r\n".to_vec());
        let flood = wire.flood(chunks);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!flood.is_done(), "nothing is read while the first command runs");
        assert!(flood.written() > 0);

        release.notify_one();
        assert!(wait_for(Duration::from_secs(10), || flood.is_done()).await);
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert!(!wire.closed());
        assert_eq!(wire.output(), "");
        assert_eq!(wire.tags(), ["a1", "a2"]);
        assert_eq!(wire.dispatched()[1].message_text(), message);
    }
}

// ---------------------------------------------------------------------------
// The literal chain (handler-literal-cap.test.ts)
// ---------------------------------------------------------------------------

mod literal_chain_ceiling {
    use super::*;

    #[tokio::test]
    async fn ends_the_session_on_a_literal_chain_no_real_command_would_send() {
        let wire = Wire::open(Recorder::default()).await;
        // Each declaration is under the per-literal cap; only the chain cap
        // bounds how many one command holds.
        wire.send("A1 LOGIN {1+}\r\n").await;
        settle().await;
        for _ in 0..200 {
            if !wire.try_send("x {1+}\r\n").await || wire.closed() {
                break;
            }
            tick().await;
        }
        wire.wait_for_close().await;

        assert_eq!(wire.output(), "* BYE Command too long\r\n");
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn refuses_rather_than_closes_a_chained_synchronizing_declaration() {
        let wire = Wire::open(Recorder::default()).await;
        // A synchronizing declaration is held by nothing: its continuation
        // is withheld, so it is refused and the session goes on.
        wire.send("A1 LOGIN {5+}\r\n").await;
        settle().await;
        wire.send("admin").await;
        tick().await;
        wire.send(format!(" {{{}}}\r\n", PENDING_CAP + 1)).await;
        wire.wait_for_output(&toobig("A1", SMALL_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("A1", SMALL_CAP));
        assert!(!wire.closed());
        assert!(wire.dispatched().is_empty());
    }

    // The one way a chain reaches the byte ceiling: a message at the APPEND
    // cap with small literals chained behind it. Each declaration rides in
    // its payload's last segment, so the command is never complete early.
    const LINKS_BESIDE_MESSAGE: usize = 7;

    fn plus_link() -> Vec<u8> {
        format!(" {{{SMALL_CAP}+}}\r\n").into_bytes()
    }

    async fn send_message_and_links(wire: &Wire) {
        wire.send(format!("a1 APPEND INBOX {{{APPEND_CAP}+}}\r\n")).await;
        settle().await;
        // The message's last octets travel with the next declaration, in a
        // write of their own once the rest has been read: a read that ended
        // exactly at the message would find the command complete.
        wire.send(vec![b'y'; APPEND_CAP - 100]).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        wire.send([vec![b'y'; 100], plus_link()].concat()).await;
        settle().await;
        for _ in 1..LINKS_BESIDE_MESSAGE {
            wire.send([vec![b'z'; SMALL_CAP], plus_link()].concat()).await;
            settle().await;
        }
    }

    #[tokio::test]
    async fn withholds_a_continuation_the_chain_has_no_room_left_for() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        send_message_and_links(&wire).await;
        // Under the ceiling, every link under its own cap: nothing refused.
        assert_eq!(wire.output(), "");
        assert!(!wire.closed());

        wire.send([vec![b'z'; SMALL_CAP], format!(" {{{SMALL_CAP}}}\r\n").into_bytes()].concat()).await;
        settle().await;

        // The cap named is what the chain has left, not the per-literal cap
        // the declaration clears.
        let lines = wire.lines();
        assert_eq!(lines.len(), 1);
        let named = lines[0]
            .strip_prefix("a1 NO [TOOBIG] Literal exceeds ")
            .and_then(|rest| rest.strip_suffix(" octets\r\n"))
            .and_then(|cap| cap.parse::<usize>().ok())
            .expect("a TOOBIG refusal");
        assert!(named > 0 && named < SMALL_CAP, "{named}");
        assert!(!wire.closed());
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn ends_the_session_on_chained_payloads_that_outgrow_the_byte_ceiling() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // The link count is still single digits: only the byte ceiling can
        // end this one.
        const { assert!(LINKS_BESIDE_MESSAGE + 1 < CHAIN_CAP) };
        send_message_and_links(&wire).await;
        assert!(!wire.closed());

        wire.send([vec![b'z'; SMALL_CAP], plus_link()].concat()).await;
        wire.wait_for_close().await;

        assert_eq!(wire.output(), "* BYE Command too long\r\n");
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn leaves_a_command_with_a_real_number_of_literals_alone() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send_pieces(&[b"A1 LOGIN {5+}\r\n", b"admin", b" {8+}\r\n", b"password\r\n"]).await;
        settle().await;

        assert!(!wire.closed());
        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "password"));
    }
}

// ---------------------------------------------------------------------------
// A pipelined literal declaration (handler-literal-cap.test.ts)
// ---------------------------------------------------------------------------

mod pipelined_literal_declaration {
    use super::*;

    #[tokio::test]
    async fn answers_a_pipelined_command_that_opens_with_its_own_literal_declaration() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {13+}\r\nHello World\r\na2 SEARCH SUBJECT {3+}\r\nfoo\r\n").await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert_eq!(wire.tags(), ["a1", "a2"]);
    }

    #[tokio::test]
    async fn still_chains_an_argument_tail_that_declares_the_next_literal() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\nadmin {17+}\r\nhunter2-arg-tail1\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert!(!wire.output().contains("hunter2-arg-tail1"));
    }

    #[tokio::test]
    async fn keeps_an_unseparated_literal_tail_chaining_while_the_command_is_incomplete() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\nadminA2 LOGIN {8+}\r\nhunter22\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        assert_eq!(wire.tags(), ["A1"]);
        assert_eq!(wire.output(), "");
    }
}

// ---------------------------------------------------------------------------
// Chained literal pacing (handler-literal-chain-pacing.test.ts)
// ---------------------------------------------------------------------------

mod chained_literal_pacing {
    use super::*;

    #[tokio::test]
    async fn charges_a_slot_for_the_chained_declaration_not_only_the_header_line() {
        let wire = Wire::open(Recorder::default()).await;
        wire.send("A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n").await;
        settle().await;

        // The header line, then the tail declaring the password.
        assert_eq!(wire.session.slots_taken(), 2);
        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].request, login("admin", "password"));
    }

    #[tokio::test]
    async fn charges_a_slot_per_link_across_a_long_chain() {
        let wire = Wire::open(Recorder::default()).await;
        // SEARCH takes an unbounded key list: the chain a peer can extend.
        let links = 30;
        wire.send(format!("A1 SEARCH SUBJECT {{1+}}\r\nx{}\r\n", " FROM {1+}\r\nx".repeat(links))).await;
        settle().await;

        assert_eq!(wire.session.slots_taken(), links as u64 + 1);
    }

    #[tokio::test]
    async fn leaves_an_unchained_command_charged_exactly_once() {
        let wire = Wire::open(Recorder::default()).await;
        // The completing tail of a one-literal command is paid for by its
        // header line.
        wire.send("A1 SELECT {5+}\r\nINBOX\r\n").await;
        settle().await;

        assert_eq!(wire.session.slots_taken(), 1);
        assert_eq!(wire.dispatched().len(), 1);
    }

    #[tokio::test]
    async fn holds_a_segmented_literal_whole() {
        let _spool = spool_test_lock().await;
        let wire = Wire::open_authenticated(Recorder::default()).await;
        let payload = 2 * 1024 * 1024;
        let segment = vec![b'A'; 64 * 1024];
        // The client counts the message's own terminator into `{N}`.
        let declared = payload + 2;
        wire.send(format!("A1 APPEND INBOX {{{declared}+}}\r\n")).await;
        settle().await;
        for _ in 0..payload / segment.len() {
            wire.send(&segment).await;
        }
        wire.send("\r\n").await;
        wire.wait_for_dispatches(1).await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched[0].append().message.size, declared as u64);
        assert_eq!(dispatched[0].message.as_ref().unwrap().len(), declared);
    }
}

// ---------------------------------------------------------------------------
// The APPEND literal spool (handler-append-spool.test.ts)
// ---------------------------------------------------------------------------

mod append_literal_spool {
    use super::*;

    /// A hook that answers the command the way `answer` says.
    fn answering(answer: &'static str) -> Recorder {
        Recorder::with_hook(move |session, tag, _| {
            Box::pin(async move {
                session.write(&format!("{tag} {answer}\r\n"));
            })
        })
    }

    #[tokio::test]
    async fn writes_the_message_to_a_file_as_it_arrives_instead_of_buffering_it() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        let message: Vec<u8> = (0..4 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", message.len())).await;
        settle().await;
        for segment in message.chunks(64 * 1024) {
            wire.send(segment).await;
        }
        wire.send("\r\n").await;
        wire.wait_for_dispatches(1).await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched[0].append().message.size, message.len() as u64);
        assert!(dispatched[0].message.as_ref().unwrap() == &message);
        assert!(!wire.closed());
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn takes_a_spooled_message_without_logging_it_as_unread_command_text() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        let message = vec![b'a'; 2 * 1024 * 1024];
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", message.len())).await;
        settle().await;
        for segment in message.chunks(512 * 1024) {
            wire.send(segment).await;
        }
        wire.send("\r\n").await;
        wire.wait_for_dispatches(1).await;

        assert_eq!(pausing_lines(&wire), 0);
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn keeps_octets_that_are_not_valid_utf8_intact() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        let message = [0x53, 0x3a, 0x20, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x0d, 0x0a, 0xc3];
        wire.send(format!("a1 APPEND INBOX {{{}+}}\r\n", message.len())).await;
        wire.send([message.as_slice(), b"\r\n"].concat()).await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].message.as_deref(), Some(message.as_slice()));
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn spools_only_the_message_not_a_mailbox_name_sent_as_a_literal() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send("a1 APPEND {6+}\r\nDrafts {5+}\r\nhello\r\n").await;
        wire.wait_for_dispatches(1).await;
        settle().await;

        let dispatched = wire.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].append().mailbox, "Drafts");
        assert_eq!(dispatched[0].message_text(), "hello");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn grants_a_synchronizing_literal_its_continuation_and_serves_the_command_behind_it() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send("a1 APPEND INBOX (\\Seen) {5}\r\n").await;
        wire.wait_for_output("+ go ahead\r\n").await;
        settle().await;
        assert_eq!(wire.output(), "+ go ahead\r\n");
        wire.send("hello\r\na2 NOOP\r\n").await;
        wire.wait_for_dispatches(2).await;
        settle().await;

        assert_eq!(wire.tags(), ["a1", "a2"]);
        assert_eq!(wire.dispatched()[0].message_text(), "hello");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_the_file_once_the_command_completes() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let during = Arc::new(Mutex::new(Vec::new()));
        let wire = Wire::open_authenticated(Recorder::with_hook({
            let (during, before) = (during.clone(), before.clone());
            move |session, tag, _| {
                *during.lock().unwrap() = new_spool_dirs(&before);
                Box::pin(async move {
                    session.write(&format!("{tag} OK [APPENDUID 1 1] APPEND completed\r\n"));
                })
            }
        }))
        .await;
        wire.send("a1 APPEND INBOX {5+}\r\nhello\r\n").await;
        settle().await;

        assert_eq!(during.lock().unwrap().len(), 1);
        assert_eq!(wire.output(), "a1 OK [APPENDUID 1 1] APPEND completed\r\n");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_the_file_when_the_command_is_answered_no_trycreate() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(answering("NO [TRYCREATE] Mailbox does not exist")).await;
        wire.send("a1 APPEND Nowhere {5+}\r\nhello\r\n").await;
        settle().await;

        assert_eq!(wire.dispatched().len(), 1);
        assert_eq!(wire.output(), "a1 NO [TRYCREATE] Mailbox does not exist\r\n");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_the_file_when_storing_the_message_fails() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::with_hook(|_, _, _| {
            Box::pin(async move {
                panic!("store failed");
            })
        }))
        .await;
        wire.send("a1 APPEND INBOX {5+}\r\nhello\r\n").await;
        settle().await;

        assert_eq!(wire.dispatched().len(), 1);
        assert_eq!(wire.output(), "a1 BAD Internal server error\r\n");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_the_file_when_an_unauthenticated_session_is_answered_no() {
        // APPEND is budgeted, and other tests saturate the budget.
        let _budget = super::super::super::command_budget::test_lock().await;
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open(Recorder::real()).await;
        wire.send("a1 APPEND INBOX {5+}\r\nhello\r\n").await;
        settle().await;

        assert_eq!(wire.dispatched().len(), 1);
        assert_eq!(wire.output(), "a1 NO Not authenticated.\r\n");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_the_file_when_the_command_is_refused_before_dispatch() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // A tag past the ceiling parses but has no answerable completion.
        wire.send(format!("{} APPEND INBOX {{5+}}\r\nhello\r\n", "t".repeat(200))).await;
        settle().await;

        assert!(wire.dispatched().is_empty());
        assert_eq!(wire.output(), "* BAD Command tag too long\r\n");
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn creates_no_file_for_a_refused_declaration() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send(format!("a1 APPEND INBOX {{{}}}\r\n", APPEND_CAP + 1)).await;
        wire.wait_for_output(&toobig("a1", APPEND_CAP)).await;
        settle().await;

        assert_eq!(wire.output(), toobig("a1", APPEND_CAP));
        assert!(wire.dispatched().is_empty());
        assert!(new_spool_dirs(&before).is_empty());
    }

    #[tokio::test]
    async fn removes_a_spooled_message_when_a_later_literal_of_the_same_command_is_refused() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {5+}\r\nhello {4000000000}\r\n").await;
        settle().await;

        let lines = wire.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("a1 NO [TOOBIG] "));
        assert!(!wire.closed());
        assert!(wire.dispatched().is_empty());
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_a_spooled_message_when_the_chain_ceiling_ends_the_session() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // One segment, so no link finds the buffer empty and dispatches early.
        wire.send(format!("a1 APPEND INBOX {{5+}}\r\nhello{}", " {1+}\r\nx".repeat(70))).await;
        wire.wait_for_close().await;

        assert_eq!(wire.output(), "* BYE Command too long\r\n");
        assert!(wire.dispatched().is_empty());
        assert_spool_cleaned(&before).await;
    }

    #[tokio::test]
    async fn removes_a_partial_file_when_the_client_disconnects_mid_literal() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {1048576+}\r\n").await;
        wire.send(vec![b'a'; 300 * 1024]).await;
        assert!(wait_for(Duration::from_secs(5), || new_spool_dirs(&before).len() == 1).await);

        wire.hang_up().await;
        assert_spool_cleaned(&before).await;
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn removes_a_partial_file_when_the_socket_closes_while_a_write_is_pending() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {1048576+}\r\n").await;
        wire.send(vec![b'a'; 64 * 1024]).await;
        wire.hang_up().await;

        assert_spool_cleaned(&before).await;
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn removes_a_complete_message_still_waiting_for_its_commands_tail() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        // The payload is in; the line that ends the command never arrives.
        wire.send("a1 APPEND INBOX {5+}\r\nhello ").await;
        assert!(wait_for(Duration::from_secs(5), || new_spool_dirs(&before).len() == 1).await);

        wire.hang_up().await;
        assert_spool_cleaned(&before).await;
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn removes_a_partial_file_when_the_server_ends_the_connection() {
        let _spool = spool_test_lock().await;
        let before = spool_dirs();
        let wire = Wire::open_authenticated(Recorder::default()).await;
        wire.send("a1 APPEND INBOX {1048576+}\r\n").await;
        wire.send(vec![b'a'; 100 * 1024]).await;
        assert!(wait_for(Duration::from_secs(5), || new_spool_dirs(&before).len() == 1).await);

        // What the shutdown sweep does to each session; the sweep itself is
        // process-wide, so it is not run here.
        wire.session.write("* BYE Server shutting down\r\n");
        wire.session.close();
        wire.wait_for_close().await;

        assert_spool_cleaned(&before).await;
        assert!(wire.dispatched().is_empty());
    }
}

// ---------------------------------------------------------------------------
// Command bursts (handler-throttle.test.ts)
// ---------------------------------------------------------------------------

mod command_bursts {
    use super::*;

    fn noop_burst(total: usize) -> String {
        (1..=total).map(|n| format!("t{n} NOOP\r\n")).collect()
    }

    fn completions(wire: &Wire) -> usize {
        wire.output().matches("OK NOOP completed").count()
    }

    #[tokio::test]
    async fn answers_every_command_in_a_burst_within_the_rate_budget() {
        let wire = Wire::open(Recorder::real()).await;
        wire.send(noop_burst(30)).await;
        let received = wire.received.clone();
        wait_for(Duration::from_secs(1), || String::from_utf8_lossy(&received.lock().unwrap()).matches("OK NOOP completed").count() >= 30)
            .await;

        assert_eq!(completions(&wire), 30);
    }

    #[tokio::test]
    async fn paces_not_drops_bursts_beyond_the_per_second_limit() {
        let wire = Wire::open(Recorder::real()).await;
        // Over the 100-a-second budget: the overflow waits for the next
        // window and is never discarded.
        let total = 150;
        wire.send(noop_burst(total)).await;
        let received = wire.received.clone();
        wait_for(Duration::from_secs(4), || {
            String::from_utf8_lossy(&received.lock().unwrap()).matches("OK NOOP completed").count() >= total
        })
        .await;

        let output = wire.output();
        for n in 1..=total {
            assert!(output.contains(&format!("t{n} OK NOOP completed\r\n")), "t{n} unanswered");
        }
        assert!(!output.contains("TEMPORARY UNAVAILABLE"));
    }

    #[tokio::test]
    async fn stops_pacing_when_the_socket_is_destroyed_mid_wait() {
        let wire = Wire::open(Recorder::default()).await;
        // Use up the second's budget, so the next slot means waiting.
        for _ in 0..100 {
            wire.session.wait_for_command_slot().await;
        }
        wire.session.socket().destroy();
        let started = std::time::Instant::now();
        wire.session.wait_for_command_slot().await;
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------------
// One command at a time (handler-serial-drain.test.ts)
// ---------------------------------------------------------------------------

mod serial_drain {
    use super::*;

    #[tokio::test]
    async fn emits_every_tagged_completion_across_separate_writes() {
        let wire = Wire::open(Recorder::real()).await;
        let total = 25;
        for n in 1..=total {
            wire.send(format!("t{n} NOOP\r\n")).await;
        }
        wire.wait_for_output(&format!("t{total} OK NOOP completed\r\n")).await;

        assert_eq!(wire.output().matches("OK NOOP completed").count(), total);
    }

    #[tokio::test]
    async fn preserves_command_order_across_pipelined_and_separate_segment_input() {
        let wire = Wire::open(Recorder::real()).await;
        wire.send("a1 NOOP\r\na2 NOOP\r\na3 NOOP\r\n").await;
        wire.send("a4 NOOP\r\n").await;
        wire.send("a5 NOOP\r\n").await;
        wire.send("a6 NOOP\r\na7 NOOP\r\na8 NOOP\r\na9 NOOP\r\na10 NOOP\r\n").await;
        wire.wait_for_output("a10 OK NOOP completed\r\n").await;

        let order: Vec<String> = wire
            .lines()
            .iter()
            .filter_map(|line| line.strip_suffix(" OK NOOP completed\r\n").map(str::to_string))
            .collect();
        assert_eq!(order, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]);
    }

    #[tokio::test]
    async fn recovers_a_partial_line_split_across_writes() {
        let wire = Wire::open(Recorder::real()).await;
        wire.send("b1 NO").await;
        wire.send("OP").await;
        wire.send("\r\n").await;
        wire.wait_for_output("b1 OK NOOP completed\r\n").await;
        wire.wait_for_output("b1 OK NOOP completed\r\n").await;
        settle().await;

        assert_eq!(wire.output(), "b1 OK NOOP completed\r\n");
    }
}

// ---------------------------------------------------------------------------
// IDLE on the wire (handler-idle.test.ts)
// ---------------------------------------------------------------------------

mod idle_done {
    use super::super::super::idle_manager::{IDLE_SOCKET_TIMEOUT_MS, SOCKET_TIMEOUT_MS};
    use super::*;

    /// A session in IDLE on INBOX, entered without a store.
    async fn idling() -> Wire {
        let wire = Wire::open_with(
            Recorder::real(),
            Setup { authenticated: true, selected: Some("INBOX"), ..Setup::default() },
        )
        .await;
        wire.session.start_idle("a3");
        wire.wait_for_output("+ idling\r\n").await;
        wire
    }

    #[tokio::test]
    async fn starts_idle_and_emits_the_continuation_response() {
        let wire = idling().await;
        assert!(wire.session.is_in_idle_mode());
        assert_eq!(wire.output(), "+ idling\r\n");
    }

    #[tokio::test]
    async fn terminates_idle_on_a_single_write_done() {
        let wire = idling().await;
        wire.send("DONE\r\n").await;
        wire.wait_for_output("a3 OK IDLE terminated\r\n").await;
        assert!(!wire.session.is_in_idle_mode());
    }

    #[tokio::test]
    async fn terminates_idle_when_done_is_split_across_writes() {
        let wire = idling().await;
        wire.send("DO").await;
        tick().await;
        wire.send("NE\r\n").await;
        wire.wait_for_output("a3 OK IDLE terminated\r\n").await;
        assert!(!wire.session.is_in_idle_mode());
    }

    #[tokio::test]
    async fn terminates_idle_and_processes_a_command_pipelined_after_done() {
        let wire = idling().await;
        wire.send("DONE\r\na4 NOOP\r\n").await;
        wire.wait_for_output("a4 OK NOOP completed\r\n").await;
        assert!(!wire.session.is_in_idle_mode());
        assert_eq!(wire.output(), "+ idling\r\na3 OK IDLE terminated\r\na4 OK NOOP completed\r\n");
    }

    #[tokio::test]
    async fn ignores_non_done_input_during_idle_without_terminating() {
        let wire = idling().await;
        wire.send("a5 NOOP\r\n").await;
        settle().await;
        assert!(wire.session.is_in_idle_mode());
        assert!(!wire.output().contains("a5 OK NOOP completed"));
    }

    #[tokio::test]
    async fn raises_the_socket_timeout_past_the_idle_managers_force_terminate() {
        let wire = idling().await;
        assert_eq!(wire.session.socket().timeout_ms(), IDLE_SOCKET_TIMEOUT_MS);
        const { assert!(IDLE_SOCKET_TIMEOUT_MS > SOCKET_TIMEOUT_MS) };
    }

    #[tokio::test]
    async fn restores_the_short_socket_timeout_when_idle_ends_via_done() {
        let wire = idling().await;
        wire.send("DONE\r\n").await;
        wire.wait_for_output("a3 OK IDLE terminated\r\n").await;
        assert_eq!(wire.session.socket().timeout_ms(), SOCKET_TIMEOUT_MS);
    }

    #[tokio::test]
    async fn restores_the_short_socket_timeout_when_the_idle_manager_force_terminates() {
        let wire = idling().await;
        assert_eq!(wire.session.socket().timeout_ms(), IDLE_SOCKET_TIMEOUT_MS);
        // What the heartbeat does to a session past the IDLE timeout.
        wire.session.end_idle(Some("timeout"));
        assert!(!wire.session.is_in_idle_mode());
        assert_eq!(wire.session.socket().timeout_ms(), SOCKET_TIMEOUT_MS);
        wire.wait_for_output("a3 OK IDLE terminated (timeout)\r\n").await;
    }
}

// ---------------------------------------------------------------------------
// Socket errors (handler-socket-error.test.ts)
// ---------------------------------------------------------------------------

mod socket_errors {
    use std::io;

    use super::super::super::socket::{is_peer_cert_rejection, socket_error_context};
    use crate::tls::TlsError;

    /// What the TLS stream reports for an alert the peer sent, as OpenSSL
    /// names it.
    fn alert(reason: &str) -> io::Error {
        let message = format!("error:0A000000:SSL routines:ssl3_read_bytes:{reason}");
        io::Error::new(
            io::ErrorKind::InvalidData,
            TlsError { reason: reason.to_string(), message, client_named_this_certificate: false },
        )
    }

    #[test]
    fn names_the_peer_that_rejected_the_certificate() {
        let remote = "203.0.113.7:50123";
        for reason in [
            "sslv3 alert bad certificate",
            "sslv3 alert unsupported certificate",
            "sslv3 alert certificate revoked",
            "sslv3 alert certificate expired",
            "sslv3 alert certificate unknown",
            "tlsv1 alert unknown ca",
        ] {
            assert_eq!(
                socket_error_context(&alert(reason), remote),
                serde_json::json!({ "component": "imap", "remote": remote }),
                "{reason}"
            );
        }
        // The OpenSSL wording the Bun server matches on.
        let openssl = io::Error::other("error:10000412:SSL routines:OPENSSL_internal:SSLV3_ALERT_BAD_CERTIFICATE");
        assert!(is_peer_cert_rejection(&openssl));
    }

    #[test]
    fn keeps_the_peer_out_of_every_other_socket_error() {
        let remote = "203.0.113.7:50123";
        let expected = serde_json::json!({ "component": "imap" });
        assert_eq!(socket_error_context(&alert("tlsv1 alert decode error"), remote), expected);
        let openssl = io::Error::other("error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER");
        assert_eq!(socket_error_context(&openssl, remote), expected);
        assert_eq!(socket_error_context(&io::Error::from(io::ErrorKind::TimedOut), remote), expected);
    }
}

// ---------------------------------------------------------------------------
// The per-command diagnostic (handler-command-diag.test.ts)
// ---------------------------------------------------------------------------

mod command_diagnostic {
    use super::*;

    fn parsed(line: &str) -> ImapRequest {
        parse_command(line, None).into_result().expect("the command parses").request
    }

    #[test]
    fn redacts_the_login_password_only_the_username_survives() {
        let described = describe_imap_command(&login("admin", "super-secret-do-not-log"));
        assert_eq!(described, "LOGIN admin");
        assert!(!described.contains("super-secret"));
    }

    #[test]
    fn fetch_includes_the_sequence_range_and_item_types_no_bodies() {
        assert_eq!(describe_imap_command(&parsed("A1 FETCH 1:100 (UID FLAGS ENVELOPE)")), "FETCH 1:100 (UID FLAGS ENVELOPE)");
    }

    #[test]
    fn uid_fetch_prefixes_the_inner_fetch_summary() {
        assert_eq!(describe_imap_command(&parsed("A1 UID FETCH 1:999999 (UID FLAGS)")), "UID FETCH 1:999999 (UID FLAGS)");
    }

    #[test]
    fn select_status_and_list_keep_the_mailbox_path() {
        assert_eq!(describe_imap_command(&parsed("A1 SELECT INBOX")), "SELECT INBOX");
        assert_eq!(
            describe_imap_command(&parsed("A1 STATUS INBOX/accounts/claude (MESSAGES UIDNEXT)")),
            "STATUS INBOX/accounts/claude (MESSAGES UIDNEXT)"
        );
        assert_eq!(describe_imap_command(&parsed("A1 LIST \"\" \"*\"")), "LIST \"\" \"*\"");
    }

    #[test]
    fn store_captures_the_range_the_operation_and_the_flags() {
        assert_eq!(describe_imap_command(&parsed("A1 STORE 1:500 +FLAGS (\\Seen)")), "STORE 1:500 +FLAGS \\Seen");
    }

    #[test]
    fn append_reports_the_message_size() {
        let message = Literal::Message(MessageLiteral { path: "/spool/message".into(), size: 4096 });
        let request = parse_command("A1 APPEND Drafts {4096}", Some(&[message])).into_result().unwrap().request;
        assert_eq!(describe_imap_command(&request), "APPEND Drafts 4096B");
    }

    #[test]
    fn the_summary_of_a_search_is_capped() {
        let described = describe_imap_command(&parsed(&format!("A1 SEARCH TEXT {}", "x".repeat(10_000))));
        assert!(js::utf16_len(&described) <= 200);
        assert!(described.starts_with("SEARCH"));
    }

    #[test]
    fn every_branch_taking_client_text_is_capped_at_200() {
        let long = |c: &str| c.repeat(10_000);
        let message = Literal::Message(MessageLiteral { path: String::new(), size: 0 });
        let requests = [
            login(&long("u"), "p"),
            parsed(&format!("A1 SELECT {}", long("m"))),
            parsed(&format!("A1 EXAMINE {}", long("m"))),
            parsed(&format!("A1 LIST \"\" {}", long("*"))),
            parsed(&format!("A1 LSUB \"\" {}", long("*"))),
            parsed(&format!("A1 STATUS {} (UIDNEXT)", long("m"))),
            parse_command(&format!("A1 APPEND {} {{0}}", long("m")), Some(&[message])).into_result().unwrap().request,
            parsed(&format!("A1 CREATE {}", long("m"))),
            parsed(&format!("A1 ENABLE {}", "CAP".repeat(5000))),
            parsed(&format!("A1 AUTHENTICATE {}", long("X"))),
        ];
        for request in requests {
            let described = describe_imap_command(&request);
            assert!(js::utf16_len(&described) <= 200, "{} for {}", described.len(), request.type_name());
        }
    }

    #[test]
    fn bare_types_fall_through_to_the_type_token() {
        for (line, expected) in [("A1 NOOP", "NOOP"), ("A1 CAPABILITY", "CAPABILITY"), ("A1 LOGOUT", "LOGOUT"), ("A1 IDLE", "IDLE")] {
            assert_eq!(describe_imap_command(&parsed(line)), expected);
        }
    }

    #[test]
    fn declares_the_three_interesting_thresholds() {
        assert_eq!(INTERESTING_RSS_DELTA_MB, 1);
        assert_eq!(INTERESTING_DURATION_MS, 100);
        assert_eq!(INTERESTING_RESPONSE_BYTES, 4096);
    }

    #[test]
    fn any_one_axis_past_its_threshold_keeps_the_line_at_info() {
        // The noise floor drops to DEBUG.
        assert!(!is_interesting_command(0, 3, 40, 0));
        assert!(is_interesting_command(1, 0, 0, 0));
        assert!(is_interesting_command(-2, 0, 0, 0));
        assert!(is_interesting_command(0, 100, 0, 0));
        assert!(is_interesting_command(0, 0, 4096, 0));
        // Starved behind the budget, then fast: the only sign it is undersized.
        assert!(is_interesting_command(0, 2, 10, 150));
        assert!(!is_interesting_command(0, 99, 4095, 99));
    }
}

// ---------------------------------------------------------------------------
// A final BYE on a connection whose peer stopped reading
// (session-close-flush.test.ts)
// ---------------------------------------------------------------------------

mod close_flush {
    use super::super::super::close_socket::CLOSE_FLUSH_TIMEOUT_MS;
    use super::super::super::idle_manager::IdleManager;
    use super::*;

    const FILL_WRITES: usize = 200;

    fn fill() -> String {
        format!("* 1 FETCH (BODY[] {{1000}}\r\n{})\r\n", "x".repeat(1000))
    }

    /// A connection whose client reads nothing until asked to, with far more
    /// queued for it than the stream holds.
    struct Stalled {
        client: DuplexStream,
        session: Arc<ImapSession>,
        _shared: RwLockReadGuard<'static, ()>,
    }

    async fn stalled(prefill: bool) -> Stalled {
        let shared = test_support::shared().await;
        let (server, client) = tokio::io::duplex(NARROW);
        let port = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
        let handler = ImapRequestHandler::with_dispatch(
            Box::new(server),
            Peer { address: "203.0.113.7".into(), port },
            false,
            Recorder::real(),
        );
        let session = handler.session().clone();
        tokio::spawn(handler.run());
        if prefill {
            for _ in 0..FILL_WRITES {
                assert!(session.write(&fill()));
            }
        }
        Stalled { client, session, _shared: shared }
    }

    impl Stalled {
        /// Reads everything until the server ends the connection.
        async fn read_to_end(&mut self) -> (String, bool) {
            let mut received = Vec::new();
            let ended = tokio::time::timeout(Duration::from_secs(5), self.client.read_to_end(&mut received)).await.is_ok();
            (String::from_utf8_lossy(&received).into_owned(), ended)
        }
    }

    async fn past_the_flush_window() {
        tokio::time::sleep(Duration::from_millis(CLOSE_FLUSH_TIMEOUT_MS + 600)).await;
    }

    #[tokio::test]
    async fn delivers_bye_when_the_literal_ceiling_closes_a_session_whose_peer_stopped_reading() {
        let mut connection = stalled(true).await;
        connection.client.write_all(b"A1 APPEND INBOX {999999999+}\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await;

        let (received, ended) = connection.read_to_end().await;
        assert!(received.contains("* BYE Command too long\r\n"));
        assert!(ended);
    }

    #[tokio::test]
    async fn delivers_bye_when_the_chained_literal_cap_closes_the_session() {
        let mut connection = stalled(true).await;
        let chain = format!("A1 APPEND INBOX {}\r\n", "{10+}\r\n0123456789".repeat(80));
        connection.client.write_all(chain.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await;

        let (received, ended) = connection.read_to_end().await;
        assert!(received.contains("* BYE Command too long\r\n"));
        assert!(ended);
    }

    #[tokio::test]
    async fn stops_reading_the_socket_the_moment_it_tears_the_session_down() {
        let mut connection = stalled(true).await;
        connection.client.write_all(b"A1 APPEND INBOX {999999999+}\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = connection.client.write_all(b"A2 CAPABILITY\r\n").await;
        tokio::time::sleep(Duration::from_millis(550)).await;

        let (received, _) = connection.read_to_end().await;
        let after_bye = received.split("* BYE Command too long\r\n").nth(1).unwrap_or_default();
        assert!(!after_bye.contains("CAPABILITY"));
    }

    #[tokio::test]
    async fn destroys_a_peer_that_never_reads_rather_than_waiting_on_it_forever() {
        let connection = stalled(true).await;
        let mut client = connection.client;
        client.write_all(b"A1 APPEND INBOX {999999999+}\r\n").await.unwrap();
        past_the_flush_window().await;

        assert!(connection.session.socket().is_destroyed());
        drop(client);
    }

    #[tokio::test]
    async fn delivers_bye_when_the_socket_timeout_fires_on_a_backpressured_session() {
        let mut connection = stalled(true).await;
        // The inactivity timeout is five minutes; this is what runs then.
        connection.session.socket().fire_timeout();
        tokio::time::sleep(Duration::from_millis(700)).await;

        let (received, ended) = connection.read_to_end().await;
        assert!(received.contains("* BYE Timeout\r\n"));
        assert!(ended);
    }

    #[tokio::test]
    async fn destroys_a_logout_whose_peer_never_reads_its_bye() {
        let connection = stalled(true).await;
        let mut client = connection.client;
        client.write_all(b"A1 LOGOUT\r\n").await.unwrap();
        past_the_flush_window().await;

        assert!(connection.session.socket().is_destroyed());
        drop(client);
    }

    #[tokio::test]
    async fn delivers_bye_and_closes_when_the_idle_sweep_ends_an_idle_session() {
        let connection = stalled(true).await;
        // A manager of its own: the process's one is swept by other tests.
        let manager = IdleManager::new();
        manager.add_idle_session("close-flush-sweep", connection.session.clone(), "t1", "INBOX", "alice");
        manager.shutdown();
        past_the_flush_window().await;

        assert!(connection.session.socket().is_destroyed());
        drop(connection.client);
    }

    #[tokio::test]
    async fn closes_a_logout_promptly_instead_of_lingering_out_the_flush_grace() {
        let mut connection = stalled(false).await;
        let started = std::time::Instant::now();
        connection.client.write_all(b"A1 LOGOUT\r\n").await.unwrap();

        let (received, ended) = connection.read_to_end().await;
        assert!(received.contains("* BYE IMAP4rev1 Server logging out\r\n"));
        assert!(received.contains("A1 OK LOGOUT completed\r\n"));
        assert!(ended);
        // The grace period is two seconds; a client that reads does not pay it.
        assert!(started.elapsed() < Duration::from_millis(1000));
    }
}

// ---------------------------------------------------------------------------
// STARTTLS (starttls-pipelining.test.ts, and the STARTTLS cases of
// proxy.test.ts and shutdown.test.ts)
// ---------------------------------------------------------------------------

mod starttls_pipelining {
    use tokio::io::AsyncRead;

    use super::super::super::auth::AuthConnection;
    use super::super::super::session_registry::{
        get_connected_session_count, reset_connected_sessions, shutdown_imap_sessions,
    };
    use super::*;

    async fn read_line<R: AsyncRead + Unpin>(stream: &mut R) -> String {
        let mut line = Vec::new();
        let mut octet = [0u8; 1];
        while !line.ends_with(b"\r\n") {
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut octet)).await {
                Ok(Ok(1)) => line.push(octet[0]),
                _ => break,
            }
        }
        String::from_utf8_lossy(&line).into_owned()
    }

    struct Upgraded {
        tls: tokio_rustls::client::TlsStream<DuplexStream>,
        dispatched: Arc<Mutex<Vec<Recorded>>>,
        /// The session each dispatched command ran on.
        sessions: Arc<Mutex<Vec<Arc<ImapSession>>>>,
        cleartext: Arc<ImapSession>,
    }

    impl Upgraded {
        fn tags(&self) -> Vec<String> {
            self.dispatched.lock().unwrap().iter().map(|recorded| recorded.tag.clone()).collect()
        }

        async fn command(&mut self, line: &str) {
            self.tls.write_all(line.as_bytes()).await.unwrap();
            self.tls.flush().await.unwrap();
        }
    }

    /// Sends `first` in one write; its STARTTLS is answered OK the way the
    /// session answers it, optionally leaving a SASL exchange half-done, and
    /// the client completes the handshake. `None` without the `openssl`
    /// command to make a certificate with.
    async fn upgrade(first: &str, leave_sasl_pending: bool) -> Option<Upgraded> {
        let Some(acceptor) = test_support::acceptor() else {
            eprintln!("skipped: no openssl to make a test certificate with");
            return None;
        };
        let sessions: Arc<Mutex<Vec<Arc<ImapSession>>>> = Arc::default();
        let recorder = Recorder::with_hook({
            let sessions = sessions.clone();
            move |session, tag, request| {
                sessions.lock().unwrap().push(session.clone());
                let acceptor = acceptor.clone();
                Box::pin(async move {
                    if matches!(request, ImapRequest::Starttls) {
                        session.write(&format!("{tag} OK Begin TLS negotiation now\r\n"));
                        if leave_sasl_pending {
                            AuthConnection::set_pending_sasl_tag(&*session, "Z9");
                        }
                        session.state().tls_upgrade = Some(acceptor);
                    } else {
                        handle_request(&session, &tag, request).await;
                    }
                })
            }
        });
        let dispatched = recorder.dispatched.clone();
        let (server, mut client) = tokio::io::duplex(1 << 20);
        let handler = ImapRequestHandler::with_dispatch(
            Box::new(server),
            Peer { address: "203.0.113.7".into(), port: 51000 },
            false,
            recorder,
        );
        let cleartext = handler.session().clone();
        tokio::spawn(handler.run());

        assert!(read_line(&mut client).await.starts_with("* OK [CAPABILITY "));
        client.write_all(first.as_bytes()).await.unwrap();
        loop {
            let line = read_line(&mut client).await;
            assert!(!line.is_empty(), "the STARTTLS is answered");
            if line.ends_with("OK Begin TLS negotiation now\r\n") {
                break;
            }
        }
        let tls = crate::tls::insecure_connector().connect(test_support::server_name(), client).await.expect("the handshake");
        Some(Upgraded { tls, dispatched, sessions, cleartext })
    }

    #[tokio::test]
    async fn drops_cleartext_commands_buffered_behind_starttls() {
        let _shared = test_support::shared().await;
        // One segment: the upgrade, then an injected command.
        let Some(mut upgraded) = upgrade("a1 STARTTLS\r\na2 CAPABILITY\r\n", false).await else {
            return;
        };
        upgraded.command("b1 NOOP\r\n").await;

        // The injected command is answered on neither side; the first thing
        // inside TLS is the answer to the client's own first command.
        assert_eq!(read_line(&mut upgraded.tls).await, "b1 OK NOOP completed\r\n");
        assert_eq!(upgraded.tags(), ["a1", "b1"]);
    }

    #[tokio::test]
    async fn drops_a_command_pipelined_behind_a_literal_bearing_starttls() {
        let _shared = test_support::shared().await;
        let Some(mut upgraded) = upgrade("A1 STARTTLS {0+}\r\nA2 CAPABILITY\r\n", false).await else {
            return;
        };
        upgraded.command("b1 NOOP\r\n").await;

        assert_eq!(read_line(&mut upgraded.tls).await, "b1 OK NOOP completed\r\n");
        assert_eq!(upgraded.tags(), ["A1", "b1"]);
    }

    #[tokio::test]
    async fn drops_a_literal_declaring_command_pipelined_behind_a_literal_bearing_starttls() {
        let _shared = test_support::shared().await;
        let Some(mut upgraded) = upgrade("A1 STARTTLS {0+}\r\nA2 SELECT {5+}\r\nINBOX\r\n", false).await else {
            return;
        };
        upgraded.command("b1 NOOP\r\n").await;

        assert_eq!(read_line(&mut upgraded.tls).await, "b1 OK NOOP completed\r\n");
        assert_eq!(upgraded.tags(), ["A1", "b1"]);
    }

    #[tokio::test]
    async fn clears_a_half_finished_sasl_exchange_across_the_upgrade() {
        let _shared = test_support::shared().await;
        // Were the pending exchange carried over, the client's first command
        // inside TLS would be consumed as its response.
        let Some(mut upgraded) = upgrade("a1 STARTTLS\r\n", true).await else {
            return;
        };
        upgraded.command("b1 CAPABILITY\r\n").await;

        let capability = read_line(&mut upgraded.tls).await;
        assert!(capability.starts_with("* CAPABILITY "), "{capability:?}");
        assert_eq!(read_line(&mut upgraded.tls).await, "b1 OK CAPABILITY completed\r\n");
        assert!(!capability.contains("Z9"));
    }

    #[tokio::test]
    async fn keeps_the_client_the_socket_reported_across_starttls() {
        let _shared = test_support::shared().await;
        let Some(mut upgraded) = upgrade("a1 STARTTLS\r\n", false).await else {
            return;
        };
        upgraded.command("b1 NOOP\r\n").await;
        assert_eq!(read_line(&mut upgraded.tls).await, "b1 OK NOOP completed\r\n");

        let inside = upgraded.sessions.lock().unwrap().last().cloned().unwrap();
        assert!(!Arc::ptr_eq(&inside, &upgraded.cleartext), "the upgrade starts a clean session");
        assert!(inside.is_tls());
        assert_eq!(inside.socket().remote(), "203.0.113.7:51000");
    }

    #[tokio::test]
    async fn the_shutdown_sweep_tracks_only_the_upgraded_session() {
        let _exclusive = test_support::exclusive().await;
        reset_connected_sessions();
        let Some(mut upgraded) = upgrade("a1 STARTTLS\r\n", false).await else {
            return;
        };
        upgraded.command("b1 NOOP\r\n").await;
        assert_eq!(read_line(&mut upgraded.tls).await, "b1 OK NOOP completed\r\n");
        assert_eq!(get_connected_session_count(), 1);

        assert_eq!(shutdown_imap_sessions(), 1);
        assert_eq!(read_line(&mut upgraded.tls).await, "* BYE Server shutting down\r\n");
    }
}

// ---------------------------------------------------------------------------
// The AUTHENTICATE continuation line (auth.test.ts)
// ---------------------------------------------------------------------------

mod sasl_continuation_line {
    use super::super::super::auth::AuthConnection;
    use super::*;

    async fn challenged(tag: &str) -> (Wire, Arc<Mutex<Vec<(String, String)>>>) {
        let recorder = Recorder::default();
        let sasl = recorder.sasl.clone();
        let wire = Wire::open(recorder).await;
        AuthConnection::set_pending_sasl_tag(&*wire.session, tag);
        (wire, sasl)
    }

    #[tokio::test]
    async fn cancels_the_exchange_on_a_bare_asterisk_without_reaching_the_user_store() {
        let (wire, sasl) = challenged("D1").await;
        wire.send("*\r\n").await;
        settle().await;

        assert!(wire.output().contains("D1 BAD Authentication cancelled\r\n"));
        assert!(sasl.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn forgets_the_tag_after_the_cancel_so_the_next_line_is_read_as_a_command() {
        let (wire, _) = challenged("D2").await;
        wire.send("*\r\n").await;
        settle().await;
        let cancelled = wire.output();
        wire.send("*\r\n").await;
        settle().await;

        assert!(!wire.output()[cancelled.len()..].contains("Authentication cancelled"));
    }

    #[tokio::test]
    async fn feeds_a_base64_continuation_into_the_plain_exchange() {
        let (wire, sasl) = challenged("D3").await;
        wire.send("AG5vYm9keQBodW50ZXIy\r\n").await;
        settle().await;

        assert_eq!(*sasl.lock().unwrap(), [("D3".to_string(), "AG5vYm9keQBodW50ZXIy".to_string())]);
        assert!(wire.dispatched().is_empty());
    }

    #[tokio::test]
    async fn takes_the_response_line_trimmed() {
        let (wire, sasl) = challenged("D4").await;
        wire.send("  AG5vYm9keQBodW50ZXIy \r\n").await;
        settle().await;

        assert_eq!(*sasl.lock().unwrap(), [("D4".to_string(), "AG5vYm9keQBodW50ZXIy".to_string())]);
    }
}

// ---------------------------------------------------------------------------
// The command budget, wired (command-budget-wiring.test.ts)
// ---------------------------------------------------------------------------

mod command_budget_wiring {
    use super::super::super::command_budget::{
        acquire_command_budget, command_budget_capacity, command_budget_in_flight, release_command_budget,
        reset_command_budget, test_lock,
    };
    use super::*;

    /// Every slot taken, as other sessions' commands would hold them.
    async fn saturate() -> usize {
        reset_command_budget();
        let capacity = command_budget_capacity();
        for _ in 0..capacity {
            acquire_command_budget().await;
        }
        assert_eq!(command_budget_in_flight(), capacity);
        capacity
    }

    fn answered(wire: &Wire, tag: &str) -> bool {
        wire.lines().iter().any(|line| line.starts_with(&format!("{tag} OK")) || line.starts_with(&format!("{tag} NO")) || line.starts_with(&format!("{tag} BAD")))
    }

    fn logged(wire: &Wire, message: &str) -> Vec<(String, Value)> {
        journal_of(&wire.remote)
            .into_iter()
            .filter(|(_, logged, _)| logged == message)
            .map(|(level, _, context)| (level, context))
            .collect()
    }

    #[tokio::test]
    async fn queues_a_real_select_when_the_budget_is_saturated_and_gives_its_slot_back() {
        let _lock = test_lock().await;
        let capacity = saturate().await;
        let wire = Wire::open(Recorder::real()).await;
        wire.send("t1 SELECT INBOX\r\n").await;
        settle().await;

        // Saturated: the command waits for a slot instead of running.
        assert!(!answered(&wire, "t1"));
        assert_eq!(command_budget_in_flight(), capacity);

        // One slot frees; the queued SELECT takes it, completes, and gives
        // its own back.
        release_command_budget();
        let received = wire.received.clone();
        assert!(
            wait_for(Duration::from_secs(2), || String::from_utf8_lossy(&received.lock().unwrap()).contains("t1 NO")).await
        );
        assert_eq!(wire.output(), "t1 NO Not authenticated.\r\n");
        assert_eq!(command_budget_in_flight(), capacity - 1);
        reset_command_budget();
    }

    #[tokio::test]
    async fn does_not_gate_a_protocol_command_behind_a_saturated_budget() {
        let _lock = test_lock().await;
        let capacity = saturate().await;
        let wire = Wire::open(Recorder::real()).await;
        wire.send("t2 NOOP\r\n").await;
        wire.wait_for_output("t2 OK NOOP completed\r\n").await;

        assert_eq!(command_budget_in_flight(), capacity);
        reset_command_budget();
    }

    #[tokio::test]
    async fn keeps_a_starved_but_fast_command_at_info_on_the_budget_wait_alone() {
        let _lock = test_lock().await;
        saturate().await;
        let wire = Wire::open(Recorder::real()).await;
        wire.send("t1 SELECT INBOX\r\n").await;
        // Queued past the interesting-duration floor before a slot frees.
        tokio::time::sleep(Duration::from_millis(INTERESTING_DURATION_MS + 50)).await;
        release_command_budget();
        wire.wait_for_output("t1 NO").await;
        settle().await;

        let completions = logged(&wire, "IMAP command completed");
        assert_eq!(completions.len(), 1);
        let (level, payload) = &completions[0];
        assert_eq!(level, "info");
        assert!(payload["waitedForCommandBudgetMs"].as_u64().unwrap() >= INTERESTING_DURATION_MS);
        // Nothing else about it is interesting: the INFO is the wait's.
        assert!(payload["durationMs"].as_u64().unwrap() < INTERESTING_DURATION_MS);
        assert!(payload["responseBytes"].as_u64().unwrap() < INTERESTING_RESPONSE_BYTES);
        assert!(payload["rssDeltaMB"].as_i64().unwrap().abs() < INTERESTING_RSS_DELTA_MB);
        assert_eq!(payload["cmd"], "SELECT INBOX");
        reset_command_budget();
    }

    /// The peer goes while the command waits for a slot: the slot is handed
    /// straight back, no response is built, and the drop is logged.
    async fn abandons_a_queued_command(kill: impl FnOnce(&Wire)) {
        let _lock = test_lock().await;
        let capacity = saturate().await;
        let wire = Wire::open(Recorder::real()).await;
        wire.send("t1 SELECT INBOX\r\n").await;
        settle().await;
        assert_eq!(command_budget_in_flight(), capacity);

        kill(&wire);
        assert!(!wire.session.socket().is_writable());
        release_command_budget();
        assert!(wait_for(Duration::from_secs(2), || command_budget_in_flight() == capacity - 1).await);
        settle().await;

        assert!(logged(&wire, "IMAP command completed").is_empty());
        let drops = logged(&wire, "IMAP command dropped");
        assert_eq!(drops.len(), 1);
        assert_eq!(drops[0].0, "info");
        assert_eq!(drops[0].1["cmd"], "SELECT INBOX");
        assert_eq!(drops[0].1["tag"], "t1");
        assert!(drops[0].1["waitedForCommandBudgetMs"].as_f64().unwrap() >= 0.0);
        reset_command_budget();
    }

    #[tokio::test]
    async fn gives_the_slot_back_however_the_command_ends_but_never_twice() {
        let _lock = test_lock().await;
        reset_command_budget();
        // A command that ends by unwinding still drops its release.
        acquire_command_budget().await;
        drop(ReleaseOnDrop(create_command_budget_hold(true, Duration::ZERO)));
        assert_eq!(command_budget_in_flight(), 0);
        // A slot given up for a deeper wait and not yet taken back is not
        // the command's to hand back.
        acquire_command_budget().await;
        let hold = create_command_budget_hold(false, Duration::ZERO);
        drop(ReleaseOnDrop(hold));
        assert_eq!(command_budget_in_flight(), 1);
        reset_command_budget();
    }

    #[tokio::test]
    async fn abandons_a_queued_command_whose_peer_disconnected_while_it_waited() {
        abandons_a_queued_command(|wire| {
            wire.session.socket().destroy();
            assert!(wire.session.socket().is_destroyed());
        })
        .await;
    }

    #[tokio::test]
    async fn abandons_a_queued_command_whose_connection_was_half_closed_by_the_server() {
        // What the inactivity timeout does: BYE, then the flush-then-destroy
        // close, which leaves the socket unwritable but not yet destroyed.
        abandons_a_queued_command(|wire| {
            wire.session.write("* BYE Timeout\r\n");
            wire.session.close();
            assert!(!wire.session.socket().is_destroyed());
        })
        .await;
    }
}
