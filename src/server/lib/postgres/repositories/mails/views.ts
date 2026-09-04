import { IS_SPAM, DRAFT } from "../../models";

/**
 * Which rows each IMAP mailbox contains, and which UID space it enumerates.
 *
 * Two kinds of mailbox reach this repository:
 *
 *  - **Mapped boxes** — the per-account views (`INBOX/accounts/<local-part>`,
 *    `Sent Messages/accounts/<local-part>`) and user-created boxes. Membership
 *    is a row in `mail_mailbox_uid`, which also carries the per-box UID.
 *  - **Domain views** — `INBOX`, the unified `Sent Messages`, and the utility
 *    views below. Membership is a predicate over `mails` and UIDs come from
 *    `mails.uid_domain`. `INBOX` additionally carries a mapping row for every
 *    mail filed into its tree or into one of the utility views, holding that
 *    same `uid_domain`; no read consults it. Those rows are the tree's
 *    *scope*, not its membership — the predicate still applies on top, so a
 *    spam-classified mail holds a row while INBOX excludes it, and un-marking
 *    it restores the mail to INBOX with no row to re-create.
 *
 * The rules live here rather than in `imap.ts` so `counters.ts` can apply the
 * same branch without importing the module that imports it.
 *
 * The box names are duplicated from `imap/util.ts`, which cannot be imported
 * here: that module pulls from the `server` barrel, which re-exports this
 * repository. `views.test.ts` pins the two copies together.
 */

const INBOX_ACCOUNTS_PREFIX = "INBOX/accounts/";

/**
 * The name the INBOX tree's mapping rows are recorded under in
 * `mail_mailbox_uid`. Matched case-insensitively on the way in, per RFC 3501
 * §5.1, and stored in this spelling — the one `canonicalMailbox` produces on
 * the IMAP side.
 */
export const INBOX_VIEW = "INBOX";

/**
 * Flag-derived views over the user's whole domain, mirroring folders the web
 * client already has. Each is one predicate over `mails` — no mapping rows, no
 * backfill — which is also why membership tracks the flag: a mail leaves
 * `Drafts` the moment `\Draft` is cleared, with nothing to keep in sync.
 */
export const DRAFTS_VIEW = "Drafts";
export const JUNK_VIEW = "Junk";

/**
 * A mailbox's membership rule as `column → required value`. One definition
 * renders both ways it is consumed: a SQL fragment for the hand-built IMAP
 * queries, and a filter bag for the `Table` call sites — so the two can't drift.
 */
export type MembershipFilter = Record<string, boolean>;

// A Map, not an object literal: mailbox names are user input, and `"toString"
// in {}` is true — an object lookup would hand a user-created box called
// `constructor` the domain UID space and show it the whole account.
//
// Keyed lowercase and looked up lowercase, because the LIST de-dup in
// `Store.listMailboxesOrThrow` is case-insensitive: `drafts` resolves to no
// listable box, so it must not resolve to a different UID space either.
const UTILITY_VIEW_MEMBERSHIP = new Map<string, MembershipFilter>([
  [DRAFTS_VIEW.toLowerCase(), { [DRAFT]: true }],
  [JUNK_VIEW.toLowerCase(), { [IS_SPAM]: true }],
]);

const utilityMembership = (mailbox: string | null): MembershipFilter | undefined =>
  mailbox === null ? undefined : UTILITY_VIEW_MEMBERSHIP.get(mailbox.toLowerCase());

/** Whether `mailbox` names one of the flag-derived utility views. */
export const isUtilityView = (mailbox: string | null): boolean =>
  utilityMembership(mailbox) !== undefined;

/**
 * Whether a mailbox enumerates `mails.uid_domain` rather than joining
 * `mail_mailbox_uid`. True for the two unnamed domain views (`mailbox === null`)
 * and for the utility views, which carry a name only so their membership rule
 * can be looked up — they hold no mapping rows to join.
 */
export const usesDomainUidSpace = (mailbox: string | null): boolean =>
  mailbox === null || isUtilityView(mailbox);

export const isInboxTree = (mailbox: string | null, sent: boolean): boolean =>
  !sent && (mailbox === null || mailbox.startsWith(INBOX_ACCOUNTS_PREFIX));

/**
 * The domain view a write into `destination` records a mapping row under, or
 * `undefined` when the destination claims no INBOX scope. `destination` is the
 * box the write names — the wire box of an IMAP `COPY` / `MOVE` / `APPEND`,
 * and the per-account view of an SMTP delivery. Whether the row may hold that
 * membership is `decideMappingWrites`' question, not this one's.
 *
 * The utility views scope to INBOX alongside the tree: they hold an ordinary
 * received-lane row in the user's own domain space, claim no mapping row of
 * their own, and select it by a flag the client can clear at any time — so an
 * `APPEND Junk` followed by "not spam", or an `APPEND Drafts` followed by
 * `STORE -FLAGS (\Draft)`, has to land the mail in INBOX. Without the scope
 * row it would land in no mailbox at all.
 *
 * `Starred` and `Trash` are mapped boxes holding a distinct clone, and are
 * deliberately left unscoped rather than settled: a COPY leaves the original
 * in INBOX carrying its own row, so scoping the clone too would be the
 * over-counting this rule exists to close. A MOVE leaves no original, so a
 * clone whose last mapped pivot is later dropped — an un-star, or a Trash
 * `STORE -FLAGS (\Deleted)` — ends up holding no mapping row of any kind. It
 * stays in INBOX today only because INBOX still selects by predicate; a read
 * that selects on the mapping table has to give that row a home first.
 *
 * The read-side twin for the tree is `isInboxTree`, which decides which boxes
 * apply the INBOX predicate; it spells the unified view `null` because a domain
 * view has no name to select on, and a mapping row does, so this one takes a
 * string. The utility views sit outside that pairing — their own read applies a
 * flag predicate, not INBOX's.
 */
export const domainViewForDestination = (destination: string): string | undefined =>
  destination.toUpperCase() === INBOX_VIEW ||
  destination.startsWith(INBOX_ACCOUNTS_PREFIX) ||
  isUtilityView(destination)
    ? INBOX_VIEW
    : undefined;

export const membershipFilter = (
  mailbox: string | null,
  sent: boolean
): MembershipFilter => {
  const utility = utilityMembership(mailbox);
  // Copied, not returned by reference: this module is public through the
  // `server` barrel, and the entries are the view definitions themselves.
  if (utility) return { ...utility };
  if (isInboxTree(mailbox, sent)) return { [IS_SPAM]: false, [DRAFT]: false };
  return {};
};

export const membershipExpression = (
  mailbox: string | null,
  sent: boolean,
  prefix: string = ""
): string => {
  const terms = Object.entries(membershipFilter(mailbox, sent)).map(
    ([column, value]) => `${prefix}${column} = ${value ? "TRUE" : "FALSE"}`
  );
  return terms.length > 0 ? terms.join(" AND ") : "TRUE";
};

/**
 * The same rule as a suffix for an existing `WHERE`, empty when the box filters
 * nothing so it appends cleanly to any clause.
 */
export const membershipCondition = (
  mailbox: string | null,
  sent: boolean,
  prefix: string = ""
): string => {
  const expression = membershipExpression(mailbox, sent, prefix);
  return expression === "TRUE" ? "" : ` AND ${expression}`;
};
