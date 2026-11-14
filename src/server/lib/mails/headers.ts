import {
  MailHeaderData,
  MaskedUser,
  Pagination,
  SignedUser,
  MailAddressValueType,
  Insight,
} from "common";
import {
  getMailHeaderIds as pgGetMailHeaderIds,
  getMailHeadersByIds as pgGetMailHeadersByIds,
  getMailHeadersDelta as pgGetMailHeadersDelta,
  getUnifiedMailHeaderIds as pgGetUnifiedMailHeaderIds,
  getUnifiedMailHeadersDelta as pgGetUnifiedMailHeadersDelta,
  GetMailHeadersOptions,
  MailHeaderResult,
} from "../postgres/repositories/mails";
import { buildSnippet } from "./snippet";

export interface GetMailsOptions {
  sent: boolean;
  saved: boolean;
  spam: boolean;
  pagination?: Pagination;
}

/**
 * Options for the unified list. The unified view is the All Mails view
 * only, so there are no sent/saved/spam variants to pass — only paging.
 * `addresses` is the user's receiving-address set, resolved by the caller
 * from the accounts payload (the route's `received` keys).
 */
export interface GetUnifiedMailsOptions {
  pagination?: Pagination;
}

export interface MailHeadersDelta {
  as_of: string;
  headers: MailHeaderData[];
  expunged_ids: string[];
}

interface UserWithId {
  user_id?: string;
}

const resolveUserId = (user: MaskedUser | SignedUser): string | undefined =>
  "id" in user ? user.id : (user as UserWithId).user_id;

async function* noBatches(): AsyncGenerator<MailHeaderResult[]> {}

export const toMailHeaderData = (m: MailHeaderResult): MailHeaderData =>
  new MailHeaderData({
    id: m.mail_id,
    subject: m.subject,
    date: m.date,
    from: m.from_address
      ? { value: m.from_address as MailAddressValueType[], text: m.from_text || "" }
      : undefined,
    to: m.to_address
      ? { value: m.to_address as MailAddressValueType[], text: m.to_text || "" }
      : undefined,
    cc: m.cc_address
      ? { value: m.cc_address as MailAddressValueType[], text: m.cc_text || "" }
      : undefined,
    bcc: m.bcc_address
      ? { value: m.bcc_address as MailAddressValueType[], text: m.bcc_text || "" }
      : undefined,
    // No envelope text column exists — the envelope recipient is an SMTP-time
    // value, never rendered, only read for account resolution.
    ...(m.envelope_to
      ? {
          envelopeTo: {
            value: m.envelope_to as MailAddressValueType[],
            text: "",
          },
        }
      : {}),
    read: m.read,
    saved: m.saved,
    sent: m.sent,
    insight: m.insight as Insight | undefined,
    snippet: buildSnippet(m.text_prefix),
    ...(m.message_id ? { messageId: m.message_id } : {}),
    ...(m.in_reply_to ? { inReplyTo: m.in_reply_to } : {}),
    ...(m.reference_ids?.length ? { references: m.reference_ids } : {}),
  });

export const getMailHeaders = async (
  user: MaskedUser | SignedUser,
  address: string,
  options: GetMailsOptions
): Promise<AsyncIterable<MailHeaderResult[]>> => {
  const userId = resolveUserId(user);
  if (!userId) return noBatches();

  const { from, size } = options.pagination || new Pagination();

  const pgOptions: GetMailHeadersOptions = {
    sent: options.sent,
    saved: options.saved,
    spam: options.spam,
    from,
    size,
  };

  const ids = await pgGetMailHeaderIds(userId, address, pgOptions);
  return pgGetMailHeadersByIds(userId, ids);
};

export const getMailHeadersDelta = async (
  user: MaskedUser | SignedUser,
  address: string,
  options: GetMailsOptions,
  since: string
): Promise<MailHeadersDelta> => {
  const userId = resolveUserId(user);
  if (!userId) return { as_of: since, headers: [], expunged_ids: [] };

  const pgOptions: GetMailHeadersOptions = {
    sent: options.sent,
    saved: options.saved,
    spam: options.spam,
  };

  const { as_of, headers, expunged_ids } = await pgGetMailHeadersDelta(
    userId,
    address,
    pgOptions,
    since
  );

  return { as_of, headers: headers.map(toMailHeaderData), expunged_ids };
};

export const getUnifiedMailHeaders = async (
  user: MaskedUser | SignedUser,
  addresses: string[],
  options: GetUnifiedMailsOptions
): Promise<AsyncIterable<MailHeaderResult[]>> => {
  const userId = resolveUserId(user);
  if (!userId) return noBatches();

  const { from, size } = options.pagination || new Pagination();

  const ids = await pgGetUnifiedMailHeaderIds(userId, addresses, { from, size });
  return pgGetMailHeadersByIds(userId, ids);
};

export const getUnifiedMailHeadersDelta = async (
  user: MaskedUser | SignedUser,
  addresses: string[],
  since: string
): Promise<MailHeadersDelta> => {
  const userId = resolveUserId(user);
  if (!userId) return { as_of: since, headers: [], expunged_ids: [] };

  const { as_of, headers, expunged_ids } =
    await pgGetUnifiedMailHeadersDelta(userId, addresses, since);

  return { as_of, headers: headers.map(toMailHeaderData), expunged_ids };
};
