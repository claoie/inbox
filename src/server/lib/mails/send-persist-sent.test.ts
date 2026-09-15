/**
 * `persistToSentMailbox: false` is what keeps a live bearer credential out of
 * the sending identity's Sent mailbox — the `/token` flow relies on it, and a
 * read-only session reads admin's mail by design, so a Sent record there is a
 * write credential handed to a read-only caller.
 *
 * The property is "`sendMail`, given that option, writes no Sent record" — not
 * "the caller passes an option object", which a mocked `sendMail` is all that
 * can assert. These drive the real one and assert on `saveMail` itself.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { MailDataToSend, SignedUser } from "common";

const REAL_SERVER = (globalThis as Record<string, unknown>).__REAL_SERVER as Record<
  string,
  unknown
>;

const mockSaveMail = mock(async () => undefined);
const mockSendMailgunMail = mock(async () => ({ id: "mailgun-message-id" }));

mock.module("server", () => ({
  ...REAL_SERVER,
  saveMail: mockSaveMail,
  getUserDomain: (username: string) => `${username}.example.com`,
  getText: (html: string) => html,
  saveBuffer: async () => "buffer-id",
  getDomainUidNext: async () => 1,
  getAccountUidNext: async () => 1,
}));

mock.module("./mailgun", () => ({ sendMailgunMail: mockSendMailgunMail }));

const { sendMail } = await import("./send");

// `mock.module` is process-global with no unmock API — hand the real barrel
// back so the next file in the same run does not inherit these stubs.
afterAll(() => {
  if (REAL_SERVER) mock.module("server", () => REAL_SERVER);
});

const USER = new SignedUser({
  id: "11111111-2222-3333-4444-555555555555",
  username: "admin",
  email: "admin@example.com",
});

const MAIL = new MailDataToSend({
  sender: "admin",
  senderFullName: "",
  to: "recipient@external.com",
  cc: undefined,
  bcc: undefined,
  subject: "Sign in",
  html: "<p>token</p>",
  inReplyTo: undefined,
});

beforeEach(() => {
  mockSaveMail.mockClear();
  mockSendMailgunMail.mockClear();
});

describe("sendMail — persistToSentMailbox", () => {
  it("writes no Sent record when the option is false", async () => {
    const response = await sendMail(USER, MAIL, undefined, {
      persistToSentMailbox: false,
    });

    expect(mockSendMailgunMail).toHaveBeenCalledTimes(1);
    expect(mockSaveMail).toHaveBeenCalledTimes(0);
    expect(response).toEqual({ id: "mailgun-message-id" });
  });

  it("writes the Sent record when the option is omitted", async () => {
    await sendMail(USER, MAIL);

    expect(mockSendMailgunMail).toHaveBeenCalledTimes(1);
    expect(mockSaveMail).toHaveBeenCalledTimes(1);
  });

  it("writes the Sent record when the option is explicitly true", async () => {
    await sendMail(USER, MAIL, undefined, { persistToSentMailbox: true });

    expect(mockSaveMail).toHaveBeenCalledTimes(1);
  });
});
