//! Authentication rate limits for IMAP and SMTP, per client address.
//!
//! Unlike HTTP behind a reverse proxy, these connections are direct: without
//! a limit an attacker tries passwords without end on one connection. Each
//! recorded failure also costs the caller half a second.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::js;
use crate::sync::LockUnpoisoned;

const MAX_FAILURES: u32 = 10;
const MAX_RECIPIENT_PROBES: u32 = 10;
const WINDOW_MS: i64 = 15 * 60 * 1000;
const FAILURE_DELAY: Duration = Duration::from_millis(500);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy)]
struct AttemptRecord {
    count: u32,
    reset_at: i64,
}

type Store = Mutex<HashMap<String, AttemptRecord>>;

struct Stores {
    auth_attempts: Store,
    auth_account_attempts: Store,
    recipient_probes: Store,
}

fn stores() -> &'static Stores {
    static STORES: OnceLock<Stores> = OnceLock::new();
    STORES.get_or_init(|| Stores {
        auth_attempts: Default::default(),
        auth_account_attempts: Default::default(),
        recipient_probes: Default::default(),
    })
}

fn account_key(ip: &str, account: &str) -> String {
    format!("{ip}\u{0}{account}")
}

/// The identity an authentication attempt is bucketed under: trimmed and
/// lower-cased, `None` when empty.
pub fn normalize_auth_account(username: Option<&str>) -> Option<String> {
    let account = js::trim(username?).to_lowercase();
    (!account.is_empty()).then_some(account)
}

/// The live record for `key`, creating a fresh window when there is none.
/// Runs `update` on it and returns the count afterwards.
fn with_record(store: &Store, key: &str, update: impl FnOnce(&mut AttemptRecord)) -> u32 {
    let now = js::now_ms();
    let mut store = store.lock_unpoisoned();
    let record = match store.get_mut(key) {
        Some(record) if now < record.reset_at => record,
        _ => {
            store.insert(key.to_string(), AttemptRecord { count: 0, reset_at: now + WINDOW_MS });
            store.get_mut(key).expect("the record was just inserted")
        }
    };
    update(record);
    record.count
}

async fn record(store: &Store, key: &str, max: u32) -> bool {
    let count = with_record(store, key, |record| record.count += 1);
    tokio::time::sleep(FAILURE_DELAY).await;
    count >= max
}

/// Whether `ip`, or `account` under it, has used up its failures.
pub fn is_auth_rate_limited(ip: &str, account: Option<&str>) -> bool {
    let stores = stores();
    if with_record(&stores.auth_attempts, ip, |_| {}) >= MAX_FAILURES {
        return true;
    }
    account.is_some_and(|account| {
        with_record(&stores.auth_account_attempts, &account_key(ip, account), |_| {}) >= MAX_FAILURES
    })
}

/// Counts a failed authentication and delays the caller. Returns whether the
/// address or the account is now limited.
pub async fn record_auth_failure(ip: &str, account: Option<&str>) -> bool {
    let stores = stores();
    let aggregate_limited = record(&stores.auth_attempts, ip, MAX_FAILURES).await;
    let Some(account) = account else {
        return aggregate_limited;
    };
    let count = with_record(&stores.auth_account_attempts, &account_key(ip, account), |record| record.count += 1);
    aggregate_limited || count >= MAX_FAILURES
}

/// Forgives failures: only the account's bucket when one is given, otherwise
/// everything recorded for the address.
pub fn reset_auth_failures(ip: &str, account: Option<&str>) {
    let stores = stores();
    match account {
        Some(account) => {
            stores.auth_account_attempts.lock_unpoisoned().remove(&account_key(ip, account));
        }
        None => {
            stores.auth_attempts.lock_unpoisoned().remove(ip);
            let prefix = format!("{ip}\u{0}");
            stores.auth_account_attempts.lock_unpoisoned().retain(|key, _| !key.starts_with(&prefix));
        }
    }
}

/// Whether `ip` has probed too many unknown recipients.
pub fn is_recipient_probe_rate_limited(ip: &str) -> bool {
    with_record(&stores().recipient_probes, ip, |_| {}) >= MAX_RECIPIENT_PROBES
}

/// Counts a recipient probe and delays the caller. Returns whether the
/// address is now limited.
pub async fn record_recipient_probe(ip: &str) -> bool {
    record(&stores().recipient_probes, ip, MAX_RECIPIENT_PROBES).await
}

pub fn reset_recipient_probes(ip: &str) {
    stores().recipient_probes.lock_unpoisoned().remove(ip);
}

/// Drops expired records and returns how many there were.
pub fn cleanup_expired_rate_limit_records() -> usize {
    let now = js::now_ms();
    let stores = stores();
    let mut cleaned = 0;
    for store in [&stores.auth_attempts, &stores.auth_account_attempts, &stores.recipient_probes] {
        let mut store = store.lock_unpoisoned();
        let before = store.len();
        store.retain(|_, record| now < record.reset_at);
        cleaned += before - store.len();
    }
    cleaned
}

/// Starts the hourly cleanup. Call once at boot.
pub fn start_cleanup_scheduler() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async {
            let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                cleanup_expired_rate_limit_records();
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_normalize() {
        assert_eq!(normalize_auth_account(Some("  Alice ")).as_deref(), Some("alice"));
        assert_eq!(normalize_auth_account(Some("   ")), None);
        assert_eq!(normalize_auth_account(None), None);
    }

    #[tokio::test(start_paused = true)]
    async fn failures_limit_the_address_and_the_account() {
        let ip = "203.0.113.200";
        for _ in 0..9 {
            assert!(!record_auth_failure(ip, Some("alice")).await);
        }
        assert!(!is_auth_rate_limited(ip, Some("alice")));
        assert!(record_auth_failure(ip, Some("alice")).await);
        assert!(is_auth_rate_limited(ip, Some("alice")));
        assert!(is_auth_rate_limited(ip, None));
        reset_auth_failures(ip, Some("alice"));
        assert!(is_auth_rate_limited(ip, Some("alice")), "the address aggregate still holds");
        reset_auth_failures(ip, None);
        assert!(!is_auth_rate_limited(ip, Some("alice")));
    }
}
