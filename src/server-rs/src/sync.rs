//! Lock access that survives a panic.
//!
//! A panic inside one IMAP command or SMTP hook is caught and answered as an
//! error for that command alone. If it happened while a `std::sync` lock was
//! held, the lock is poisoned, and an `unwrap` on every later `lock()` would
//! turn that one fault into a failure of everything sharing the lock (rate
//! limits, the session registry, the IDLE list) until the process restarts.
//! These accessors take the guard either way: the data behind each of the
//! server's locks is a cache, a counter or a registry that stays usable after
//! an interrupted update.

use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub trait LockUnpoisoned<T: ?Sized> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> LockUnpoisoned<T> for Mutex<T> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub trait RwLockUnpoisoned<T: ?Sized> {
    fn read_unpoisoned(&self) -> RwLockReadGuard<'_, T>;
    fn write_unpoisoned(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> RwLockUnpoisoned<T> for RwLock<T> {
    fn read_unpoisoned(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write_unpoisoned(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_mutex_poisoned_by_a_panic_still_hands_out_its_guard() {
        let shared = Arc::new(Mutex::new(vec![1]));
        let poisoner = Arc::clone(&shared);
        let _ = std::thread::spawn(move || {
            let mut guard = poisoner.lock().unwrap();
            guard.push(2);
            panic!("fault while holding the lock");
        })
        .join();
        assert!(shared.is_poisoned());
        shared.lock_unpoisoned().push(3);
        assert_eq!(*shared.lock_unpoisoned(), vec![1, 2, 3]);
    }

    #[test]
    fn an_rwlock_poisoned_by_a_panic_still_reads_and_writes() {
        let shared = Arc::new(RwLock::new(0));
        let poisoner = Arc::clone(&shared);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.write().unwrap();
            panic!("fault while holding the lock");
        })
        .join();
        assert!(shared.is_poisoned());
        *shared.write_unpoisoned() += 1;
        assert_eq!(*shared.read_unpoisoned(), 1);
    }
}
