/**
 * Every SQL statement the HTTP mail reads issue, built with no pool involved
 * so the emitted string and its bound parameters can be asserted directly.
 *
 * ```ts
 * const { sql, values } = buildMailHeadersQuery(user_id, address, options);
 * const result = await pool.query(sql, values);
 * ```
 */
import { ParamValue } from "../../database";
import { mailInDomainsCondition, scopeToDomains } from "./domain-scope";
import {
  MESSAGE_ID,
  IN_REPLY_TO,
  REFERENCE_IDS,
  MAIL_ID,
  USER_ID,
  READ,
  SAVED,
  TO_ADDRESS,
  FROM_ADDRESS,
  SUBJECT,
  DATE,
  FROM_TEXT,
  TO_TEXT,
  CC_ADDRESS,
  CC_TEXT,
  BCC_ADDRESS,
  BCC_TEXT,
  ENVELOPE_TO,
  SENT,
  IS_SPAM,
  INSIGHT,
  TEXT,
} from "../../models";

export interface GetMailHeadersOptions {
  sent: boolean;
  saved: boolean;
  // Restrict to spam-flagged received mail. Spam is a per-account folder like
  // received/sent, so it rides the same address-scoped query path.
  spam?: boolean;
  /** Only the mail of these of the owner's domains (`mailInDomainsCondition`). */
  domains?: string[];
  from?: number;
  size?: number;
  since?: string;
  after?: ListCursor;
}

/**
 * The sort keys of the row a page ended on, in newest-first order. The next
 * page starts strictly after it, so mail arriving or changing between page
 * loads never shifts the rows still to come the way an offset would. Both
 * keys are immutable, so a mail never moves across the cursor.
 */
export interface ListCursor {
  date: string;
  id: string;
}

/**
 * Selected by a paged list query: the id, plus the exact sort keys the next
 * cursor is built from. `date` is read as text so the cursor keeps the
 * column's microseconds, which a JS Date would round away.
 */
export const LIST_CURSOR_COLUMNS = `${MAIL_ID}, ${DATE}::text AS cursor_date`;

export const buildHeaderAddressCondition = (
  options: Pick<GetMailHeadersOptions, "sent" | "saved">
): string => {
  const sentCondition = `${FROM_ADDRESS} @> $2::jsonb`;
  const receivedCondition = `(${TO_ADDRESS} @> $2::jsonb OR cc_address @> $2::jsonb OR bcc_address @> $2::jsonb OR envelope_to @> $2::jsonb)`;
  return options.saved && !options.sent
    ? `(${sentCondition} OR ${receivedCondition})`
    : options.sent
    ? sentCondition
    : receivedCondition;
};

// Seconds the delta cursor lags real time. `as_of` is backed off by this
// margin so a row mutated just before the read — the commit-latency window (a
// txn whose CURRENT_TIMESTAMP precedes our now() but commits after our SELECT),
// or one stamped under bounded app/DB clock skew — is re-sent on the NEXT call
// rather than skipped forever. Re-sends are deduped client-side by mail_id, so
// the cost is a small overlap, not duplicates. Must exceed expected commit
// latency + clock skew (NTP keeps the latter well under a second).
const DELTA_CURSOR_SAFETY_MARGIN_SECONDS = 2;

const RECEIVED_ADDRESS_EXPANSION = `jsonb_array_elements(
  COALESCE(to_address, '[]'::jsonb) ||
  COALESCE(cc_address, '[]'::jsonb) ||
  COALESCE(bcc_address, '[]'::jsonb) ||
  COALESCE(envelope_to, '[]'::jsonb)
)->>'address' as address`;
// The lower-cased domain part of the `address` an expansion produced.
const ADDRESS_DOMAIN = `lower(regexp_replace(address, '^.*@', ''))`;

const RECEIVED_ADDRESS_NOT_NULL = `(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL OR envelope_to IS NOT NULL)`;

// Select only columns needed for mail headers — excludes html/attachments
// and full text bodies to avoid loading them into memory for every
// concurrent request. The one exception is a bounded prefix of the plain
// text body, which the list snippet is built from (design doc §5); it is
// capped at 400 chars so the headers payload stays small. Shared by the
// per-account list, the unified list and search, so the three views can
// never drift apart on a column a list row (or its conversation grouping)
// needs.
const headerColumns = [
  MAIL_ID, USER_ID, SUBJECT, DATE,
  FROM_ADDRESS, FROM_TEXT,
  TO_ADDRESS, TO_TEXT,
  CC_ADDRESS, CC_TEXT,
  BCC_ADDRESS, BCC_TEXT,
  // The envelope recipient the received condition also matches on: without
  // this column the client cannot tell which account an envelope-only (BCC)
  // delivery belongs to and falls back to the parked account.
  ENVELOPE_TO,
  READ, SAVED, SENT, IS_SPAM, INSIGHT,
  `left(${TEXT}, 400) AS text_prefix`,
  // Threading ids, so the list can group a folder into conversations.
  // References keeps its first entry (usually the conversation's root) and
  // its last two (the messages it answers): enough to link a message to
  // the ones before it without sending the whole chain on every row.
  MESSAGE_ID, IN_REPLY_TO,
  `CASE WHEN jsonb_array_length(${REFERENCE_IDS}) > 3
    THEN jsonb_build_array(${REFERENCE_IDS}->0, ${REFERENCE_IDS}->-2, ${REFERENCE_IDS}->-1)
    ELSE ${REFERENCE_IDS} END AS ${REFERENCE_IDS}`,
].join(", ");

/**
 * Header rows for `ids`, in no particular order. The batch half of the full
 * list fetch: the list query picks and orders the ids, this reads their
 * headers a bounded batch at a time.
 */
export const buildMailHeadersByIdsQuery = (
  user_id: string,
  ids: string[]
): { sql: string; values: ParamValue[] } => ({
  sql: `
    SELECT ${headerColumns} FROM mails
    WHERE user_id = $1
      AND ${MAIL_ID} = ANY($2::uuid[])
      AND expunged = FALSE
  `,
  values: [user_id, ids],
});

export const buildMailHeadersQuery = (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions,
  columns = headerColumns
): { sql: string; values: ParamValue[] } => {
  const addressJson = JSON.stringify([{ address }]);
  const addressCondition = buildHeaderAddressCondition(options);
  let sql = `
    SELECT ${columns} FROM mails 
    WHERE user_id = $1 
      AND ${addressCondition}
      AND expunged = FALSE
      AND draft = FALSE
  `;
  const values: ParamValue[] = [user_id, addressJson];
  let paramIdx = 3;

  if (options.saved) {
    sql += ` AND saved = TRUE`;
  }

  if (options.spam) {
    // Spam mail is always received, never sent — matches the (sent = FALSE)
    // guard the standalone spam query carried before spam became per-account.
    sql += ` AND is_spam = TRUE AND sent = FALSE`;
  } else {
    // Every non-spam view (New / All / Saved / Sent) is the complement of the
    // spam folder: a mail flagged spam — whether auto-classified on receipt or
    // marked by the user via /spam/mark — belongs only in the spam folder, not
    // here. Without this the "Mark as spam" action is cosmetic: the row would
    // reappear on the next refetch because the inbox query still returned it.
    sql += ` AND is_spam = FALSE`;
  }

  if (options.domains !== undefined) {
    sql += ` AND ${mailInDomainsCondition(paramIdx++)}`;
    values.push(options.domains);
  }

  if (options.since !== undefined) {
    sql += ` AND updated > $${paramIdx++}`;
    values.push(options.since);
  }

  if (options.after) {
    sql += ` AND (date, mail_id) < ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`;
    values.push(options.after.date, options.after.id);
    paramIdx += 2;
  }

  sql += ` ORDER BY date DESC, mail_id DESC`;

  if (options.size !== undefined) {
    sql += ` LIMIT $${paramIdx++}`;
    values.push(options.size);
  }

  if (options.from !== undefined) {
    sql += ` OFFSET $${paramIdx}`;
    values.push(options.from);
  }
  return { sql, values };
};

/**
 * One page of a folder's ids: `limit` rows after `options.after`, plus one
 * more so the caller can tell whether another page follows.
 */
export const buildMailHeaderIdPageQuery = (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions,
  limit: number
): { sql: string; values: ParamValue[] } =>
  buildMailHeadersQuery(
    user_id,
    address,
    { ...options, from: undefined, size: limit + 1 },
    LIST_CURSOR_COLUMNS
  );

export const buildDeltaAsOfQuery = (): {
  sql: string;
  values: ParamValue[];
} => ({
  sql: "SELECT now() - make_interval(secs => $1) AS as_of",
  values: [DELTA_CURSOR_SAFETY_MARGIN_SECONDS],
});

export const buildDeltaEvictionQuery = (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions,
  since: string
): { sql: string; values: ParamValue[] } => {
  const addressJson = JSON.stringify([{ address }]);
  const addressCondition = buildHeaderAddressCondition(options);
  // A row leaves the spam folder either by expunge OR by being un-marked
  // (is_spam flips to FALSE); both must tombstone so a cached client evicts
  // it. A non-spam view is the mirror: a row leaves it on expunge OR by being
  // marked spam (is_spam flips to TRUE), so a delta-sync client evicts a mail
  // the user just moved to the spam folder instead of leaving it cached.
  const evictionCondition = options.spam
    ? `(expunged = TRUE OR is_spam = FALSE)`
    : `(expunged = TRUE OR is_spam = TRUE)`;
  const expungedSql = `
      SELECT ${MAIL_ID} FROM mails
      WHERE user_id = $1
        AND ${addressCondition}
        AND ${evictionCondition}
        AND updated > $3
    `;
  return scopeToDomains(expungedSql, [user_id, addressJson, since], options.domains);
};

/** Paging / cursor options for the unified list. The unified view is the All
 * Mails view only — received mail across accounts — so it takes no
 * sent/saved/spam variant: those folders stay per-account. */
export interface UnifiedMailHeadersOptions {
  from?: number;
  size?: number;
  since?: string;
  /** Newest first, as the client shows the list, instead of unread first. A
   * paged list needs it: under unread-first a partial list would leave out
   * read mail newer than the unread mail it holds. */
  newestFirst?: boolean;
  /** Only with `newestFirst`: start after this position. */
  after?: ListCursor;
}

/**
 * The cross-account ("All accounts") list condition: a mail belongs to the
 * unified view when any of its recipient headers names one of the user's
 * receiving addresses. The union of the per-account All Mails views — a mail
 * the user sent to someone else is out, a mail they sent to themselves is in
 * (their own address is a recipient). An empty address set matches nothing,
 * so a user with no received mail gets an empty list rather than an error.
 *
 * The addresses are bound as one text[]: Postgres hashes a large `= ANY`
 * array, so each recipient costs one lookup, where a jsonb `@> ANY` probes
 * every address against every column of every row.
 */
export const buildUnifiedAddressCondition = (paramIndex = 2): string =>
  `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${TO_ADDRESS}, '[]'::jsonb) || COALESCE(cc_address, '[]'::jsonb) || COALESCE(bcc_address, '[]'::jsonb) || COALESCE(envelope_to, '[]'::jsonb)) AS recipient WHERE recipient->>'address' = ANY($${paramIndex}::text[]))`;

export const buildUnifiedMailHeadersQuery = (
  user_id: string,
  addresses: string[],
  options: UnifiedMailHeadersOptions,
  columns = headerColumns
): { sql: string; values: ParamValue[] } => {
  const addressCondition = buildUnifiedAddressCondition();
  let sql = `
    SELECT ${columns} FROM mails 
    WHERE user_id = $1 
      AND ${addressCondition}
      AND expunged = FALSE
      AND draft = FALSE
      AND is_spam = FALSE
  `;
  const values: ParamValue[] = [user_id, addresses];
  let paramIdx = 3;

  if (options.since !== undefined) {
    sql += ` AND updated > $${paramIdx++}`;
    values.push(options.since);
  }

  if (options.newestFirst) {
    if (options.after) {
      sql += ` AND (date, mail_id) < ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`;
      values.push(options.after.date, options.after.id);
      paramIdx += 2;
    }
    sql += ` ORDER BY date DESC, mail_id DESC`;
  } else {
    // Unread-then-recent (design doc §8): unread mail first, newest first
    // within each read state — the per-account list is date-only.
    sql += ` ORDER BY read ASC, date DESC`;
  }

  if (options.size !== undefined) {
    sql += ` LIMIT $${paramIdx++}`;
    values.push(options.size);
  }

  if (options.from !== undefined) {
    sql += ` OFFSET $${paramIdx}`;
    values.push(options.from);
  }
  return { sql, values };
};

/** The unified list's `buildMailHeaderIdPageQuery`, newest first like the client shows it. */
export const buildUnifiedMailHeaderIdPageQuery = (
  user_id: string,
  addresses: string[],
  options: UnifiedMailHeadersOptions,
  limit: number
): { sql: string; values: ParamValue[] } =>
  buildUnifiedMailHeadersQuery(
    user_id,
    addresses,
    { ...options, newestFirst: true, from: undefined, size: limit + 1 },
    LIST_CURSOR_COLUMNS
  );

export const buildUnifiedDeltaEvictionQuery = (
  user_id: string,
  addresses: string[],
  since: string
): { sql: string; values: ParamValue[] } => {
  const addressCondition = buildUnifiedAddressCondition();
  // The unified view is a non-spam view: a row leaves it on expunge OR by
  // being marked spam, mirroring the per-account eviction's non-spam branch.
  const expungedSql = `
      SELECT ${MAIL_ID} FROM mails
      WHERE user_id = $1
        AND ${addressCondition}
        AND (expunged = TRUE OR is_spam = TRUE)
        AND updated > $3
    `;
  return { sql: expungedSql, values: [user_id, addresses, since] };
};

export const buildSearchMailsQuery = (
  user_id: string,
  searchTerm: string
): { sql: string; values: ParamValue[] } => {
  // Use PostgreSQL full-text search with ranking and highlights
  const sql = `
      SELECT 
        ${headerColumns},
        ts_rank(search_vector, plainto_tsquery('english', $2)) as rank,
        ts_headline('english', subject, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as subject_highlight,
        ts_headline('english', text, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as text_highlight
      FROM mails
      WHERE user_id = $1
        AND search_vector @@ plainto_tsquery('english', $2)
        AND expunged = FALSE
        -- Drafts belong to the IMAP Drafts folder, not the search results;
        -- mirrors the draft filter on getMailHeaders / getAccountStats so a
        -- draft never surfaces in a view (search) that no folder/count shows.
        AND draft = FALSE
      ORDER BY rank DESC, date DESC
      LIMIT 1000
    `;
  return { sql, values: [user_id, searchTerm] };
};

/**
 * The accounts (addresses) a store holds mail for, with their counts.
 *
 * `domainFilter` keeps the addresses on those domains, so the external
 * correspondents a mail names are not listed as accounts. `scopeDomains`
 * keeps only the mail of those domains (`mailInDomainsCondition`), for a
 * viewer reading one domain of the owner's.
 */
export const buildAccountStatsQuery = (
  user_id: string,
  sent: boolean,
  domainFilter: string[] | undefined,
  spamOnly: boolean,
  scopeDomains?: string[]
): { sql: string; values: ParamValue[] } => {
  const useSentExpansion = sent && !spamOnly;

  const addressExpansion = useSentExpansion
    ? `jsonb_array_elements(from_address)->>'address' as address`
    : RECEIVED_ADDRESS_EXPANSION;

  const addressNotNull = useSentExpansion
    ? `from_address IS NOT NULL`
    : RECEIVED_ADDRESS_NOT_NULL;

  // Match the per-account spam-folder query (is_spam received mail only).
  // Spam is a separate per-account folder: the spam view counts only is_spam
  // received mail; every other view (received/sent counts + New badge) is its
  // complement and must exclude is_spam, so the sidebar count matches the
  // spam-excluding headers list rather than over-counting by the spam total.
  const spamCondition = spamOnly
    ? `AND is_spam = TRUE AND sent = FALSE`
    : `AND is_spam = FALSE`;

  // Use address matching (from_address for sent, to/cc/bcc for received) rather
  // than the `sent` boolean flag, so self-emails appear in both views correctly.
  const values: ParamValue[] = [user_id];
  const domainCondition = domainFilter
    ? `AND ${ADDRESS_DOMAIN} = ANY($${values.push(domainFilter)}::text[])`
    : "";
  const scopeCondition = scopeDomains
    ? `AND ${mailInDomainsCondition(values.push(scopeDomains))}`
    : "";

  // DISTINCT collapses rows where the same address appears more than once in
  // a single mail's recipient/sender list (e.g. LinkedIn duplicates the To
  // header), so each mail contributes once per address it actually involves.
  // The draft filter mirrors getMailHeaders so per-account badge counts match
  // the headers list view (drafts belong to the IMAP Drafts folder, not to
  // the per-account inbox view).
  const sql = `
      WITH expanded_mails AS (
        SELECT DISTINCT
          mail_id, read, saved, date,
          ${addressExpansion}
        FROM mails
        WHERE user_id = $1
          AND expunged = FALSE
          AND draft = FALSE
          ${spamCondition}
          AND ${addressNotNull}
          ${scopeCondition}
      )
      SELECT
        address,
        COUNT(*) as count,
        SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN saved = TRUE THEN 1 ELSE 0 END) as saved_count,
        MAX(date) as latest
      FROM expanded_mails
      WHERE address IS NOT NULL
      ${domainCondition}
      GROUP BY address
      ORDER BY latest DESC
    `;
  return { sql, values };
};

export const buildSearchAccountStatsQuery = (
  user_id: string,
  searchTerm: string,
  domainFilter?: string[]
): { sql: string; values: ParamValue[] } => {
  const domainCondition = domainFilter ? `AND ${ADDRESS_DOMAIN} = ANY($3::text[])` : "";
  const sql = `
      WITH expanded_mails AS (
        SELECT DISTINCT
          mail_id, read, saved, date,
          ${RECEIVED_ADDRESS_EXPANSION}
        FROM mails
        WHERE user_id = $1
          AND expunged = FALSE
          AND draft = FALSE
          AND ${RECEIVED_ADDRESS_NOT_NULL}
          AND search_vector @@ plainto_tsquery('english', $2)
      )
      SELECT
        address,
        COUNT(*) as count,
        SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN saved = TRUE THEN 1 ELSE 0 END) as saved_count,
        MAX(date) as latest
      FROM expanded_mails
      WHERE address IS NOT NULL
      ${domainCondition}
      GROUP BY address
      ORDER BY latest DESC
    `;
  const values: ParamValue[] = domainFilter
    ? [user_id, searchTerm, domainFilter]
    : [user_id, searchTerm];
  return { sql, values };
};

// The empty-list guard lives at the call site: an empty placeholder list
// renders `IN ()`, which Postgres rejects.
export const buildUnreadNotificationsQuery = (
  user_ids: string[]
): { sql: string; values: ParamValue[] } => {
  const placeholders = user_ids.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `
      SELECT 
        user_id,
        COUNT(*) FILTER (WHERE read = FALSE) as unread_count,
        -- ingested, not date or updated: date is the sender's Date header, so a
        -- backdated mail would never cross the push gate's wall-clock
        -- lastNotified; updated moves on every read, flag or spam write.
        MAX(ingested) as latest
      FROM mails
      -- draft = FALSE: a user's own unsent draft must not ring the new-mail
      -- push badge. Mirrors getMailHeaders / getAccountStats so the badge count
      -- matches the headers list view (drafts live in the Drafts folder).
      -- is_spam = FALSE: spam is quarantined to the spam folder, so it must not
      -- ring the new-mail badge either (same mirror — the New view excludes it).
      WHERE user_id IN (${placeholders}) AND sent = FALSE AND is_spam = FALSE AND expunged = FALSE AND draft = FALSE
      GROUP BY user_id
    `;
  return { sql, values: user_ids };
};
