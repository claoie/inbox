//! The account sidebar: mail counts per address (mails/accounts.ts).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::domains::domain_of_address;
use crate::js;
use crate::mails::notifications::get_unread_notifications;
use crate::models::SignedUser;
use crate::postgres::repositories::domains::{list_domain_access, list_former_domains, DomainAccess, DomainRole};
use crate::postgres::repositories::mails::http::{get_account_stats, search_account_stats, AccountStat};
use crate::postgres::DbResult;

/// One address and its counts, as the client's `Account` serializes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Account {
    pub key: String,
    pub doc_count: i64,
    pub unread_doc_count: i64,
    pub saved_doc_count: i64,
    /// ISO time of the newest mail.
    pub updated: String,
}

impl From<AccountStat> for Account {
    fn from(stat: AccountStat) -> Account {
        Account {
            key: stat.address,
            doc_count: stat.count,
            unread_doc_count: stat.unread,
            saved_doc_count: stat.saved,
            updated: if stat.latest.is_empty() { js::now_iso() } else { stat.latest },
        }
    }
}

/// A domain the user holds the viewer role on, with its accounts. Its mail is
/// the owner's, read-only, so it is listed apart from the user's own.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SharedDomainAccounts {
    pub domain: String,
    pub owner: String,
    pub received: Vec<Account>,
    pub sent: Vec<Account>,
}

/// Received, sent and spam accounts, each newest first, then the domains the
/// user views, then the user's own unread mail counted once per message.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Accounts {
    pub received: Vec<Account>,
    pub sent: Vec<Account>,
    pub spam: Vec<Account>,
    pub shared: Vec<SharedDomainAccounts>,
    /// Summing `unread_doc_count` counts a mail once per own address it names;
    /// this is the push badge's per-message count, from the same query.
    pub unread_mail_count: i64,
}

/// The addresses the user's own rows hold mail for: those on the domains they
/// own, and on the ones they used to own, whose mail stays with them.
async fn own_account_domains(user_id: &str, access: &[DomainAccess]) -> DbResult<Vec<String>> {
    let mut seen = BTreeSet::new();
    let owned = access.iter().filter(|domain| domain.role == DomainRole::Owner).map(|domain| domain.name.clone());
    let former = list_former_domains(user_id).await?;
    Ok(owned.chain(former).filter(|name| seen.insert(name.clone())).collect())
}

/// The accounts of the domains the user views, read from each owner's rows
/// filtered to those domains: one pair of queries per owner, however many of
/// their domains the user views.
async fn shared_accounts(viewed: &[DomainAccess]) -> Vec<SharedDomainAccounts> {
    let mut by_owner: BTreeMap<&str, Vec<&DomainAccess>> = BTreeMap::new();
    for domain in viewed {
        by_owner.entry(domain.owner_id.as_str()).or_default().push(domain);
    }
    let per_owner = futures_util::future::join_all(by_owner.into_iter().map(|(owner_id, domains)| async move {
        let names: Vec<String> = domains.iter().map(|domain| domain.name.clone()).collect();
        let (received, sent) = tokio::join!(
            get_account_stats(owner_id, false, Some(&names), false, Some(&names)),
            get_account_stats(owner_id, true, Some(&names), false, Some(&names)),
        );
        let on_domain = |name: &str, stats: &[AccountStat]| -> Vec<Account> {
            stats
                .iter()
                .filter(|stat| domain_of_address(&stat.address) == name)
                .cloned()
                .map(Account::from)
                .collect()
        };
        domains
            .iter()
            .map(|domain| SharedDomainAccounts {
                domain: domain.name.clone(),
                owner: domain.owner_username.clone(),
                received: on_domain(&domain.name, &received),
                sent: on_domain(&domain.name, &sent),
            })
            .collect::<Vec<_>>()
    }))
    .await;
    let mut shared: Vec<SharedDomainAccounts> = per_owner.into_iter().flatten().collect();
    shared.sort_by(|a, b| a.domain.cmp(&b.domain));
    shared
}

/// The user's accounts: received groups by recipient (To, Cc, Bcc and the
/// envelope), sent by From, spam by recipient of spam. Only addresses on the
/// user's own and former domains are kept.
pub async fn get_accounts(user: &SignedUser) -> DbResult<Accounts> {
    let access = list_domain_access(&user.id).await?;
    let own = own_account_domains(&user.id, &access).await?;
    let viewed: Vec<DomainAccess> = access.into_iter().filter(|domain| domain.role == DomainRole::Viewer).collect();
    let user_ids = [user.id.clone()];
    let (received, sent, spam, shared, unread) = tokio::join!(
        get_account_stats(&user.id, false, Some(&own), false, None),
        get_account_stats(&user.id, true, Some(&own), false, None),
        get_account_stats(&user.id, false, Some(&own), true, None),
        shared_accounts(&viewed),
        get_unread_notifications(&user_ids),
    );
    Ok(Accounts {
        received: received.into_iter().map(Account::from).collect(),
        sent: sent.into_iter().map(Account::from).collect(),
        spam: spam.into_iter().map(Account::from).collect(),
        shared,
        unread_mail_count: unread.get(&user.id).map_or(0, |badge| badge.count),
    })
}

/// Received accounts that own at least one mail matching `value`. Search
/// covers the user's own mail only.
pub async fn search_accounts(user: &SignedUser, value: &str) -> DbResult<Vec<Account>> {
    let value = js::trim(value);
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let own = own_account_domains(&user.id, &list_domain_access(&user.id).await?).await?;
    Ok(search_account_stats(&user.id, value, Some(&own)).await.into_iter().map(Account::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_account_serializes_in_the_client_order() {
        let account = Account::from(AccountStat {
            address: "a@bob.mail.test".into(),
            count: 2,
            unread: 1,
            saved: 0,
            latest: "2026-01-01T00:00:00.000Z".into(),
        });
        assert_eq!(
            serde_json::to_string(&account).unwrap(),
            r#"{"key":"a@bob.mail.test","doc_count":2,"unread_doc_count":1,"saved_doc_count":0,"updated":"2026-01-01T00:00:00.000Z"}"#
        );
    }

    #[test]
    fn the_accounts_carry_the_shared_list_then_the_unread_mail_count() {
        assert_eq!(
            serde_json::to_string(&Accounts::default()).unwrap(),
            r#"{"received":[],"sent":[],"spam":[],"shared":[],"unread_mail_count":0}"#
        );
    }
}
