import { Account, SignedUser } from "common";
import {
  getAccountStats,
  getUnreadNotifications,
  searchAccountStats,
} from "../postgres/repositories/mails";
import {
  listDomainAccess,
  listFormerDomains,
  type DomainAccess,
} from "../postgres/repositories/domains";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
  // Spam is grouped per receiving account, like received/sent — each entry
  // carries that account's spam doc/unread counts for the sidebar list + badge.
  spam: Account[];
  /**
   * The domains the user holds the viewer role on, each with its accounts.
   * Their mail is the owner's, read-only, so they are listed apart from the
   * user's own.
   */
  shared: SharedDomainAccounts[];
  /**
   * The user's own unread mail, counted once per message. Summing the
   * accounts' `unread_doc_count` counts a mail once per own address it names,
   * so the app badge and the all-accounts totals read this instead. It is the
   * count the new-mail push sends as its badge, from the same query.
   */
  unread_mail_count: number;
}

export interface SharedDomainAccounts {
  domain: string;
  owner: string;
  received: Account[];
  sent: Account[];
}

const toAccount = (stat: {
  address: string;
  count: number;
  unread: number;
  saved: number;
  latest: Date;
}): Account =>
  new Account({
    key: stat.address,
    doc_count: stat.count,
    unread_doc_count: stat.unread,
    saved_doc_count: stat.saved,
    updated: stat.latest,
  });

/**
 * The addresses the user's own rows hold mail for: those on the domains they
 * own, and on the ones they used to own, whose mail stays with them.
 */
const ownAccountDomains = async (userId: string, access: DomainAccess[]) => [
  ...new Set([
    ...access.filter((domain) => domain.role === "owner").map((domain) => domain.name),
    ...(await listFormerDomains(userId)),
  ]),
];

/**
 * The accounts of the domains the user views, read from each owner's rows
 * filtered to those domains: one pair of queries per owner, however many of
 * their domains the user views.
 */
const sharedAccounts = async (viewed: DomainAccess[]): Promise<SharedDomainAccounts[]> => {
  const byOwner = new Map<string, DomainAccess[]>();
  for (const domain of viewed) {
    byOwner.set(domain.ownerId, [...(byOwner.get(domain.ownerId) ?? []), domain]);
  }
  const perOwner = await Promise.all(
    [...byOwner.entries()].map(async ([ownerId, domains]) => {
      const names = domains.map((domain) => domain.name);
      const [received, sent] = await Promise.all([
        getAccountStats(ownerId, false, names, false, names),
        getAccountStats(ownerId, true, names, false, names),
      ]);
      const onDomain = (name: string) => (stat: { address: string }) =>
        stat.address.toLowerCase().split("@").pop() === name;
      return domains.map(({ name, ownerUsername }) => ({
        domain: name,
        owner: ownerUsername,
        received: received.filter(onDomain(name)).map(toAccount),
        sent: sent.filter(onDomain(name)).map(toAccount),
      }));
    })
  );
  return perOwner.flat().sort((a, b) => a.domain.localeCompare(b.domain));
};

export const getAccounts = async (
  user: SignedUser
): Promise<AccountsGetResponse> => {
  const access = await listDomainAccess(user.id);
  const own = await ownAccountDomains(user.id, access);
  const viewed = access.filter((domain) => domain.role === "viewer");

  const [receivedStats, sentStats, spamStats, shared, unread] = await Promise.all([
    getAccountStats(user.id, false, own),
    getAccountStats(user.id, true, own),
    getAccountStats(user.id, false, own, true),
    sharedAccounts(viewed),
    getUnreadNotifications([user.id]),
  ]);

  return {
    received: receivedStats.map(toAccount),
    sent: sentStats.map(toAccount),
    spam: spamStats.map(toAccount),
    shared,
    unread_mail_count: unread.get(user.id)?.count ?? 0,
  };
};

// Received accounts that own at least one mail matching `value`. Backs the
// search side-tab: the user types a keyword, this lists the accounts whose mail
// appears in the results, and clicking one jumps to that account's All view.
// Search covers the user's own mail only.
export const searchAccounts = async (
  user: SignedUser,
  value: string
): Promise<Account[]> => {
  value = value.trim();
  if (!value) return [];

  const own = await ownAccountDomains(user.id, await listDomainAccess(user.id));
  const stats = await searchAccountStats(user.id, value, own);

  return stats.map(toAccount);
};
