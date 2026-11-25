//! A counting semaphore that grants waiters strictly in arrival order.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;
use crate::sync::LockUnpoisoned;

struct State {
    in_flight: usize,
    wait_queue: VecDeque<(u64, oneshot::Sender<()>)>,
    next_id: u64,
}

pub struct FifoSemaphore {
    capacity: usize,
    state: Mutex<State>,
}

impl FifoSemaphore {
    pub fn new(capacity: usize) -> FifoSemaphore {
        FifoSemaphore {
            capacity,
            state: Mutex::new(State { in_flight: 0, wait_queue: VecDeque::new(), next_id: 0 }),
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn in_flight(&self) -> usize {
        self.state.lock_unpoisoned().in_flight
    }

    /// Takes a slot if one is free right now.
    pub fn try_acquire(&self) -> bool {
        let mut state = self.state.lock_unpoisoned();
        if state.in_flight >= self.capacity {
            return false;
        }
        state.in_flight += 1;
        true
    }

    fn enqueue(&self) -> Option<(u64, oneshot::Receiver<()>)> {
        let mut state = self.state.lock_unpoisoned();
        if state.in_flight < self.capacity {
            state.in_flight += 1;
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        let id = state.next_id;
        state.next_id += 1;
        state.wait_queue.push_back((id, sender));
        Some((id, receiver))
    }

    /// Waits for a slot and returns how long the wait was.
    pub async fn acquire(&self) -> Duration {
        let Some((_, receiver)) = self.enqueue() else {
            return Duration::ZERO;
        };
        let start = Instant::now();
        // The sender is only dropped by `reset`, which abandons its waiters.
        let _ = receiver.await;
        start.elapsed()
    }

    /// Waits up to `timeout` for a slot. `None` when none freed up in time;
    /// the waiter then leaves the queue.
    pub async fn acquire_within(&self, timeout: Duration) -> Option<Duration> {
        let Some((id, mut receiver)) = self.enqueue() else {
            return Some(Duration::ZERO);
        };
        let start = Instant::now();
        match tokio::time::timeout(timeout, &mut receiver).await {
            Ok(_) => Some(start.elapsed()),
            Err(_) => {
                let mut state = self.state.lock_unpoisoned();
                let before = state.wait_queue.len();
                state.wait_queue.retain(|(queued, _)| *queued != id);
                if state.wait_queue.len() == before {
                    // Granted between the timeout firing and this lock: the slot is ours.
                    drop(state);
                    return Some(start.elapsed());
                }
                None
            }
        }
    }

    /// Returns a slot, handing it to the longest-waiting acquirer if any.
    pub fn release(&self) {
        let mut state = self.state.lock_unpoisoned();
        if state.in_flight == 0 {
            return;
        }
        state.in_flight -= 1;
        while let Some((_, sender)) = state.wait_queue.pop_front() {
            state.in_flight += 1;
            if sender.send(()).is_ok() {
                return;
            }
            // The waiter went away; its slot goes to the next one.
            state.in_flight -= 1;
        }
    }

    /// Forgets every slot and waiter. For tests.
    pub fn reset(&self) {
        let mut state = self.state.lock_unpoisoned();
        state.in_flight = 0;
        state.wait_queue.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn grants_in_arrival_order() {
        let semaphore = Arc::new(FifoSemaphore::new(1));
        assert!(semaphore.try_acquire());
        assert!(!semaphore.try_acquire());
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for n in 0..3 {
            let (semaphore, order) = (semaphore.clone(), order.clone());
            tasks.push(tokio::spawn(async move {
                semaphore.acquire().await;
                order.lock().unwrap().push(n);
                semaphore.release();
            }));
            tokio::task::yield_now().await;
        }
        semaphore.release();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
        assert_eq!(semaphore.in_flight(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_out_waiter_leaves_the_queue() {
        let semaphore = FifoSemaphore::new(1);
        assert!(semaphore.try_acquire());
        assert_eq!(semaphore.acquire_within(Duration::from_millis(50)).await, None);
        semaphore.release();
        assert_eq!(semaphore.in_flight(), 0);
        assert!(semaphore.acquire_within(Duration::from_millis(50)).await.is_some());
    }
}
