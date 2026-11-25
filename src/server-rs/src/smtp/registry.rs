//! The authenticated SMTP connections this process holds, by username
//! (`smtp-registry.ts`).

use std::sync::{Arc, Mutex};

use serde_json::json;

use super::server::{ServerShared, SmtpServer};
use crate::logger;
use crate::sync::LockUnpoisoned;

static LIVE_SERVERS: Mutex<Vec<Arc<ServerShared>>> = Mutex::new(Vec::new());

/// Tracks a listening server so [`evict_smtp_connections`] can reach its
/// connections. SMTP authenticates once per connection, so a client that
/// authenticated with a since-rotated password keeps its grant until the
/// socket closes.
pub fn register_smtp_server(server: &SmtpServer) {
    let mut servers = LIVE_SERVERS.lock_unpoisoned();
    if !servers.iter().any(|live| Arc::ptr_eq(live, server.shared())) {
        servers.push(server.shared().clone());
    }
}

/// Drops a server from the registry. Runs when the server closes.
pub fn unregister_smtp_server(server: &SmtpServer) {
    LIVE_SERVERS.lock_unpoisoned().retain(|live| !Arc::ptr_eq(live, server.shared()));
}

/// Closes every SMTP connection authenticated as `username`, across every
/// listening port, and returns how many there were. Called when the
/// account's credential is rotated or revoked.
///
/// `session.user` is the credential's own username (`on_auth` answers with
/// the name as presented), so a read-only connection is left alone when the
/// account it sends for rotates its password.
pub fn evict_smtp_connections(username: &str) -> usize {
    let servers = LIVE_SERVERS.lock_unpoisoned().clone();
    let evicted: usize = servers.iter().map(|server| server.evict(username)).sum();
    if evicted > 0 {
        logger::info(
            "Evicted SMTP connections on credential change",
            json!({ "authenticatedAs": username, "evicted": evicted }),
        );
    }
    evicted
}
