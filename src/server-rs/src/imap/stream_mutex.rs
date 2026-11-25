//! Per-key mutex for streaming a message body (imap/stream-mutex.ts).
//!
//! IMAP clients (notably iOS Mail) pipeline several fetches of the SAME mail.
//! Each would start its own stream of the body, all doing the same database
//! round trips and attachment reads for one identical response. The body
//! budget bounds aggregate work but not duplicate work.
//!
//! This serializes streams of one key: a second request for a key that is
//! streaming queues, and starts its own fresh stream when the first is done.
//! Retries pay latency, memory stays bounded, and nothing is materialized.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Mutex, OnceLock};

use tokio::sync::oneshot;

use super::command_budget_hold::yield_command_budget_during;
use crate::sync::LockUnpoisoned;

/// Absent key: available. Present: held, and the queue is who waits for it.
fn inflight() -> &'static Mutex<HashMap<String, VecDeque<oneshot::Sender<()>>>> {
    static INFLIGHT: OnceLock<Mutex<HashMap<String, VecDeque<oneshot::Sender<()>>>>> = OnceLock::new();
    INFLIGHT.get_or_init(Default::default)
}

fn release(key: &str) {
    let mut inflight = inflight().lock_unpoisoned();
    let Some(queue) = inflight.get_mut(key) else {
        return;
    };
    // Ownership passes to the first waiter still there; the entry stays.
    while let Some(next) = queue.pop_front() {
        if next.send(()).is_ok() {
            return;
        }
    }
    inflight.remove(key);
}

/// Ownership of a key, given up when dropped.
#[must_use = "the key is released when this is dropped"]
pub struct StreamMutexGuard {
    key: String,
}

impl Drop for StreamMutexGuard {
    fn drop(&mut self) {
        release(&self.key);
    }
}

/// A place in a key's queue. Dropped before its turn it leaves the queue;
/// dropped after being handed the key it passes the key on.
struct Queued {
    key: String,
    turn: Option<oneshot::Receiver<()>>,
}

impl Drop for Queued {
    fn drop(&mut self) {
        let Some(mut turn) = self.turn.take() else {
            return;
        };
        turn.close();
        if turn.try_recv().is_ok() {
            release(&self.key);
        }
    }
}

/// Waits for `key` and holds it until the guard is dropped. Callers for one
/// key are served in arrival order; other keys do not wait on each other.
///
/// The guard is released when the stream it covers completes, fails, or is
/// abandoned by its consumer.
pub async fn acquire_stream_mutex(key: &str) -> StreamMutexGuard {
    let turn = {
        let mut inflight = inflight().lock_unpoisoned();
        match inflight.get_mut(key) {
            None => {
                inflight.insert(key.to_string(), VecDeque::new());
                None
            }
            Some(queue) => {
                let (granted, turn) = oneshot::channel();
                queue.push_back(granted);
                Some(turn)
            }
        }
    };
    if let Some(turn) = turn {
        let mut queued = Queued { key: key.to_string(), turn: Some(turn) };
        yield_command_budget_during(async {
            if let Some(turn) = queued.turn.as_mut() {
                // The sender is only dropped by a reset, which abandons its waiters.
                let _ = turn.await;
            }
        })
        .await;
        queued.turn = None;
    }
    StreamMutexGuard { key: key.to_string() }
}

/// Runs `work` holding `key`.
pub async fn with_stream_mutex<F: Future>(key: &str, work: F) -> F::Output {
    let _guard = acquire_stream_mutex(key).await;
    work.await
}

/// Forgets every key and waiter. For tests.
pub fn reset_stream_mutex() {
    inflight().lock_unpoisoned().clear();
}

/// Number of keys held now.
pub fn stream_mutex_held_count() -> usize {
    inflight().lock_unpoisoned().len()
}

/// Number of callers queued for `key`.
pub fn stream_mutex_waiters_for(key: &str) -> usize {
    inflight().lock_unpoisoned().get(key).map_or(0, VecDeque::len)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    // Keys are per test, so the tests share the map without sharing state.

    #[tokio::test]
    async fn runs_different_keys_in_parallel() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for key in ["parallel-a", "parallel-b"] {
            let (running, peak) = (running.clone(), peak.clone());
            tasks.push(tokio::spawn(async move {
                with_stream_mutex(key, async {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    running.fetch_sub(1, Ordering::SeqCst);
                })
                .await;
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(stream_mutex_waiters_for("parallel-a"), 0);
    }

    #[tokio::test]
    async fn serializes_streams_of_one_key() {
        let key = "serial-key";
        let first = acquire_stream_mutex(key).await;
        let second = tokio::spawn(async move {
            let _guard = acquire_stream_mutex(key).await;
        });
        settle().await;
        assert!(!second.is_finished());
        assert_eq!(stream_mutex_waiters_for(key), 1);
        drop(first);
        second.await.unwrap();
        assert_eq!(stream_mutex_waiters_for(key), 0);
    }

    #[tokio::test]
    async fn wakes_waiters_of_one_key_in_fifo_order() {
        let key = "fifo-key";
        let head = acquire_stream_mutex(key).await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for n in 0..3 {
            let order = order.clone();
            tasks.push(tokio::spawn(async move {
                let _guard = acquire_stream_mutex(key).await;
                order.lock().unwrap().push(n);
                tokio::task::yield_now().await;
            }));
            settle().await;
        }
        assert_eq!(stream_mutex_waiters_for(key), 3);
        drop(head);
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn releases_the_key_when_the_stream_is_abandoned() {
        let key = "abandoned-key";
        let stuck = tokio::spawn(with_stream_mutex(key, std::future::pending::<()>()));
        settle().await;
        assert_eq!(stream_mutex_waiters_for(key), 0);
        stuck.abort();
        let _ = stuck.await;
        // The next stream of the key starts at once.
        let _next =
            tokio::time::timeout(Duration::from_secs(1), acquire_stream_mutex(key)).await.expect("the key was released");
    }

    #[tokio::test]
    async fn a_waiter_that_gives_up_does_not_strand_the_ones_behind_it() {
        let key = "gave-up-key";
        let head = acquire_stream_mutex(key).await;
        let impatient = tokio::spawn(async move {
            let _guard = acquire_stream_mutex(key).await;
        });
        settle().await;
        let patient = tokio::spawn(async move {
            let _guard = acquire_stream_mutex(key).await;
        });
        settle().await;
        impatient.abort();
        let _ = impatient.await;
        drop(head);
        tokio::time::timeout(Duration::from_secs(1), patient).await.expect("the key reached the next waiter").unwrap();
        settle().await;
        assert_eq!(stream_mutex_waiters_for(key), 0);
    }

    #[tokio::test]
    async fn an_empty_stream_releases_at_once() {
        let key = "empty-key";
        with_stream_mutex(key, async {}).await;
        assert_eq!(stream_mutex_waiters_for(key), 0);
        let _again = acquire_stream_mutex(key).await;
    }
}
