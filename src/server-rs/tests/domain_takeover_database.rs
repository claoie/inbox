//! A domain changing owner against a real PostgreSQL: `promote_claim` moving a
//! verified name to its claimant, and what that does to viewer roles granted
//! by the former owner, before and after the move.
//!
//! Runs when `MAIL_TEST_POSTGRES=1` and reports itself skipped otherwise:
//!
//! ```bash
//! MAIL_TEST_POSTGRES=1 cargo test --manifest-path src/server-rs/Cargo.toml --test domain_takeover_database
//! ```
//!
//! The server is `MAIL_TEST_POSTGRES_HOST`, `_PORT`, `_USER`, `_PASSWORD`
//! (default `postgres:postgres@127.0.0.1:5432`). The database
//! `domain_takeover_rs_<pid>` is created from `schema.json` and dropped at the end.

use std::panic::{resume_unwind, AssertUnwindSafe};
use std::time::Duration;

use futures_util::FutureExt;

use mail_server::params;
use mail_server::postgres::repositories::domains::{
    add_claim, assign_domain, find_domain, list_former_domains, get_domain_access, grant_viewer, promote_claim,
    DomainRole, GrantViewerResult, PromoteClaimResult,
};
use mail_server::postgres::schema::schema;
use mail_server::postgres::{pool, Pool, PoolOptions};

fn setting(name: &str, default: &str) -> String {
    std::env::var(format!("MAIL_TEST_POSTGRES_{name}")).unwrap_or_else(|_| default.to_string())
}

async fn admin(sql: &str) {
    let pool = Pool::new(PoolOptions {
        host: setting("HOST", "127.0.0.1"),
        port: setting("PORT", "5432").parse().expect("a port"),
        user: setting("USER", "postgres"),
        password: Some(setting("PASSWORD", "postgres")),
        database: "postgres".to_string(),
        max: 1,
        connection_timeout: Duration::from_secs(5),
        statement_timeout: Duration::from_secs(30),
        query_timeout: Duration::from_secs(30),
    });
    pool.query(sql, &[]).await.expect("the admin statement runs");
    pool.end();
}

async fn new_user(username: &str) -> String {
    let values = params![username];
    pool()
        .query("INSERT INTO users (username, password) VALUES ($1, 'not-a-digest') RETURNING user_id", &values)
        .await
        .expect("the user is inserted")
        .rows[0]
        .text("user_id")
}

async fn take_over(claimant: &str, name: &str) -> Option<String> {
    add_claim(claimant, name, "tok").await.expect("the claim is added");
    match promote_claim(claimant, name, "tok").await.expect("the claim is promoted") {
        PromoteClaimResult::Verified { previous_owner_id } => previous_owner_id,
        PromoteClaimResult::Missing => panic!("the claim was not found"),
    }
}

async fn role_of(user_id: &str, name: &str) -> Option<DomainRole> {
    get_domain_access(user_id, name).await.expect("access is read").map(|access| access.role)
}

async fn scenario() {
    let (former, claimant) = (new_user("former").await, new_user("claimant").await);
    let (early, late) = (new_user("early").await, new_user("late").await);

    assert!(assign_domain(&former, "x.org").await.unwrap());
    let domain_id = find_domain("x.org").await.unwrap().expect("the domain exists").domain_id;
    assert_eq!(grant_viewer(&domain_id, &former, &early).await.unwrap(), GrantViewerResult::Granted);
    assert_eq!(role_of(&early, "x.org").await, Some(DomainRole::Viewer));

    assert_eq!(take_over(&claimant, "x.org").await, Some(former.clone()));

    // The move keeps the domain id, drops the former owner's grants and
    // remembers the name as one of theirs.
    assert_eq!(find_domain("x.org").await.unwrap().unwrap().domain_id, domain_id);
    assert_eq!(role_of(&claimant, "x.org").await, Some(DomainRole::Owner));
    assert_eq!(role_of(&early, "x.org").await, None);
    assert_eq!(list_former_domains(&former).await.unwrap(), vec!["x.org".to_string()]);

    // A grant whose ownership check ran before the move lands after it.
    assert_eq!(grant_viewer(&domain_id, &former, &late).await.unwrap(), GrantViewerResult::NotOwner);
    assert_eq!(role_of(&late, "x.org").await, None);

    assert_eq!(grant_viewer(&domain_id, &claimant, &late).await.unwrap(), GrantViewerResult::Granted);
    assert_eq!(grant_viewer(&domain_id, &claimant, &late).await.unwrap(), GrantViewerResult::Exists);
    assert_eq!(role_of(&late, "x.org").await, Some(DomainRole::Viewer));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_takeover_drops_old_grants_and_refuses_late_ones() {
    if std::env::var("MAIL_TEST_POSTGRES").as_deref() != Ok("1") {
        eprintln!("skipped: set MAIL_TEST_POSTGRES=1 to run against PostgreSQL");
        return;
    }
    let database = format!("domain_takeover_rs_{}", std::process::id());
    admin(&format!("DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)")).await;
    admin(&format!("CREATE DATABASE \"{database}\"")).await;
    std::env::set_var("POSTGRES_HOST", setting("HOST", "127.0.0.1"));
    std::env::set_var("POSTGRES_PORT", setting("PORT", "5432"));
    std::env::set_var("POSTGRES_USER", setting("USER", "postgres"));
    std::env::set_var("POSTGRES_PASSWORD", setting("PASSWORD", "postgres"));
    std::env::set_var("POSTGRES_DATABASE", &database);
    std::env::set_var("EMAIL_DOMAIN", "mail.test");
    std::env::set_var("NODE_ENV", "test");

    let outcome = AssertUnwindSafe(async {
        for table in &schema().tables {
            pool().query(&table.create_sql, &[]).await.expect("the table is created");
        }
        scenario().await
    })
    .catch_unwind()
    .await;

    pool().end();
    admin(&format!("DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)")).await;
    if let Err(panic) = outcome {
        resume_unwind(panic);
    }
}
