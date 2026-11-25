//! `/api/domains/*`: the domains a user owns or views, claims on new ones
//! and their DNS verification, and the viewer role (`routes/domains`).

use std::sync::OnceLock;

use serde::Serialize;
use serde_json::{json, Value};

use super::route::{auth_required, dispatch, ApiResponse, Reply, Route};
use crate::domains::{
    check_verification_record, is_in_served_zone, new_verification_token, normalize_domain_name, served_zone,
    verification_record, VerificationCheck, VerificationRecord,
};
use crate::http::request::HttpRequest;
use crate::http::respond::Response;
use crate::logger;
use crate::models::SignedUser;
use crate::postgres::repositories::domains::{
    add_claim, delete_claim, delete_owned_domain, find_domain, get_claim, get_domain_access, grant_viewer,
    list_claims, list_domain_access, list_domain_viewers, promote_claim, revoke_role, AddClaimResult, DomainAccess,
    DomainClaim, DomainRole, GrantViewerResult, PromoteClaimResult, DOMAIN_COUNT_MAX, DOMAIN_VIEWER_COUNT_MAX,
};
use crate::postgres::repositories::users::find_user_by_username;

/// A domain as the user sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainEntry {
    pub name: String,
    pub role: &'static str,
    pub owner: String,
    pub managed_by_server: bool,
    pub verified_at: Option<String>,
    /// The viewers' usernames, shown to the owner only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewers: Option<Vec<String>>,
}

/// A claim not verified yet, with the record that proves it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainClaimEntry {
    pub name: String,
    pub record: VerificationRecord,
    pub created_at: String,
}

fn to_claim_entry(claim: &DomainClaim) -> DomainClaimEntry {
    DomainClaimEntry {
        name: claim.name.clone(),
        record: verification_record(&claim.name, &claim.token),
        created_at: claim.created_at.clone(),
    }
}

async fn to_domain_entry(access: &DomainAccess) -> anyhow::Result<DomainEntry> {
    let viewers = match access.role {
        DomainRole::Owner => {
            Some(list_domain_viewers(&access.domain_id).await?.into_iter().map(|viewer| viewer.username).collect())
        }
        DomainRole::Viewer => None,
    };
    Ok(DomainEntry {
        name: access.name.clone(),
        role: access.role.as_str(),
        owner: access.owner_username.clone(),
        managed_by_server: is_in_served_zone(&access.name),
        verified_at: access.verified_at.clone(),
        viewers,
    })
}

fn session_user(req: &HttpRequest) -> anyhow::Result<SignedUser> {
    req.session.user.clone().ok_or_else(|| anyhow::anyhow!("the route runs behind the session gate"))
}

/// A body field as `normalizeDomainName` reads it: anything but a string is no name.
fn name_field(req: &HttpRequest) -> Option<String> {
    req.body_object().and_then(|body| body.get("name")).and_then(Value::as_str).and_then(normalize_domain_name)
}

async fn get_domains(req: &mut HttpRequest) -> anyhow::Result<Reply> {
    let user = session_user(req)?;
    let (access, claims) = tokio::try_join!(list_domain_access(&user.id), list_claims(&user.id))?;
    let mut domains = Vec::with_capacity(access.len());
    for access in &access {
        domains.push(to_domain_entry(access).await?);
    }
    let claims: Vec<DomainClaimEntry> = claims.iter().map(to_claim_entry).collect();
    Ok(ApiResponse::success_with(json!({ "zone": served_zone(), "domains": domains, "claims": claims })).into())
}

async fn post_domain(req: &mut HttpRequest) -> anyhow::Result<Reply> {
    let user = session_user(req)?;
    let Some(name) = name_field(req) else {
        return Ok(ApiResponse::failed("Enter a domain name, such as example.com.").into());
    };
    if is_in_served_zone(&name) {
        let zone = served_zone();
        return Ok(ApiResponse::failed(format!(
            "{name} is part of {zone}, which this server assigns to accounts itself."
        ))
        .into());
    }
    if find_domain(&name).await?.is_some_and(|existing| existing.owner_id == user.id) {
        return Ok(ApiResponse::failed(format!("You already own {name}.")).into());
    }
    Ok(match add_claim(&user.id, &name, &new_verification_token()).await? {
        AddClaimResult::AtLimit => ApiResponse::failed(format!(
            "You can have at most {DOMAIN_COUNT_MAX} domains, counting the ones not verified yet."
        )),
        AddClaimResult::Created(claim) | AddClaimResult::Exists(claim) => {
            ApiResponse::success_with(to_claim_entry(&claim))
        }
    }
    .into())
}

async fn post_verify(req: &mut HttpRequest) -> anyhow::Result<Reply> {
    let user = session_user(req)?;
    let name = name_field(req);
    let claim = match &name {
        Some(name) => get_claim(&user.id, name).await?,
        None => None,
    };
    let (Some(name), Some(claim)) = (name, claim) else {
        return Ok(ApiResponse::failed("Add the domain first.").into());
    };

    match check_verification_record(&name, &claim.token).await {
        VerificationCheck::Unavailable => {
            return Ok(ApiResponse::failed("DNS could not be reached. Try again in a minute.").into());
        }
        VerificationCheck::Missing => {
            let VerificationRecord { host, value, .. } = verification_record(&name, &claim.token);
            return Ok(ApiResponse::failed(format!(
                "No TXT record {host} with the value {value} was found yet. DNS changes can take a while to show up."
            ))
            .into());
        }
        VerificationCheck::Found => {}
    }

    match promote_claim(&user.id, &name, &claim.token).await? {
        PromoteClaimResult::Missing => {
            return Ok(ApiResponse::failed("This domain's verification changed. Reload and try again.").into());
        }
        PromoteClaimResult::Verified { previous_owner_id: Some(previous_owner_id) } => {
            logger::info(
                "A verified domain moved to a new owner",
                json!({ "domain": name, "previousOwnerId": previous_owner_id, "ownerId": user.id }),
            );
        }
        PromoteClaimResult::Verified { previous_owner_id: None } => {}
    }
    let Some(access) = get_domain_access(&user.id, &name).await? else {
        return Ok(ApiResponse::failed("This domain could not be read back.").into());
    };
    Ok(ApiResponse::success_with(to_domain_entry(&access).await?).into())
}

async fn delete_domain(req: &mut HttpRequest) -> anyhow::Result<Reply> {
    let user = session_user(req)?;
    let Some(name) = normalize_domain_name(req.param("name")) else {
        return Ok(ApiResponse::failed("Not a domain name.").into());
    };
    if delete_claim(&user.id, &name).await? {
        return Ok(ApiResponse::success().into());
    }
    if is_in_served_zone(&name) {
        return Ok(ApiResponse::failed(format!("{name} is assigned by this server and cannot be removed.")).into());
    }
    if delete_owned_domain(&user.id, &name).await? {
        return Ok(ApiResponse::success().into());
    }
    Ok(ApiResponse::failed(format!("You don't own {name}.")).into())
}

/// The domain named, when the user owns it.
async fn owned_domain(user_id: &str, raw_name: Option<&str>) -> anyhow::Result<Option<DomainAccess>> {
    let Some(name) = raw_name.and_then(normalize_domain_name) else { return Ok(None) };
    Ok(get_domain_access(user_id, &name).await?.filter(|access| access.role == DomainRole::Owner))
}

async fn post_viewer(req: &mut HttpRequest) -> anyhow::Result<Reply> {
    let user = session_user(req)?;
    let field = |name: &str| req.body_object().and_then(|body| body.get(name)).and_then(Value::as_str).map(str::to_string);
    let (name, username) = (field("name"), field("username"));
    let Some(domain) = owned_domain(&user.id, name.as_deref()).await? else {
        return Ok(ApiResponse::failed("You can only share a domain you own.").into());
    };
    let username = username.as_deref().map(crate::js::trim).unwrap_or("").to_string();
    let viewer = if username.is_empty() { None } else { find_user_by_username(&username).await? };
    let viewer = viewer.filter(|viewer| {
        viewer.is_deleted != Some(true) && (viewer.password.is_some() || viewer.auth_sub.is_some())
    });
    let Some(viewer) = viewer else {
        let named = if username.is_empty() { "that" } else { username.as_str() };
        return Ok(ApiResponse::failed(format!("There is no account named {named}.")).into());
    };
    if viewer.user_id == user.id {
        return Ok(ApiResponse::failed("You already own this domain.").into());
    }
    match grant_viewer(&domain.domain_id, &user.id, &viewer.user_id).await? {
        GrantViewerResult::NotOwner => {
            return Ok(ApiResponse::failed("You can only share a domain you own.").into());
        }
        GrantViewerResult::AtLimit => {
            return Ok(
                ApiResponse::failed(format!("A domain can have at most {DOMAIN_VIEWER_COUNT_MAX} viewers.")).into()
            );
        }
        GrantViewerResult::Granted | GrantViewerResult::Exists => {}
    }
    logger::info(
        "Granted the viewer role on a domain",
        json!({ "domain": domain.name, "viewer": viewer.username, "grantedBy": user.username }),
    );
    Ok(ApiResponse::success_with(to_domain_entry(&domain).await?).into())
}

async fn delete_viewer(req: &mut HttpRequest) -> anyhow::Result<Reply> {
    let user = session_user(req)?;
    let Some(domain) = owned_domain(&user.id, Some(req.param("name"))).await? else {
        return Ok(ApiResponse::failed("You can only manage a domain you own.").into());
    };
    if let Some(viewer) = find_user_by_username(req.param("username")).await? {
        revoke_role(&domain.domain_id, &viewer.user_id).await?;
        logger::info(
            "Revoked the viewer role on a domain",
            json!({ "domain": domain.name, "viewer": viewer.username, "revokedBy": user.username }),
        );
    }
    Ok(ApiResponse::success_with(to_domain_entry(&domain).await?).into())
}

fn routes() -> &'static [Route] {
    static ROUTES: OnceLock<Vec<Route>> = OnceLock::new();
    ROUTES.get_or_init(|| {
        vec![
            Route::new("GET", "/", |req| Box::pin(get_domains(req))),
            Route::new("POST", "/", |req| Box::pin(post_domain(req))),
            Route::new("POST", "/verify", |req| Box::pin(post_verify(req))),
            Route::new("POST", "/viewers", |req| Box::pin(post_viewer(req))),
            Route::new("DELETE", "/viewers/:name/:username", |req| Box::pin(delete_viewer(req))),
            Route::new("DELETE", "/:name", |req| Box::pin(delete_domain(req))),
        ]
    })
}

/// `/api/domains/*`, with `path` relative to that mount. Every route needs a
/// session.
pub async fn handle_domains(req: &mut HttpRequest, path: &str) -> anyhow::Result<Option<Response>> {
    if let Some(denied) = auth_required(req) {
        return Ok(Some(denied));
    }
    dispatch(routes(), req, path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_serialize_as_the_bun_server_writes_them() {
        let owned = DomainEntry {
            name: "example.org".into(),
            role: "owner",
            owner: "alice".into(),
            managed_by_server: false,
            verified_at: None,
            viewers: Some(vec!["bob".into()]),
        };
        assert_eq!(
            serde_json::to_value(&owned).unwrap(),
            json!({ "name": "example.org", "role": "owner", "owner": "alice", "managedByServer": false, "verifiedAt": null, "viewers": ["bob"] })
        );
        let viewed = DomainEntry { role: "viewer", viewers: None, ..owned };
        assert!(serde_json::to_value(&viewed).unwrap().get("viewers").is_none());
        let claim = to_claim_entry(&DomainClaim {
            name: "example.info".into(),
            token: "tok".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        });
        assert_eq!(
            serde_json::to_value(&claim).unwrap(),
            json!({
                "name": "example.info",
                "record": { "type": "TXT", "host": "_mail-verification.example.info", "value": "mail-verification=tok" },
                "createdAt": "2026-01-01T00:00:00.000Z",
            })
        );
    }
}
