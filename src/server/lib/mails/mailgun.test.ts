import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// The host domain is the sender's own domain, as it is for an admin in
// production, so the visible-To assertions run against the shape that ships.
// It also has to differ from the module's own "mydomain" default, or an
// assertion about it passes just as well against a build that never reads it.
process.env.EMAIL_DOMAIN = "example.com";
process.env.MAILGUN_KEY = "test-key";

// Mock fs first (before mailgun.ts is imported)
const mockReadFileSync = mock(() => Buffer.from("file-content"));
mock.module("fs", () => ({
  default: { readFileSync: mockReadFileSync },
  readFileSync: mockReadFileSync,
}));

// Mock form-data
mock.module("form-data", () => ({
  default: class FormData {},
}));

// Track mailgun API calls
const mockMessagesCreate = mock(() =>
  Promise.resolve({ id: "msg-id-123", message: "Queued. Thank you." })
);

// Mock mailgun.js — the module exports a default class whose instances have .client()
mock.module("mailgun.js", () => {
  class MockMailgun {
    client(_opts: unknown) {
      return { messages: { create: mockMessagesCreate } };
    }
  }
  return { default: MockMailgun };
});

// Mock logger
const mockLoggerError = mock(() => {});
mock.module("../logger", () => ({
  logger: {
    info: mock(() => {}),
    error: mockLoggerError,
    warn: mock(() => {}),
    debug: mock(() => {}),
  },
}));

// Mock server exports — only getUserDomain is mocked; getText uses real implementation
// to avoid contaminating util.test.ts via bun's shared module registry. The
// mapping matches the real one's shape: admin sits on the host domain itself,
// every other user on a subdomain of it.
mock.module("server", () => ({
  getUserDomain: (username: string) =>
    username === "admin" ? "example.com" : `${username}.example.com`,
}));

import { sendMailgunMail } from "./mailgun";
import { MailDataToSend } from "common";

// Restore the process-global `fs` mock so subsequent test files see the
// real bindings. Bun's `mock.module` replaces the export graph-wide
// with no per-file scope; preload captures the real `fs` onto
// `__REAL_FS` (see `reference_bun_mock_module_global_hoisting.md`).
afterAll(() => {
  const realFs = (globalThis as Record<string, unknown>).__REAL_FS;
  if (realFs) mock.module("fs", () => realFs);
});

const baseMail = new MailDataToSend({
  sender: "admin",
  senderFullName: "",
  to: "recipient@external.com",
  cc: undefined,
  bcc: undefined,
  subject: "Test Subject",
  html: "<p>Hello</p>",
  inReplyTo: undefined,
});

describe("sendMailgunMail", () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockMessagesCreate.mockResolvedValue({ id: "msg-id-123", message: "Queued. Thank you." });
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue(Buffer.from("file-content"));
    mockLoggerError.mockReset();
    process.env.EMAIL_DOMAIN = "example.com";
    process.env.MAILGUN_KEY = "test-key";
  });

  it("should send when recipients include external addresses", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "external@gmail.com" });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalled();
  });

  it("should pass the envelope to as an array of trimmed addresses", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "a@gmail.com, b@yahoo.com" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    const toList: string[] = Array.isArray(msgData.to) ? msgData.to : [msgData.to];
    expect(toList).toContain("a@gmail.com");
    expect(toList).toContain("b@yahoo.com");
  });

  // Mailgun renders a `To:` header from the `to:` parameter on its own.
  // Passing `h:To` as well appends a SECOND `To:` header to the RFC 5322
  // message, which Gmail rejects with `5.7.1 … multiple To headers`. Keep
  // the envelope-only shape.
  it("should not set the h:To custom header (would duplicate the To: header)", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "a@gmail.com, b@yahoo.com" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:To"]).toBeUndefined();
  });

  it("should format from address with senderFullName when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, senderFullName: "Admin User" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toContain("Admin User");
    expect(msgData.from).toContain("admin@");
  });

  it("should format from address without senderFullName when not provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, senderFullName: "" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toContain("admin@");
    expect(msgData.from).not.toContain(" <"); // no name part
  });

  it("should include subject, html, and text in message", async () => {
    const mail = new MailDataToSend({ ...baseMail, subject: "My Test Subject", html: "<p>Hello World</p>" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.subject).toBe("My Test Subject");
    expect(msgData.html).toBe("<p>Hello World</p>");
    expect(msgData.text).toBeDefined();
  });

  it("should include cc and bcc when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, cc: "cc@external.com", bcc: "bcc@external.com" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.cc).toBe("cc@external.com");
    expect(msgData.bcc).toBe("bcc@external.com");
  });

  it("should send a Bcc-only submission one message per recipient", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "hidden@external.com, other@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    const payloads = mockMessagesCreate.mock.calls.map((call) => call[1]);
    expect(payloads.map((data) => data.to)).toEqual([
      ["hidden@external.com"],
      ["other@external.com"],
    ]);
  });

  it("should never disclose one bcc recipient to another", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "hidden@external.com, other@external.com",
    });
    await sendMailgunMail("admin", mail);
    mockMessagesCreate.mock.calls.forEach((call) => {
      const data = call[1];
      const toList = data.to as string[];
      expect(toList).toHaveLength(1);
      expect(data.bcc).toBeUndefined();
      expect(data.cc).toBeUndefined();
    });
  });

  it("should never hand Mailgun a host-domain recipient on a Bcc-only send", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "inside@example.com, outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toBe("admin@example.com");
    expect(msgData.to).toEqual(["outside@gmail.com"]);
  });

  it("should keep a non-admin sender's own subdomain address out of the To", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      sender: "bob",
      to: "",
      bcc: "outside@gmail.com",
    });
    await sendMailgunMail("bob", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toBe("bob@bob.example.com");
    expect(msgData.to).toEqual(["outside@gmail.com"]);
  });

  it("should read each attachment once regardless of the recipient count", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com, three@external.com",
    });
    const mockFile = {
      name: "test.pdf",
      mimetype: "application/pdf",
      size: 1024,
      tempFilePath: "/tmp/uploaded-file.pdf",
      data: Buffer.alloc(0),
    };
    await sendMailgunMail(
      "admin",
      mail,
      mockFile as import("express-fileupload").UploadedFile
    );
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("should skip Mailgun only when every recipient across to/cc/bcc is host-domain", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      cc: "colleague@example.com",
      bcc: "another@example.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("should still send when the only external recipient sits in bcc", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      bcc: "outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.to).toEqual(["outside@gmail.com"]);
  });

  // The egress guard reads the union of all three lists, and a cc-only send is
  // the one shape where cc is the member holding it open — every other fixture
  // with an external cc carries a second external recipient elsewhere.
  it("should send when the only external recipient sits in cc", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      cc: "outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate.mock.calls[0][1].to).toEqual(["outside@gmail.com"]);
  });

  // The promoted list is the only carrier those recipients have — dropping the
  // cc parameter for them means a short `to` is silent non-delivery, so more
  // than one address has to be driven here to tell a complete one from a
  // truncated one.
  it("should address the visible To to every external cc when no addressee is external", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      cc: "outside@gmail.com, second@yahoo.com",
      bcc: "hidden@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.to).toEqual(["outside@gmail.com", "second@yahoo.com"]);
    expect(msgData.cc).toBeUndefined();
    expect(msgData.bcc).toBe("hidden@external.com");
  });

  it("should prefer an external addressee over an external cc for the visible To", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "addressee@gmail.com",
      cc: "outside@yahoo.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate.mock.calls[0][1].to).toEqual([
      "addressee@gmail.com",
    ]);
  });

  it("should keep host-domain addresses out of the rendered To header", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com, outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate.mock.calls[0][1].to).toEqual(["outside@gmail.com"]);
  });

  it("should include inReplyTo header when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, inReplyTo: "<original-msg@example.com>" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:In-Reply-To"]).toBe("<original-msg@example.com>");
  });

  it("should return data from mailgun API on success", async () => {
    const expected = { id: "msg-id-999", message: "Queued. Thank you." };
    mockMessagesCreate.mockResolvedValue(expected);
    const result = await sendMailgunMail("admin", baseMail);
    expect(result).toEqual(expected);
  });

  it("should handle file attachment from tempFilePath", async () => {
    const mockFile = {
      name: "test.pdf",
      mimetype: "application/pdf",
      size: 1024,
      tempFilePath: "/tmp/uploaded-file.pdf",
      data: Buffer.alloc(0),
    };
    await sendMailgunMail("admin", baseMail, mockFile as import("express-fileupload").UploadedFile);
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/uploaded-file.pdf");
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(1);
    expect(msgData.attachment[0].filename).toBe("test.pdf");
  });

  it("should handle file attachment from data buffer", async () => {
    const fileData = Buffer.from("file-content");
    const mockFile = {
      name: "image.jpg",
      mimetype: "image/jpeg",
      size: 512,
      tempFilePath: "",
      data: fileData,
    };
    await sendMailgunMail("admin", baseMail, mockFile as import("express-fileupload").UploadedFile);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(1);
    expect(msgData.attachment[0].filename).toBe("image.jpg");
  });

  it("should handle array of file attachments", async () => {
    const mockFiles = [
      { name: "a.pdf", mimetype: "application/pdf", size: 100, tempFilePath: "", data: Buffer.from("a") },
      { name: "b.pdf", mimetype: "application/pdf", size: 200, tempFilePath: "", data: Buffer.from("b") },
    ];
    await sendMailgunMail("admin", baseMail, mockFiles as import("express-fileupload").UploadedFile[]);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(2);
  });

  it("should propagate errors from mailgun API", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("Mailgun API error"));
    const mail = new MailDataToSend({ ...baseMail });
    await expect(sendMailgunMail("admin", mail)).rejects.toThrow("Mailgun API error");
  });

  // A host-domain address handed to the relay is delivered back at our own MX
  // on an unauthenticated leg, which answers 450 and buys a full retry window.
  it("should keep host-domain cc and bcc out of the forwarded message", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "outside@gmail.com",
      cc: "inside@example.com, seen@gmail.com",
      bcc: "admin@example.com, hidden@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.cc).toBe("seen@gmail.com");
    expect(msgData.bcc).toBe("hidden@gmail.com");
  });

  it("should omit cc and bcc entirely when every one of them is host-domain", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "outside@gmail.com",
      cc: "inside@example.com",
      bcc: "admin@example.com",
    });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.cc).toBeUndefined();
    expect(msgData.bcc).toBeUndefined();
  });

  // The copies that landed cannot be recalled, so failing the whole send would
  // have the user resend to everyone with no Sent record for those copies.
  it("should report success when part of a bcc fan-out fails", async () => {
    mockMessagesCreate.mockImplementation((_domain: string, data: { to: string[] }) =>
      data.to[0] === "two@external.com"
        ? Promise.reject(new Error("Mailgun 429"))
        : Promise.resolve({ id: `msg-${data.to[0]}`, message: "Queued. Thank you." })
    );
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com, three@external.com",
    });
    const result = await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ id: "msg-one@external.com", message: "Queued. Thank you." });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Some Bcc recipients were not delivered",
      { failed: ["two@external.com"] }
    );
  });

  // The alarm names addresses the send was actually attempted against, so a
  // host-domain bcc that never reached the relay must not appear in it.
  it("should report only external recipients as undelivered", async () => {
    mockMessagesCreate.mockImplementation((_domain: string, data: { to: string[] }) =>
      data.to[0] === "two@external.com"
        ? Promise.reject(new Error("Mailgun 429"))
        : Promise.resolve({ id: `msg-${data.to[0]}`, message: "Queued. Thank you." })
    );
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "inside@example.com, one@external.com, two@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Some Bcc recipients were not delivered",
      { failed: ["two@external.com"] }
    );
  });

  it("should not report undelivered recipients when the whole fan-out lands", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("should throw when every recipient of a bcc fan-out fails", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("Mailgun 429"));
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com",
    });
    await expect(sendMailgunMail("admin", mail)).rejects.toThrow("Mailgun 429");
  });

  it("should cap how many bcc uploads are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    mockMessagesCreate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { id: "msg-id-123", message: "Queued. Thank you." };
    });
    const bcc = Array.from({ length: 12 }, (_, i) => `b${i}@external.com`).join(",");
    const mail = new MailDataToSend({ ...baseMail, to: "", bcc });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(5);
  });
});
