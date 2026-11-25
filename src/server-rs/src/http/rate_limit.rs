//! Per-address rate limits for the public routes.
//!
//! A limiter only reads the limit when it checks; route handlers decide which
//! outcomes count by recording a failure or resetting on success.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use super::request::HttpRequest;
use super::respond::{json_failed, Response};
use crate::sync::LockUnpoisoned;
use crate::{js, logger};

/// The identity every bucket is keyed on: the resolved client address, which
/// honours a forwarded address only from a trusted proxy.
pub fn get_client_ip(req: &HttpRequest) -> String {
    if req.ip.is_empty() {
        "unknown".to_string()
    } else {
        req.ip.clone()
    }
}

const WINDOW_MS: i64 = 15 * 60 * 1000;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy)]
struct AttemptRecord {
    count: u32,
    reset_at: i64,
}

type Attempts = Arc<Mutex<HashMap<String, AttemptRecord>>>;

fn all_attempt_maps() -> &'static Mutex<Vec<Attempts>> {
    static MAPS: OnceLock<Mutex<Vec<Attempts>>> = OnceLock::new();
    MAPS.get_or_init(Default::default)
}

/// The attempted login identity a request is bucketed under: the username
/// when present, otherwise the email, trimmed and lower-cased.
pub fn login_identity_of(body: &Value) -> Option<String> {
    let body = body.as_object()?;
    let non_empty = |key: &str| body.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
    let raw = non_empty("username").or_else(|| non_empty("email"))?;
    Some(js::trim(raw).to_lowercase())
}

pub struct RateLimiter {
    max_attempts: u32,
    message: &'static str,
    by_identity: bool,
    attempts: Attempts,
    account_attempts: Attempts,
}

// The separator cannot appear in a client address, so a crafted account
// string cannot collide with a different (ip, account) pair.
fn account_key(ip: &str, account: &str) -> String {
    format!("{ip}\u{0}{account}")
}

fn bump(map: &Attempts, key: String) {
    let now = js::now_ms();
    let mut map = map.lock_unpoisoned();
    match map.get_mut(&key) {
        Some(record) if now < record.reset_at => record.count += 1,
        _ => {
            map.insert(key, AttemptRecord { count: 1, reset_at: now + WINDOW_MS });
        }
    }
}

impl RateLimiter {
    /// `by_identity` adds one bucket per attempted login identity under each
    /// address, next to the address's aggregate bucket.
    pub fn new(max_attempts: u32, message: &'static str, by_identity: bool) -> RateLimiter {
        let attempts: Attempts = Default::default();
        let account_attempts: Attempts = Default::default();
        let mut maps = all_attempt_maps().lock_unpoisoned();
        maps.push(attempts.clone());
        maps.push(account_attempts.clone());
        RateLimiter { max_attempts, message, by_identity, attempts, account_attempts }
    }

    fn is_limited(&self, map: &Attempts, key: &str) -> bool {
        map.lock_unpoisoned()
            .get(key)
            .is_some_and(|record| js::now_ms() < record.reset_at && record.count >= self.max_attempts)
    }

    /// A 429 when the request's address or attempted identity is over the limit.
    pub fn check(&self, req: &HttpRequest) -> Option<Response> {
        let ip = get_client_ip(req);
        let account = if self.by_identity { login_identity_of(&req.body) } else { None };
        let limited = self.is_limited(&self.attempts, &ip)
            || account.is_some_and(|account| self.is_limited(&self.account_attempts, &account_key(&ip, &account)));
        limited.then(|| json_failed(self.message, 429))
    }

    /// Counts a failure against the address, and against the account's own
    /// bucket under it when one is given.
    pub fn record_failure(&self, ip: &str, account: Option<&str>) {
        bump(&self.attempts, ip.to_string());
        if let Some(account) = account {
            bump(&self.account_attempts, account_key(ip, account));
        }
    }

    /// Forgives failures. With an account, only that account's bucket; the
    /// address's aggregate keeps accumulating. Without one, the whole address.
    pub fn reset(&self, ip: &str, account: Option<&str>) {
        match account {
            Some(account) => {
                self.account_attempts.lock_unpoisoned().remove(&account_key(ip, account));
            }
            None => {
                self.attempts.lock_unpoisoned().remove(ip);
                let prefix = format!("{ip}\u{0}");
                self.account_attempts.lock_unpoisoned().retain(|key, _| !key.starts_with(&prefix));
            }
        }
    }
}

/// Drops expired records from every limiter and returns how many there were.
pub fn cleanup_expired_attempts() -> usize {
    let now = js::now_ms();
    let mut cleaned = 0;
    for map in all_attempt_maps().lock_unpoisoned().iter() {
        let mut map = map.lock_unpoisoned();
        let before = map.len();
        map.retain(|_, record| now < record.reset_at);
        cleaned += before - map.len();
    }
    cleaned
}

/// Starts the hourly cleanup of expired records. Idempotent.
pub fn start_cleanup_scheduler() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        cleanup_expired_attempts();
        tokio::spawn(async {
            let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                let cleaned = cleanup_expired_attempts();
                if cleaned > 0 {
                    logger::info(format!("[Rate Limit] Cleaned up {cleaned} expired attempt records"), json!({}));
                }
            }
        });
    });
}

pub fn login_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::new(5, "Too many login attempts, try again later", true))
}

pub fn token_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::new(3, "Too many token requests, try again later", false))
}

pub fn mailgun_events_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::new(60, "Too many Mailgun webhook requests, try again later", false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_identities() {
        assert_eq!(login_identity_of(&json!({ "username": " Alice " })).as_deref(), Some("alice"));
        assert_eq!(login_identity_of(&json!({ "username": "", "email": "A@B.co" })).as_deref(), Some("a@b.co"));
        assert_eq!(login_identity_of(&json!({ "username": 5 })), None);
        assert_eq!(login_identity_of(&json!([])), None);
    }

    #[test]
    fn buckets() {
        let limiter = RateLimiter::new(2, "slow down", true);
        limiter.record_failure("1.1.1.1", Some("alice"));
        assert!(!limiter.is_limited(&limiter.attempts, "1.1.1.1"));
        limiter.record_failure("1.1.1.1", Some("bob"));
        assert!(limiter.is_limited(&limiter.attempts, "1.1.1.1"));
        assert!(!limiter.is_limited(&limiter.account_attempts, &account_key("1.1.1.1", "alice")));
        limiter.reset("1.1.1.1", Some("alice"));
        assert!(limiter.is_limited(&limiter.attempts, "1.1.1.1"));
        limiter.reset("1.1.1.1", None);
        assert!(!limiter.is_limited(&limiter.attempts, "1.1.1.1"));
    }
}
