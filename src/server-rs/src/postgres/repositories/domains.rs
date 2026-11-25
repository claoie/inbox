//! The domains, domain_claims, domain_roles and former_domains tables
//! (repositories/domains.ts, models/domain.ts).
//!
//! A domain is a resource with one owner, the row's `user_id`, which also
//! keys the domain's mail rows. Other people hold roles on it through
//! `domain_roles`. The statements are the Bun server's, text for text.

use serde_json::Value;

use crate::params;
use crate::postgres::{pool, DbResult, Param, Row};

/// Ceiling on domains per account, counting claims not verified yet.
pub const DOMAIN_COUNT_MAX: i64 = 100;
/// Ceiling on viewers per domain.
pub const DOMAIN_VIEWER_COUNT_MAX: i64 = 100;
/// The longest DNS name.
pub const DOMAIN_NAME_MAX_LENGTH: usize = 253;

/// The role a person holds on a domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomainRole {
    Owner,
    Viewer,
}

impl DomainRole {
    pub fn as_str(self) -> &'static str {
        match self {
            DomainRole::Owner => "owner",
            DomainRole::Viewer => "viewer",
        }
    }

    fn parse(value: &str) -> DomainRole {
        if value == "owner" {
            DomainRole::Owner
        } else {
            DomainRole::Viewer
        }
    }
}

/// A domain as one person sees it: its owner and the role they hold on it.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainAccess {
    pub domain_id: String,
    pub name: String,
    /// The owner, whose `user_id` keys the domain's mail rows.
    pub owner_id: String,
    pub owner_username: String,
    pub role: DomainRole,
    pub verified_at: Option<String>,
}

fn to_access(row: &Row) -> DomainAccess {
    DomainAccess {
        domain_id: row.text("domain_id"),
        name: row.text("name"),
        owner_id: row.text("owner_id"),
        owner_username: row.text("owner_username"),
        role: DomainRole::parse(&row.text("role")),
        verified_at: row.opt_text("verified_at"),
    }
}

// The role a person holds on `d`, given their user id as $1. The owner is the
// row's `user_id`; anyone else holds the role their `domain_roles` row names.
const ACCESS_COLUMNS: &str = "
  d.domain_id, d.name, d.user_id AS owner_id, o.username AS owner_username,
  d.verified_at,
  CASE WHEN d.user_id = $1 THEN 'owner' ELSE r.role END AS role";

const ACCESS_FROM: &str = "
  FROM domains d
  JOIN users o ON o.user_id = d.user_id
  LEFT JOIN domain_roles r ON r.domain_id = d.domain_id AND r.user_id = $1";

const HAS_ACCESS: &str = "(d.user_id = $1 OR r.user_id IS NOT NULL)";

/// `buildListDomainAccess`.
pub fn build_list_domain_access(user_id: &str) -> (String, Vec<Param>) {
    (
        format!("SELECT {ACCESS_COLUMNS} {ACCESS_FROM} WHERE {HAS_ACCESS} ORDER BY d.name"),
        params![user_id],
    )
}

/// Every domain the person owns or holds a role on, by name.
pub async fn list_domain_access(user_id: &str) -> DbResult<Vec<DomainAccess>> {
    let (sql, values) = build_list_domain_access(user_id);
    let result = pool().query(&sql, &values).await?;
    Ok(result.rows.iter().map(to_access).collect())
}

/// `buildGetDomainAccess`.
pub fn build_get_domain_access(user_id: &str, name: &str) -> (String, Vec<Param>) {
    (
        format!("SELECT {ACCESS_COLUMNS} {ACCESS_FROM} WHERE d.name = $2 AND {HAS_ACCESS}"),
        params![user_id, name.to_lowercase()],
    )
}

/// The person's role on `name`, or `None` when they hold none.
pub async fn get_domain_access(user_id: &str, name: &str) -> DbResult<Option<DomainAccess>> {
    let (sql, values) = build_get_domain_access(user_id, name);
    let result = pool().query(&sql, &values).await?;
    Ok(result.rows.first().map(to_access))
}

/// A domain row, whoever owns it.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainRow {
    pub domain_id: String,
    pub name: String,
    pub owner_id: String,
    /// The owner's account is soft-deleted: the name stays taken, and nothing
    /// is delivered to it.
    pub owner_deleted: bool,
}

/// The domain row for `name`, whoever owns it.
pub async fn find_domain(name: &str) -> DbResult<Option<DomainRow>> {
    let result = pool()
        .query(
            "SELECT d.domain_id, d.name, d.user_id, (u.is_deleted IS TRUE) AS owner_deleted
     FROM domains d JOIN users u ON u.user_id = d.user_id
     WHERE d.name = $1",
            &params![name.to_lowercase()],
        )
        .await?;
    Ok(result.rows.first().map(|row| DomainRow {
        domain_id: row.text("domain_id"),
        name: row.text("name"),
        owner_id: row.text("user_id"),
        owner_deleted: row.bool("owner_deleted"),
    }))
}

/// The user ids of everyone who can read mail delivered to `name`.
pub async fn readers_of_domain(name: &str) -> DbResult<Vec<String>> {
    let result = pool()
        .query(
            "
    SELECT d.user_id FROM domains d WHERE d.name = $1
    UNION
    SELECT r.user_id FROM domain_roles r
    JOIN domains d ON d.domain_id = r.domain_id
    WHERE d.name = $1",
            &params![name.to_lowercase()],
        )
        .await?;
    Ok(result.rows.iter().map(|row| row.text("user_id")).collect())
}

/// Assigns `name` to `user_id` without a DNS check, unless the name is taken.
/// Only for names this server answers for itself and for the operator.
/// True when the name now belongs to `user_id`.
pub async fn assign_domain(user_id: &str, name: &str) -> DbResult<bool> {
    let result = pool()
        .query(
            "WITH inserted AS (
       INSERT INTO domains (name, user_id) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING user_id
     )
     SELECT user_id FROM inserted
     UNION ALL
     SELECT user_id FROM domains WHERE name = $1",
            &params![name.to_lowercase(), user_id],
        )
        .await?;
    Ok(result.rows.iter().any(|row| row.text("user_id") == user_id))
}

/// Gives every account that is not deleted, and whose username is a DNS
/// label, its own name under `zone`. Idempotent; a taken name stays taken.
pub async fn backfill_account_domains(zone: &str) -> DbResult<u64> {
    let result = pool()
        .query(
            "
    INSERT INTO domains (name, user_id)
    SELECT username || '.' || $1, user_id FROM users
    WHERE is_deleted IS NOT TRUE
      AND username ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    ON CONFLICT (name) DO NOTHING",
            &params![zone.to_lowercase()],
        )
        .await?;
    Ok(result.row_count.unwrap_or(0))
}

/// Removes a domain its owner no longer wants, remembering it as a former
/// one of theirs. Its mail stays with the owner.
pub async fn delete_owned_domain(user_id: &str, name: &str) -> DbResult<bool> {
    let result = pool()
        .query(
            "
    WITH removed AS (
      DELETE FROM domains WHERE name = $1 AND user_id = $2 RETURNING user_id, name
    ), remembered AS (
      INSERT INTO former_domains (user_id, name) SELECT user_id, name FROM removed
      ON CONFLICT (user_id, name) DO NOTHING
    )
    SELECT COUNT(*)::int AS removed FROM removed",
            &params![name.to_lowercase(), user_id],
        )
        .await?;
    Ok(result.rows.first().map(|row| row.i64("removed")).unwrap_or(0) > 0)
}

/// The domains an account owned and no longer does, whose mail it still holds.
pub async fn list_former_domains(user_id: &str) -> DbResult<Vec<String>> {
    let result = pool()
        .query("SELECT name FROM former_domains WHERE user_id = $1 ORDER BY name", &params![user_id])
        .await?;
    Ok(result.rows.iter().map(|row| row.text("name")).collect())
}

/// A pending claim on a domain, proved by its DNS record.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainClaim {
    pub name: String,
    pub token: String,
    pub created_at: String,
}

fn to_claim(row: &Row) -> DomainClaim {
    DomainClaim {
        name: row.text("name"),
        token: row.text("token"),
        created_at: match row.get("created_at") {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        },
    }
}

pub async fn list_claims(user_id: &str) -> DbResult<Vec<DomainClaim>> {
    let result = pool()
        .query(
            "SELECT name, token, created_at FROM domain_claims WHERE user_id = $1 ORDER BY name",
            &params![user_id],
        )
        .await?;
    Ok(result.rows.iter().map(to_claim).collect())
}

pub async fn get_claim(user_id: &str, name: &str) -> DbResult<Option<DomainClaim>> {
    let result = pool()
        .query(
            "SELECT name, token, created_at FROM domain_claims WHERE user_id = $1 AND name = $2",
            &params![user_id, name.to_lowercase()],
        )
        .await?;
    Ok(result.rows.first().map(to_claim))
}

#[derive(Debug, Clone, PartialEq)]
pub enum AddClaimResult {
    Created(DomainClaim),
    Exists(DomainClaim),
    AtLimit,
}

/// Records a claim on `name`, or returns the one the person already has.
pub async fn add_claim(user_id: &str, name: &str, token: &str) -> DbResult<AddClaimResult> {
    let result = pool()
        .query(
            "
    INSERT INTO domain_claims (name, user_id, token)
    SELECT $1, $2, $3
    WHERE (SELECT COUNT(*) FROM domain_claims WHERE user_id = $2)
        + (SELECT COUNT(*) FROM domains WHERE user_id = $2) < $4
    ON CONFLICT (name, user_id) DO NOTHING
    RETURNING name, token, created_at",
            &params![name.to_lowercase(), user_id, token, DOMAIN_COUNT_MAX],
        )
        .await?;
    if let Some(row) = result.rows.first() {
        return Ok(AddClaimResult::Created(to_claim(row)));
    }
    Ok(match get_claim(user_id, name).await? {
        Some(existing) => AddClaimResult::Exists(existing),
        None => AddClaimResult::AtLimit,
    })
}

pub async fn delete_claim(user_id: &str, name: &str) -> DbResult<bool> {
    let result = pool()
        .query(
            "DELETE FROM domain_claims WHERE user_id = $1 AND name = $2",
            &params![user_id, name.to_lowercase()],
        )
        .await?;
    Ok(result.row_count.unwrap_or(0) > 0)
}

#[derive(Debug, Clone, PartialEq)]
pub enum PromoteClaimResult {
    Verified { previous_owner_id: Option<String> },
    Missing,
}

/// Turns a claim whose DNS record was just proved into the domain, in one
/// transaction. A name someone else owns moves to the claimant, its roles are
/// dropped, and it is remembered as one of the previous owner's former domains.
pub async fn promote_claim(user_id: &str, name: &str, token: &str) -> DbResult<PromoteClaimResult> {
    let normalized = name.to_lowercase();
    let mut client = pool().connect().await?;
    client.query("BEGIN", &[]).await?;
    let outcome = async {
        let claimed = client
            .query(
                "DELETE FROM domain_claims WHERE user_id = $1 AND name = $2 AND token = $3 RETURNING claim_id",
                &params![user_id, normalized.as_str(), token],
            )
            .await?;
        if !claimed.any() {
            return Ok(None);
        }
        let existing = client
            .query(
                "SELECT domain_id, user_id FROM domains WHERE name = $1 FOR UPDATE",
                &params![normalized.as_str()],
            )
            .await?;
        let mut previous_owner_id = None;
        match existing.rows.first() {
            None => {
                client
                    .query(
                        "INSERT INTO domains (name, user_id, verified_at) VALUES ($1, $2, CURRENT_TIMESTAMP)",
                        &params![normalized.as_str(), user_id],
                    )
                    .await?;
            }
            Some(row) if row.text("user_id") == user_id => {
                client
                    .query(
                        "UPDATE domains SET verified_at = CURRENT_TIMESTAMP WHERE domain_id = $1",
                        &params![row.text("domain_id")],
                    )
                    .await?;
            }
            Some(row) => {
                let domain_id = row.text("domain_id");
                let previous = row.text("user_id");
                client.query("DELETE FROM domain_roles WHERE domain_id = $1", &params![domain_id.as_str()]).await?;
                client
                    .query(
                        "INSERT INTO former_domains (user_id, name) VALUES ($1, $2) ON CONFLICT (user_id, name) DO NOTHING",
                        &params![previous.as_str(), normalized.as_str()],
                    )
                    .await?;
                client
                    .query(
                        "UPDATE domains SET user_id = $2, verified_at = CURRENT_TIMESTAMP WHERE domain_id = $1",
                        &params![domain_id.as_str(), user_id],
                    )
                    .await?;
                previous_owner_id = Some(previous);
            }
        }
        Ok::<_, crate::postgres::DbError>(Some(previous_owner_id))
    }
    .await;
    match outcome {
        Ok(Some(previous_owner_id)) => {
            client.query("COMMIT", &[]).await?;
            Ok(PromoteClaimResult::Verified { previous_owner_id })
        }
        Ok(None) => {
            client.query("ROLLBACK", &[]).await?;
            Ok(PromoteClaimResult::Missing)
        }
        Err(error) => {
            let _ = client.query("ROLLBACK", &[]).await;
            Err(error)
        }
    }
}

/// A person holding a role on a domain, the owner excluded.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainMember {
    pub user_id: String,
    pub username: String,
    pub role: DomainRole,
}

pub async fn list_domain_viewers(domain_id: &str) -> DbResult<Vec<DomainMember>> {
    let result = pool()
        .query(
            "SELECT r.user_id, u.username, r.role FROM domain_roles r
     JOIN users u ON u.user_id = r.user_id
     WHERE r.domain_id = $1 ORDER BY u.username",
            &params![domain_id],
        )
        .await?;
    Ok(result
        .rows
        .iter()
        .map(|row| DomainMember {
            user_id: row.text("user_id"),
            username: row.text("username"),
            role: DomainRole::parse(&row.text("role")),
        })
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantViewerResult {
    Granted,
    Exists,
    AtLimit,
    NotOwner,
}

/// Grants only while `granter_id` owns the domain. The owner check takes a
/// share lock on the domain row, so a grant racing a takeover either lands
/// before it (and its role is dropped with the move) or sees the new owner and
/// is refused.
pub async fn grant_viewer(domain_id: &str, granter_id: &str, user_id: &str) -> DbResult<GrantViewerResult> {
    let result = pool()
        .query(
            "
    INSERT INTO domain_roles (domain_id, user_id, role)
    SELECT $1, $3, 'viewer'
    WHERE EXISTS (SELECT 1 FROM domains WHERE domain_id = $1 AND user_id = $2 FOR SHARE)
      AND $2 <> $3
      AND (SELECT COUNT(*) FROM domain_roles WHERE domain_id = $1) < $4
    ON CONFLICT (domain_id, user_id) DO NOTHING
    RETURNING user_id",
            &params![domain_id, granter_id, user_id, DOMAIN_VIEWER_COUNT_MAX],
        )
        .await?;
    if result.any() {
        return Ok(GrantViewerResult::Granted);
    }
    let probe = pool()
        .query(
            "SELECT EXISTS (SELECT 1 FROM domains WHERE domain_id = $1 AND user_id = $2) AS owns,
            EXISTS (SELECT 1 FROM domain_roles WHERE domain_id = $1 AND user_id = $3) AS holds",
            &params![domain_id, granter_id, user_id],
        )
        .await?;
    let row = probe.rows.first();
    Ok(match (row.is_some_and(|row| row.bool("owns")), row.is_some_and(|row| row.bool("holds"))) {
        (false, _) => GrantViewerResult::NotOwner,
        (true, true) => GrantViewerResult::Exists,
        (true, false) => GrantViewerResult::AtLimit,
    })
}

pub async fn revoke_role(domain_id: &str, user_id: &str) -> DbResult<bool> {
    let result = pool()
        .query(
            "DELETE FROM domain_roles WHERE domain_id = $1 AND user_id = $2",
            &params![domain_id, user_id],
        )
        .await?;
    Ok(result.row_count.unwrap_or(0) > 0)
}
