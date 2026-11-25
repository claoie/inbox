//! Accounts: lookup, the sign-up / password-reset token flow, and setting a
//! password.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::json;
use tokio::task::JoinHandle;

use crate::domains::account_domain;
use crate::imap::session_registry::evict_imap_sessions;
use crate::models::{SignedUser, User};
use crate::postgres::repositories::domains::assign_domain;
use crate::postgres::repositories::sessions::delete_sessions_for_user;
use crate::postgres::repositories::users::{
    find_user_model_by_id, hard_delete_user, insert_pending_user, rotate_user_password, search_user,
    update_user_columns, UserFilter,
};
use crate::postgres::Param;
use crate::smtp::registry::evict_smtp_connections;
use crate::sync::LockUnpoisoned;
use crate::util::is_routable_username;
use crate::verify_password::hash_password;
use crate::{env, js, logger};

/// Which account to look for; every field given must match.
#[derive(Debug, Clone, Default)]
pub struct UserQuery {
    pub id: Option<String>,
    pub username: Option<String>,
    pub email: Option<String>,
}

impl UserQuery {
    pub fn username(username: &str) -> UserQuery {
        UserQuery { username: Some(username.to_string()), ..Default::default() }
    }

    pub fn email(email: &str) -> UserQuery {
        UserQuery { email: Some(email.to_string()), ..Default::default() }
    }

    pub fn id(id: &str) -> UserQuery {
        UserQuery { id: Some(id.to_string()), ..Default::default() }
    }
}

/// The account matching `query`. A row with no password yet (an unfinished
/// sign-up) is found without one: it cannot sign in or be signed.
pub async fn get_user(query: &UserQuery) -> Result<Option<User>> {
    let found = search_user(&UserFilter {
        user_id: query.id.clone(),
        username: query.username.clone(),
        email: query.email.clone(),
    })
    .await?;
    Ok(found.map(|record| User {
        id: Some(record.user_id),
        username: Some(record.username),
        email: record.email,
        password: record.password,
        token: record.token,
        expiry: record.expiry,
        // Rows that predate the revocation fence read back NULL: generation 1.
        password_version: Some(record.password_version.unwrap_or(1)),
    }))
}

/// The signed users among `usernames`, skipping names with no account.
pub async fn get_active_users(usernames: &[String]) -> Result<Vec<SignedUser>> {
    let mut users = Vec::new();
    for username in usernames {
        if let Some(signed) = get_user(&UserQuery::username(username)).await?.and_then(|u| u.get_signed()) {
            users.push(signed);
        }
    }
    Ok(users)
}

const TOKEN_DURATION_MS: i64 = 1000 * 60 * 60;

/// A sign-up or reset token that was just issued.
pub struct CreatedToken {
    pub id: String,
    pub token: String,
    /// The account's username when the address already has one.
    pub username: Option<String>,
}

/// Issues a one-hour token for `email`: onto the existing account, or onto a
/// new placeholder row named `user_<id prefix>`.
pub async fn create_token(email: &str) -> Result<CreatedToken> {
    let secret: [u8; 32] = rand::random();
    let token = hex::encode(secret);
    let expiry = js::iso_from_ms(js::now_ms() + TOKEN_DURATION_MS);

    if let Some(existing) = get_user(&UserQuery::email(email)).await? {
        if let Some(id) = existing.id.filter(|id| !id.is_empty()) {
            update_user_columns(
                &id,
                &[("token", Param::from(&token)), ("expiry", Param::from(&expiry))],
            )
            .await?;
            // A pending sign-up's username is the placeholder, which nobody chose.
            let username = existing.password.is_some().then_some(existing.username).flatten();
            return Ok(CreatedToken { id, token, username });
        }
    }

    let user_id = uuid::Uuid::new_v4().to_string();
    insert_pending_user(&user_id, &format!("user_{}", &user_id[..8]), email, &token, &expiry).await?;
    Ok(CreatedToken { id: user_id, token, username: None })
}

/// Whether `email` is `local@domain` with the characters this server accepts
/// and a dot in the domain.
pub fn is_valid_email(email: &str) -> bool {
    let parts: Vec<&str> = email.split('@').collect();
    let [local, domain] = parts[..] else {
        return false;
    };
    let local_valid = !local.is_empty()
        && local.bytes().all(|b| b.is_ascii_alphanumeric() || b"._%+-".contains(&b));
    let domain_valid = !domain.is_empty()
        && domain.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        && domain.contains('.');
    local_valid && domain_valid
}

/// Clears an expired token. On a placeholder row (no password) the row itself
/// is the unclaimed sign-up and is deleted; a registered account keeps its
/// data and loses only the stale token.
pub async fn reclaim_expired_token(user_id: &str) -> Result<()> {
    let Some(model) = find_user_model_by_id(user_id).await? else {
        return Ok(());
    };
    let Some(expiry) = model.expiry.as_deref().and_then(js::date_parse) else {
        return Ok(());
    };
    if expiry >= js::now_ms() {
        return Ok(());
    }
    if model.password.is_some() {
        update_user_columns(user_id, &[("token", Param::Null), ("expiry", Param::Null)]).await?;
        return Ok(());
    }
    match hard_delete_user(user_id).await {
        Ok(true) => logger::info("Deleted an unclaimed sign-up.", json!({ "userId": user_id })),
        Ok(false) => {}
        Err(error) => logger::error_with("Failed to delete user", json!({}), &error),
    }
    Ok(())
}

fn expiry_timers() -> &'static Mutex<HashMap<String, JoinHandle<()>>> {
    static TIMERS: OnceLock<Mutex<HashMap<String, JoinHandle<()>>>> = OnceLock::new();
    TIMERS.get_or_init(Default::default)
}

fn clear_timer(user_id: &str) {
    if let Some(timer) = expiry_timers().lock_unpoisoned().remove(user_id) {
        timer.abort();
    }
}

/// Schedules the reclaim of `user_id`'s token for when it expires, replacing
/// any timer already running for the same user.
pub fn start_timer(user_id: &str) {
    clear_timer(user_id);
    let id = user_id.to_string();
    let handle = tokio::spawn({
        let id = id.clone();
        async move {
            tokio::time::sleep(Duration::from_millis(TOKEN_DURATION_MS as u64)).await;
            expiry_timers().lock_unpoisoned().remove(&id);
            if let Err(error) = reclaim_expired_token(&id).await {
                logger::error_with("Failed to reclaim an expired token", json!({ "userId": id }), &error);
            }
        }
    });
    expiry_timers().lock_unpoisoned().insert(id, handle);
}

/// Completes a sign-up or a password reset: checks the token, stores the new
/// password, and revokes everything the old credential had issued.
pub async fn set_user_info(email: &str, username: &str, password: &str, token: Option<&str>) -> Result<SignedUser> {
    if email.is_empty() || username.is_empty() || password.is_empty() {
        bail!("Setting userInfo failed because input is invalid: [object Object]");
    }

    let existing = get_user(&UserQuery::email(email)).await?;
    let Some((existing, id)) = existing.and_then(|user| {
        let id = user.id.clone().filter(|id| !id.is_empty())?;
        Some((user, id))
    }) else {
        bail!("`setUserInfo` failed because user doesn't exist.");
    };
    let stored_token = existing.token.as_deref().filter(|t| !t.is_empty());
    if stored_token.is_none() || stored_token != token {
        bail!("`setUserInfo` failed because token doesn't match.");
    }

    if let Some(expiry) = existing.expiry.as_deref().filter(|e| !e.is_empty()) {
        if js::date_parse(expiry).is_some_and(|at| at < js::now_ms()) {
            reclaim_expired_token(&id).await?;
            bail!("Setting userInfo failed because user token is expired.");
        }
    }

    let registered_name = existing.username.as_deref().filter(|name| !name.is_empty() && existing.password.is_some());
    let username = match registered_name {
        Some(existing_name) => existing_name.to_string(),
        None => {
            let taken = get_user(&UserQuery::username(username)).await?;
            if taken.is_some_and(|other| other.id.as_deref() != Some(id.as_str())) {
                bail!("`setUserInfo` failed because username already exists.");
            }
            username.to_string()
        }
    };

    // Only once the request is known to go through: a refused name leaves the
    // sign-up pending, with its reclaim still scheduled.
    clear_timer(&id);

    // Hashed ahead of the delete to keep a bcrypt round out of that window,
    // and sessions evicted before the write so a failed DELETE aborts the
    // rotation with the reset token intact.
    let password_hash = hash_password(password).await;
    delete_sessions_for_user(&id).await?;

    let password_version = rotate_user_password(&id, &password_hash, &username, None, None)
        .await?
        .ok_or_else(|| anyhow!("`setUserInfo` failed because the user row is missing."))?;

    // After the write: until the new hash lands, an evicted client could
    // reconnect on the old one.
    evict_imap_sessions(&username);
    evict_smtp_connections(&username);

    // A finished sign-up owns its own name under the served zone from now on.
    // Idempotent, so a password reset on an existing account changes nothing.
    if is_routable_username(&username) {
        assign_domain(&id, &account_domain(&username)).await?;
    }

    User {
        id: Some(id),
        email: Some(email.to_string()),
        username: Some(username),
        password: Some(password_hash),
        token: None,
        expiry: None,
        password_version: Some(password_version),
    }
    .get_signed()
    .ok_or_else(|| anyhow!("`setUserInfo` failed to sign the updated user."))
}

/// The mail that carries a sign-up or reset link.
pub struct AuthenticationMail {
    pub sender_full_name: String,
    pub sender: String,
    pub to: String,
    pub subject: String,
    pub html: String,
}

pub fn create_authentication_mail(email: &str, token: &str, username: Option<&str>) -> AuthenticationMail {
    let hostname = env::var("APP_HOSTNAME").unwrap_or_else(|| "undefined".to_string());
    let mut href = format!("https://{hostname}/set-info/{email}?t={token}");
    if let Some(username) = username.filter(|name| !name.is_empty()) {
        href.push_str(&format!("&u={username}"));
    }
    let html = format!(
        r#"
<h2 style="text-align: center;">Thanks for signing up with Mail!</h2>
<p style="text-align: center;">
  You have requested membership confirmation email for Mail.
  <br/>
  Please click the button below to complete setting user information.
</p>
<a
  href="{href}"
  target="mail-confirm"
  style="display: flex; align-items: center; justify-content: center; margin: 2rem auto; padding: 5px; background-color: #3291FF; color: white; border: none; height: 40px; width: 400px; font-size: 20px;"
>Confirm Sign Up</a>
<p style="text-align: center;">
  * This email expires in 1 hour.
  <br/>  
  * You should not share this email with other people.
  <br/>  
  * Ignore this email if you have not requested it.
</p>
"#
    );
    AuthenticationMail {
        sender_full_name: "Mail".to_string(),
        sender: "no-reply".to_string(),
        to: email.to_string(),
        subject: "Please set your password for Mail".to_string(),
        html,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_emails() {
        assert!(is_valid_email("a@b.co"));
        assert!(is_valid_email("first.last+tag@sub.example.com"));
        assert!(!is_valid_email("a@b"));
        assert!(!is_valid_email("a@@b.co"));
        assert!(!is_valid_email("@b.co"));
        assert!(!is_valid_email("a b@c.co"));
        assert!(!is_valid_email("a@b_c.co"));
        assert!(!is_valid_email(""));
    }
}
