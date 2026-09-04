import fs from "fs";

import {
  MailAddressType,
  MailAddressValueType,
  getRandomId,
  IncomingMail,
  IncomingMailAddress,
  IncomingMailAddressValue,
  IncomingAttachment,
  Mail,
  Attachment,
  MailUid,
  MaskedUser,
} from "common";

import {
  saveMail as pgSaveMail,
  SaveMailInput,
  INBOX_VIEW,
  getDomainUidNext as pgGetDomainUidNext,
  getAccountUidNext as pgGetAccountUidNext,
} from "../postgres/repositories/mails";
import { getUser, getText, getDomain } from "server";
import {
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachmentId,
} from "./util";
import { push } from "../push";
import { accountToBox, accountToSentBox } from "../imap/util";
import { checkSpam, SpamCheckResult, EmailContext } from "../spam";
import { sendAlarm } from "../alarm";
import { logger } from "../logger";

export interface SaveMailHandlerOptions {
  remoteAddress?: string;
}

export const saveMailHandler = async (
  _: unknown,
  data: IncomingMail,
  options: SaveMailHandlerOptions = {}
) => {
  const envelopeTo = JSON.stringify(convertAddressValue(data.envelopeTo));
  const from = JSON.stringify(convertMailAddress(data.from)?.value);
  logger.info("Received an email", { timestamp: new Date().toISOString(), envelopeTo, from });

  const domain = getDomain();
  const validData = validateIncomingMail(data, domain);
  if (!validData) {
    logger.warn("Recipient is not valid. Mails is not saved.");
    return;
  }

  const usernames = getUsernamesFromIncomingMail(validData);
  await Promise.all(
    usernames.map((u) => saveIncomingMail(u, validData, { remoteAddress: options.remoteAddress }))
  );
  logger.info("Successfully saved an email");

  const mailboxes = getMailboxesFromIncomingMail(validData);
  await push.notifyNewMails(usernames, mailboxes);
  logger.info(`Sent push notifications to users: [${usernames.toString()}]`);
};

interface SaveIncomingMailOptions {
  remoteAddress?: string;
}

const saveIncomingMail = async (
  username: string,
  incoming: IncomingMail,
  options: SaveIncomingMailOptions = {}
) => {
  const user = await getUser({ username });
  if (!user) {
    logger.warn(`User not found for username: ${username}`);
    logger.warn("Skipping saving mail", { incoming });
    return;
  }

  const mail = await convertMail(user, incoming);

  // Run spam check
  let spamResult: SpamCheckResult | undefined;
  if (user.id) {
    try {
      const emailContext: EmailContext = {
        fromAddress: mail.from?.value?.[0]?.address,
        fromName: mail.from?.text,
        replyToAddress: mail.replyTo?.value?.[0]?.address,
        subject: incoming.subject,
        text: incoming.text,
        html: incoming.html,
        remoteAddress: options.remoteAddress,
      };

      spamResult = await checkSpam(user.id, emailContext);
      
      if (spamResult.isSpam) {
        logger.info(`[SpamFilter] Email marked as spam for user ${username}`, { score: spamResult.score, reasons: spamResult.reasons });
      }
    } catch (error) {
      logger.warn("[SpamFilter] Spam check failed, proceeding without spam filtering", {}, error);
    }
  }

  return saveMail(mail, user?.id, spamResult);
};

export const saveMail = async (
  mail: Mail,
  userId?: string,
  spamResult?: SpamCheckResult
): Promise<{ _id: string } | undefined> => {
  if (!userId) return;

  const scopeAddress = mail.sent
    ? mail.envelopeFrom?.[0]?.address
    : mail.envelopeTo?.[0]?.address;
  const mailbox = scopeAddress
    ? mail.sent
      ? accountToSentBox(scopeAddress)
      : accountToBox(scopeAddress)
    : undefined;

  const input: SaveMailInput = {
    user_id: userId,
    message_id: mail.messageId,
    subject: mail.subject,
    date: mail.date,
    html: mail.html,
    text: mail.text,
    from_address: mail.from?.value,
    from_text: mail.from?.text,
    to_address: mail.to?.value,
    to_text: mail.to?.text,
    cc_address: mail.cc?.value,
    cc_text: mail.cc?.text,
    bcc_address: mail.bcc?.value,
    bcc_text: mail.bcc?.text,
    reply_to_address: mail.replyTo?.value,
    reply_to_text: mail.replyTo?.text,
    envelope_from: mail.envelopeFrom,
    envelope_to: mail.envelopeTo,
    attachments: mail.attachments,
    read: mail.read,
    saved: mail.saved,
    sent: mail.sent,
    deleted: mail.deleted,
    draft: mail.draft,
    uid_domain: mail.uid?.domain,
    uid_mailbox: mail.uid?.account,
    mailbox,
    spam_score: spamResult?.score ?? 0,
    spam_reasons: spamResult?.reasons ?? null,
    is_spam: spamResult?.isSpam ?? false,
    // Received mail is in the INBOX tree; the per-account view above is a
    // sub-view beneath it, and records its own row against `uid_mailbox`.
    // Whether the row that ends up written may hold that membership is
    // `decideMappingWrites`' question — it gates on the written row's own
    // `sent`, which on the merge branch is the surviving row's, not this one's.
    domain_mailbox: INBOX_VIEW,
  };

  try {
    return await pgSaveMail(input);
  } catch (error) {
    logger.error("Error saving mail", {}, error);
    const alarmTitle = mail.sent ? "Mail Send Save Failed" : "Mail Receive Failed";
    sendAlarm(
      alarmTitle,
      `**Error:** ${error instanceof Error ? error.message : String(error)}`
    ).catch(() => undefined);
    try {
      const errorFilePath = `./error/${Date.now()}`;
      const errorContent = JSON.stringify({ ...mail, error });
      if (!fs.existsSync("./error")) fs.mkdirSync("./error");
      fs.writeFileSync(errorFilePath, errorContent);
    } catch (fsError) {
      logger.warn("Failed to persist mail error dump", {}, fsError);
    }
    throw error;
  }
};

export const convertMail = async (
  user: MaskedUser,
  incoming: IncomingMail
): Promise<Mail> => {
  const from = convertMailAddress(incoming.from);
  const to = convertMailAddress(incoming.to);
  const cc = convertMailAddress(incoming.cc);
  const bcc = convertMailAddress(incoming.bcc);
  const replyTo = convertMailAddress(incoming.replyTo);

  const envelopeFrom = convertAddressValue(incoming.envelopeFrom);
  // convertAddressValue returns undefined when no usable address survives
  // (empty input, or every entry filtered out). envelopeTo is dereferenced
  // below and passed to Mail as a non-null array, so default to [].
  const envelopeTo = convertAddressValue(incoming.envelopeTo) ?? [];

  const attachments = await convertAttachments(incoming.attachments);

  const {
    subject = "",
    date = new Date().toISOString(),
    html = "",
    text: incomingText,
    messageId = getRandomId(),
  } = incoming;

  const text = incomingText ?? getText(html);
  const envelopeToAddress = envelopeTo[0]?.address || "";

  if (!user.id) {
    throw new Error("User ID is required to save mail");
  }

  const [domainUid, accountUid] = await Promise.all([
    pgGetDomainUidNext(user.id!),
    pgGetAccountUidNext(user.id!, envelopeToAddress),
  ]);

  const uid = new MailUid({ domain: domainUid, account: accountUid });

  return new Mail({
    messageId,
    attachments,
    to,
    from,
    cc,
    bcc,
    replyTo,
    envelopeTo,
    envelopeFrom,
    text,
    date,
    html,
    subject,
    read: false,
    saved: false,
    sent: false,
    uid,
  });
};

export const convertMailAddress = (
  incoming?: IncomingMailAddress | IncomingMailAddress[]
): MailAddressType | undefined => {
  if (!incoming) return undefined;
  if (Array.isArray(incoming)) {
    if (!incoming.length) return undefined;
    const value = convertAddressValue(incoming.flatMap(({ value }) => value));
    if (!value) return undefined;
    const text = incoming.map(({ text }) => text).join(", ");
    return { value, text };
  }
  const value = convertAddressValue(incoming.value);
  if (!value) return undefined;
  const { text } = incoming;
  return { value, text };
};

export const convertAddressValue = (
  incoming?: IncomingMailAddressValue | IncomingMailAddressValue[]
) => {
  if (!incoming) return undefined;
  const array: MailAddressValueType[] = [];
  const push = (entry: IncomingMailAddressValue) => {
    // RFC 2822 group addresses (`"Team": a@x.com, b@x.com;`) arrive with the
    // members on `entry.group` and an empty top-level `address`. Recurse into
    // the members so they aren't dropped as `{ address: "" }`.
    if (entry.group) {
      const members = Array.isArray(entry.group) ? entry.group : [entry.group];
      members.forEach(push);
      return;
    }
    const address = entry.address?.toLowerCase().trim();
    if (!address) return; // drop empty/whitespace-only addresses
    // Some parsed entries arrive comma-concatenated in a single `address`
    // string (`"alice@x.com, bob@x.com"`). A valid address never contains a
    // comma, so split into separate rows rather than storing a phantom one.
    if (address.includes(",")) {
      address
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
        .forEach((a) => array.push({ address: a, name: entry.name }));
      return;
    }
    array.push({ address, name: entry.name });
  };
  if (Array.isArray(incoming)) {
    if (incoming.length) incoming.forEach(push);
    else return undefined;
  } else push(incoming);
  return array.length ? array : undefined;
};

const convertAttachments = async (
  incoming?: IncomingAttachment | IncomingAttachment[]
): Promise<Attachment[] | undefined> => {
  if (!incoming) return undefined;
  const array: IncomingAttachment[] = [];
  if (Array.isArray(incoming)) array.push(...incoming);
  else array.push(incoming);
  const attachments = array.map(convertAttachment);
  return Promise.all(attachments);
};

const convertAttachment = async ({
  content,
  filename,
  contentType,
  size,
}: IncomingAttachment) => {
  const isDataExist = typeof content === "object" && "data" in content;
  const data = isDataExist ? content.data : content;
  const id = await saveBuffer(data);
  return new Attachment({
    filename,
    contentType,
    content: { data: id },
    size,
  });
};

export const saveBuffer = async (buffer: Buffer | string): Promise<string> => {
  const id = getAttachmentId();
  fs.mkdirSync(ATTACHMENT_FOLDER, { recursive: true });
  const attachmentFilePath = getAttachmentFilePath(id);
  const bytes = typeof buffer === "string" ? Buffer.from(buffer, "base64") : buffer;
  // Wrap in Uint8Array to satisfy strict @types/node: Buffer.slice().buffer is
  // ArrayBufferLike (includes SharedArrayBuffer), but writeFile needs ArrayBuffer.
  await fs.promises.writeFile(attachmentFilePath, new Uint8Array(bytes));
  return id;
};

const getUsernamesFromIncomingMail = (data: IncomingMail): string[] => {
  const { envelopeTo } = data;
  if (!envelopeTo) return [];
  const array: MailAddressValueType[] = [];
  if (Array.isArray(envelopeTo)) array.push(...envelopeTo);
  else array.push(envelopeTo);
  const domain = getDomain();
  return array
    .filter((e) => e.address && isValidAddress(e.address, domain))
    .map((e) => addressToUsername(e.address as string));
};

const getMailboxesFromIncomingMail = (data: IncomingMail): string[] => {
  const { envelopeTo } = data;
  if (!envelopeTo) return [];
  const array: MailAddressValueType[] = [];
  if (Array.isArray(envelopeTo)) array.push(...envelopeTo);
  else array.push(envelopeTo);
  const domain = getDomain();
  return array
    .filter((e) => e.address && isValidAddress(e.address, domain))
    .map((e) => accountToBox(e.address as string));
};

const isValidAddress = (address: string, domain: string) => {
  const parsedAddress = address.split("@");
  const domainInData = parsedAddress[parsedAddress.length - 1].toLowerCase();
  const target = domain.toLowerCase();
  return domainInData === target || domainInData.endsWith(`.${target}`);
};

export const validateIncomingMail = (
  data?: IncomingMail,
  domainName?: string
): IncomingMail | undefined => {
  if (!data || !domainName) return undefined;

  const { envelopeTo } = data;
  if (!envelopeTo) return undefined;

  const addressArray: MailAddressValueType[] = [];
  if (Array.isArray(envelopeTo)) addressArray.push(...envelopeTo);
  else addressArray.push(envelopeTo);

  const isAddressCorrect = !!addressArray.find((e) => {
    return e.address && isValidAddress(e.address, domainName);
  });

  if (isAddressCorrect) return data as IncomingMail;
  return undefined;
};

export const addressToUsername = (address: string) => {
  const domain = getDomain();
  const parsedAddress = address.split("@");
  const domainInAddress = parsedAddress[parsedAddress.length - 1];
  const subDomain = domainInAddress.split(`.${domain}`)[0]?.toLowerCase();
  return subDomain === domain ? "admin" : subDomain;
};
