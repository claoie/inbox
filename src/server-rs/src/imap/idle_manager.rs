//! IDLE sessions waiting for mailbox changes (imap/idle-manager.ts).

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::join_all;
use serde_json::json;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::util::is_inbox;
use crate::logger;
use crate::sync::LockUnpoisoned;

// The sweep interval must stay well below the timeout so the keepalive runs
// several times before a session is force-terminated.
pub const IDLE_HEARTBEAT_INTERVAL_MS: u64 = 5 * 60 * 1000;
pub const IDLE_TIMEOUT_MS: u64 = 25 * 60 * 1000;

pub const SOCKET_TIMEOUT_MS: u64 = 5 * 60 * 1000;
pub const IDLE_SOCKET_TIMEOUT_MS: u64 = 35 * 60 * 1000;

pub type IdleFuture<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

/// What the manager needs from a session in IDLE.
pub trait IdleTarget: Send + Sync {
    /// Re-advertises the selected mailbox: an EXPUNGE for anything that
    /// left, then EXISTS and RECENT. The new message count, or `None` when
    /// nothing was sent.
    fn notify_mailbox_update(&self) -> IdleFuture<'_, Option<usize>>;
    /// Pushes untagged FETCH (FLAGS) for the mails in the session's view.
    fn notify_flag_change<'a>(&'a self, mail_ids: &'a [String]) -> IdleFuture<'a, ()>;
    fn end_idle(&self, reason: Option<&str>);
    fn write(&self, data: &str) -> bool;
    fn close(&self);
}

#[derive(Clone)]
struct IdleSession {
    session: Arc<dyn IdleTarget>,
    #[allow(dead_code)]
    tag: String,
    mailbox: String,
    username: String,
    start_time: Instant,
}

/// The sessions in IDLE, in the order they entered it.
#[derive(Default)]
pub struct IdleManager {
    idle_sessions: Mutex<Vec<(String, IdleSession)>>,
    heartbeat: Mutex<Option<JoinHandle<()>>>,
}

impl IdleManager {
    pub fn new() -> IdleManager {
        IdleManager::default()
    }

    fn snapshot(&self) -> Vec<(String, IdleSession)> {
        self.idle_sessions.lock_unpoisoned().clone()
    }

    /// Registers a session for IDLE.
    pub fn add_idle_session(
        &self,
        session_id: &str,
        session: Arc<dyn IdleTarget>,
        tag: &str,
        mailbox: &str,
        username: &str,
    ) {
        let idle_session = IdleSession {
            session,
            tag: tag.to_string(),
            mailbox: mailbox.to_string(),
            username: username.to_string(),
            start_time: Instant::now(),
        };
        {
            let mut sessions = self.idle_sessions.lock_unpoisoned();
            match sessions.iter_mut().find(|(id, _)| id == session_id) {
                Some(entry) => entry.1 = idle_session,
                None => sessions.push((session_id.to_string(), idle_session)),
            }
        }
        logger::debug("IDLE session started", json!({ "component": "imap.idle", "username": username, "mailbox": mailbox }));
    }

    /// Removes a session from IDLE.
    pub fn remove_idle_session(&self, session_id: &str) {
        let removed = {
            let mut sessions = self.idle_sessions.lock_unpoisoned();
            sessions.iter().position(|(id, _)| id == session_id).map(|at| sessions.remove(at).1)
        };
        if let Some(idle_session) = removed {
            logger::debug(
                "IDLE session ended",
                json!({ "component": "imap.idle", "username": idle_session.username, "mailbox": idle_session.mailbox }),
            );
        }
    }

    /// Notifies the IDLE sessions of these users about new mail. The session
    /// re-reads its mailbox and emits the untagged responses itself, because
    /// RFC 3501 §7.3.1 forbids the count shrinking any other way.
    pub async fn notify_new_mail(&self, usernames: &[String], mailboxes: Option<&[String]>) {
        let usernames: HashSet<&str> = usernames.iter().map(String::as_str).collect();
        let mailboxes: Option<HashSet<&str>> = mailboxes.map(|names| names.iter().map(String::as_str).collect());

        let notifications: Vec<(String, IdleSession)> = self
            .snapshot()
            .into_iter()
            .filter(|(_, idle_session)| {
                if !usernames.contains(idle_session.username.as_str()) {
                    return false;
                }
                match &mailboxes {
                    // INBOX is the aggregate view showing every account's
                    // mail, so it is always notified; other sessions only
                    // when watching a target mailbox.
                    Some(mailboxes) => {
                        let watching = idle_session.mailbox.as_str();
                        is_inbox(watching) || mailboxes.contains(watching)
                    }
                    None => true,
                }
            })
            .collect();

        join_all(notifications.iter().map(|(session_id, idle_session)| async move {
            match idle_session.session.notify_mailbox_update().await {
                Ok(None) => {}
                Ok(Some(total)) => logger::debug(
                    "Notified IDLE session about new mail",
                    json!({
                        "component": "imap.idle",
                        "username": idle_session.username,
                        "mailbox": idle_session.mailbox,
                        "total": total,
                    }),
                ),
                Err(error) => {
                    logger::error_with(
                        "Error notifying IDLE session",
                        json!({ "component": "imap.idle", "sessionId": session_id }),
                        &error,
                    );
                    self.remove_idle_session(session_id);
                }
            }
        }))
        .await;
    }

    /// Notifies the IDLE sessions of these users about flag changes on these
    /// mails. Unlike new mail, a flag change cannot add or remove messages,
    /// so no mailbox rescan is needed.
    pub async fn notify_flag_change(&self, usernames: &[String], mail_ids: &[String]) {
        if mail_ids.is_empty() {
            return;
        }
        let usernames: HashSet<&str> = usernames.iter().map(String::as_str).collect();
        let notifications: Vec<(String, IdleSession)> = self
            .snapshot()
            .into_iter()
            .filter(|(_, idle_session)| usernames.contains(idle_session.username.as_str()))
            .collect();

        join_all(notifications.iter().map(|(session_id, idle_session)| async move {
            match idle_session.session.notify_flag_change(mail_ids).await {
                Ok(()) => logger::debug(
                    "Notified IDLE session about flag change",
                    json!({
                        "component": "imap.idle",
                        "username": idle_session.username,
                        "mailbox": idle_session.mailbox,
                        "mailCount": mail_ids.len(),
                    }),
                ),
                Err(error) => {
                    logger::error_with(
                        "Error notifying IDLE session of flag change",
                        json!({ "component": "imap.idle", "sessionId": session_id }),
                        &error,
                    );
                    self.remove_idle_session(session_id);
                }
            }
        }))
        .await;
    }

    /// Starts the keepalive sweep. Once per manager; needs a runtime.
    pub fn start_heartbeat(&'static self) {
        let mut heartbeat = self.heartbeat.lock_unpoisoned();
        if heartbeat.is_some() {
            return;
        }
        *heartbeat = Some(tokio::spawn(async move {
            let period = Duration::from_millis(IDLE_HEARTBEAT_INTERVAL_MS);
            let mut interval = tokio::time::interval_at(Instant::now() + period, period);
            loop {
                interval.tick().await;
                self.heartbeat_tick(Instant::now());
            }
        }));
    }

    /// One heartbeat sweep: keep young sessions alive, force-terminate
    /// sessions past the timeout. Termination goes through the session's
    /// `end_idle("timeout")` so IDLE state is cleared in one place; leaving
    /// only the manager's record would brick the connection, which drops
    /// every command while it believes it is idling.
    pub fn heartbeat_tick(&self, now: Instant) {
        for (_, idle_session) in self.snapshot() {
            let session_age = now.saturating_duration_since(idle_session.start_time);
            if session_age > Duration::from_millis(IDLE_TIMEOUT_MS) {
                idle_session.session.end_idle(Some("timeout"));
            } else {
                // An untagged keepalive is allowed mid-IDLE (RFC 3501 §7).
                idle_session.session.write("* OK Still here\r\n");
            }
        }
    }

    /// Number of sessions in IDLE.
    pub fn get_active_session_count(&self) -> usize {
        self.idle_sessions.lock_unpoisoned().len()
    }

    /// Number of sessions of one user in IDLE.
    pub fn get_user_session_count(&self, username: &str) -> usize {
        self.idle_sessions.lock_unpoisoned().iter().filter(|(_, session)| session.username == username).count()
    }

    /// Cleanup on shutdown: stops the sweep and says BYE to every IDLE session.
    pub fn shutdown(&self) {
        if let Some(heartbeat) = self.heartbeat.lock_unpoisoned().take() {
            heartbeat.abort();
        }
        let sessions = std::mem::take(&mut *self.idle_sessions.lock_unpoisoned());
        for (_, idle_session) in sessions {
            idle_session.session.write("* BYE Server shutting down\r\n");
            idle_session.session.close();
        }
    }
}

/// The process's IDLE manager.
pub fn idle_manager() -> &'static IdleManager {
    static MANAGER: OnceLock<IdleManager> = OnceLock::new();
    MANAGER.get_or_init(IdleManager::new)
}

/// Tells IDLE sessions of these users that new mail arrived, optionally
/// limited to the given mailboxes.
pub async fn notify_new_mail(usernames: &[String], mailboxes: Option<&[String]>) {
    idle_manager().notify_new_mail(usernames, mailboxes).await;
}

/// Tells IDLE sessions of these users that the flags of these mails changed.
pub async fn notify_flag_change(usernames: &[String], mail_ids: &[String]) {
    idle_manager().notify_flag_change(usernames, mail_ids).await;
}

/// Says BYE to every IDLE session and stops the keepalive sweep. Runs before
/// the IMAP servers are closed.
pub fn shutdown() {
    idle_manager().shutdown();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    #[derive(Default)]
    struct FakeSession {
        mailbox_updates: AtomicUsize,
        flag_changes: Mutex<Vec<Vec<String>>>,
        fail: AtomicBool,
        ended: Mutex<Vec<Option<String>>>,
        writes: Mutex<Vec<String>>,
        closed: AtomicBool,
    }

    impl IdleTarget for FakeSession {
        fn notify_mailbox_update(&self) -> IdleFuture<'_, Option<usize>> {
            Box::pin(async move {
                if self.fail.load(Ordering::SeqCst) {
                    anyhow::bail!("socket gone");
                }
                self.mailbox_updates.fetch_add(1, Ordering::SeqCst);
                Ok(Some(3))
            })
        }

        fn notify_flag_change<'a>(&'a self, mail_ids: &'a [String]) -> IdleFuture<'a, ()> {
            Box::pin(async move {
                if self.fail.load(Ordering::SeqCst) {
                    anyhow::bail!("socket gone");
                }
                self.flag_changes.lock().unwrap().push(mail_ids.to_vec());
                Ok(())
            })
        }

        fn end_idle(&self, reason: Option<&str>) {
            self.ended.lock().unwrap().push(reason.map(str::to_string));
        }

        fn write(&self, data: &str) -> bool {
            self.writes.lock().unwrap().push(data.to_string());
            true
        }

        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn add(manager: &IdleManager, id: &str, mailbox: &str, username: &str) -> Arc<FakeSession> {
        let session = Arc::new(FakeSession::default());
        manager.add_idle_session(id, session.clone(), "t1", mailbox, username);
        session
    }

    fn updates(session: &FakeSession) -> usize {
        session.mailbox_updates.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn notifies_only_the_matching_mailbox_and_the_inbox_catch_all() {
        let manager = IdleManager::new();
        let inbox = add(&manager, "s1", "INBOX", "alice");
        let work = add(&manager, "s2", "INBOX/accounts/work", "alice");
        let home = add(&manager, "s3", "INBOX/accounts/home", "alice");

        manager.notify_new_mail(&names(&["alice"]), Some(&names(&["INBOX/accounts/work"]))).await;

        assert_eq!(updates(&inbox), 1);
        assert_eq!(updates(&work), 1);
        assert_eq!(updates(&home), 0);
    }

    #[tokio::test]
    async fn notifies_every_session_of_the_user_when_no_mailbox_filter_is_given() {
        let manager = IdleManager::new();
        let inbox = add(&manager, "s1", "INBOX", "alice");
        let work = add(&manager, "s2", "INBOX/accounts/work", "alice");
        manager.notify_new_mail(&names(&["alice"]), None).await;
        assert_eq!(updates(&inbox), 1);
        assert_eq!(updates(&work), 1);
    }

    #[tokio::test]
    async fn does_not_notify_sessions_of_another_user() {
        let manager = IdleManager::new();
        let alice = add(&manager, "s1", "INBOX", "alice");
        let bob = add(&manager, "s2", "INBOX", "bob");
        manager.notify_new_mail(&names(&["alice"]), None).await;
        assert_eq!(updates(&alice), 1);
        assert_eq!(updates(&bob), 0);
    }

    #[tokio::test]
    async fn flag_changes_reach_only_the_sessions_of_the_named_users() {
        let manager = IdleManager::new();
        let alice = add(&manager, "s1", "INBOX", "alice");
        let bob = add(&manager, "s2", "INBOX", "bob");
        manager.notify_flag_change(&names(&["alice"]), &names(&["m1", "m2"])).await;
        assert_eq!(*alice.flag_changes.lock().unwrap(), vec![names(&["m1", "m2"])]);
        assert!(bob.flag_changes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_flag_change_with_no_mail_ids_is_a_no_op() {
        let manager = IdleManager::new();
        let alice = add(&manager, "s1", "INBOX", "alice");
        manager.notify_flag_change(&names(&["alice"]), &[]).await;
        assert!(alice.flag_changes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn removes_the_session_when_a_notification_fails() {
        let manager = IdleManager::new();
        let broken = add(&manager, "s1", "INBOX", "alice");
        let healthy = add(&manager, "s2", "INBOX", "alice");
        broken.fail.store(true, Ordering::SeqCst);

        manager.notify_flag_change(&names(&["alice"]), &names(&["m1"])).await;
        assert_eq!(manager.get_active_session_count(), 1);
        assert_eq!(healthy.flag_changes.lock().unwrap().len(), 1);

        let also_broken = add(&manager, "s3", "INBOX", "alice");
        also_broken.fail.store(true, Ordering::SeqCst);
        manager.notify_new_mail(&names(&["alice"]), None).await;
        assert_eq!(manager.get_active_session_count(), 1);
        assert_eq!(manager.get_user_session_count("alice"), 1);
    }

    #[test]
    fn sweeps_several_times_before_the_timeout_cutoff() {
        const { assert!(IDLE_TIMEOUT_MS / IDLE_HEARTBEAT_INTERVAL_MS >= 3) };
        const { assert!(IDLE_SOCKET_TIMEOUT_MS > IDLE_TIMEOUT_MS) };
        const { assert!(IDLE_SOCKET_TIMEOUT_MS > SOCKET_TIMEOUT_MS) };
    }

    #[tokio::test(start_paused = true)]
    async fn the_heartbeat_keeps_a_young_session_alive_without_ending_idle() {
        let manager = IdleManager::new();
        let session = add(&manager, "s1", "INBOX", "alice");
        manager.heartbeat_tick(Instant::now() + Duration::from_millis(IDLE_HEARTBEAT_INTERVAL_MS));
        assert_eq!(*session.writes.lock().unwrap(), vec!["* OK Still here\r\n".to_string()]);
        assert!(session.ended.lock().unwrap().is_empty());
        assert_eq!(manager.get_active_session_count(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_heartbeat_terminates_a_timed_out_session_through_end_idle() {
        let manager = IdleManager::new();
        let session = add(&manager, "s1", "INBOX", "alice");
        manager.heartbeat_tick(Instant::now() + Duration::from_millis(IDLE_TIMEOUT_MS + 1));
        assert_eq!(*session.ended.lock().unwrap(), vec![Some("timeout".to_string())]);
        assert!(session.writes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shutdown_says_bye_to_every_idle_session_and_forgets_them() {
        let manager = IdleManager::new();
        let first = add(&manager, "s1", "INBOX", "alice");
        let second = add(&manager, "s2", "Drafts", "bob");
        manager.shutdown();
        for session in [first, second] {
            assert_eq!(*session.writes.lock().unwrap(), vec!["* BYE Server shutting down\r\n".to_string()]);
            assert!(session.closed.load(Ordering::SeqCst));
        }
        assert_eq!(manager.get_active_session_count(), 0);
    }
}
