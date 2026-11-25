//! The IMAP sessions this process holds (imap/session-registry.ts): the
//! authenticated ones, by the credential they presented, and every live
//! connection, for the shutdown sweep.

use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::logger;
use crate::sync::LockUnpoisoned;

/// What the registry needs from a session.
pub trait RegisteredSession: Send + Sync {
    /// The username the connection authenticated as, before any remap.
    fn authenticated_as(&self) -> Option<String>;
    fn session_id(&self) -> String;
    fn write(&self, data: &str) -> bool;
    fn close(&self);
    /// True when the socket is destroyed or its write side already ended.
    fn is_closing(&self) -> bool;
}

type Sessions = Mutex<Vec<Arc<dyn RegisteredSession>>>;

static AUTHENTICATED_SESSIONS: Sessions = Mutex::new(Vec::new());
static CONNECTED_SESSIONS: Sessions = Mutex::new(Vec::new());

fn same(a: &Arc<dyn RegisteredSession>, b: &Arc<dyn RegisteredSession>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

fn add(sessions: &Sessions, session: Arc<dyn RegisteredSession>) {
    let mut sessions = sessions.lock_unpoisoned();
    if !sessions.iter().any(|held| same(held, &session)) {
        sessions.push(session);
    }
}

fn remove(sessions: &Sessions, session: &Arc<dyn RegisteredSession>) {
    sessions.lock_unpoisoned().retain(|held| !same(held, session));
}

/// Tracks a live connection, authenticated or not, so
/// [`shutdown_imap_sessions`] can reach it. A STARTTLS upgrade drops the
/// cleartext session it replaces.
pub fn register_connection(session: Arc<dyn RegisteredSession>) {
    add(&CONNECTED_SESSIONS, session);
}

/// Drops a connection from the shutdown sweep. Runs on every socket close.
pub fn unregister_connection(session: &Arc<dyn RegisteredSession>) {
    remove(&CONNECTED_SESSIONS, session);
}

/// Tracks a connection that has completed AUTHENTICATE or LOGIN so
/// [`evict_imap_sessions`] can reach it later. IMAP holds authentication for
/// the life of the socket, so nothing else in the process can find a live
/// authenticated connection from outside its own handler.
pub fn register_authenticated_session(session: Arc<dyn RegisteredSession>) {
    add(&AUTHENTICATED_SESSIONS, session);
}

/// Drops a connection from the registry. Runs on every socket close.
pub fn unregister_session(session: &Arc<dyn RegisteredSession>) {
    remove(&AUTHENTICATED_SESSIONS, session);
}

/// Closes every IMAP session authenticated as `username` and returns how many
/// there were. Called when the account's credential is rotated or revoked.
///
/// Keyed on the credential the connection presented, never on the effective
/// user: a read-only session authenticates as its own credential, whose
/// password is a separate row, so it survives a rotation on the account it
/// reads.
pub fn evict_imap_sessions(username: &str) -> usize {
    let matching: Vec<Arc<dyn RegisteredSession>> = {
        let mut sessions = AUTHENTICATED_SESSIONS.lock_unpoisoned();
        let (matching, rest): (Vec<_>, Vec<_>) =
            sessions.drain(..).partition(|session| session.authenticated_as().as_deref() == Some(username));
        *sessions = rest;
        matching
    };
    // Outside the lock: closing a session unregisters it.
    for session in &matching {
        session.write("* BYE Credential changed, please re-authenticate\r\n");
        session.close();
    }
    let evicted = matching.len();
    if evicted > 0 {
        logger::info(
            "Evicted IMAP sessions on credential change",
            json!({ "component": "imap", "authenticatedAs": username, "evicted": evicted }),
        );
    }
    evicted
}

/// Tears down every live connection, telling each one why, and returns how
/// many there were.
///
/// Stopping a listener only stops accepting: an idle client ends only when
/// its inactivity timeout reclaims it, long past a container's stop grace
/// period.
pub fn shutdown_imap_sessions() -> usize {
    let sessions: Vec<Arc<dyn RegisteredSession>> = std::mem::take(&mut *CONNECTED_SESSIONS.lock_unpoisoned());
    let mut closed = 0;
    for session in sessions {
        // Already on its way out: an IDLE session the IDLE sweep has just
        // said BYE to, or a LOGOUT that beat the signal.
        if session.is_closing() {
            continue;
        }
        session.write("* BYE Server shutting down\r\n");
        session.close();
        closed += 1;
    }
    closed
}

pub fn get_authenticated_session_count() -> usize {
    AUTHENTICATED_SESSIONS.lock_unpoisoned().len()
}

pub fn get_connected_session_count() -> usize {
    CONNECTED_SESSIONS.lock_unpoisoned().len()
}

/// Forgets every tracked connection without touching its socket. A test's
/// runtime drops the connections it leaves open without their cleanup, so a
/// test that counts or sweeps the registry starts from nothing.
#[cfg(test)]
pub(crate) fn reset_connected_sessions() {
    CONNECTED_SESSIONS.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct FakeSession {
        authenticated_as: Option<String>,
        calls: Mutex<Vec<String>>,
        closing: AtomicBool,
    }

    impl FakeSession {
        fn new(authenticated_as: Option<&str>) -> Arc<FakeSession> {
            Arc::new(FakeSession {
                authenticated_as: authenticated_as.map(str::to_string),
                calls: Mutex::new(Vec::new()),
                closing: AtomicBool::new(false),
            })
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl RegisteredSession for FakeSession {
        fn authenticated_as(&self) -> Option<String> {
            self.authenticated_as.clone()
        }

        fn session_id(&self) -> String {
            format!("s-{:?}", self.authenticated_as)
        }

        fn write(&self, data: &str) -> bool {
            self.calls.lock().unwrap().push(format!("write:{data}"));
            true
        }

        fn close(&self) {
            self.calls.lock().unwrap().push("close".to_string());
            self.closing.store(true, Ordering::SeqCst);
        }

        fn is_closing(&self) -> bool {
            self.closing.load(Ordering::SeqCst)
        }
    }

    // The registry is process-wide and other tests open real sessions, so
    // each test uses usernames of its own and compares counts by difference.

    fn register(authenticated_as: Option<&str>) -> Arc<FakeSession> {
        let session = FakeSession::new(authenticated_as);
        register_authenticated_session(session.clone());
        session
    }

    const BYE: &str = "write:* BYE Credential changed, please re-authenticate\r\n";

    #[test]
    fn tears_down_every_connection_that_authenticated_as_the_username() {
        let first = register(Some("registry-alice"));
        let second = register(Some("registry-alice"));
        assert_eq!(evict_imap_sessions("registry-alice"), 2);
        for session in [first, second] {
            assert_eq!(session.calls(), vec![BYE.to_string(), "close".to_string()]);
        }
    }

    #[test]
    fn leaves_every_other_credentials_connection_untouched() {
        let alice = register(Some("registry-carol"));
        let bob = register(Some("registry-bob"));
        let unauthenticated = register(None);
        assert_eq!(evict_imap_sessions("registry-carol"), 1);
        assert_eq!(alice.calls().len(), 2);
        assert!(bob.calls().is_empty());
        assert!(unauthenticated.calls().is_empty());
        let bob: Arc<dyn RegisteredSession> = bob;
        let unauthenticated: Arc<dyn RegisteredSession> = unauthenticated;
        unregister_session(&bob);
        unregister_session(&unauthenticated);
    }

    #[test]
    fn spares_a_read_only_session_when_the_account_it_reads_rotates() {
        // The read-only credential is its own row with its own password.
        let read_only = register(Some("registry-admin-ro"));
        let admin = register(Some("registry-admin"));
        assert_eq!(evict_imap_sessions("registry-admin"), 1);
        assert_eq!(admin.calls().len(), 2);
        assert!(read_only.calls().is_empty());
        let read_only: Arc<dyn RegisteredSession> = read_only;
        unregister_session(&read_only);
    }

    #[test]
    fn does_not_re_tear_a_connection_whose_socket_has_already_closed() {
        let closed = register(Some("registry-dave"));
        let as_registered: Arc<dyn RegisteredSession> = closed.clone();
        unregister_session(&as_registered);
        assert_eq!(evict_imap_sessions("registry-dave"), 0);
        assert!(closed.calls().is_empty());
    }

    #[test]
    fn drops_an_evicted_connection_from_the_registry() {
        let erin = register(Some("registry-erin"));
        assert_eq!(evict_imap_sessions("registry-erin"), 1);
        assert_eq!(evict_imap_sessions("registry-erin"), 0);
        assert_eq!(erin.calls().len(), 2);
    }

    #[test]
    fn reports_nothing_evicted_when_no_connection_matches() {
        let frank = register(Some("registry-frank"));
        assert_eq!(evict_imap_sessions("registry-nobody"), 0);
        assert!(frank.calls().is_empty());
        let frank: Arc<dyn RegisteredSession> = frank;
        unregister_session(&frank);
    }

    #[test]
    fn registering_twice_is_registering_once() {
        let session = FakeSession::new(Some("registry-gina"));
        register_authenticated_session(session.clone());
        register_authenticated_session(session.clone());
        assert_eq!(evict_imap_sessions("registry-gina"), 1);
    }
}
