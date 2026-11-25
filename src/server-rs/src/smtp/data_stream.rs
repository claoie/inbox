//! The message of one DATA transaction, handed to `on_data` as it arrives.
//!
//! This is the `PassThrough` the Bun server writes the dot-unstuffed message
//! into: the connection pushes what it reads, stops reading its socket while
//! the consumer is behind, and tells a message that ended from one whose
//! connection went away. It can also hold the message to the listener's size
//! ceiling, as the Bun mail handling does with its own `PassThrough` in front
//! of the parser (`boundMessageSize` in `smtp.ts`).

use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use bytes::Bytes;
use futures_util::Stream;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::Notify;

use super::types::SmtpHookError;
use crate::sync::LockUnpoisoned;

/// What the stream holds before the connection stops reading its socket: a
/// `PassThrough` fills its writable and its readable side, 64 KiB each.
const HIGH_WATER_MARK: usize = 128 * 1024;

/// The connection reads again once the consumer has brought the backlog
/// down to this.
const LOW_WATER_MARK: usize = HIGH_WATER_MARK / 2;

/// The error a read fails with when the connection was lost before the
/// message's end. See [`SmtpDataStream::is_abandoned`].
#[derive(Debug)]
pub struct SmtpDataAbandoned;

impl fmt::Display for SmtpDataAbandoned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the connection was lost before the end of DATA")
    }
}

impl std::error::Error for SmtpDataAbandoned {}

/// The error a read fails with once the message has grown past the size
/// ceiling a consumer asked for with [`SmtpDataStream::enforce_size_limit`].
/// See [`SmtpDataStream::is_too_large`].
///
/// As a hook's answer it is the reply the Bun server gives such a message:
/// `552 Error: message exceeds fixed maximum message size <limit>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmtpDataTooLarge {
    pub limit: u64,
}

impl SmtpDataTooLarge {
    /// RFC 5321 §4.2.3 gives 552 to a message that exceeds the fixed maximum size.
    pub const RESPONSE_CODE: u16 = 552;
}

impl fmt::Display for SmtpDataTooLarge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Error: message exceeds fixed maximum message size {}", self.limit)
    }
}

impl std::error::Error for SmtpDataTooLarge {}

impl From<SmtpDataTooLarge> for SmtpHookError {
    fn from(error: SmtpDataTooLarge) -> SmtpHookError {
        SmtpHookError::with_code(SmtpDataTooLarge::RESPONSE_CODE, error.to_string())
    }
}

#[derive(Default)]
struct State {
    chunks: VecDeque<Bytes>,
    buffered: usize,
    /// Every byte of the message the connection has handed over so far.
    written: u64,
    /// The listener's `size`.
    size_limit: u64,
    /// The consumer asked for the message to be held to `size_limit`.
    enforce_size_limit: bool,
    /// The message grew past `size_limit` while that was enforced: what is
    /// left of it is discarded and reads fail.
    too_large: bool,
    /// The terminator was seen: no more bytes will follow.
    ended: bool,
    /// The connection closed before the terminator.
    abandoned: bool,
    /// The consumer has read the end, which is when the reply may go out.
    end_read: bool,
    reader_gone: bool,
    /// The connection stopped reading its socket until the backlog is consumed.
    need_drain: bool,
    reader: Option<Waker>,
}

struct Shared {
    state: Mutex<State>,
    /// Wakes the connection: the backlog drained, the end was read, or the
    /// consumer dropped the stream.
    progress: Notify,
}

/// The connection's side of the stream.
pub(crate) struct DataWriter {
    shared: Arc<Shared>,
}

/// The message of a DATA transaction: dot-unstuffed, without the terminator.
///
/// Read it with [`AsyncRead`] or chunk by chunk as a [`Stream`]. It ends
/// (`Ok(0)` / `None`) at the message's terminator; when the connection is
/// lost first, the read fails with an error [`SmtpDataStream::is_abandoned`]
/// recognizes, which is how a consumer tells an abandoned message from a
/// complete one. Dropping the stream discards the rest of the message.
pub struct SmtpDataStream {
    shared: Arc<Shared>,
}

/// The two ends of the message of one DATA transaction on a listener whose
/// `size` is `size_limit`.
pub(crate) fn data_stream(size_limit: u64) -> (DataWriter, SmtpDataStream) {
    let state = State { size_limit, ..State::default() };
    let shared = Arc::new(Shared { state: Mutex::new(state), progress: Notify::new() });
    (DataWriter { shared: shared.clone() }, SmtpDataStream { shared })
}

impl State {
    /// Whether what arrives now is thrown away rather than queued.
    fn discarding(&self) -> bool {
        self.reader_gone || self.too_large
    }

    /// Past the enforced ceiling: drops what is queued and everything after
    /// it. True when this is the moment the ceiling was crossed.
    fn check_size(&mut self) -> bool {
        if !self.enforce_size_limit || self.too_large || self.written <= self.size_limit {
            return false;
        }
        self.too_large = true;
        self.chunks.clear();
        self.buffered = 0;
        self.need_drain = false;
        true
    }
}

impl DataWriter {
    /// Queues message bytes. `false` means the consumer is behind and the
    /// socket should not be read until [`DataWriter::needs_drain`] clears.
    pub fn write(&self, chunk: Bytes) -> bool {
        let mut state = self.shared.state.lock_unpoisoned();
        if state.ended || state.abandoned || chunk.is_empty() {
            return !state.need_drain;
        }
        state.written += chunk.len() as u64;
        if state.check_size() {
            // A reader waiting for more learns at once.
            let waker = state.reader.take();
            drop(state);
            if let Some(waker) = waker {
                waker.wake();
            }
            return true;
        }
        if state.discarding() {
            return !state.need_drain;
        }
        state.buffered += chunk.len();
        state.chunks.push_back(chunk);
        if state.buffered >= HIGH_WATER_MARK {
            state.need_drain = true;
        }
        let flowing = !state.need_drain;
        let waker = state.reader.take();
        drop(state);
        if let Some(waker) = waker {
            waker.wake();
        }
        flowing
    }

    /// Marks the end of the message.
    pub fn end(&self) {
        self.finish(false);
    }

    /// The connection is gone before the message's end.
    pub fn abandon(&self) {
        self.finish(true);
    }

    fn finish(&self, abandoned: bool) {
        let mut state = self.shared.state.lock_unpoisoned();
        if state.ended || state.abandoned {
            return;
        }
        if abandoned {
            state.abandoned = true;
        } else {
            state.ended = true;
        }
        let waker = state.reader.take();
        drop(state);
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Whether [`DataWriter::end`] was called.
    pub fn is_ended(&self) -> bool {
        self.shared.state.lock_unpoisoned().ended
    }

    /// The consumer has not caught up with what was written yet.
    pub fn needs_drain(&self) -> bool {
        self.shared.state.lock_unpoisoned().need_drain
    }

    /// The message ended and its consumer has read all of it, or dropped it,
    /// or it went past the size ceiling and the rest was discarded.
    pub fn is_finished(&self) -> bool {
        let state = self.shared.state.lock_unpoisoned();
        state.ended && (state.end_read || state.discarding())
    }

    /// Resolves when the consumer made progress the connection cares about.
    pub async fn progress(&self) {
        self.shared.progress.notified().await;
    }
}

impl Drop for DataWriter {
    fn drop(&mut self) {
        self.abandon();
    }
}

impl SmtpDataStream {
    /// Whether `error` is this stream reporting that the connection was lost
    /// mid-message — as opposed to the message having ended.
    pub fn is_abandoned(error: &io::Error) -> bool {
        error.get_ref().is_some_and(|inner| inner.is::<SmtpDataAbandoned>())
    }

    /// Whether `error` is this stream reporting that the message grew past
    /// the ceiling [`SmtpDataStream::enforce_size_limit`] set.
    pub fn is_too_large(error: &io::Error) -> bool {
        error.get_ref().is_some_and(|inner| inner.is::<SmtpDataTooLarge>())
    }

    /// The listener's `size`: the ceiling it advertises in EHLO and checks a
    /// declared `SIZE=` against.
    pub fn size_limit(&self) -> u64 {
        self.shared.state.lock_unpoisoned().size_limit
    }

    /// How many bytes of the message have arrived so far, read or not.
    pub fn received(&self) -> u64 {
        self.shared.state.lock_unpoisoned().written
    }

    /// Holds the message to the listener's `size`. Once more than that has
    /// arrived — the whole message counted, from its first byte, after
    /// dot-unstuffing — what is still queued is dropped, every read from
    /// then on fails with [`SmtpDataTooLarge`], and the server discards the
    /// rest of the message up to its terminator before it replies. A message
    /// of exactly `size` bytes passes.
    ///
    /// The listener does not do this on its own, because the Bun server's
    /// does not: there the mail handling counts the octets in front of its
    /// parser and refuses as soon as the ceiling is crossed. Answer the hook
    /// with the error (`SmtpHookError::from(too_large)`) for its 552.
    pub fn enforce_size_limit(&mut self) {
        let mut state = self.shared.state.lock_unpoisoned();
        state.enforce_size_limit = true;
        let crossed = state.check_size();
        drop(state);
        if crossed {
            // The connection may be holding its socket for this consumer.
            self.shared.progress.notify_one();
        }
    }

    /// Whether the message went past the ceiling being enforced.
    pub fn is_over_size_limit(&self) -> bool {
        self.shared.state.lock_unpoisoned().too_large
    }

    /// The bytes that have arrived and not been read yet. The connection
    /// stops reading its socket while this is at the high-water mark.
    pub fn buffered(&self) -> usize {
        self.shared.state.lock_unpoisoned().buffered
    }

    /// The next piece of the message, `None` at its end.
    pub async fn next_chunk(&mut self) -> io::Result<Option<Bytes>> {
        std::future::poll_fn(|cx| self.poll_chunk(cx, usize::MAX)).await
    }

    fn poll_chunk(&mut self, cx: &mut Context<'_>, limit: usize) -> Poll<io::Result<Option<Bytes>>> {
        let mut state = self.shared.state.lock_unpoisoned();
        if state.too_large {
            let limit = state.size_limit;
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::InvalidData, SmtpDataTooLarge { limit })));
        }
        if let Some(front) = state.chunks.front_mut() {
            let piece = if front.len() <= limit {
                state.chunks.pop_front().expect("the front chunk exists")
            } else {
                front.split_to(limit)
            };
            state.buffered -= piece.len();
            if state.need_drain && state.buffered <= LOW_WATER_MARK {
                state.need_drain = false;
                drop(state);
                self.shared.progress.notify_one();
            }
            return Poll::Ready(Ok(Some(piece)));
        }
        if state.abandoned {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::ConnectionAborted, SmtpDataAbandoned)));
        }
        if state.ended {
            let first = !state.end_read;
            state.end_read = true;
            drop(state);
            if first {
                self.shared.progress.notify_one();
            }
            return Poll::Ready(Ok(None));
        }
        state.reader = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl AsyncRead for SmtpDataStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        match self.poll_chunk(cx, buf.remaining()) {
            Poll::Ready(Ok(Some(piece))) => {
                buf.put_slice(&piece);
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Ok(None)) => Poll::Ready(Ok(())),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Stream for SmtpDataStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.poll_chunk(cx, usize::MAX) {
            Poll::Ready(Ok(Some(piece))) => Poll::Ready(Some(Ok(piece))),
            Poll::Ready(Ok(None)) => Poll::Ready(None),
            Poll::Ready(Err(error)) => Poll::Ready(Some(Err(error))),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for SmtpDataStream {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock_unpoisoned();
        state.reader_gone = true;
        state.chunks.clear();
        state.buffered = 0;
        state.need_drain = false;
        state.reader = None;
        drop(state);
        self.shared.progress.notify_one();
    }
}

impl fmt::Debug for SmtpDataStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SmtpDataStream")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    const LIMIT: u64 = 1024 * 1024;

    fn data_stream() -> (DataWriter, SmtpDataStream) {
        super::data_stream(LIMIT)
    }

    #[tokio::test]
    async fn delivers_the_message_and_then_its_end() {
        let (writer, mut stream) = data_stream();
        assert!(writer.write(Bytes::from_static(b"Subject: x\r\n")));
        assert!(writer.write(Bytes::from_static(b"\r\nbody\r\n")));
        writer.end();
        assert!(!writer.is_finished());
        let mut message = Vec::new();
        stream.read_to_end(&mut message).await.unwrap();
        assert_eq!(message, b"Subject: x\r\n\r\nbody\r\n");
        assert!(writer.is_finished());
    }

    #[tokio::test]
    async fn fails_the_read_when_the_connection_is_lost_first() {
        let (writer, mut stream) = data_stream();
        writer.write(Bytes::from_static(b"partial"));
        drop(writer);
        assert_eq!(stream.next_chunk().await.unwrap().unwrap(), "partial");
        let error = stream.next_chunk().await.unwrap_err();
        assert!(SmtpDataStream::is_abandoned(&error));
        assert!(!SmtpDataStream::is_abandoned(&io::Error::other("something else")));
    }

    #[tokio::test]
    async fn asks_the_writer_to_wait_while_the_consumer_is_behind() {
        let (writer, mut stream) = data_stream();
        let chunk = Bytes::from(vec![b'a'; 64 * 1024]);
        assert!(writer.write(chunk.clone()));
        assert!(!writer.write(chunk.clone()));
        assert!(writer.needs_drain());
        let progress = writer.progress();
        tokio::pin!(progress);
        assert!(futures_util::poll!(progress.as_mut()).is_pending());
        let mut buffer = vec![0u8; 64 * 1024];
        stream.read_exact(&mut buffer).await.unwrap();
        progress.await;
        assert!(!writer.needs_drain());
    }

    #[tokio::test]
    async fn a_dropped_stream_discards_what_follows() {
        let (writer, stream) = data_stream();
        writer.write(Bytes::from(vec![b'a'; HIGH_WATER_MARK]));
        assert!(writer.needs_drain());
        drop(stream);
        assert!(!writer.needs_drain());
        assert!(writer.write(Bytes::from(vec![b'a'; HIGH_WATER_MARK])));
        writer.end();
        assert!(writer.is_finished());
    }
}

#[cfg(test)]
mod size_limit_tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn passes_a_message_of_exactly_the_ceiling() {
        let (writer, mut stream) = data_stream(10);
        stream.enforce_size_limit();
        writer.write(Bytes::from_static(b"12345"));
        writer.write(Bytes::from_static(b"67890"));
        writer.end();
        let mut message = Vec::new();
        stream.read_to_end(&mut message).await.unwrap();
        assert_eq!(message, b"1234567890");
        assert_eq!(stream.received(), 10);
        assert!(!stream.is_over_size_limit());
        assert!(writer.is_finished());
    }

    #[tokio::test]
    async fn fails_the_read_once_the_message_grows_past_the_ceiling() {
        let (writer, mut stream) = data_stream(10);
        assert_eq!(stream.size_limit(), 10);
        stream.enforce_size_limit();
        writer.write(Bytes::from_static(b"12345"));
        assert_eq!(stream.next_chunk().await.unwrap().unwrap(), "12345");
        writer.write(Bytes::from_static(b"678901"));
        let error = stream.next_chunk().await.unwrap_err();
        assert!(SmtpDataStream::is_too_large(&error));
        assert!(!SmtpDataStream::is_abandoned(&error));
        assert!(stream.is_over_size_limit());
        let too_large = error.get_ref().and_then(|inner| inner.downcast_ref::<SmtpDataTooLarge>()).copied();
        let refusal = SmtpHookError::from(too_large.expect("the error says how large"));
        assert_eq!(refusal, SmtpHookError::with_code(552, "Error: message exceeds fixed maximum message size 10"));

        // The rest is discarded without holding the connection back, and the
        // reply may go out once the terminator is in.
        assert!(writer.write(Bytes::from(vec![b'a'; 2 * HIGH_WATER_MARK])));
        assert!(!writer.needs_drain());
        assert!(!writer.is_finished());
        writer.end();
        assert!(writer.is_finished());
        assert!(SmtpDataStream::is_too_large(&stream.next_chunk().await.unwrap_err()));
    }

    #[tokio::test]
    async fn counts_what_arrived_before_the_ceiling_was_asked_for() {
        let (writer, mut stream) = data_stream(10);
        writer.write(Bytes::from_static(b"123456789012"));
        assert_eq!(stream.received(), 12);
        assert!(!stream.is_over_size_limit());
        stream.enforce_size_limit();
        assert!(stream.is_over_size_limit());
        assert!(SmtpDataStream::is_too_large(&stream.next_chunk().await.unwrap_err()));
    }

    #[tokio::test]
    async fn wakes_a_reader_that_waits_when_the_ceiling_is_crossed() {
        let (writer, mut stream) = data_stream(4);
        stream.enforce_size_limit();
        let reader = tokio::spawn(async move { stream.next_chunk().await.map(|chunk| chunk.map(|c| c.to_vec())) });
        tokio::task::yield_now().await;
        writer.write(Bytes::from_static(b"12345"));
        let error = reader.await.unwrap().unwrap_err();
        assert!(SmtpDataStream::is_too_large(&error));
    }

    #[tokio::test]
    async fn leaves_a_message_alone_when_nobody_asked_for_the_ceiling() {
        let (writer, mut stream) = data_stream(4);
        writer.write(Bytes::from_static(b"123456789"));
        writer.end();
        let mut message = Vec::new();
        stream.read_to_end(&mut message).await.unwrap();
        assert_eq!(message, b"123456789");
    }
}
