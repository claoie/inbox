//! One client connection: the command loop, AUTH, STARTTLS and the DATA
//! transfer (`smtp/connection.ts`).
//!
//! The Bun server is a set of socket event handlers around one piece of
//! state; this is the same state driven by one task. Commands are handled
//! strictly one at a time. The connection is paused while a command waits on
//! a hook, while the DATA consumer is behind, or while the client is not
//! reading its replies, so a pipelining client is held by TCP backpressure
//! rather than buffered.
//!
//! Four things are carried over from how Bun's sockets behave, because a
//! client can see them:
//!
//! - Closing is two steps. `close` ends the writing side (after QUIT, a 421,
//!   or the client's own FIN) and replies after it are dropped, but lines
//!   keep being read and handled until the client has closed too.
//! - A hook whose answer needs no outside event is answered on the spot, as
//!   a hook calling back synchronously is there; the lines behind it are then
//!   handled before anything else is read off the socket.
//! - A paused connection still takes in a socket buffer's worth: what
//!   arrives meanwhile counts as activity for the idle timeout, and waits
//!   its turn.
//! - The client's FIN is acted on as soon as nothing is left in front of it,
//!   even while a hook is running: the connection is over, the hook's answer
//!   goes nowhere, and lines not yet handled are dropped. The hook itself
//!   still runs to its end. A FIN that came in behind commands while the
//!   connection was paused is acted on right after the first of those
//!   commands that calls a hook.

use std::any::Any;
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::{Buf, Bytes, BytesMut};
use futures_util::FutureExt;
use regex::Regex;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::address_command::{parse_address_command, split_whitespace};
use super::data_stream::{data_stream, DataWriter};
use super::server::{ServerShared, SmtpServerError};
use super::types::{
    SmtpAddress, SmtpArgValue, SmtpAuthMethod, SmtpAuthRequest, SmtpAuthResponse, SmtpEnvelope, SmtpHookError,
    SmtpSession, SmtpSessionState,
};
use crate::proxy_protocol::Prefixed;
use crate::sync::LockUnpoisoned;
use crate::tls::{TlsAcceptor, TlsStream};
use crate::{js, logger};

const DEFAULT_SOCKET_TIMEOUT: Duration = Duration::from_secs(60);

/// Quiet time after accept during which a client that talks first is refused.
const GREETING_DELAY: Duration = Duration::from_millis(100);

/// Longest command line. RFC 5321 §4.5.3.1.4 sets 512 octets for commands, but
/// an AUTH PLAIN initial response may run to RFC 4954's 12288.
const MAX_LINE_BYTES: usize = 16 * 1024;

/// RFC 5321 §4.5.3.1.8: a server must accept at least 100 recipients.
const MAX_RECIPIENTS: usize = 100;

const MAX_UNRECOGNIZED_COMMANDS: u32 = 10;

/// The most one read takes off the socket: what Bun hands a `data` listener
/// at once. It is what "the same read" means where the Bun server acts on
/// one, as when it drops what was pipelined behind STARTTLS.
const READ_CHUNK_BYTES: usize = 512 * 1024;

/// What a paused connection still takes in: the read buffer of a Bun socket.
const HELD_BACK_BYTES: usize = 64 * 1024;

/// Replies queued past this stop the command loop until the client has read
/// them: the high-water mark of a Bun socket.
const REPLY_HIGH_WATER_MARK: usize = 64 * 1024;

/// `/^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i`:
/// the method and `HTTP` match ASCII letters of either case, and `.` stops at
/// JavaScript's line terminators.
static HTTP_REQUEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?i-u:OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) /[^\n\r\x{2028}\x{2029}]* (?i-u:HTTP)/[0-9]\.[0-9]$",
    )
    .expect("the HTTP request pattern compiles")
});

const LF: u8 = 0x0a;
const CR: u8 = 0x0d;
const DOT: u8 = 0x2e;

/// What [`DotUnstuffer::feed`] made of a chunk.
pub(crate) struct Unstuffed {
    /// The message bytes.
    pub data: Vec<Bytes>,
    /// Once the terminator is seen, what follows it.
    pub rest: Option<Bytes>,
}

/// Turns the DATA section of the byte stream into the message: drops the
/// leading dot of a dot-stuffed line (RFC 5321 §4.5.2) and stops at the
/// `CRLF.CRLF` terminator, whose leading CRLF stays part of the message.
pub(crate) struct DotUnstuffer {
    carry: Vec<u8>,
    at_line_start: bool,
    after_crlf: bool,
    previous: Option<u8>,
}

impl DotUnstuffer {
    pub fn new() -> DotUnstuffer {
        DotUnstuffer { carry: Vec::new(), at_line_start: true, after_crlf: true, previous: None }
    }

    pub fn feed(&mut self, chunk: Bytes) -> Unstuffed {
        let buf = match self.carry.is_empty() {
            true => chunk,
            false => {
                let mut joined = std::mem::take(&mut self.carry);
                joined.extend_from_slice(&chunk);
                Bytes::from(joined)
            }
        };
        let mut data = Vec::new();
        let mut start = 0;
        let mut i = 0;
        while i < buf.len() {
            let byte = buf[i];
            if self.at_line_start && byte == DOT {
                if i + 1 >= buf.len() {
                    if i > start {
                        data.push(buf.slice(start..i));
                    }
                    self.carry = buf[i..].to_vec();
                    return Unstuffed { data, rest: None };
                }
                let next = buf[i + 1];
                if next == DOT {
                    if i > start {
                        data.push(buf.slice(start..i));
                    }
                    start = i + 1;
                    self.at_line_start = false;
                    self.previous = Some(DOT);
                    i += 2;
                    continue;
                }
                if next == CR && self.after_crlf {
                    if i + 2 >= buf.len() {
                        if i > start {
                            data.push(buf.slice(start..i));
                        }
                        self.carry = buf[i..].to_vec();
                        return Unstuffed { data, rest: None };
                    }
                    if buf[i + 2] == LF {
                        if i > start {
                            data.push(buf.slice(start..i));
                        }
                        return Unstuffed { data, rest: Some(buf.slice(i + 3..)) };
                    }
                }
            }
            if byte == LF {
                self.at_line_start = true;
                self.after_crlf = self.previous == Some(CR);
            } else {
                self.at_line_start = false;
            }
            self.previous = Some(byte);
            i += 1;
        }
        if buf.len() > start {
            data.push(buf.slice(start..));
        }
        Unstuffed { data, rest: None }
    }
}

/// `Buffer.from(text, "base64")` as Bun decodes it: either alphabet, anything
/// else skipped, the first `=` ends the input, and a dangling sextet is
/// dropped. A character outside Latin-1 counts as the low byte of each of its
/// UTF-16 code units, so `Ł` (U+0141) reads as `A`.
pub fn decode_base64_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    for unit in text.encode_utf16() {
        let byte = unit as u8;
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        accumulator = accumulator << 6 | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    out
}

/// `Buffer.from(text, "base64").toString()`.
fn decode_base64_text(text: &str) -> String {
    String::from_utf8_lossy(&decode_base64_lenient(text)).into_owned()
}

/// `Number(text)` for a `SIZE=` value, which holds no whitespace.
fn js_number(text: &str) -> f64 {
    let lower = text.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16u32), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut value = 0f64;
            for digit in digits.chars() {
                match digit.to_digit(radix) {
                    Some(digit) => value = value * f64::from(radix) + f64::from(digit),
                    None => return f64::NAN,
                }
            }
            return value;
        }
    }
    // NEL is whitespace to Rust and not to JavaScript.
    if text.contains('\u{85}') {
        return f64::NAN;
    }
    js::number_from_str(text)
}

/// The socket of a connection, before or after its TLS handshake.
pub(crate) enum Io {
    Plain(Prefixed<TcpStream>),
    Tls(Box<TlsStream<Prefixed<TcpStream>>>),
    /// The socket has been handed to a TLS handshake, or is gone.
    Closed,
}

impl AsyncRead for Io {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Io::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Io::Tls(stream) => Pin::new(stream).poll_read(cx, buf),
            Io::Closed => Poll::Ready(Ok(())),
        }
    }
}

impl AsyncWrite for Io {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Io::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Io::Tls(stream) => Pin::new(stream).poll_write(cx, buf),
            Io::Closed => Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Io::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Io::Tls(stream) => Pin::new(stream).poll_flush(cx),
            Io::Closed => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Io::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Io::Tls(stream) => Pin::new(stream).poll_shutdown(cx),
            Io::Closed => Poll::Ready(Ok(())),
        }
    }
}

/// Where a connection comes from and which listener address it reached.
pub(crate) struct Remote {
    pub address: String,
    pub port: u16,
    pub local: String,
    pub local_port: u16,
}

/// What the rest of the server can do to a connection from outside its task.
pub(crate) enum Control {
    /// Answer `421 <text>` and close: a rotated credential, or shutdown.
    /// `done` is told once the reply has been handed to the socket.
    Refuse { text: &'static str, done: Option<oneshot::Sender<()>> },
}

/// A connection as its listener and the registry see it.
pub(crate) struct ConnectionHandle {
    /// `session.user`, kept current for the eviction sweep.
    user: Mutex<Option<String>>,
    /// The bytes of replies the client has not been sent yet.
    queued: AtomicUsize,
    control: mpsc::UnboundedSender<Control>,
}

impl ConnectionHandle {
    pub fn user(&self) -> Option<String> {
        self.user.lock_unpoisoned().clone()
    }

    pub fn queued_reply_bytes(&self) -> usize {
        self.queued.load(Ordering::Relaxed)
    }

    /// Answers the client `421 <text>` and closes the connection.
    pub fn refuse(&self, text: &'static str, done: Option<oneshot::Sender<()>>) {
        // A connection whose task has ended has nothing left to close.
        let _ = self.control.send(Control::Refuse { text, done });
    }
}

/// The AUTH exchange waiting for its next line.
enum NextLine {
    Plain,
    LoginUsername,
    LoginPassword(String),
}

/// What a hook answered, with what the answer applies to.
enum HookAnswer {
    Auth(Result<SmtpAuthResponse, SmtpHookError>),
    Mail(SmtpAddress, Result<(), SmtpHookError>),
    Rcpt(SmtpAddress, Result<(), SmtpHookError>),
    Data(Result<(), SmtpHookError>),
}

/// A hook's answer and the session it borrowed, or the panic it died of.
type HookDone = Result<(SmtpSession, HookAnswer), Box<dyn Any + Send>>;

type RunningHook = Pin<Box<dyn Future<Output = HookDone> + Send>>;

/// A DATA transaction in progress.
struct DataTransfer {
    writer: DataWriter,
    /// Present until the terminator has been seen.
    unstuffer: Option<DotUnstuffer>,
    /// What `on_data` answered, held until the message has been read out.
    answer: Option<Result<(), SmtpHookError>>,
}

enum IoEvent {
    Read(io::Result<usize>),
    Wrote(io::Result<usize>),
    Flushed(io::Result<()>),
    ShutDown,
}

pub(crate) struct Connection {
    server: Arc<ServerShared>,
    id: u64,
    handle: Arc<ConnectionHandle>,
    control: mpsc::UnboundedReceiver<Control>,
    io: Io,
    /// With the hook that is running, while one is.
    session: Option<SmtpSession>,
    remote_address: String,
    /// `session.envelope.mailFrom`, readable while a hook holds the session.
    transaction_open: bool,
    secure: bool,
    ready: bool,
    /// The socket is gone: nothing more is read, written or handled.
    closed: bool,
    /// The socket goes without the replies still queued.
    destroyed: bool,
    /// The writing side has been ended; replies from here on are dropped.
    ended: bool,
    /// The client's FIN has been acted on.
    eof: bool,
    /// The client's FIN was read behind data that is still held back.
    fin_held_back: bool,
    /// The TLS handshake of STARTTLS is due.
    upgrading: Option<TlsAcceptor>,
    busy: bool,
    /// Replies are queued past the high-water mark; no command runs until they are written.
    reply_backlog: bool,
    /// A hook answered on the spot; the command loop picks up after it.
    resume_pending: bool,
    pending: BytesMut,
    /// Read off the socket while the connection was paused, in order.
    held_back: VecDeque<Bytes>,
    /// How much more a paused connection takes in.
    held_back_room: usize,
    next_line: Option<NextLine>,
    unrecognized: u32,
    transaction_count: u64,
    data: Option<DataTransfer>,
    hook: Option<RunningHook>,
    out: BytesMut,
    flush_needed: bool,
    shut_down: bool,
    greeting_at: Option<Instant>,
    idle_at: Option<Instant>,
    stall_at: Option<Instant>,
}

impl Drop for Connection {
    /// However the task ends, the listener stops counting the connection.
    fn drop(&mut self) {
        self.server.remove_connection(self.id);
    }
}

/// A context that wakes nobody, for a poll whose `Pending` is an answer.
fn noop_context() -> Context<'static> {
    Context::from_waker(futures_util::task::noop_waker_ref())
}

fn random_session_id() -> String {
    hex::encode(rand::random::<[u8; 10]>())
}

impl Connection {
    /// Registers the connection with its listener and returns its task's state.
    pub fn new(server: Arc<ServerShared>, io: Io, remote: Remote) -> Connection {
        let (sender, control) = mpsc::unbounded_channel();
        let handle = Arc::new(ConnectionHandle { user: Mutex::new(None), queued: AtomicUsize::new(0), control: sender });
        let id = server.add_connection(handle.clone());
        let secure = server.options.secure;
        let session = SmtpSession {
            id: random_session_id(),
            remote_address: remote.address.clone(),
            remote_port: remote.port,
            local_address: remote.local,
            local_port: remote.local_port,
            secure,
            user: None,
            host_name_appears_as: None,
            envelope: SmtpEnvelope::default(),
            transaction: 1,
            state: SmtpSessionState::default(),
        };
        Connection {
            server,
            id,
            handle,
            control,
            io,
            session: Some(session),
            remote_address: remote.address,
            transaction_open: false,
            secure,
            ready: false,
            closed: false,
            destroyed: false,
            ended: false,
            eof: false,
            fin_held_back: false,
            upgrading: None,
            busy: false,
            reply_backlog: false,
            resume_pending: false,
            pending: BytesMut::new(),
            held_back: VecDeque::new(),
            held_back_room: HELD_BACK_BYTES,
            next_line: None,
            unrecognized: 0,
            transaction_count: 0,
            data: None,
            hook: None,
            out: BytesMut::new(),
            flush_needed: false,
            shut_down: false,
            greeting_at: None,
            idle_at: None,
            stall_at: None,
        }
    }

    fn socket_timeout(&self) -> Duration {
        self.server.options.socket_timeout.unwrap_or(DEFAULT_SOCKET_TIMEOUT)
    }

    /// Runs the connection until its socket has closed.
    pub async fn run(mut self) {
        self.init();
        let mut buffer = vec![0u8; READ_CHUNK_BYTES];
        while !self.closed {
            if self.upgrading.is_some() {
                self.upgrade().await;
                continue;
            }
            let flowing = self.flowing();
            if flowing {
                if let Some(chunk) = self.held_back.pop_front() {
                    self.on_chunk(chunk, true, &mut buffer);
                    continue;
                }
            }

            self.handle.queued.store(self.out.len(), Ordering::Relaxed);
            let deadline = [self.greeting_at, self.idle_at, self.stall_at].into_iter().flatten().min();
            let want_read = !self.eof && !self.fin_held_back && (flowing || self.held_back_room > 0);
            let want_shutdown = self.ended && !self.shut_down;
            tokio::select! {
                biased;
                Some(control) = self.control.recv() => self.on_control(control),
                _ = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    self.on_timers();
                }
                done = hook_done(&mut self.hook), if self.hook.is_some() => {
                    self.hook = None;
                    self.on_hook_done(done);
                    self.settle();
                }
                _ = data_progress(&self.data), if self.data.is_some() => self.settle(),
                event = poll_io(&mut self.io, &self.out, self.flush_needed, want_shutdown, want_read, &mut buffer) => {
                    self.on_io(event, &mut buffer);
                }
            }
        }
        self.teardown().await;
    }

    fn init(&mut self) {
        self.touch();
        if self.server.connection_count() > self.server.options.max_clients {
            let text = format!("{} Too many connected clients, try again in a moment", self.server.name);
            self.send(421, &text);
            return;
        }
        self.greeting_at = Some(Instant::now() + GREETING_DELAY);
    }

    /// Socket activity: the idle timeout starts over.
    fn touch(&mut self) {
        self.idle_at = Some(Instant::now() + self.socket_timeout());
    }

    fn on_timers(&mut self) {
        let now = Instant::now();
        if self.stall_at.is_some_and(|at| at <= now) {
            // The client never read its replies: the socket goes as it is.
            self.stall_at = None;
            self.destroyed = true;
            self.on_close();
            return;
        }
        if self.greeting_at.is_some_and(|at| at <= now) {
            self.greeting_at = None;
            self.ready = true;
            let text = format!("{} ESMTP", self.server.name);
            self.send(220, &text);
            self.pump();
            self.settle();
        }
        if self.idle_at.is_some_and(|at| at <= now) {
            self.idle_at = None;
            if self.out.is_empty() {
                self.send(421, "Timeout - closing connection");
            } else {
                // The timeout does not fire while writes are stuck; the
                // stall timer is what drops a client that stopped reading.
                self.touch();
            }
        }
    }

    fn on_control(&mut self, control: Control) {
        let Control::Refuse { text, done } = control;
        self.send(421, text);
        self.close();
        self.write_now();
        if let Some(done) = done {
            let _ = done.send(());
        }
        if self.out.is_empty() {
            self.on_drain();
        }
    }

    /// Hands as much of the queued replies to the socket as it takes now.
    fn write_now(&mut self) {
        let mut cx = noop_context();
        while !self.out.is_empty() {
            match Pin::new(&mut self.io).poll_write(&mut cx, &self.out) {
                Poll::Ready(Ok(written)) if written > 0 => {
                    self.out.advance(written);
                    self.flush_needed = true;
                }
                _ => return,
            }
        }
        if self.flush_needed && Pin::new(&mut self.io).poll_flush(&mut cx).is_ready() {
            self.flush_needed = false;
        }
    }

    fn on_io(&mut self, event: IoEvent, buffer: &mut [u8]) {
        match event {
            IoEvent::Read(Ok(0)) => self.on_fin(),
            IoEvent::Read(Ok(read)) => {
                let chunk = Bytes::copy_from_slice(&buffer[..read]);
                if self.flowing() {
                    self.held_back_room = HELD_BACK_BYTES;
                    self.on_chunk(chunk, false, buffer);
                } else {
                    // Taken in while paused: activity, but not yet its turn.
                    self.touch();
                    self.held_back_room = self.held_back_room.saturating_sub(read);
                    self.held_back.push_back(chunk);
                }
            }
            IoEvent::Read(Err(error)) if error.kind() == io::ErrorKind::UnexpectedEof => self.on_fin(),
            IoEvent::Read(Err(error)) => self.on_socket_error("read", error),
            IoEvent::Wrote(Ok(0)) => self.on_socket_error("write", io::ErrorKind::WriteZero.into()),
            IoEvent::Wrote(Ok(written)) => {
                self.out.advance(written);
                self.flush_needed = true;
                self.touch();
                if self.out.is_empty() {
                    self.on_drain();
                }
            }
            IoEvent::Wrote(Err(error)) | IoEvent::Flushed(Err(error)) => self.on_socket_error("write", error),
            IoEvent::Flushed(Ok(())) => self.flush_needed = false,
            IoEvent::ShutDown => self.shut_down = true,
        }
    }

    /// The replies that were holding the command loop back have been written.
    fn on_drain(&mut self) {
        if !self.reply_backlog {
            return;
        }
        self.stall_at = None;
        self.reply_backlog = false;
        if self.closed || self.upgrading.is_some() || self.busy || self.in_data() {
            return;
        }
        self.pump();
        self.settle();
    }

    fn on_socket_error(&mut self, syscall: &str, error: io::Error) {
        self.on_error(SmtpServerError::from_io(syscall, &error));
        self.destroyed = true;
        self.on_close();
    }

    /// Whether what the client sends is handled as it arrives. While it is
    /// not, what the socket still takes in is held back.
    fn flowing(&self) -> bool {
        !self.busy && !self.reply_backlog && !self.data.as_ref().is_some_and(|data| {
            data.unstuffer.is_some() && data.writer.needs_drain()
        })
    }

    fn in_data(&self) -> bool {
        self.data.as_ref().is_some_and(|data| data.unstuffer.is_some())
    }

    /// One read's worth of what the client sent. `held_back` is set for a
    /// read that waited for the connection to take it.
    fn on_chunk(&mut self, chunk: Bytes, held_back: bool, buffer: &mut [u8]) {
        if !held_back {
            self.touch();
        }
        if self.in_data() {
            self.feed_data(chunk);
        } else {
            self.pending.extend_from_slice(&chunk);
            self.pump();
        }
        // Bun hands over what piled up while the socket was paused in one
        // go: a FIN behind the last of it is acted on before anything that
        // waited on the data continues. Read as it arrives, the data is
        // finished with first.
        if held_back && self.held_back.is_empty() && self.upgrading.is_none() && !self.closed && !self.eof {
            if self.fin_held_back {
                self.on_end();
            } else if self.held_back_room > 0 {
                // What reached the socket during the pause may not have been read yet.
                let mut read = ReadBuf::new(buffer);
                match Pin::new(&mut self.io).poll_read(&mut noop_context(), &mut read) {
                    Poll::Ready(Ok(())) if read.filled().is_empty() => self.on_end(),
                    Poll::Ready(Ok(())) => {
                        self.touch();
                        self.held_back_room = self.held_back_room.saturating_sub(read.filled().len());
                        self.held_back.push_back(Bytes::copy_from_slice(read.filled()));
                    }
                    Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::UnexpectedEof => self.on_end(),
                    // The error is still there for the next read.
                    Poll::Ready(Err(_)) | Poll::Pending => {}
                }
            }
        }
        self.settle();
        if self.eof {
            self.on_close();
        }
    }

    /// The client's FIN has been read.
    fn on_fin(&mut self) {
        if self.held_back.is_empty() {
            self.on_end();
            self.settle();
            self.on_close();
        } else {
            // It waits behind the data it followed.
            self.fin_held_back = true;
        }
    }

    /// The client will send nothing more. A socket that is not half-open
    /// answers with its own FIN: what is queued is still written, nothing
    /// after it.
    fn on_end(&mut self) {
        self.eof = true;
        self.ended = true;
    }

    /// Lets everything that can continue without an outside event do so:
    /// the command loop behind a hook that has answered, and the hook
    /// itself as far as it gets.
    fn settle(&mut self) {
        loop {
            if self.closed {
                return;
            }
            if self.resume_pending {
                self.resume_pending = false;
                self.busy = false;
                self.pump();
                continue;
            }
            if self.poll_hook() || self.reply_to_data() {
                continue;
            }
            return;
        }
    }

    /// Writes one reply; a multi-line reply is passed as several lines.
    fn send_lines(&mut self, code: u16, lines: &[&str]) {
        if !self.ended && !self.closed {
            for (index, line) in lines.iter().enumerate() {
                let separator = if index + 1 < lines.len() { '-' } else { ' ' };
                self.out.extend_from_slice(format!("{code}{separator}{line}\r\n").as_bytes());
            }
            if self.out.len() >= REPLY_HIGH_WATER_MARK && !self.reply_backlog {
                self.hold_for_drain();
            }
        }
        if code == 421 {
            self.close();
        }
    }

    fn send(&mut self, code: u16, text: &str) {
        self.send_lines(code, &[text]);
    }

    /// Stops reading commands until the client has read the replies already
    /// queued. A client that never reads again is dropped after the socket
    /// timeout, which does not fire on its own while writes are stuck.
    fn hold_for_drain(&mut self) {
        self.reply_backlog = true;
        self.stall_at = Some(Instant::now() + self.socket_timeout());
    }

    /// Ends the writing side and drops the connection from its listener's
    /// count. What the client still sends is read until it closes too.
    fn close(&mut self) {
        if !self.closed {
            self.ended = true;
        }
        self.server.remove_connection(self.id);
    }

    /// Runs buffered command lines until one has to wait.
    fn pump(&mut self) {
        while !self.busy && !self.closed && self.upgrading.is_none() && !self.in_data() && !self.reply_backlog {
            let Some(lf) = self.pending.iter().position(|&byte| byte == LF) else {
                if self.pending.len() > MAX_LINE_BYTES {
                    self.pending.clear();
                    self.send(421, "Error: line too long");
                }
                break;
            };
            let end = if lf > 0 && self.pending[lf - 1] == CR { lf - 1 } else { lf };
            let line = String::from_utf8_lossy(&self.pending[..end]).into_owned();
            self.pending.advance(lf + 1);
            if end > MAX_LINE_BYTES {
                self.send(421, "Error: line too long");
                break;
            }
            self.handle_line(&line);
        }
    }

    fn session(&mut self) -> &mut SmtpSession {
        self.session.as_mut().expect("no hook is running while a command is handled")
    }

    fn authenticated(&mut self) -> bool {
        self.session().user.as_deref().is_some_and(|user| !user.is_empty())
    }

    fn handle_line(&mut self, line: &str) {
        let command = line.split(' ').next().unwrap_or("").to_uppercase();

        if self.server.is_closing() {
            return self.send(421, "Server shutting down");
        }
        if !self.ready {
            let text = format!("{} You talk too soon", self.server.name);
            return self.send(421, &text);
        }
        if HTTP_REQUEST.is_match(line) {
            return self.send(421, "HTTP requests not allowed");
        }

        if let Some(next) = self.next_line.take() {
            return match next {
                NextLine::Plain => self.auth_plain(line, true),
                NextLine::LoginUsername => self.auth_login_username(line, true),
                NextLine::LoginPassword(username) => self.auth_login_password(username, line),
            };
        }

        const COMMANDS: [&str; 12] =
            ["EHLO", "HELO", "QUIT", "NOOP", "RSET", "HELP", "VRFY", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA"];
        if !COMMANDS.contains(&command.as_str()) {
            self.unrecognized += 1;
            if self.unrecognized >= MAX_UNRECOGNIZED_COMMANDS {
                return self.send(421, "Error: too many unrecognized commands");
            }
            return self.send(500, "Error: command not recognized");
        }

        let greeted = self.session().host_name_appears_as.as_deref().is_some_and(|name| !name.is_empty());
        if !greeted && matches!(command.as_str(), "MAIL" | "RCPT" | "DATA" | "AUTH") {
            return self.send(503, "Error: send HELO/EHLO first");
        }

        match command.as_str() {
            "EHLO" => self.ehlo(line),
            "HELO" => self.helo(line),
            "QUIT" => {
                self.send(221, "Bye");
                self.close();
            }
            "NOOP" => self.send(250, "OK"),
            "RSET" => {
                self.reset_envelope();
                self.send(250, "Flushed");
            }
            "HELP" => self.send(214, "See https://tools.ietf.org/html/rfc5321 for details"),
            "VRFY" => self.send(252, "Try to send something. No promises though"),
            "STARTTLS" => self.start_tls(),
            "AUTH" => self.auth(line),
            "MAIL" => self.mail(line),
            "RCPT" => self.rcpt(line),
            _ => self.data(),
        }
    }

    fn reset_envelope(&mut self) {
        let transaction = self.transaction_count + 1;
        let session = self.session();
        session.envelope = SmtpEnvelope::default();
        session.transaction = transaction;
        self.transaction_open = false;
    }

    fn greeting_line(&self) -> String {
        format!("{} Nice to meet you, [{}]", self.server.name, self.remote_address)
    }

    fn ehlo(&mut self, line: &str) {
        let parts = split_whitespace(line);
        if parts.len() != 2 {
            return self.send(501, "Error: syntax: EHLO hostname");
        }
        self.session().host_name_appears_as = Some(parts[1].to_lowercase());

        let greeting = self.greeting_line();
        let size = format!("SIZE {}", self.server.options.size);
        let mut features = vec![greeting.as_str(), "PIPELINING", "8BITMIME", "SMTPUTF8"];
        if !self.authenticated() {
            features.push("AUTH LOGIN PLAIN");
        }
        if !self.secure && self.server.tls_available() {
            features.push("STARTTLS");
        }
        features.push(&size);

        self.reset_envelope();
        self.send_lines(250, &features);
    }

    fn helo(&mut self, line: &str) {
        let parts = split_whitespace(line);
        if parts.len() != 2 {
            return self.send(501, "Error: Syntax: HELO hostname");
        }
        self.session().host_name_appears_as = Some(parts[1].to_lowercase());
        self.reset_envelope();
        let greeting = self.greeting_line();
        self.send(250, &greeting);
    }

    fn start_tls(&mut self) {
        if self.secure {
            return self.send(503, "Error: TLS already active");
        }
        let Some(source) = self.server.options.tls.clone() else {
            return self.send(454, "Error: TLS not available");
        };
        // The certificate is read now, for this handshake.
        let acceptor = match source() {
            Ok(acceptor) => acceptor,
            Err(error) => {
                logger::error_with("SMTP: STARTTLS refused, the certificate could not be loaded", json!({}), &error);
                return self.send(454, "Error: TLS not available");
            }
        };

        self.send(220, "Ready to start TLS");
        // Anything pipelined after STARTTLS arrived in cleartext and must not be
        // read as if it came over the encrypted channel (RFC 3207 §4.2).
        self.pending.clear();
        self.upgrading = Some(acceptor);
        self.idle_at = None;
    }

    /// The TLS handshake of STARTTLS, over the socket the command came on.
    async fn upgrade(&mut self) {
        let Some(acceptor) = self.upgrading.take() else {
            return;
        };
        let timeout = self.socket_timeout();
        let Io::Plain(plain) = std::mem::replace(&mut self.io, Io::Closed) else {
            // STARTTLS is refused on a connection that is already encrypted.
            self.destroyed = true;
            return self.on_close();
        };
        let out = self.out.split().freeze();
        // What the paused connection had taken in behind STARTTLS is left
        // unread: the TLS layer reads the socket, not what was held back.
        self.held_back.clear();
        let handshake = async {
            let mut plain = plain;
            plain.write_all(&out).await?;
            plain.flush().await?;
            acceptor.accept(plain).await
        };
        let outcome = tokio::select! {
            outcome = tokio::time::timeout(timeout, handshake) => outcome,
            // A refusal cannot be said mid-handshake; the socket just goes.
            Some(Control::Refuse { done, .. }) = self.control.recv() => {
                drop(done);
                self.destroyed = true;
                return self.on_close();
            }
        };
        match outcome {
            Ok(Ok(stream)) => {
                self.io = Io::Tls(Box::new(stream));
                self.secure = true;
                self.flush_needed = false;
                let session = self.session();
                session.secure = true;
                // RFC 3207 §4.2: nothing learned before the handshake carries over.
                session.host_name_appears_as = None;
                session.user = None;
                self.reset_envelope();
                self.sync_handle();
                self.reply_backlog = false;
                self.stall_at = None;
                self.touch();
            }
            Ok(Err(error)) => {
                self.destroyed = true;
                // A client that hangs up mid-handshake is a reset: reported
                // only when it leaves a transaction open.
                let error = SmtpServerError::handshake(Some(&error), Some(self.remote_address.clone()));
                self.on_error(error);
                self.on_close();
            }
            Err(_) => {
                self.destroyed = true;
                self.on_close();
            }
        }
    }

    fn auth(&mut self, line: &str) {
        let mut words = split_whitespace(line).into_iter();
        words.next();
        let method = words.next().unwrap_or("").to_uppercase();
        let args: Vec<&str> = words.collect();

        if !self.secure && !self.server.options.allow_insecure_auth {
            return self.send(538, "Error: Must issue a STARTTLS command first");
        }
        if self.authenticated() {
            return self.send(503, "Error: No identity changes permitted");
        }

        match method.as_str() {
            "PLAIN" => {
                if args.len() > 1 {
                    return self.send(501, "Error: syntax: AUTH PLAIN token");
                }
                match args.first() {
                    Some(token) => self.auth_plain(token, false),
                    None => {
                        self.next_line = Some(NextLine::Plain);
                        self.send(334, "");
                    }
                }
            }
            "LOGIN" => {
                if args.len() > 1 {
                    return self.send(501, "Error: syntax: AUTH LOGIN");
                }
                match args.first() {
                    Some(username) => self.auth_login_username(username, false),
                    None => {
                        self.next_line = Some(NextLine::LoginUsername);
                        self.send(334, "VXNlcm5hbWU6");
                    }
                }
            }
            _ => self.send(504, "Error: Unrecognized authentication type"),
        }
    }

    fn auth_plain(&mut self, token: &str, can_abort: bool) {
        let trimmed = js::trim(token);
        if can_abort && trimmed == "*" {
            return self.send(501, "Authentication aborted");
        }
        let decoded = decode_base64_text(trimmed);
        let fields: Vec<&str> = decoded.split('\0').collect();
        let [authorization, authentication, password] = fields[..] else {
            return self.send(500, "Error: invalid userdata");
        };
        let username = if authentication.is_empty() { authorization } else { authentication };
        self.authenticate(SmtpAuthMethod::Plain, username.to_string(), password.to_string());
    }

    fn auth_login_username(&mut self, token: &str, can_abort: bool) {
        let trimmed = js::trim(token);
        if can_abort && trimmed == "*" {
            return self.send(501, "Authentication aborted");
        }
        let username = decode_base64_text(trimmed);
        if username.is_empty() {
            return self.send(500, "Error: missing username");
        }
        self.next_line = Some(NextLine::LoginPassword(username));
        self.send(334, "UGFzc3dvcmQ6");
    }

    fn auth_login_password(&mut self, username: String, token: &str) {
        let trimmed = js::trim(token);
        if trimmed == "*" {
            return self.send(501, "Authentication aborted");
        }
        self.authenticate(SmtpAuthMethod::Login, username, decode_base64_text(trimmed));
    }

    fn authenticate(&mut self, method: SmtpAuthMethod, username: String, password: String) {
        let handler = self.server.options.handler.0.clone();
        let request = SmtpAuthRequest { method, username, password };
        self.run_hook(|mut session| async move {
            let answer = handler.on_auth(request, &mut session).await;
            (session, HookAnswer::Auth(answer))
        });
    }

    fn mail(&mut self, line: &str) {
        let Some(parsed) = parse_address_command("mail from", line) else {
            return self.send(501, "Error: Bad sender address syntax");
        };
        if self.session().envelope.mail_from.is_some() {
            return self.send(503, "Error: nested MAIL command");
        }

        let arg = |key: &str| parsed.args.as_ref().and_then(|args| args.get(key));
        let size = self.server.options.size;
        let declared = match arg("SIZE") {
            Some(SmtpArgValue::Flag) => 1.0,
            Some(SmtpArgValue::Value(value)) => js_number(value),
            None => 0.0,
        };
        if declared > size as f64 {
            let text = format!("Error: message exceeds fixed maximum message size {size}");
            return self.send(552, &text);
        }
        let body = arg("BODY").map(|body| match body {
            SmtpArgValue::Flag => "true".to_string(),
            SmtpArgValue::Value(value) => value.to_lowercase(),
        });
        if body.as_deref().is_some_and(|body| body != "7bit" && body != "8bitmime") {
            return self.send(501, "Invalid BODY parameter value. Must be 7BIT or 8BITMIME");
        }
        let smtp_utf8 = arg("SMTPUTF8");
        if matches!(smtp_utf8, Some(SmtpArgValue::Value(_))) {
            return self.send(501, "Invalid SMTPUTF8 parameter. This flag does not accept a value");
        }
        let require_tls = arg("REQUIRETLS");
        if require_tls.is_some() {
            if !self.secure {
                return self.send(530, "REQUIRETLS not permitted on non-TLS connections");
            }
            if matches!(require_tls, Some(SmtpArgValue::Value(_))) {
                return self.send(501, "Invalid REQUIRETLS parameter. This flag does not accept a value");
            }
        }

        let (smtp_utf8, require_tls) = (smtp_utf8.is_some(), require_tls.is_some());
        let envelope = &mut self.session().envelope;
        if let Some(body) = body {
            envelope.body_type = body;
        }
        if smtp_utf8 {
            envelope.smtp_utf8 = true;
        }
        if require_tls {
            envelope.require_tls = true;
        }

        let handler = self.server.options.handler.0.clone();
        self.run_hook(|mut session| async move {
            let answer = handler.on_mail_from(&parsed, &mut session).await;
            (session, HookAnswer::Mail(parsed, answer))
        });
    }

    fn rcpt(&mut self, line: &str) {
        let parsed = match parse_address_command("rcpt to", line) {
            Some(parsed) if !parsed.address.is_empty() => parsed,
            _ => return self.send(501, "Error: Bad recipient address syntax"),
        };
        if self.session().envelope.mail_from.is_none() {
            return self.send(503, "Error: need MAIL command");
        }

        let recipients = &self.session().envelope.rcpt_to;
        let address = parsed.address.to_lowercase();
        let is_repeat = recipients.iter().any(|entry| entry.address.to_lowercase() == address);
        if !is_repeat && recipients.len() >= MAX_RECIPIENTS {
            return self.send(452, "Error: too many recipients");
        }

        let handler = self.server.options.handler.0.clone();
        self.run_hook(|mut session| async move {
            let answer = handler.on_rcpt_to(&parsed, &mut session).await;
            (session, HookAnswer::Rcpt(parsed, answer))
        });
    }

    fn data(&mut self) {
        if self.session().envelope.rcpt_to.is_empty() {
            return self.send(503, "Error: need RCPT command");
        }

        let (writer, stream) = data_stream(self.server.options.size);
        self.data = Some(DataTransfer { writer, unstuffer: Some(DotUnstuffer::new()), answer: None });

        let handler = self.server.options.handler.0.clone();
        self.start_hook(|mut session| async move {
            let answer = handler.on_data(stream, &mut session).await;
            (session, HookAnswer::Data(answer))
        });

        self.send(354, "End data with <CR><LF>.<CR><LF>");

        // Bytes that followed the DATA line in the same read are message content.
        let rest = self.pending.split().freeze();
        if !rest.is_empty() {
            self.feed_data(rest);
        }
    }

    fn feed_data(&mut self, chunk: Bytes) {
        let Some(data) = self.data.as_mut() else {
            return;
        };
        let Some(unstuffer) = data.unstuffer.as_mut() else {
            return;
        };
        let Unstuffed { data: pieces, rest } = unstuffer.feed(chunk);
        for piece in pieces {
            if !data.writer.is_ended() {
                data.writer.write(piece);
            }
        }
        if let Some(rest) = rest {
            data.unstuffer = None;
            data.writer.end();
            // Commands pipelined behind the message wait for its reply.
            self.pending = BytesMut::from(&rest[..]);
            self.busy = true;
        }
    }

    /// Answers the DATA transaction once `on_data` has answered and the
    /// message has been read out.
    fn reply_to_data(&mut self) -> bool {
        if self.closed {
            return false;
        }
        let Some(data) = self.data.as_mut() else {
            return false;
        };
        if data.answer.is_none() || !data.writer.is_finished() {
            return false;
        }
        match data.answer.take().expect("the answer is in") {
            Err(error) => self.send(error.code_or(450), &error.message),
            Ok(()) => self.send(250, "OK: message queued"),
        }
        self.finish_transaction();
        true
    }

    fn finish_transaction(&mut self) {
        self.data = None;
        self.transaction_count += 1;
        self.unrecognized = 0;
        self.reset_envelope();
        self.busy = false;
        if !self.closed && !self.reply_backlog {
            self.pump();
        }
    }

    /// Starts a hook the command waits on: nothing else is handled until it
    /// has answered.
    fn run_hook<F, Fut>(&mut self, hook: F)
    where
        F: FnOnce(SmtpSession) -> Fut,
        Fut: Future<Output = (SmtpSession, HookAnswer)> + Send + 'static,
    {
        self.busy = true;
        self.start_hook(hook);
    }

    /// Hands the session to a hook and takes its answer at once when it has one.
    fn start_hook<F, Fut>(&mut self, hook: F)
    where
        F: FnOnce(SmtpSession) -> Fut,
        Fut: Future<Output = (SmtpSession, HookAnswer)> + Send + 'static,
    {
        let session = self.session.take().expect("no hook is running while a command is handled");
        self.hook = Some(Box::pin(AssertUnwindSafe(hook(session)).catch_unwind()));
        self.poll_hook();
    }

    /// Lets the running hook get as far as it can. True when it answered.
    fn poll_hook(&mut self) -> bool {
        let Some(hook) = self.hook.as_mut() else {
            return false;
        };
        let Poll::Ready(done) = hook.as_mut().poll(&mut noop_context()) else {
            return false;
        };
        self.hook = None;
        self.on_hook_done(done);
        true
    }

    fn on_hook_done(&mut self, done: HookDone) {
        let (session, answer) = match done {
            Ok(done) => done,
            Err(panic) => {
                // The session went with the hook, so the connection cannot go on.
                let reason = panic
                    .downcast_ref::<&str>()
                    .map(|text| text.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                let error = SmtpServerError::new(format!("SMTP hook panicked: {reason}"));
                self.on_error(error);
                self.destroyed = true;
                return self.on_close();
            }
        };
        self.session = Some(session);
        match answer {
            HookAnswer::Auth(answer) => {
                match answer {
                    Err(error) => self.send(error.code_or(535), &error.message),
                    Ok(response) => match response.user.filter(|user| !user.is_empty()) {
                        None => {
                            let code = response.response_code.filter(|code| *code != 0).unwrap_or(535);
                            let message = response.message.filter(|message| !message.is_empty());
                            self.send(code, message.as_deref().unwrap_or("Error: Authentication credentials invalid"));
                        }
                        Some(user) => {
                            self.session().user = Some(user);
                            self.send(235, "Authentication successful");
                        }
                    },
                }
                self.resume_pending = true;
            }
            HookAnswer::Mail(parsed, answer) => {
                match answer {
                    Err(error) => self.send(error.code_or(550), &error.message),
                    Ok(()) => {
                        self.session().envelope.mail_from = Some(parsed);
                        self.send(250, "Accepted");
                    }
                }
                self.resume_pending = true;
            }
            HookAnswer::Rcpt(parsed, answer) => {
                match answer {
                    Err(error) => self.send(error.code_or(550), &error.message),
                    Ok(()) => {
                        let list = &mut self.session().envelope.rcpt_to;
                        let address = parsed.address.to_lowercase();
                        match list.iter().position(|entry| entry.address.to_lowercase() == address) {
                            Some(index) => list[index] = parsed,
                            None => list.push(parsed),
                        }
                        self.send(250, "Accepted");
                    }
                }
                self.resume_pending = true;
            }
            HookAnswer::Data(answer) => {
                if let Some(data) = self.data.as_mut() {
                    data.answer.get_or_insert(answer);
                }
            }
        }
        self.sync_handle();
    }

    /// Keeps what is read from outside the task in step with the session.
    fn sync_handle(&mut self) {
        if let Some(session) = self.session.as_ref() {
            self.transaction_open = session.envelope.mail_from.is_some();
            let user = session.user.clone();
            let mut current = self.handle.user.lock_unpoisoned();
            if *current != user {
                *current = user;
            }
        }
    }

    fn on_close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.server.remove_connection(self.id);
        // A transfer cut off mid-DATA ends without an end, which is how the
        // consumer tells an abandoned message from a complete one.
        if let Some(data) = self.data.take() {
            if !data.writer.is_ended() {
                data.writer.abandon();
            }
        }
    }

    fn on_error(&mut self, mut error: SmtpServerError) {
        error.remote_address = Some(self.remote_address.clone());
        let quiet = matches!(error.code.as_deref(), Some("ECONNRESET" | "EPIPE"));
        if quiet && !self.transaction_open {
            // A client dropping the connection outside a transaction is how most
            // sessions end; nothing was accepted, so nothing is reported.
            self.close();
            return;
        }
        self.server.emit_error(&error);
    }

    /// The socket's last moments: what was queued before it closed is still
    /// written, and a hook that is running is left to finish on its own.
    async fn teardown(mut self) {
        self.server.remove_connection(self.id);
        if let Some(hook) = self.hook.take() {
            tokio::spawn(hook);
        }
        if self.destroyed {
            return;
        }
        let out = self.out.split().freeze();
        let timeout = self.socket_timeout();
        let goodbye = async {
            self.io.write_all(&out).await?;
            self.io.flush().await?;
            self.io.shutdown().await
        };
        let _ = tokio::time::timeout(timeout, goodbye).await;
    }
}

/// The answer of the hook that is running.
async fn hook_done(hook: &mut Option<RunningHook>) -> HookDone {
    match hook.as_mut() {
        Some(hook) => hook.as_mut().await,
        None => std::future::pending().await,
    }
}

/// The DATA consumer caught up, read the message's end, or went away.
async fn data_progress(data: &Option<DataTransfer>) {
    match data.as_ref() {
        Some(data) => data.writer.progress().await,
        None => std::future::pending().await,
    }
}

/// One step of socket work: writing queued replies comes before reading.
async fn poll_io(
    io: &mut Io,
    out: &[u8],
    flush_needed: bool,
    want_shutdown: bool,
    want_read: bool,
    buffer: &mut [u8],
) -> IoEvent {
    std::future::poll_fn(|cx| {
        if !out.is_empty() {
            if let Poll::Ready(result) = Pin::new(&mut *io).poll_write(cx, out) {
                return Poll::Ready(IoEvent::Wrote(result));
            }
        } else if flush_needed {
            if let Poll::Ready(result) = Pin::new(&mut *io).poll_flush(cx) {
                return Poll::Ready(IoEvent::Flushed(result));
            }
        } else if want_shutdown {
            // A FIN that cannot be sent leaves the client to notice on its own.
            if Pin::new(&mut *io).poll_shutdown(cx).is_ready() {
                return Poll::Ready(IoEvent::ShutDown);
            }
        }
        if want_read {
            let mut read = ReadBuf::new(buffer);
            if let Poll::Ready(result) = Pin::new(&mut *io).poll_read(cx, &mut read) {
                return Poll::Ready(IoEvent::Read(result.map(|()| read.filled().len())));
            }
        }
        Poll::Pending
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds `input` in the given pieces; the message, and what followed the terminator.
    fn unstuff(pieces: &[&[u8]]) -> (Vec<u8>, Option<Vec<u8>>) {
        let mut unstuffer = DotUnstuffer::new();
        let mut message = Vec::new();
        for (index, piece) in pieces.iter().enumerate() {
            let Unstuffed { data, rest } = unstuffer.feed(Bytes::copy_from_slice(piece));
            data.iter().for_each(|chunk| message.extend_from_slice(chunk));
            if let Some(rest) = rest {
                let mut rest = rest.to_vec();
                pieces[index + 1..].iter().for_each(|later| rest.extend_from_slice(later));
                return (message, Some(rest));
            }
        }
        (message, None)
    }

    /// The message and the rest, worked out over the whole input at once.
    fn reference(input: &[u8]) -> (Vec<u8>, Option<Vec<u8>>) {
        let mut message = Vec::new();
        let mut line_start = 0;
        let mut after_crlf = true;
        loop {
            let line_end = input[line_start..].iter().position(|&byte| byte == LF).map(|at| line_start + at + 1);
            let line = &input[line_start..line_end.unwrap_or(input.len())];
            if after_crlf && line == b".\r\n" {
                return (message, Some(input[line_start + 3..].to_vec()));
            }
            let Some(line_end) = line_end else {
                // An unfinished line: a dot that may yet be stuffing or the terminator is held back.
                let held = line == b"." || (after_crlf && line == b".\r");
                let kept = if held { &[][..] } else { line.strip_prefix(b"..").map_or(line, |_| &line[1..]) };
                message.extend_from_slice(kept);
                return (message, None);
            };
            message.extend_from_slice(line.strip_prefix(b"..").map_or(line, |_| &line[1..]));
            after_crlf = line.ends_with(b"\r\n");
            line_start = line_end;
        }
    }

    #[test]
    fn unstuffs_dots_and_stops_at_the_terminator() {
        let (message, rest) = unstuff(&[b"..leading dot\r\n.x\r\nlast\r\n.\r\nNOOP\r\n"]);
        assert_eq!(message, b".leading dot\r\n.x\r\nlast\r\n");
        assert_eq!(rest.as_deref(), Some(&b"NOOP\r\n"[..]));

        assert_eq!(unstuff(&[b".\r\n"]), (Vec::new(), Some(Vec::new())));
        assert_eq!(unstuff(&[b"...\r\n.. \r\n..\r\n.\r\n"]).0, b"..\r\n. \r\n.\r\n");
        assert_eq!(unstuff(&[b"a.\r\n.b\r\n"]), (b"a.\r\n.b\r\n".to_vec(), None));
    }

    #[test]
    fn finds_the_terminator_split_across_chunks() {
        let (message, rest) = unstuff(&[b"Subject: x\r\n\r\nbody\r", b"\n", b".", b"\r", b"\n"]);
        assert_eq!(message, b"Subject: x\r\n\r\nbody\r\n");
        assert_eq!(rest, Some(Vec::new()));

        let (message, rest) = unstuff(&[b"line\r\n", b".", b".stuffed\r\n.", b"x\r\n.", b"\r", b"y\r\n", b".\r", b"\nQUIT"]);
        assert_eq!(message, b"line\r\n.stuffed\r\n.x\r\n.\ry\r\n");
        assert_eq!(rest.as_deref(), Some(&b"QUIT"[..]));
    }

    #[test]
    fn ends_only_at_crlf_dot_crlf() {
        let content = b"A\n.\r\nMAIL FROM:<smuggled@x.org>\r\nB\r\n.\nRCPT TO:<smuggled@x.org>\r\nC\n.\nD\r.\rE\r\n";
        let mut input = content.to_vec();
        input.extend_from_slice(b".\r\n");
        assert_eq!(unstuff(&[&input]), (content.to_vec(), Some(Vec::new())));
        // A dot after a bare line feed is still unstuffed.
        assert_eq!(unstuff(&[b"a\n..b\n.\r\nc\r..d\r\n.\r\n"]).0, b"a\n.b\n.\r\nc\r..d\r\n");
    }

    #[test]
    fn gives_the_same_message_however_the_bytes_are_cut() {
        // A small generator, so a failure names an input that fails again.
        let mut state = 0x9e37_79b9u32;
        let mut next = move |below: u32| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state % below
        };
        for _ in 0..3000 {
            let length = next(40) as usize;
            let input: Vec<u8> = (0..length).map(|_| b".\r\n.a\r\n"[next(7) as usize]).collect();
            let expected = reference(&input);
            assert_eq!(unstuff(&[&input]), expected, "{:?}", String::from_utf8_lossy(&input));

            let mut pieces: Vec<&[u8]> = Vec::new();
            let mut at = 0;
            while at < input.len() {
                let take = (1 + next(4) as usize).min(input.len() - at);
                pieces.push(&input[at..at + take]);
                at += take;
            }
            assert_eq!(unstuff(&pieces), expected, "{:?} cut as {pieces:?}", String::from_utf8_lossy(&input));
        }
    }

    #[test]
    fn decodes_base64_as_buffer_from_does() {
        assert_eq!(decode_base64_lenient("AHVzZXIAcGFzcw=="), b"\0user\0pass");
        assert_eq!(decode_base64_lenient("AHVzZXIAcGFzcw"), b"\0user\0pass");
        assert_eq!(decode_base64_lenient("AHVz ZXIA\tcGFz*cw=="), b"\0user\0pass");
        assert_eq!(decode_base64_lenient("YQ==YQ=="), b"a");
        assert_eq!(decode_base64_lenient("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(decode_base64_lenient("*"), b"");
        assert_eq!(decode_base64_lenient("A"), b"");
        // Outside Latin-1 a character counts as the low byte of its UTF-16 units.
        assert_eq!(decode_base64_lenient("\u{141}\u{141}\u{141}\u{141}"), [0, 0, 0]);
        assert_eq!(decode_base64_lenient("\u{1f600}QUJD"), b"");
        assert_eq!(decode_base64_text("w6k="), "é");
        assert_eq!(decode_base64_text("//4="), "\u{fffd}\u{fffd}");
    }

    #[test]
    fn reads_a_declared_size_as_javascript_reads_a_number() {
        assert_eq!(js_number("1048577"), 1_048_577.0);
        assert_eq!(js_number("1e9"), 1e9);
        assert_eq!(js_number("0x200000"), 2_097_152.0);
        assert_eq!(js_number("0XFFFFFFFFFFFFFFFFFFFF"), 1_208_925_819_614_629_174_706_175.0);
        assert_eq!(js_number("12.5"), 12.5);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert!(js_number("abc").is_nan());
        assert!(js_number("0x").is_nan());
        assert!(js_number("12abc").is_nan());
        assert!(js_number("\u{85}5").is_nan());
    }

    #[test]
    fn recognizes_an_http_request_line_as_the_bun_server_does() {
        for line in ["GET / HTTP/1.1", "post /submit http/1.0", "OPTIONS /a b c HTTP/2.0", "CONNECT /x:443 HTTP/1.1"] {
            assert!(HTTP_REQUEST.is_match(line), "{line}");
        }
        for line in [
            "GET /HTTP/1.1",
            "GET / HTTP/1.1 ",
            "GET / HTTP/11",
            "PATCH / HTTP/1.1",
            " GET / HTTP/1.1",
            "GET / HTTP/1.1\r",
            "GET /a\rb HTTP/1.1",
            "GET /a\u{2028}b HTTP/1.1",
            "PO\u{17f}T / HTTP/1.1",
            "GET / HTTP/\u{661}.1",
        ] {
            assert!(!HTTP_REQUEST.is_match(line), "{line:?}");
        }
    }
}
