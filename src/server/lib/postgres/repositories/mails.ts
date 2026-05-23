import crypto from "crypto";
import { logger } from "../../logger";
import { pool } from "../client";
import { ParamValue } from "../database";
import {
  MailModel,
  PartialMailModel,
  mailsTable,
  MAIL_ID,
  USER_ID,
  READ,
  SAVED,
  UID_DOMAIN,
  UID_ACCOUNT,
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
  SENT,
  INSIGHT,
  ENVELOPE_TO,
  DELETED,
  EXPUNGED,
} from "../models";

/**
 * Represents the subset of mail fields returned by getMailHeaders.
 * This is a partial view that excludes body fields (html, text, attachments, etc.)
 * for performance reasons.
 */
export interface MailHeaderResult {
  mail_id: string;
  user_id: string;
  subject: string;
  date: string;
  from_address: object | null;
  from_text: string | null;
  to_address: object | null;
  to_text: string | null;
  cc_address: object | null;
  cc_text: string | null;
  bcc_address: object | null;
  bcc_text: string | null;
  read: boolean;
  saved: boolean;
  sent: boolean;
  insight: object | null;
}

export interface SaveMailInput {
  user_id: string;
  message_id: string;
  subject?: string;
  date?: string;
  html?: string;
  text?: string;
  from_address?: object | null;
  from_text?: string | null;
  to_address?: object | null;
  to_text?: string | null;
  cc_address?: object | null;
  cc_text?: string | null;
  bcc_address?: object | null;
  bcc_text?: string | null;
  reply_to_address?: object | null;
  reply_to_text?: string | null;
  envelope_from?: object | null;
  envelope_to?: object | null;
  attachments?: object | null;
  read?: boolean;
  saved?: boolean;
  sent?: boolean;
  deleted?: boolean;
  draft?: boolean;
  answered?: boolean;
  expunged?: boolean;
  insight?: object | null;
  uid_domain?: number;
  uid_account?: number;
  spam_score?: number;
  spam_reasons?: string[] | null;
  is_spam?: boolean;
}

export const saveMail = async (
  input: SaveMailInput
): Promise<{ _id: string } | undefined> => {
  try {
    const mail_id = crypto.randomUUID();
    const data: Record<string, ParamValue | object | null> = {
      mail_id,
      user_id: input.user_id,
      message_id: input.message_id,
      subject: input.subject ?? "",
      date: input.date ?? new Date().toISOString(),
      html: input.html ?? "",
      text: input.text ?? "",
      from_address: input.from_address ? JSON.stringify(input.from_address) : null,
      from_text: input.from_text ?? null,
      to_address: input.to_address ? JSON.stringify(input.to_address) : null,
      to_text: input.to_text ?? null,
      cc_address: input.cc_address ? JSON.stringify(input.cc_address) : null,
      cc_text: input.cc_text ?? null,
      bcc_address: input.bcc_address ? JSON.stringify(input.bcc_address) : null,
      bcc_text: input.bcc_text ?? null,
      reply_to_address: input.reply_to_address
        ? JSON.stringify(input.reply_to_address)
        : null,
      reply_to_text: input.reply_to_text ?? null,
      envelope_from: input.envelope_from
        ? JSON.stringify(input.envelope_from)
        : null,
      envelope_to: input.envelope_to ? JSON.stringify(input.envelope_to) : null,
      attachments: input.attachments ? JSON.stringify(input.attachments) : null,
      read: input.read ?? false,
      saved: input.saved ?? false,
      sent: input.sent ?? false,
      deleted: input.deleted ?? false,
      draft: input.draft ?? false,
      answered: input.answered ?? false,
      expunged: input.expunged ?? false,
      insight: input.insight ? JSON.stringify(input.insight) : null,
      uid_domain: input.uid_domain ?? 0,
      uid_account: input.uid_account ?? 0,
      spam_score: input.spam_score ?? 0,
      spam_reasons: input.spam_reasons ? JSON.stringify(input.spam_reasons) : null,
      is_spam: input.is_spam ?? false,
    };

    const row = await mailsTable.insert(data, [MAIL_ID]);
    if (row) return { _id: row[MAIL_ID] as string };
    return undefined;
  } catch (error: unknown) {
    // Unique constraint violation on (user_id, message_id):
    // This can happen legitimately when one email is delivered to multiple accounts
    // (e.g. account1@inbox.app, account2@inbox.app). The sender uses separate
    // envelopes, but the message_id is the same. In that case we must merge the
    // envelope_to values so we can correctly identify BCC recipients later.
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      const existing = await getMailByMessageId(input.user_id, input.message_id);
      if (!existing) return undefined;

      if (input.envelope_to) {
        type AddressEntry = { address?: string };
        const existingTo = (existing.envelope_to as AddressEntry[] | null) ?? [];
        const incomingTo = input.envelope_to as AddressEntry[];
        const seen = new Set(existingTo.map((a) => a.address));
        const merged = [
          ...existingTo,
          ...incomingTo.filter((a) => !seen.has(a.address)),
        ];
        await mailsTable.updateWhere(
          { user_id: input.user_id, message_id: input.message_id },
          { [ENVELOPE_TO]: JSON.stringify(merged) }
        );
      }

      return { _id: existing.mail_id };
    }

    logger.error("Failed to save mail", {}, error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
};

/**
 * Get a mail by user_id and message_id.
 * Used to find existing mail when a conflict occurs.
 */
export const getMailByMessageId = async (
  user_id: string,
  message_id: string
): Promise<MailModel | undefined> => {
  const result = await mailsTable.query({ user_id, message_id });
  return result[0];
};

export const getMailById = async (
  user_id: string,
  mail_id: string
): Promise<MailModel | null> => {
  try {
    return await mailsTable.queryOne({ [MAIL_ID]: mail_id, [USER_ID]: user_id });
  } catch (error) {
    logger.error("Failed to get mail by ID", {}, error);
    return null;
  }
};

export const markMailRead = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  try {
    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: mail_id, [USER_ID]: user_id },
      { read: true, updated: new Date() },
      [MAIL_ID]
    );
    return rows.length > 0;
  } catch (error) {
    logger.error("Failed to mark mail as read", {}, error);
    return false;
  }
};

export const markMailSaved = async (
  user_id: string,
  mail_id: string,
  saved: boolean
): Promise<boolean> => {
  try {
    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: mail_id, [USER_ID]: user_id },
      { saved, updated: new Date() },
      [MAIL_ID]
    );
    return rows.length > 0;
  } catch (error) {
    logger.error("Failed to mark mail as saved", {}, error);
    return false;
  }
};

export const deleteMail = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  try {
    const count = await mailsTable.deleteWhere({
      [MAIL_ID]: mail_id,
      [USER_ID]: user_id
    });
    return count > 0;
  } catch (error) {
    logger.error("Failed to delete mail", {}, error);
    return false;
  }
};

export interface GetMailHeadersOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  from?: number;
  size?: number;
}

export const getMailHeaders = async (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions
): Promise<MailHeaderResult[]> => {
  try {
    const addressJson = JSON.stringify([{ address }]);
    // Detect sent/received by address matching, not the `sent` flag.
    // For sent mails, check from_address only.
    // For received mails, check to_address, cc_address, bcc_address AND
    // envelope_to. `envelope_to` is the SMTP-level delivery address that
    // can differ from MIME to/cc/bcc when a sender uses listserv-style
    // routing (e.g. GitHub notifications). Without it, mails surfaced
    // under an envelope_to-only account in getAccountStats wouldn't have
    // any rows when the user clicks through. Mirrors getAccountStats's
    // address expansion below.
    const addressCondition = options.sent
      ? `${FROM_ADDRESS} @> $2::jsonb`
      : `(${TO_ADDRESS} @> $2::jsonb OR cc_address @> $2::jsonb OR bcc_address @> $2::jsonb OR envelope_to @> $2::jsonb)`;
    // Select only columns needed for mail headers — excludes html/text/attachments
    // to avoid loading full email bodies into memory for every concurrent request.
    const headerColumns = [
      MAIL_ID, USER_ID, SUBJECT, DATE,
      FROM_ADDRESS, FROM_TEXT,
      TO_ADDRESS, TO_TEXT,
      CC_ADDRESS, CC_TEXT,
      BCC_ADDRESS, BCC_TEXT,
      READ, SAVED, SENT, INSIGHT,
    ].join(", ");
    let sql = `
      SELECT ${headerColumns} FROM mails 
      WHERE user_id = $1 
        AND ${addressCondition}
        AND expunged = FALSE
        AND draft = FALSE
    `;
    const values: ParamValue[] = [user_id, addressJson];
    let paramIdx = 3;

    if (options.new) {
      sql += ` AND read = FALSE`;
    } else if (options.saved) {
      sql += ` AND saved = TRUE`;
    }

    sql += ` ORDER BY date DESC`;

    if (options.size !== undefined) {
      sql += ` LIMIT $${paramIdx++}`;
      values.push(options.size);
    }

    if (options.from !== undefined) {
      sql += ` OFFSET $${paramIdx}`;
      values.push(options.from);
    }

    const result = await pool.query(sql, values);
    return result.rows as MailHeaderResult[];
  } catch (error) {
    logger.error("Failed to get mail headers", {}, error);
    return [];
  }
};

export interface SearchMailModel extends MailModel {
  highlight?: {
    subject?: string[];
    text?: string[];
  };
  rank?: number;
}

export const searchMails = async (
  user_id: string,
  searchTerm: string,
  _field?: string
): Promise<SearchMailModel[]> => {
  try {
    // Use PostgreSQL full-text search with ranking and highlights
    const sql = `
      SELECT 
        *,
        ts_rank(search_vector, plainto_tsquery('english', $2)) as rank,
        ts_headline('english', subject, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as subject_highlight,
        ts_headline('english', text, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as text_highlight
      FROM mails 
      WHERE user_id = $1 
        AND search_vector @@ plainto_tsquery('english', $2)
        AND expunged = FALSE
      ORDER BY rank DESC, date DESC
      LIMIT 1000
    `;

    interface SearchRow {
      rank: number;
      subject_highlight: string;
      text_highlight: string;
      [key: string]: unknown;
    }
    const result = await pool.query(sql, [user_id, searchTerm]);
    return result.rows.map((row: SearchRow) => {
      const model = new MailModel(row) as SearchMailModel;
      model.rank = row.rank;
      model.highlight = {};
      if (row.subject_highlight && row.subject_highlight.includes("<em>")) {
        model.highlight.subject = [row.subject_highlight];
      }
      if (row.text_highlight && row.text_highlight.includes("<em>")) {
        model.highlight.text = [row.text_highlight];
      }
      return model;
    });
  } catch (error) {
    logger.error("Failed to search mails", {}, error);
    return [];
  }
};

export const getDomainUidNext = async (
  user_id: string,
  sent: boolean = false
): Promise<number> => {
  try {
    const sql = `
      SELECT COALESCE(MAX(${UID_DOMAIN}), 0) + 1 AS next_uid FROM mails
      WHERE user_id = $1 AND sent = $2
    `;
    const result = await pool.query(sql, [user_id, sent]);
    return parseInt(result.rows[0]?.next_uid || "1", 10);
  } catch (error) {
    logger.error("Error getting next UID", {}, error);
    return 1;
  }
};

export const getAccountUidNext = async (
  user_id: string,
  account: string,
  sent: boolean = false
): Promise<number> => {
  try {
    const addressJson = JSON.stringify([{ address: account }]);
    // For sent mails, check from_address only
    // For received mails, check to_address, cc_address, and bcc_address
    const addressCondition = sent
      ? `${FROM_ADDRESS} @> $2::jsonb`
      : `(${TO_ADDRESS} @> $2::jsonb OR cc_address @> $2::jsonb OR bcc_address @> $2::jsonb)`;
    const sql = `
      SELECT COALESCE(MAX(${UID_ACCOUNT}), 0) + 1 AS next_uid FROM mails
      WHERE user_id = $1
        AND ${addressCondition}
        AND sent = $3
    `;
    const result = await pool.query(sql, [user_id, addressJson, sent]);
    return parseInt(result.rows[0]?.next_uid || "1", 10);
  } catch (error) {
    logger.error("Error getting account UID next", {}, error);
    return 1;
  }
};

export const getAccountStats = async (
  user_id: string,
  sent: boolean,
  domainFilter?: string
): Promise<
  {
    address: string;
    count: number;
    unread: number;
    saved: number;
    latest: Date;
  }[]
> => {
  try {
    // For sent mails, only look at from_address.
    // For received mails, union to_address + cc_address + bcc_address AND
    // envelope_to. `envelope_to` is the SMTP-level delivery address, which
    // can differ from MIME to/cc/bcc when a sender uses listserv-style
    // routing (e.g. GitHub notifications: MIME `to_text` =
    // `"hoiekim/budget" <budget@noreply.github.com>`, envelope_to =
    // `<sub-addr>@hoie.kim`). Without including envelope_to, mails
    // delivered via sub-addressing don't surface in the per-account
    // received view at all — but the push badge counts them, causing
    // FE shows 0 / badge shows N.
    const addressExpansion = sent
      ? `jsonb_array_elements(from_address)->>'address' as address`
      : `jsonb_array_elements(
          COALESCE(to_address, '[]'::jsonb) ||
          COALESCE(cc_address, '[]'::jsonb) ||
          COALESCE(bcc_address, '[]'::jsonb) ||
          COALESCE(envelope_to, '[]'::jsonb)
        )->>'address' as address`;

    const addressNotNull = sent
      ? `from_address IS NOT NULL`
      : `(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL OR envelope_to IS NOT NULL)`;

    // Use address matching (from_address for sent, to/cc/bcc for received) rather
    // than the `sent` boolean flag, so self-emails appear in both views correctly.
    const domainCondition = domainFilter
      ? `AND address ILIKE '%@' || $2`
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
          AND ${addressNotNull}
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
      ? [user_id, domainFilter]
      : [user_id];
    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      address: row.address as string,
      count: parseInt(row.count as string, 10),
      unread: parseInt(row.unread as string, 10),
      saved: parseInt(row.saved_count as string, 10),
      latest: new Date(row.latest as string),
    }));
  } catch (error) {
    logger.error("Failed to get account stats", {}, error);
    return [];
  }
};

export const countMessages = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<{ total: number; unread: number; maxUid: number }> => {
  try {
    let sql: string;
    let values: ParamValue[];
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    if (account === null) {
      // Domain-wide count (exclude expunged messages)
      sql = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
          COALESCE(MAX(${uidField}), 0) as max_uid
        FROM mails 
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
      `;
      values = [user_id, sent];
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      sql = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
          COALESCE(MAX(${uidField}), 0) as max_uid
        FROM mails 
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE
      `;
      values = [user_id, sent, addressJson];
    }

    const result = await pool.query(sql, values);
    return {
      total: parseInt(result.rows[0]?.total || "0", 10),
      unread: parseInt(result.rows[0]?.unread || "0", 10),
      maxUid: parseInt(result.rows[0]?.max_uid || "0", 10),
    };
  } catch (error) {
    logger.error("Failed to count messages", {}, error);
    return { total: 0, unread: 0, maxUid: 0 };
  }
};

export const getMailsByRange = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[] = ["*"]
): Promise<Map<string, PartialMailModel>> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    // Validate and resolve the field list.
    // "*" expands to all valid MailModel columns; otherwise each field is validated.
    const isSelectAll = fields.length === 1 && fields[0] === "*";
    const resolvedFields = isSelectAll
      ? [...PartialMailModel.validFields]
      : fields;
    // Validate field names up-front so bad requests fail fast
    const unknownFields = resolvedFields.filter(
      (f) => !PartialMailModel.validFields.has(f)
    );
    if (unknownFields.length > 0) {
      logger.warn("getMailsByRange: unknown fields requested", {
        unknownFields,
      });
    }
    const safeFields = resolvedFields.filter((f) =>
      PartialMailModel.validFields.has(f)
    );
    // Always include mail_id — it is the Map key; without it all rows collapse to key=undefined
    if (!safeFields.includes("mail_id")) {
      safeFields.unshift("mail_id");
    }
    const fieldList = safeFields.length > 0 ? safeFields.join(", ") : "*";

    if (account === null) {
      // Domain-wide query (exclude expunged messages)
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${uidField} >= $3 AND ${uidField} <= $4
            AND expunged = FALSE
          ORDER BY ${uidField} ASC
        `;
        values = [user_id, sent, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
          ORDER BY ${uidField} ASC
          OFFSET $3 LIMIT $4
        `;
        values = [user_id, sent, start - 1, end - start + 1];
      }
    } else {
      // Account-specific query (exclude expunged messages)
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            AND ${uidField} >= $4 AND ${uidField} <= $5 AND expunged = FALSE
          ORDER BY ${uidField} ASC
        `;
        values = [user_id, sent, addressJson, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE
          ORDER BY ${uidField} ASC
          OFFSET $4 LIMIT $5
        `;
        values = [user_id, sent, addressJson, start - 1, end - start + 1];
      }
    }

    const result = await pool.query(sql, values);
    const mails = new Map<string, PartialMailModel>();
    for (const row of result.rows) {
      mails.set(row.mail_id, new PartialMailModel(safeFields, row));
    }
    return mails;
  } catch (error) {
    logger.error("Failed to get mails by range", {}, error);
    return new Map();
  }
};

export interface UpdatedMailFlags {
  uid: number;
  read: boolean;
  saved: boolean;
  deleted: boolean;
  draft: boolean;
  answered: boolean;
}

/**
 * Operation type for STORE command per RFC 3501
 * - "FLAGS" or "FLAGS.SILENT": Replace all flags with the provided flags
 * - "+FLAGS" or "+FLAGS.SILENT": Add the provided flags (leave others unchanged)
 * - "-FLAGS" or "-FLAGS.SILENT": Remove the provided flags (leave others unchanged)
 */
export type StoreOperationType = "FLAGS" | "+FLAGS" | "-FLAGS";

/**
 * Build SET clause for flag updates based on operation type.
 * Per RFC 3501 Section 6.4.6:
 * - FLAGS: Replace all flags with the provided list
 * - +FLAGS: Add the specified flags to existing flags
 * - -FLAGS: Remove the specified flags from existing flags
 */
function buildFlagSetClause(
  operation: StoreOperationType,
  flags: string[]
): string {
  const hasFlag = (flag: string) => flags.includes(flag);

  switch (operation) {
    case "FLAGS":
      // Replace mode: set all flags based on presence in flags array
      return `
        read = ${hasFlag("\\Seen")},
        saved = ${hasFlag("\\Flagged")},
        deleted = ${hasFlag("\\Deleted")},
        draft = ${hasFlag("\\Draft")},
        answered = ${hasFlag("\\Answered")}
      `;

    case "+FLAGS": {
      // Add mode: only set flags that are in the array to true
      const addClauses: string[] = [];
      if (hasFlag("\\Seen")) addClauses.push("read = TRUE");
      if (hasFlag("\\Flagged")) addClauses.push("saved = TRUE");
      if (hasFlag("\\Deleted")) addClauses.push("deleted = TRUE");
      if (hasFlag("\\Draft")) addClauses.push("draft = TRUE");
      if (hasFlag("\\Answered")) addClauses.push("answered = TRUE");
      // If no flags specified, return a no-op that still works
      return addClauses.length > 0 ? addClauses.join(", ") : "updated = updated";
    }

    case "-FLAGS": {
      // Remove mode: only set flags that are in the array to false
      const removeClauses: string[] = [];
      if (hasFlag("\\Seen")) removeClauses.push("read = FALSE");
      if (hasFlag("\\Flagged")) removeClauses.push("saved = FALSE");
      if (hasFlag("\\Deleted")) removeClauses.push("deleted = FALSE");
      if (hasFlag("\\Draft")) removeClauses.push("draft = FALSE");
      if (hasFlag("\\Answered")) removeClauses.push("answered = FALSE");
      // If no flags specified, return a no-op that still works
      return removeClauses.length > 0 ? removeClauses.join(", ") : "updated = updated";
    }

    default:
      // Default to replace mode
      return `
        read = ${hasFlag("\\Seen")},
        saved = ${hasFlag("\\Flagged")},
        deleted = ${hasFlag("\\Deleted")},
        draft = ${hasFlag("\\Draft")},
        answered = ${hasFlag("\\Answered")}
      `;
  }
}

export const setMailFlags = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  start: number,
  end: number,
  flags: string[],
  useUid: boolean,
  operation: StoreOperationType = "FLAGS"
): Promise<UpdatedMailFlags[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;
    const setClause = buildFlagSetClause(operation, flags);

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      if (useUid) {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND sent = $2 AND ${uidField} >= $3 AND ${uidField} <= $4
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, start, end];
      } else {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE mail_id IN (
            SELECT mail_id FROM mails
            WHERE user_id = $1 AND sent = $2
            ORDER BY ${uidField} ASC
            OFFSET $3 LIMIT 1
          )
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, start];
      }
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      if (useUid) {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            AND ${uidField} >= $4 AND ${uidField} <= $5
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, addressJson, start, end];
      } else {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE mail_id IN (
            SELECT mail_id FROM mails
            WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            ORDER BY ${uidField} ASC
            OFFSET $4 LIMIT 1
          )
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, addressJson, start];
      }
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      uid: row.uid as number,
      read: row.read as boolean,
      saved: row.saved as boolean,
      deleted: row.deleted as boolean,
      draft: row.draft as boolean,
      answered: row.answered as boolean,
    }));
  } catch (error) {
    logger.error("Failed to set mail flags", {}, error);
    return [];
  }
};

export const searchMailsByUid = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  criteria: { type: string; value?: unknown }[]
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    // Always exclude expunged messages from search
    const conditions: string[] = ["user_id = $1", "sent = $2", "expunged = FALSE"];
    const values: ParamValue[] = [user_id, sent];
    let paramIdx = 3;

    if (account !== null) {
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $${paramIdx}::jsonb`
        : `(${TO_ADDRESS} @> $${paramIdx}::jsonb OR cc_address @> $${paramIdx}::jsonb OR bcc_address @> $${paramIdx}::jsonb)`;
      conditions.push(addressCondition);
      values.push(addressJson);
      paramIdx++;
    }

    for (const criterion of criteria) {
      const type = criterion.type.toUpperCase();
      switch (type) {
        // ALL: match everything — no additional condition needed
        case "ALL":
          break;

        // Flag / status criteria
        case "UNSEEN":
          conditions.push("read = FALSE");
          break;
        case "SEEN":
          conditions.push("read = TRUE");
          break;
        case "FLAGGED":
          conditions.push("saved = TRUE");
          break;
        case "UNFLAGGED":
          conditions.push("saved = FALSE");
          break;
        // ANSWERED / UNANSWERED: not tracked in schema; treat as ALL/NONE
        // to avoid incorrect filtering. ANSWERED = match all, UNANSWERED = match none.
        case "ANSWERED":
          break; // assume no answered-flag tracking → match all
        case "UNANSWERED":
          conditions.push("FALSE"); // no messages satisfy this
          break;
        // DELETED / UNDELETED: our schema uses expunged for physical removal; there is no
        // separate \Deleted flag. Non-expunged messages are always "UNDELETED" in IMAP terms.
        case "DELETED":
          conditions.push("FALSE"); // no messages are flagged \Deleted without being expunged
          break;
        case "UNDELETED":
          break; // all visible (non-expunged) messages qualify
        // DRAFT / UNDRAFT: not tracked; treat conservatively
        case "DRAFT":
          conditions.push("FALSE");
          break;
        case "UNDRAFT":
          break; // all messages are non-draft
        // NEW = RECENT + UNSEEN; RECENT / OLD: not tracked, treat as ALL
        case "NEW":
          conditions.push("read = FALSE");
          break;
        case "OLD":
        case "RECENT":
          break; // no \Recent flag tracking; match all

        // Text search criteria
        case "SUBJECT":
          conditions.push(`subject ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "FROM":
          conditions.push(`from_text ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "TO":
          conditions.push(`to_text ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "CC":
          conditions.push(`cc_text ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "BCC":
          conditions.push(`bcc_text ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "BODY":
        case "TEXT":
        case "SUBJECT_TEXT":
          // Full-text search across subject (extend to body when indexed)
          conditions.push(`(subject ILIKE $${paramIdx} OR from_text ILIKE $${paramIdx} OR to_text ILIKE $${paramIdx})`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;

        // Header search
        case "HEADER": {
          const { field, text } = criterion.value as { field: string; text: string };
          const fieldLower = field.toLowerCase();
          if (fieldLower === "subject") {
            conditions.push(`subject ILIKE $${paramIdx}`);
          } else if (fieldLower === "from") {
            conditions.push(`from_text ILIKE $${paramIdx}`);
          } else if (fieldLower === "to") {
            conditions.push(`to_text ILIKE $${paramIdx}`);
          } else if (fieldLower === "message-id") {
            conditions.push(`message_id ILIKE $${paramIdx}`);
          } else {
            // Unsupported header field — skip to avoid incorrect results
            break;
          }
          values.push(`%${text}%`);
          paramIdx++;
          break;
        }

        // Date criteria (using internal date — date column)
        case "BEFORE":
          conditions.push(`date < $${paramIdx}`);
          values.push(criterion.value as Date);
          paramIdx++;
          break;
        case "ON": {
          const onDate = criterion.value as Date;
          const nextDay = new Date(onDate);
          nextDay.setDate(nextDay.getDate() + 1);
          conditions.push(`date >= $${paramIdx} AND date < $${paramIdx + 1}`);
          values.push(onDate, nextDay);
          paramIdx += 2;
          break;
        }
        case "SINCE":
          conditions.push(`date >= $${paramIdx}`);
          values.push(criterion.value as Date);
          paramIdx++;
          break;
        // SENT* criteria use the same date column (we have only one date field)
        case "SENTBEFORE":
          conditions.push(`date < $${paramIdx}`);
          values.push(criterion.value as Date);
          paramIdx++;
          break;
        case "SENTON": {
          const sentOnDate = criterion.value as Date;
          const nextDay = new Date(sentOnDate);
          nextDay.setDate(nextDay.getDate() + 1);
          conditions.push(`date >= $${paramIdx} AND date < $${paramIdx + 1}`);
          values.push(sentOnDate, nextDay);
          paramIdx += 2;
          break;
        }
        case "SENTSINCE":
          conditions.push(`date >= $${paramIdx}`);
          values.push(criterion.value as Date);
          paramIdx++;
          break;

        // Size criteria: not tracked per-row; skip to avoid incorrect results
        case "LARGER":
        case "SMALLER":
          break;

        // UID ranges (already split from UidCriterion in store.ts)
        case "UID_EXACT":
          conditions.push(`${uidField} = $${paramIdx}`);
          values.push(criterion.value as number);
          paramIdx++;
          break;
        case "UID_RANGE": {
          const range = criterion.value as { start: number; end: number };
          conditions.push(`${uidField} >= $${paramIdx} AND ${uidField} <= $${paramIdx + 1}`);
          values.push(range.start, range.end);
          paramIdx += 2;
          break;
        }
      }
    }

    const sql = `
      SELECT ${uidField} as uid FROM mails 
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${uidField} ASC
      LIMIT 10000
    `;

    const result = await pool.query(sql, values);
    return result.rows
      .map((row: Record<string, unknown>) => row.uid as number)
      .filter((uid: number) => uid > 0);
  } catch (error) {
    logger.error("Failed to search mails by UID", {}, error);
    return [];
  }
};

export const getUnreadNotifications = async (
  user_ids: string[]
): Promise<Map<string, { count: number; latest?: Date }>> => {
  try {
    if (user_ids.length === 0) return new Map();

    const placeholders = user_ids.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `
      SELECT 
        user_id,
        COUNT(*) FILTER (WHERE read = FALSE) as unread_count,
        MAX(date) as latest
      FROM mails 
      WHERE user_id IN (${placeholders}) AND sent = FALSE AND expunged = FALSE
      GROUP BY user_id
    `;

    const result = await pool.query(sql, user_ids);
    const notifications = new Map<string, { count: number; latest?: Date }>();

    for (const row of result.rows) {
      const count = parseInt(row.unread_count, 10);
      notifications.set(row.user_id, {
        count,
        latest: row.latest ? new Date(row.latest) : undefined,
      });
    }

    return notifications;
  } catch (error) {
    logger.error("Failed to get unread notifications", {}, error);
    return new Map();
  }
};

/**
 * Get all UIDs in a mailbox, ordered by UID ascending.
 * Used to build sequence number → UID mapping for IMAP sessions.
 */
export const getAllUids = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      // Domain-wide query (exclude expunged messages)
      sql = `
        SELECT ${uidField} as uid FROM mails 
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
        ORDER BY ${uidField} ASC
      `;
      values = [user_id, sent];
    } else {
      // Account-specific query (exclude expunged messages)
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      sql = `
        SELECT ${uidField} as uid FROM mails 
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE
        ORDER BY ${uidField} ASC
      `;
      values = [user_id, sent, addressJson];
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    logger.error("Failed to get all UIDs", {}, error);
    return [];
  }
};

/**
 * Soft-delete messages marked with \Deleted flag (EXPUNGE operation)
 * Sets expunged = TRUE instead of hard deleting.
 * Returns the UIDs of expunged messages for EXPUNGE responses.
 */
export const expungeDeletedMails = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    if (account === null) {
      // Domain-wide expunge: simple equality filters → use the framework's
      // updateWhere so `updated` is bumped via the standard data-bag pattern.
      const rows = await mailsTable.updateWhere(
        { [USER_ID]: user_id, [SENT]: sent, [DELETED]: true, [EXPUNGED]: false },
        { [EXPUNGED]: true, updated: new Date() },
        [`${uidField} as uid`]
      );
      return rows.map((row: Record<string, unknown>) => row.uid as number);
    }

    // Account-specific expunge: the address filter uses jsonb `@>` containment
    // (with an OR across to/cc/bcc on the recv side), which WhereFilters cannot
    // express. Two-step: raw SELECT to resolve mail_ids, then framework
    // updateWhere with an IN filter so the data-bag pattern bumps `updated`.
    const addressJson = JSON.stringify([{ address: account }]);
    const addressCondition = sent
      ? `${FROM_ADDRESS} @> $3::jsonb`
      : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
    const selectSql = `
      SELECT ${MAIL_ID} as mail_id FROM mails
      WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND deleted = TRUE AND expunged = FALSE
    `;
    const selectValues: ParamValue[] = [user_id, sent, addressJson];
    const selectResult = await pool.query(selectSql, selectValues);
    const mailIds = selectResult.rows.map((row: Record<string, unknown>) => row.mail_id as string);
    if (mailIds.length === 0) return [];

    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: { op: "IN", value: mailIds } },
      { [EXPUNGED]: true, updated: new Date() },
      [`${uidField} as uid`]
    );
    return rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    logger.error("Failed to expunge deleted mails", {}, error);
    return [];
  }
};

/**
 * Get all spam-flagged mails for a user.
 * Returns mails where is_spam = true, sorted by date descending.
 */
export const getSpamMails = async (user_id: string): Promise<MailModel[]> => {
  try {
    const sql = `
      SELECT * FROM mails 
      WHERE user_id = $1 AND is_spam = TRUE AND sent = FALSE AND expunged = FALSE
      ORDER BY date DESC
    `;
    const result = await pool.query(sql, [user_id]);
    return result.rows.map((row: Record<string, unknown>) => new MailModel(row));
  } catch (error) {
    logger.error("Failed to get spam mails", {}, error);
    return [];
  }
};

/**
 * Mark or unmark a mail as spam.
 *
 * Returns:
 *   - `found`: true if the (user, mail) pair exists, regardless of current is_spam value
 *   - `changed`: true if the row's is_spam value was actually flipped
 *
 * Distinguishing "no change" from "not found" lets the caller skip classifier
 * training on idempotent re-marks while still surfacing real auth failures.
 */
export const markMailSpam = async (
  user_id: string,
  mail_id: string,
  is_spam: boolean
): Promise<{ found: boolean; changed: boolean }> => {
  try {
    const result = await pool.query(
      `UPDATE mails SET is_spam = $1, updated = NOW()
         WHERE mail_id = $2 AND user_id = $3 AND is_spam IS DISTINCT FROM $1
         RETURNING mail_id`,
      [is_spam, mail_id, user_id]
    );
    if ((result.rowCount ?? 0) > 0) return { found: true, changed: true };
    const exists = await pool.query(
      `SELECT 1 FROM mails WHERE mail_id = $1 AND user_id = $2 LIMIT 1`,
      [mail_id, user_id]
    );
    return { found: (exists.rowCount ?? 0) > 0, changed: false };
  } catch (error) {
    logger.error("Failed to mark mail as spam", {}, error);
    return { found: false, changed: false };
  }
};
