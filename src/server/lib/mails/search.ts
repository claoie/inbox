import { MailHeaderData, SignedUser, MailAddressValueType, Insight } from "common";
import { searchMails, SearchMailResult } from "../postgres/repositories/mails";
import { buildSnippet } from "./snippet";

export const searchMail = async (
  user: SignedUser,
  value: string,
  field?: string
): Promise<MailHeaderData[]> => {
  // Clean search value - less aggressive since we use plainto_tsquery
  value = value.trim();
  if (!value) return [];

  const mailModels = await searchMails(user.id, value, field);

  return mailModels.map((m: SearchMailResult) => {
    return new MailHeaderData({
      id: m.mail_id,
      subject: m.subject,
      date: m.date,
      from: m.from_address
        ? { value: m.from_address as MailAddressValueType[], text: m.from_text || "" }
        : undefined,
      to: m.to_address
        ? { value: m.to_address as MailAddressValueType[], text: m.to_text || "" }
        : undefined,
      read: m.read,
      saved: m.saved,
      sent: m.sent,
      insight: m.insight as Insight | undefined,
      cc: m.cc_address
        ? { value: m.cc_address as MailAddressValueType[], text: m.cc_text || "" }
        : undefined,
      bcc: m.bcc_address
        ? { value: m.bcc_address as MailAddressValueType[], text: m.bcc_text || "" }
        : undefined,
      ...(m.envelope_to
        ? {
            envelopeTo: {
              value: m.envelope_to as MailAddressValueType[],
              text: "",
            },
          }
        : {}),
      highlight: m.highlight,
      snippet: buildSnippet(m.text_prefix),
      // Search spans the spam folder; the row says so.
      ...(m.is_spam ? { spam: true } : {}),
    });
  });
};
