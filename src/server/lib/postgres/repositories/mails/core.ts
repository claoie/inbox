import crypto from "crypto";
import { MailType } from "common";
import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import {
  MailModel,
  mailsTable,
  MAIL_ID,
  USER_ID,
  ENVELOPE_TO,
  MODSEQ,
  DB_NOW,
  RFC822_SIZE,
} from "../../models";
import {
  getNextModseq,
  syncMailboxPivot,
  writeMailboxUid,
} from "./counters";
import { decideMappingWrites, type MappingWrite } from "./mapping-decisions";
import {
  computeFullMessageSize,
  type FetchMailInput,
} from "../../../imap/session-utils";

// The two mapped-utility mailbox names — kept as string literals to avoid a
// cycle back into `imap/util.ts` (which pulls this module's barrel). The
// `mail_mailbox_uid` writes here are keyed on the same canonical spelling
// that `canonicalMailbox` produces, so a `COPY 5 "starred"` on the wire
// still lands on `Starred`.
const STARRED_MAILBOX = "Starred";
const TRASH_MAILBOX = "Trash";

/**
 * One pivot write the caller should issue for a saveMail row — `mailbox` is
 * the mapped-utility name (Starred / Trash), `present` is the target flag
 * value.
 */
export type MappedPivotDecision = { mailbox: string; present: boolean };

/**
 * The gating logic behind `syncMappedPivotsForRow`, extracted so the
 * `undefined` ↔ skip convention can be unit-tested without a Postgres pool
 * (the pool-facing sibling requires the FakePool recipe which is fragile
 * across test files — see `reference_bun_mock_module_global_hoisting.md`).
 * Returns the pivot writes the caller should issue, in order.
 *
 * - `saved === undefined` / `deleted === undefined` → skip the corresponding
 *   pivot (INSERT branch uses this for a false-flag fresh row that never
 *   had a pivot; merge branch uses it for flags the placement didn't touch).
 * - `destMailbox === STARRED_MAILBOX` / `TRASH_MAILBOX` → skip that pivot;
 *   the caller's own `writeMailboxUid` above (for the reserved UID) already
 *   handled it, and calling `syncMailboxPivot` on top would waste a counter
 *   tick on a ON CONFLICT DO UPDATE that keeps the same uid.
 */
export const decideMappedPivots = (
  saved: boolean | undefined,
  deleted: boolean | undefined,
  destMailbox: string | undefined
): MappedPivotDecision[] => {
  const decisions: MappedPivotDecision[] = [];
  if (saved !== undefined && destMailbox !== STARRED_MAILBOX) {
    decisions.push({ mailbox: STARRED_MAILBOX, present: saved });
  }
  if (deleted !== undefined && destMailbox !== TRASH_MAILBOX) {
    decisions.push({ mailbox: TRASH_MAILBOX, present: deleted });
  }
  return decisions;
};

export const syncMappedPivotsForRow = async (
  user_id: string,
  mail_id: string,
  saved: boolean | undefined,
  deleted: boolean | undefined,
  destMailbox: string | undefined
): Promise<void> => {
  for (const { mailbox, present } of decideMappedPivots(saved, deleted, destMailbox)) {
    await syncMailboxPivot(user_id, mailbox, mail_id, present);
  }
};

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
  uid_mailbox?: number;
  spam_score?: number;
  spam_reasons?: string[] | null;
  is_spam?: boolean;
  placement?: {
    draft?: boolean;
    is_spam?: boolean;
    saved?: boolean;
    deleted?: boolean;
  };
  mailbox?: string;
  /**
   * A domain view this mail also belongs to (`INBOX`), recorded in
   * `mail_mailbox_uid` against `uid_domain`. Independent of `mailbox` above,
   * which names the mapped destination and carries `uid_mailbox`: a received
   * mail belongs to its per-account view and to INBOX at once.
   */
  domain_mailbox?: string;
}

/**
 * Issues the mapping writes for one row and returns the UID persisted for the
 * mapped destination, which `storeMail` reconciles onto `mail.uid.account`.
 * The rows are independent, so the round trips overlap.
 */
const recordMappings = async (
  user_id: string,
  mail_id: string,
  writes: MappingWrite[],
  mappedDestination: string | undefined
): Promise<number | undefined> => {
  const persisted = await Promise.all(
    writes.map(async ({ mailbox, uid }) => ({
      mailbox,
      uid: await writeMailboxUid(user_id, mailbox, mail_id, uid),
    }))
  );
  return persisted.find(({ mailbox }) => mailbox === mappedDestination)?.uid;
};

export const saveMail = async (
  input: SaveMailInput
): Promise<{ _id: string; uid_mailbox?: number; uid_domain?: number } | undefined> => {
  try {
    const mail_id = crypto.randomUUID();
    // Stamp the new message with a fresh mod-sequence so it advances the
    // mailbox's HIGHESTMODSEQ (CONDSTORE, RFC 7162). Reserved before the INSERT,
    // like uid_domain/uid_mailbox are in convertMail.
    const modseq = await getNextModseq(input.user_id);
    const text = input.text ?? "";
    const html = input.html ?? "";
    const date = input.date ?? new Date().toISOString();
    // Reconstruct just the shape `computeFullMessageSize` touches, using
    // the LAZY-BODY synthetics (text_octets / html_octets / mail_id /
    // user_id) with text/html left undefined. This forces
    // `wantsLazyBodies` true, so `hasText`/`hasHtml` derive from octet
    // counts — the same predicate every subsequent FETCH uses on the
    // row returned by `getMailsByRange` (session-utils.ts:207-215). A
    // materialized shape here would take the `.trim()` branch and drift
    // on whitespace-only bodies (SIZE would omit the part, FETCH BODY[]
    // would include it — SIZE ≠ {N}).
    //
    // Attachments are already on disk by the time saveMail is called
    // (saveBuffer in receive.ts:355 completes before pgSaveMail), so
    // the internal `fs.statSync` per attachment works.
    const mailForSize: FetchMailInput = {
      messageId: input.message_id,
      date,
      subject: input.subject,
      text_octets: Buffer.byteLength(text, "utf8"),
      html_octets: Buffer.byteLength(html, "utf8"),
      mail_id,
      user_id: input.user_id,
      attachments: input.attachments as MailType["attachments"] | undefined,
      from: input.from_text ? { value: [], text: input.from_text } : undefined,
      to: input.to_text ? { value: [], text: input.to_text } : undefined,
      cc: input.cc_text ? { value: [], text: input.cc_text } : undefined,
      bcc: input.bcc_text ? { value: [], text: input.bcc_text } : undefined,
      replyTo: input.reply_to_text
        ? { value: [], text: input.reply_to_text }
        : undefined,
    };
    const rfc822_size = computeFullMessageSize(mailForSize, mail_id);
    const data: Record<string, ParamValue | object | null> = {
      mail_id,
      user_id: input.user_id,
      message_id: input.message_id,
      subject: input.subject ?? "",
      date,
      html,
      text,
      // Populate at INSERT so the RFC822.SIZE fetch handler's cache-hit
      // branch fires from the first observation.
      // The lazy-populate fallback in fetch-helpers stays as a safety net
      // for pre-migration rows.
      [RFC822_SIZE]: rfc822_size,
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
      modseq,
      spam_score: input.spam_score ?? 0,
      spam_reasons: input.spam_reasons ? JSON.stringify(input.spam_reasons) : null,
      is_spam: input.is_spam ?? false,
      ...input.placement,
    };

    const row = await mailsTable.insert(data, [MAIL_ID]);
    if (row) {
      const inserted_id = row[MAIL_ID] as string;
      const persistedUid = await recordMappings(
        input.user_id,
        inserted_id,
        decideMappingWrites({
          mailbox: input.mailbox,
          uid_mailbox: input.uid_mailbox,
          domain_mailbox: input.domain_mailbox,
          uid_domain: input.uid_domain,
          sent: input.sent ?? false,
        }),
        input.mailbox
      );
      // Mapped-utility invariant sync — see `syncMappedPivotsForRow`. A
      // fresh row has no prior pivot, so we only issue the write when the
      // flag is TRUE (pass `undefined` otherwise to skip).
      await syncMappedPivotsForRow(
        input.user_id,
        inserted_id,
        data.saved ? true : undefined,
        data.deleted ? true : undefined,
        input.mailbox
      );
      // On the INSERT branch the row we just wrote has our input.uid_domain
      // (no conflict) — return it verbatim so storeMail can reconcile
      // mail.uid.domain for domain-scoped COPY/APPEND wire responses.
      return {
        _id: inserted_id,
        uid_mailbox: persistedUid,
        uid_domain: input.uid_domain,
      };
    }
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
          { [ENVELOPE_TO]: JSON.stringify(merged), updated: DB_NOW }
        );
      }

      // The 23505 branch fires for cross-delivery re-sends of the same
      // Message-ID from distinct SMTP sessions — a mailgun retry landing
      // on a different envelope, or a listserv fanning the same message
      // to multiple recipients under separate connections. Each session
      // has its own `input.mailbox`; the mapping row (existing_mail_id,
      // new_mailbox, new_uid) surfaces the second delivery in the second
      // account's UID space. Same-mailbox race between two concurrent
      // saveIncomingMail calls hits `writeMailboxUid`'s
      // `ON CONFLICT (user_id, mailbox, mail_id) DO NOTHING`, so the
      // loser's counter tick and mapping-insert round-trip are wasted
      // (rare, sub-ms, off the SMTP reply path) — the winner's row wins.
      // A mapped destination gets its membership from the mapping row below; a
      // utility destination gets it from the flag, and `existing` predates this
      // write, so the flag has to be set here too. Without it the APPEND is
      // acknowledged and the message is in no box the client named. The flip is
      // a membership change, so it advances the mod-sequence like markMailSpam.
      if (input.placement) {
        await mailsTable.updateWhere(
          { user_id: input.user_id, message_id: input.message_id },
          {
            ...input.placement,
            [MODSEQ]: await getNextModseq(input.user_id),
            updated: DB_NOW,
          }
        );
      }

      // The domain view describes the SURVIVING row, so its `uid_domain` and
      // `sent` come off `existing` — the caller's reservation belongs to an
      // INSERT that never happened, and its `sent` describes a different
      // delivery of the same Message-ID. The mapped destination is the
      // caller's own: this delivery's account box is exactly what the merge
      // exists to record.
      const persistedUid = await recordMappings(
        input.user_id,
        existing.mail_id,
        decideMappingWrites({
          mailbox: input.mailbox,
          uid_mailbox: input.uid_mailbox,
          domain_mailbox: input.domain_mailbox,
          uid_domain: existing.uid_domain,
          sent: existing.sent,
        }),
        input.mailbox
      );
      // Mirror the placement flip into the mapped-utility pivots — same
      // helper as the INSERT branch above. A placement that transitions
      // `saved` to TRUE (COPY into `Starred` for a same-Message-ID row) has
      // to write the pivot; a transition to FALSE has to drop it. `undefined`
      // means the placement didn't touch the flag → skip (invariant already
      // held pre-write).
      await syncMappedPivotsForRow(
        input.user_id,
        existing.mail_id,
        input.placement?.saved,
        input.placement?.deleted,
        input.mailbox
      );
      // On the 23505 merge branch the caller's input.uid_domain is a
      // fresh reservation, but the row `existing` already has its own
      // uid_domain from the first attempt. Return the existing value
      // so storeMail reconciles mail.uid.domain — otherwise a
      // domain-scoped COPY/APPEND that partial-failure-retries would
      // report a fresh uid_domain in COPYUID/APPENDUID that has no
      // matching mails row.
      return {
        _id: existing.mail_id,
        uid_mailbox: persistedUid,
        uid_domain: existing.uid_domain,
      };
    }

    logger.error("Failed to save mail", {}, error instanceof Error ? error : new Error(String(error)));
    throw error;
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
  return mailsTable.queryOne({ [MAIL_ID]: mail_id, [USER_ID]: user_id });
};

/**
 * Persist the derived `rfc822_size` for a mail on the first FETCH that
 * computes it. Deliberately does NOT bump `updated` — this is metadata
 * derivation, not a semantic edit; touching `updated` would trip the
 * CONDSTORE/HIGHESTMODSEQ change-tracking that clients use to detect
 * real mail mutations, generating spurious wake-ups on every first-observation.
 *
 * Idempotent: mail body content (text/html/attachments/headers) is
 * immutable after insert, so the derived size is stable; concurrent
 * callers writing the same value is a no-op collision. Deliberately
 * unconditional — a `WHERE rfc822_size IS NULL` guard would race with
 * a parallel writer for the same mail, and the same-value write is
 * cheap.
 *
 * Fire-and-forget from the caller: a failure here logs but does not
 * fail the FETCH response.
 */
export const updateRfc822Size = async (
  user_id: string,
  mail_id: string,
  rfc822_size: number
): Promise<void> => {
  await mailsTable.updateWhere(
    { [MAIL_ID]: mail_id, [USER_ID]: user_id },
    { [RFC822_SIZE]: rfc822_size }
  );
};

export const markMailRead = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  const rows = await mailsTable.updateWhere(
    { [MAIL_ID]: mail_id, [USER_ID]: user_id },
    { read: true, updated: DB_NOW },
    [MAIL_ID]
  );
  return rows.length > 0;
};

export const markMailSaved = async (
  user_id: string,
  mail_id: string,
  saved: boolean
): Promise<boolean> => {
  const rows = await mailsTable.updateWhere(
    { [MAIL_ID]: mail_id, [USER_ID]: user_id },
    { saved, updated: DB_NOW },
    [MAIL_ID]
  );
  if (rows.length === 0) return false;
  await syncMailboxPivot(user_id, "Starred", mail_id, saved);
  return true;
};

export const deleteMail = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  const count = await mailsTable.deleteWhere({
    [MAIL_ID]: mail_id,
    [USER_ID]: user_id
  });
  return count > 0;
};

export const markMailSpam = async (
  user_id: string,
  mail_id: string,
  is_spam: boolean
): Promise<{ found: boolean; changed: boolean }> => {
  const result = await pool.query(
    `UPDATE mails SET is_spam = $1, updated = NOW(), modseq = $4
       WHERE mail_id = $2 AND user_id = $3 AND is_spam IS DISTINCT FROM $1
       RETURNING mail_id`,
    [is_spam, mail_id, user_id, await getNextModseq(user_id)]
  );
  if ((result.rowCount ?? 0) > 0) return { found: true, changed: true };
  const exists = await pool.query(
    `SELECT 1 FROM mails WHERE mail_id = $1 AND user_id = $2 LIMIT 1`,
    [mail_id, user_id]
  );
  return { found: (exists.rowCount ?? 0) > 0, changed: false };
};
