//! Unread counts behind push notifications (mails/notifications.ts).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::json;

use crate::logger;
use crate::models::SignedUser;
use crate::postgres::{pool, Param};

/// How many unread mails a user has, and when the newest mail arrived.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BadgeCount {
    pub count: i64,
    pub latest: Option<DateTime<Utc>>,
}

/// Unread counts by user id. Drafts, sent mail and spam do not ring the
/// badge. A database fault reads as "nothing unread" and is logged.
pub async fn get_unread_notifications(user_ids: &[String]) -> HashMap<String, BadgeCount> {
    if user_ids.is_empty() {
        return HashMap::new();
    }
    let placeholders: Vec<String> = (1..=user_ids.len()).map(|i| format!("${i}")).collect();
    let sql = format!(
        "
      SELECT 
        user_id,
        COUNT(*) FILTER (WHERE read = FALSE) as unread_count,
        MAX(ingested) as latest
      FROM mails
      WHERE user_id IN ({}) AND sent = FALSE AND is_spam = FALSE AND expunged = FALSE AND draft = FALSE
      GROUP BY user_id
    ",
        placeholders.join(", ")
    );
    let values: Vec<Param> = user_ids.iter().map(Param::from).collect();
    match pool().query(&sql, &values).await {
        Ok(result) => result
            .rows
            .iter()
            .map(|row| {
                (row.text("user_id"), BadgeCount { count: row.i64("unread_count"), latest: row.opt_time("latest") })
            })
            .collect(),
        Err(error) => {
            logger::error_with("Failed to get unread notifications", json!({}), &error);
            HashMap::new()
        }
    }
}

/// Unread counts by username; a user with no mail has a count of zero.
pub async fn get_notifications(users: &[SignedUser]) -> HashMap<String, BadgeCount> {
    let ids: Vec<String> = users.iter().map(|user| user.id.clone()).collect();
    let mut raw = get_unread_notifications(&ids).await;
    users
        .iter()
        .map(|user| (user.username.clone(), raw.remove(&user.id).unwrap_or_default()))
        .collect()
}
