import {
  MAIL_ID,
  USER_ID,
  MESSAGE_ID,
  SUBJECT,
  DATE,
  HTML,
  TEXT,
  FROM_ADDRESS,
  FROM_TEXT,
  TO_ADDRESS,
  TO_TEXT,
  CC_ADDRESS,
  CC_TEXT,
  BCC_ADDRESS,
  BCC_TEXT,
  REPLY_TO_ADDRESS,
  REPLY_TO_TEXT,
  ENVELOPE_FROM,
  ENVELOPE_TO,
  ATTACHMENTS,
  READ,
  SAVED,
  SENT,
  DELETED,
  DRAFT,
  ANSWERED,
  EXPUNGED,
  INSIGHT,
  UID_DOMAIN,
  MODSEQ,
  UPDATED,
  MAILS,
  SPAM_SCORE,
  SPAM_REASONS,
  IS_SPAM,
  RFC822_SIZE,
  TEXT_LINE_COUNT,
  HTML_LINE_COUNT,
  IN_REPLY_TO,
  REFERENCE_IDS,
  INGESTED,
} from "./common";
import { Model, ModelValidationError, createTable, validateObject } from "./base";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNullableObject = (v: unknown): v is object | null =>
  v === null || typeof v === "object";
const isNullableArray = (v: unknown): v is unknown[] | null =>
  v === null || Array.isArray(v);

export interface MailJSON {
  mail_id: string;
  user_id: string;
  message_id: string;
  subject: string;
  date: string;
  html: string;
  text: string;
  from_address: object | null;
  from_text: string | null;
  to_address: object | null;
  to_text: string | null;
  cc_address: object | null;
  cc_text: string | null;
  bcc_address: object | null;
  bcc_text: string | null;
  reply_to_address: object | null;
  reply_to_text: string | null;
  envelope_from: object | null;
  envelope_to: object | null;
  attachments: object | null;
  read: boolean;
  saved: boolean;
  sent: boolean;
  deleted: boolean;
  draft: boolean;
  answered: boolean;
  expunged: boolean;
  insight: object | null;
  uid_domain: number;
  modseq: number;
  spam_score: number;
  spam_reasons: string[] | null;
  is_spam: boolean;
  rfc822_size: number | null;
  text_line_count: number | null;
  html_line_count: number | null;
  in_reply_to: string | null;
  reference_ids: string[] | null;
}

const mailSchema = {
  [MAIL_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [MESSAGE_ID]: "VARCHAR(512) NOT NULL",
  [SUBJECT]: "TEXT NOT NULL DEFAULT ''",
  [DATE]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
  [HTML]: "TEXT NOT NULL DEFAULT ''",
  [TEXT]: "TEXT NOT NULL DEFAULT ''",
  [FROM_ADDRESS]: "JSONB",
  [FROM_TEXT]: "TEXT",
  [TO_ADDRESS]: "JSONB",
  [TO_TEXT]: "TEXT",
  [CC_ADDRESS]: "JSONB",
  [CC_TEXT]: "TEXT",
  [BCC_ADDRESS]: "JSONB",
  [BCC_TEXT]: "TEXT",
  [REPLY_TO_ADDRESS]: "JSONB",
  [REPLY_TO_TEXT]: "TEXT",
  [ENVELOPE_FROM]: "JSONB",
  [ENVELOPE_TO]: "JSONB",
  [ATTACHMENTS]: "JSONB",
  [READ]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [SAVED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [SENT]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [DELETED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [DRAFT]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [ANSWERED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [EXPUNGED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [INSIGHT]: "JSONB",
  [UID_DOMAIN]: "INTEGER NOT NULL DEFAULT 0",
  // DEFAULT 1 doubles as the single-pass backfill: the auto-migration's ADD
  // COLUMN stamps every existing row with modseq=1, so each mailbox's initial
  // HIGHESTMODSEQ is 1 and the counter (getNextModseq) seeds from MAX(modseq)+1.
  // New rows are assigned an explicit counter value (>1); the DEFAULT is only a
  // safety net for a write path that forgets to set it.
  [MODSEQ]: "BIGINT NOT NULL DEFAULT 1",
  [SPAM_SCORE]: "INTEGER NOT NULL DEFAULT 0",
  [SPAM_REASONS]: "JSONB",
  [IS_SPAM]: "BOOLEAN NOT NULL DEFAULT FALSE",
  // Nullable — auto-migration ADD COLUMN IF NOT EXISTS stamps existing rows
  // with NULL. New rows populate at INSERT via saveMail
  // (`computeFullMessageSize` on the lazy-body synthetics, same predicate
  // FETCH uses). The lazy-populate fallback in `fetch-helpers.ts` stays as
  // a safety net for pre-migration rows.
  [RFC822_SIZE]: "BIGINT",
  // Legacy, always NULL on new rows — nothing writes or reads them. They
  // counted decoded lines, which is not what RFC 3501 §7.4.2's `lines`
  // describes. Kept only until the columns are dropped.
  [TEXT_LINE_COUNT]: "INTEGER",
  [HTML_LINE_COUNT]: "INTEGER",
  // The Message-IDs the mail answers (`In-Reply-To`) and the conversation it
  // belongs to (`References`), for showing a mail inside its thread.
  // Nullable: rows stored before these columns existed have neither, and
  // the thread lookup falls back to subject and participants for them.
  [IN_REPLY_TO]: "VARCHAR(512)",
  [REFERENCE_IDS]: "JSONB",
  // When the server stored the row. Insert-only: no write path sets it, unlike
  // `updated`, which every flag or spam write restamps. Rows that predate the
  // column carry the migration's timestamp.
  [INGESTED]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  search_vector: "TSVECTOR",
};

type MailSchema = typeof mailSchema;

export class MailModel extends Model<MailJSON, MailSchema> {
  declare mail_id: string;
  declare user_id: string;
  declare message_id: string;
  declare subject: string;
  declare date: string;
  declare html: string;
  declare text: string;
  declare from_address: object | null;
  declare from_text: string | null;
  declare to_address: object | null;
  declare to_text: string | null;
  declare cc_address: object | null;
  declare cc_text: string | null;
  declare bcc_address: object | null;
  declare bcc_text: string | null;
  declare reply_to_address: object | null;
  declare reply_to_text: string | null;
  declare envelope_from: object | null;
  declare envelope_to: object | null;
  declare attachments: object | null;
  declare read: boolean;
  declare saved: boolean;
  declare sent: boolean;
  declare deleted: boolean;
  declare draft: boolean;
  declare answered: boolean;
  declare expunged: boolean;
  declare insight: object | null;
  declare uid_domain: number;
  declare modseq: number;
  declare spam_score: number;
  declare spam_reasons: string[] | null;
  declare is_spam: boolean;
  declare rfc822_size: number | null;
  declare text_line_count: number | null;
  declare html_line_count: number | null;
  declare in_reply_to: string | null;
  declare reference_ids: string[] | null;
  declare ingested: string;
  declare updated: string;

  static typeChecker = {
    mail_id: isString,
    user_id: isString,
    message_id: isString,
    subject: isString,
    date: isString,
    html: isString,
    text: isString,
    from_address: isNullableObject,
    from_text: isNullableString,
    to_address: isNullableObject,
    to_text: isNullableString,
    cc_address: isNullableObject,
    cc_text: isNullableString,
    bcc_address: isNullableObject,
    bcc_text: isNullableString,
    reply_to_address: isNullableObject,
    reply_to_text: isNullableString,
    envelope_from: isNullableObject,
    envelope_to: isNullableObject,
    attachments: isNullableObject,
    read: isBoolean,
    saved: isBoolean,
    sent: isBoolean,
    deleted: isBoolean,
    draft: isBoolean,
    answered: isBoolean,
    expunged: isBoolean,
    insight: isNullableObject,
    uid_domain: isNumber,
    modseq: isNumber,
    spam_score: isNumber,
    spam_reasons: isNullableArray,
    is_spam: isBoolean,
    rfc822_size: (v: unknown): v is number | null =>
      v === null || typeof v === "number",
    text_line_count: (v: unknown): v is number | null =>
      v === null || typeof v === "number",
    html_line_count: (v: unknown): v is number | null =>
      v === null || typeof v === "number",
    // Optional as well as nullable: rows read with an explicit column list
    // that predates these columns, and models built in code, don't carry
    // them, and threading treats a missing value as "no headers".
    in_reply_to: (v: unknown): v is string | null | undefined =>
      v === undefined || isNullableString(v),
    reference_ids: (v: unknown): v is unknown[] | null | undefined =>
      v === undefined || isNullableArray(v),
    ingested: (v: unknown): v is string | null | undefined =>
      v === undefined || isNullableString(v),
    updated: isNullableString,
    search_vector: isNullableString,
  };

  constructor(data: unknown) {
    super(data, MailModel.typeChecker);
  }

  toJSON(): MailJSON {
    return {
      mail_id: this.mail_id,
      user_id: this.user_id,
      message_id: this.message_id,
      subject: this.subject,
      date: this.date,
      html: this.html,
      text: this.text,
      from_address: this.from_address,
      from_text: this.from_text,
      to_address: this.to_address,
      to_text: this.to_text,
      cc_address: this.cc_address,
      cc_text: this.cc_text,
      bcc_address: this.bcc_address,
      bcc_text: this.bcc_text,
      reply_to_address: this.reply_to_address,
      reply_to_text: this.reply_to_text,
      envelope_from: this.envelope_from,
      envelope_to: this.envelope_to,
      attachments: this.attachments,
      read: this.read,
      saved: this.saved,
      sent: this.sent,
      deleted: this.deleted,
      draft: this.draft,
      answered: this.answered,
      expunged: this.expunged,
      insight: this.insight,
      uid_domain: this.uid_domain,
      modseq: this.modseq,
      spam_score: this.spam_score,
      spam_reasons: this.spam_reasons,
      is_spam: this.is_spam,
      rfc822_size: this.rfc822_size,
      text_line_count: this.text_line_count,
      html_line_count: this.html_line_count,
      in_reply_to: this.in_reply_to ?? null,
      reference_ids: this.reference_ids ?? null,
    };
  }
}

/**
 * A partial view of a MailModel with only the requested fields validated.
 * Use when querying a subset of mail columns (e.g., IMAP FETCH with specific fields).
 *
 * Validates:
 * 1. Each requested field name exists in MailModel (unknown column → throws)
 * 2. Each selected field's value passes the MailModel type check
 *
 * Usage:
 *   const partial = new PartialMailModel(["mail_id", "subject", "read"], row);
 *   partial.subject // string | undefined
 */
/**
 * PartialMailModel-only synthetic fields — populated by a JOIN alias or a
 * function projection in the repository layer, not stored on the `mails`
 * table. Kept out of MailModel's typeChecker so full-row constructor calls
 * (via `mailsTable.query`) don't fail when the alias is absent.
 *
 * - `uid_mailbox` — the per-mailbox UID from `mail_mailbox_uid.uid`. Only set
 *   when `getMailsByRange` is called with a specific mailbox (account-scoped
 *   or user-created). Undefined for domain-scoped views (INBOX / unified
 *   Sent Messages) — those use `uid_domain`.
 * - `text_octets` / `html_octets` — `octet_length()` of the corresponding
 *   TEXT column, projected as an alias so a caller can pre-measure the
 *   `{N}` literal for a BODY[] stream without materializing the body itself.
 *   The body is then read in chunks via `SUBSTRING` (see the IMAP
 *   fetch-helpers stream path).
 */
const partialSyntheticFieldCheckers: Record<string, (v: unknown) => boolean> = {
  uid_mailbox: isNumber,
  text_octets: isNumber,
  html_octets: isNumber,
};

export class PartialMailModel {
  static readonly validFields: ReadonlySet<string> = new Set([
    ...Object.keys(MailModel.typeChecker),
    ...Object.keys(partialSyntheticFieldCheckers),
  ]);

  readonly selectedFields: ReadonlySet<string>;

  // All MailModel fields exposed as optional properties
  readonly mail_id?: string;
  readonly user_id?: string;
  readonly message_id?: string;
  readonly subject?: string;
  readonly date?: string;
  readonly html?: string;
  readonly text?: string;
  readonly from_address?: object | null;
  readonly from_text?: string | null;
  readonly to_address?: object | null;
  readonly to_text?: string | null;
  readonly cc_address?: object | null;
  readonly cc_text?: string | null;
  readonly bcc_address?: object | null;
  readonly bcc_text?: string | null;
  readonly reply_to_address?: object | null;
  readonly reply_to_text?: string | null;
  readonly envelope_from?: object | null;
  readonly envelope_to?: object | null;
  readonly attachments?: object | null;
  readonly read?: boolean;
  readonly saved?: boolean;
  readonly sent?: boolean;
  readonly deleted?: boolean;
  readonly draft?: boolean;
  readonly answered?: boolean;
  readonly expunged?: boolean;
  readonly insight?: object | null;
  readonly uid_domain?: number;
  readonly uid_mailbox?: number;
  readonly text_octets?: number;
  readonly html_octets?: number;
  readonly modseq?: number;
  readonly spam_score?: number;
  readonly spam_reasons?: string[] | null;
  readonly is_spam?: boolean;
  readonly rfc822_size?: number | null;
  readonly text_line_count?: number | null;
  readonly html_line_count?: number | null;
  readonly updated?: string;

  constructor(fields: string[], data: unknown) {
    // 1. Validate all field names are known MailModel columns
    const unknownFields = fields.filter(
      (f) => !PartialMailModel.validFields.has(f)
    );
    if (unknownFields.length > 0) {
      throw new ModelValidationError(
        "PartialMailModel",
        unknownFields.map((f) => `Unknown field: ${f}`)
      );
    }

    // 2. Build a checker for only the requested fields and validate.
    // Synthetic PartialMailModel fields (e.g. uid_mailbox, populated from a
    // JOIN alias) live outside MailModel.typeChecker; look them up in the
    // synthetic table when MailModel's checker doesn't have them.
    const partialChecker = Object.fromEntries(
      fields.map((f) => [
        f,
        MailModel.typeChecker[f as keyof typeof MailModel.typeChecker] ??
          partialSyntheticFieldCheckers[f],
      ])
    ) as Record<string, (v: unknown) => boolean>;

    const errors = validateObject(data, partialChecker);
    if (errors.length > 0) {
      throw new ModelValidationError("PartialMailModel", errors);
    }

    // 3. Assign only the selected fields
    this.selectedFields = new Set(fields);
    const self = this as Record<string, unknown>;
    const obj = data as Record<string, unknown>;
    for (const field of fields) {
      self[field] = obj[field];
    }
  }
}

export const mailsTable = createTable<MailJSON, MailSchema, MailModel>({
  name: MAILS,
  primaryKey: MAIL_ID,
  schema: mailSchema,
  constraints: ["UNIQUE (user_id, message_id)"],
  indexes: [
    { column: USER_ID },
    { column: DATE },
    { column: SENT },
    { column: READ },
    { column: SAVED },
    { column: UID_DOMAIN },
    { column: MODSEQ },
    { column: IS_SPAM },
    { column: DRAFT },
    { column: EXPUNGED },
    // Address containment (@>) filters for the per-account reads —
    // buildHeaderAddressCondition in repositories/mails/http-query.ts.
    // jsonb_path_ops is the smallest opclass that supports @>.
    { column: TO_ADDRESS, using: "gin", opclass: "jsonb_path_ops" },
    { column: CC_ADDRESS, using: "gin", opclass: "jsonb_path_ops" },
    { column: BCC_ADDRESS, using: "gin", opclass: "jsonb_path_ops" },
    { column: ENVELOPE_TO, using: "gin", opclass: "jsonb_path_ops" },
    { column: FROM_ADDRESS, using: "gin", opclass: "jsonb_path_ops" },
    // Thread lookup (repositories/mails/thread.ts): replies by the id they
    // answer, and the References overlap (`?|`, which needs the default
    // jsonb_ops opclass).
    { column: IN_REPLY_TO },
    { column: REFERENCE_IDS, using: "gin" },
  ],
  ModelClass: MailModel,
  supportsSoftDelete: false,
});

export const mailColumns = Object.keys(mailsTable.schema);
