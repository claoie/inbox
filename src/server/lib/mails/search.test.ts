import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the postgres repository
const mockSearchMails = mock(() => Promise.resolve([]));

mock.module("../postgres/repositories/mails", () => ({
  searchMails: mockSearchMails,
}));

import { searchMail } from "./search";
import { SignedUser } from "common";

const mockUser = new SignedUser({
  id: "user-123",
  username: "testuser",
  email: "test@example.com",
});

describe("searchMail", () => {
  beforeEach(() => {
    mockSearchMails.mockClear();
    mockSearchMails.mockResolvedValue([]);
  });

  it("should return empty array for empty search value", async () => {
    const result = await searchMail(mockUser, "");
    expect(result).toEqual([]);
    expect(mockSearchMails).not.toHaveBeenCalled();
  });

  it("should return empty array for whitespace-only search value", async () => {
    const result = await searchMail(mockUser, "   ");
    expect(result).toEqual([]);
    expect(mockSearchMails).not.toHaveBeenCalled();
  });

  it("should call searchMails with trimmed value", async () => {
    await searchMail(mockUser, "  hello  ");
    expect(mockSearchMails).toHaveBeenCalledWith("user-123", "hello", undefined);
  });

  it("should call searchMails with field when provided", async () => {
    await searchMail(mockUser, "test", "subject");
    expect(mockSearchMails).toHaveBeenCalledWith("user-123", "test", "subject");
  });

  it("should map SearchMailResult to MailHeaderData", async () => {
    const mockMailModel = {
      mail_id: "mail-abc",
      subject: "Test Subject",
      date: "2024-01-01T00:00:00Z",
      from_address: [{ address: "sender@example.com", name: "Sender" }],
      from_text: "Sender <sender@example.com>",
      to_address: [{ address: "recipient@example.com", name: "Recipient" }],
      to_text: "Recipient <recipient@example.com>",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: true,
      is_spam: true,
      insight: null,
      highlight: "Test <em>Subject</em>",
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser, "subject");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mail-abc");
    expect(results[0].subject).toBe("Test Subject");
    expect(results[0].read).toBe(false);
    expect(results[0].saved).toBe(true);
    expect(results[0].highlight).toBe("Test <em>Subject</em>");
  });

  it("should map envelope_to when present", async () => {
    // A BCC delivery's search hit resolves its account the same way the
    // list rows do.
    const mockMailModel = {
      mail_id: "mail-envelope",
      subject: "BCC Email",
      date: "2024-01-01T00:00:00Z",
      from_address: [{ address: "sender@example.com", name: "Sender" }],
      from_text: "Sender <sender@example.com>",
      to_address: [{ address: "list@example.com", name: "List" }],
      to_text: "List <list@example.com>",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      envelope_to: [{ address: "b@example.com" }],
      read: false,
      saved: false,
      sent: false,
      is_spam: false,
      insight: null,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser, "subject");
    expect(results).toHaveLength(1);
    expect(results[0].envelopeTo?.value).toEqual([
      { address: "b@example.com" },
    ]);
  });

  it("builds the snippet from the bounded text prefix", async () => {
    mockSearchMails.mockResolvedValue([
      {
        mail_id: "m-snippet",
        subject: "s",
        date: "2024-01-01T00:00:00Z",
        read: false,
        saved: false,
        sent: false,
        text_prefix: "Hello there\n> quoted line",
      },
    ] as never);

    const results = await searchMail(mockUser, "hello");
    expect(results.map((r) => r.snippet)).toEqual(["Hello there"]);
  });

  it("should handle null from/to addresses gracefully", async () => {
    const mockMailModel = {
      mail_id: "mail-xyz",
      subject: "No Addresses",
      date: "2024-01-01T00:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: true,
      saved: false,
      insight: null,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser, "test");
    expect(results).toHaveLength(1);
    expect(results[0].from).toBeUndefined();
    expect(results[0].to).toBeUndefined();
  });

  it("should forward sent so the spam gate sees the delivery lane", async () => {
    mockSearchMails.mockResolvedValue([
      { mail_id: "m-sent", subject: "s", date: "2024-01-01T00:00:00Z", read: false, saved: false, sent: true },
      { mail_id: "m-received", subject: "r", date: "2024-01-01T00:00:00Z", read: false, saved: false, sent: false },
    ] as never);
    const result = await searchMail(mockUser, "q");
    expect(result.map((m) => m.sent)).toEqual([true, false]);
  });

  it("flags spam matches and leaves the flag off everything else", async () => {
    mockSearchMails.mockResolvedValue([
      { mail_id: "m-spam", subject: "s", date: "2024-01-01T00:00:00Z", read: false, saved: false, sent: false, is_spam: true },
      { mail_id: "m-ham", subject: "h", date: "2024-01-01T00:00:00Z", read: false, saved: false, sent: false, is_spam: false },
    ] as never);
    const result = await searchMail(mockUser, "q");
    expect(result[0].spam).toBe(true);
    expect("spam" in result[1]).toBe(false);
  });

  it("should map cc and bcc addresses when present", async () => {
    const mockMailModel = {
      mail_id: "mail-cc",
      subject: "With CC/BCC",
      date: "2024-01-01T00:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: [{ address: "cc@example.com" }],
      cc_text: "cc@example.com",
      bcc_address: [{ address: "bcc@example.com" }],
      bcc_text: "bcc@example.com",
      read: false,
      saved: false,
      insight: null,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser, "cc");
    expect(results[0].cc).toBeDefined();
    expect(results[0].bcc).toBeDefined();
  });

  it("should map insight when present", async () => {
    const insight = { category: "newsletter", summary: "A newsletter" };
    const mockMailModel = {
      mail_id: "mail-insight",
      subject: "Newsletter",
      date: "2024-01-01T00:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: false,
      insight,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser, "newsletter");
    expect(results[0].insight).toEqual(insight);
  });

  it("should return multiple results", async () => {
    const models = [
      { mail_id: "m1", subject: "First", date: "2024-01-01", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: false, saved: false, insight: null, highlight: undefined },
      { mail_id: "m2", subject: "Second", date: "2024-01-02", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: true, saved: false, insight: null, highlight: undefined },
    ];
    mockSearchMails.mockResolvedValue(models);

    const results = await searchMail(mockUser, "query");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("m1");
    expect(results[1].id).toBe("m2");
  });
});
