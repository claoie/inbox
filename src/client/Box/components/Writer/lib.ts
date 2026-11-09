import { ReplyData } from "common";
import { getDateForMailHeader } from "client/lib/formatters";

export interface OriginalMessage {
  id: string;
  messageId: string;
  subject: string;
  prefix: string;
  html: string;
}

export type OriginalMessageMeta = Omit<OriginalMessage, "html">;

export const EMPTY_ORIGINAL_META: OriginalMessageMeta = {
  id: "",
  messageId: "",
  subject: "",
  prefix: ""
};

export const wrapQuoteHtml = (html: string) =>
  `<blockquote style="border-left: 1px solid #cccccc; padding: 0 0 0 0.5rem; margin: 0 0 0 0.5rem;">${html || ""}</blockquote>`;

export const replyDataToOriginalMessage = (
  replyData: ReplyData
): OriginalMessage => {
  if (!replyData || !replyData.id) {
    return {
      id: "",
      messageId: "",
      subject: "",
      prefix: "",
      html: ""
    };
  }
  const { id, messageId, date, subject, from, html } = replyData;

  const parsedDate = date ? new Date(date) : new Date();
  const { date: localeDate, time: localeTime } = getDateForMailHeader(parsedDate);

  const fromText = from?.text || "Unknown";
  const prefix = `On ${localeDate} at ${localeTime}, ${fromText} wrote:`;

  return {
    id: id || "",
    messageId: messageId || "",
    subject: subject || "",
    prefix,
    html: wrapQuoteHtml(html || "")
  };
};

/** The signature as HTML: its lines escaped and kept as line breaks. */
export const signatureHtml = (signature: string) => {
  if (!signature.trim()) return "";
  const escaped = signature
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<p>${escaped.split(/\r?\n/).join("<br>")}</p>`;
};

export const getReplyContainerHtml = (originalMessage: OriginalMessage) => {
  const inner =
    `<p>${originalMessage.prefix
      .replace("<", "&lt;")
      .replace(">", "&gt;")}</p>` + originalMessage.html;
  return `<div class="replace_with_details">${inner}</div>`;
};
