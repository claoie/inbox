import { randomUUID } from "crypto";
import fs from "fs";
import { UploadedFile } from "express-fileupload";
import {
  AttachmentType,
  Mail,
  MailDataToSend,
  MailUid,
  SignedUser
} from "common";
import {
  getUserDomain,
  saveMail,
  getText,
  saveBuffer,
  getDomainUidNext,
  getAccountUidNext
} from "server";
import { sendMailgunMail } from "./mailgun";
import { validateMailData, MailValidationError } from "./validation";
import { sendAlarm } from "../alarm";
import { logger } from "../logger";

export class MailSendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendingError";
  }
}

export type UploadedFileDynamicArray = UploadedFile | UploadedFile[];

export type SendMailOptions = {
  /**
   * Whether the delivered mail is also written to the sender's Sent mailbox.
   * Defaults to true; pass `false` for transactional mail whose body carries a
   * live bearer credential, so the credential is never retrievable by anyone
   * who can read the sending identity's mail.
   */
  persistToSentMailbox?: boolean;
};

export const sendMail = async (
  user: SignedUser,
  mailToSend: MailDataToSend,
  files?: UploadedFileDynamicArray,
  options?: SendMailOptions
) => {
  // Validate mail data before sending
  const validation = validateMailData(mailToSend);
  if (!validation.valid) {
    throw new MailValidationError(validation.error!);
  }

  const { persistToSentMailbox = true } = options ?? {};
  const { id: userId, username } = user;
  try {
    const response = await sendMailgunMail(username, mailToSend, files);
    if (!persistToSentMailbox) return response;
    const messageId = response?.id || randomUUID();
    let sentMail;
    try {
      sentMail = await getSentMail(user, mailToSend, messageId, files);
    } catch (getSentMailError) {
      logger.error(
        "Mailgun accepted the send but building the local Sent record failed",
        { mailgunMessageId: response?.id },
        getSentMailError
      );
      sendAlarm(
        "Mail Send Save Failed",
        `**Error:** ${getSentMailError instanceof Error ? getSentMailError.message : String(getSentMailError)}\n**Mailgun message-id:** ${response?.id ?? "unknown"}`
      ).catch(() => undefined);
      return response;
    }
    try {
      await saveMail(sentMail, userId);
    } catch (saveError) {
      // receive.ts saveMail's catch already fired `Mail Send Save Failed`
      // + wrote ./error/&lt;ts&gt; before re-throwing. Don't double-alarm; just
      // log with the mailgun message-id for cross-correlation.
      logger.error(
        "Mailgun accepted the send but local Sent-record save failed — recipient got the mail, per-mailbox mapping missing",
        { mailgunMessageId: response?.id },
        saveError
      );
    }

    return response;
  } catch (error: unknown) {
    logger.error("Email sending request failed", {}, error);
    sendAlarm(
      "Mail Send Failed",
      `**Error:** ${error instanceof Error ? error.message : String(error)}`
    ).catch(() => undefined);

    // Provide user-friendly error messages for common Mailgun errors
    let message = "Failed to send email. Please try again.";

    const err = error as { status?: number; message?: string; code?: string };
    if (err?.status === 401 || err?.status === 403) {
      message = "Email service not configured correctly";
    } else if (err?.status === 400) {
      message = err?.message || "Invalid email request";
    } else if (err?.status === 429) {
      message = "Too many requests. Please try again later.";
    } else if (err?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED") {
      message = "Unable to reach email service. Please try again later.";
    } else if (err?.code === "ECONNRESET" || (error as { details?: string })?.details === "socket hang up") {
      message = err?.message || "Failed to send email. Please try again.";
    }

    throw new MailSendingError(message);
  }
};

/**
 * Split a comma-separated address string into address objects, lowercasing
 * each address. Mirrors the receive-path normalization in `convertAddressValue`
 * (receive.ts) so stored addresses group case-insensitively — without this the
 * send path stored addresses verbatim, fragmenting the per-account list when a
 * sender/recipient was typed with any uppercase letter.
 */
export const parseAddressList = (str: string) =>
  str
    .split(",")
    .map((addr) => addr.trim())
    .filter(Boolean)
    .map((address) => ({ address: address.toLowerCase() }));

/**
 * Builds a stored recipient field, or `undefined` when the list is empty so
 * the column stays NULL and the IMAP ENVELOPE emits NIL.
 */
export const addressField = (list?: string) =>
  !list ? undefined : { value: parseAddressList(list), text: list };

/**
 * Builds the stored envelope recipient list — every address the submission was
 * delivered to, across all three header fields. A Bcc-only send names nobody in
 * `To:`, so a `to`-only list would leave the record with no recipients at all.
 */
export const envelopeRecipients = (...lists: (string | undefined)[]) =>
  parseAddressList(lists.filter(Boolean).join(","));

const getSentMail = async (
  user: SignedUser,
  mailToSend: MailDataToSend,
  messageId: string,
  files?: UploadedFileDynamicArray
): Promise<Mail> => {
  const { username } = user;
  const { sender, senderFullName, to, cc, bcc, subject, html } = mailToSend;

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const fromEmail = `${sender}@${userDomain}`.toLowerCase();
  const attachments = (await getAttachmentsToSave(files)) || [];

  const [domainUid, accountUid] = await Promise.all([
    getDomainUidNext(user.id, true),
    getAccountUidNext(user.id, fromEmail, true)
  ]);

  const uid = new MailUid({ domain: domainUid, account: accountUid });

  return new Mail({
    subject,
    text,
    html,
    date: new Date().toISOString(),
    attachments,
    messageId: `<${messageId}@${userDomain}>`,
    from: {
      value: [{ name: senderFullName || undefined, address: fromEmail }],
      text: senderFullName ? `${senderFullName} <${fromEmail}>` : fromEmail
    },
    to: addressField(to),
    cc: addressField(cc),
    bcc: addressField(bcc),
    envelopeFrom: [{ name: senderFullName || undefined, address: fromEmail }],
    envelopeTo: envelopeRecipients(to, cc, bcc),
    replyTo: {
      value: [{ name: senderFullName || undefined, address: fromEmail }],
      text: fromEmail
    },
    read: true,
    sent: true,
    saved: false,
    uid
  });
};

const getAttachmentsToSave = async (files?: UploadedFileDynamicArray) => {
  const noFiles = Array.isArray(files) ? !files.length : !files;
  if (noFiles) return undefined;

  const attachmentsToSave: AttachmentType[] = [];

  const parseFile = async (file: UploadedFile) => {
    // With useTempFiles:true, file.data is an empty Buffer — read from tempFilePath.
    const buffer = file.tempFilePath
      ? fs.readFileSync(file.tempFilePath)
      : file.data;
    attachmentsToSave.push({
      content: { data: await saveBuffer(buffer) },
      filename: file.name,
      contentType: file.mimetype,
      size: file.size
    });
  };

  if (Array.isArray(files)) await Promise.all(files.map(parseFile));
  else if (files) await parseFile(files as UploadedFile);

  return attachmentsToSave;
};

export const addressParser = (str: string) => {
  const result = str
    .split(",")
    .map((e) => e.replace(/ /g, ""))
    .filter((str) => typeof str === "string" && str.split("@").length === 2)
    .map((e) => ({ email: e }));
  return result;
};
