import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ADMIN_PASSWORD,
  MAILGUN_KEY,
  createUser,
  waitFor,
  type MailgunRequest,
  type TestServer,
  type TestUser,
} from "../harness";
import type { SmtpClient } from "../harness/smtp";
import {
  FIXED_DATE,
  MAX_MESSAGE_BYTES,
  attachmentBytes,
  attachmentFiles,
  bootAll,
  closeClients,
  countersOf,
  crlf,
  deliver,
  incomingLeftovers,
  mailsByMessageId,
  mailsOf,
  mappingsOf,
  messageId,
  open,
  raws,
  sha256,
  uniqueName,
  type Listener,
  type Row,
} from "./support";

// Authenticated sending: a signed-in user's message is handed to Mailgun and
// a copy is stored as Sent.
// `offline` is pointed at a Mailgun address nothing listens on.
let server: TestServer;
let offline: TestServer;
let alice: TestUser;

beforeAll(async () => {
  // Port 1 on loopback: reserved, and refused by every sane machine.
  [server, offline] = (await bootAll({ tls: true }, { tls: true, env: { MAILGUN_URL: "http://127.0.0.1:1" } })) as [TestServer, TestServer];
  alice = await createUser(server, "alice");
  await createUser(server, "bob");
}, 180_000);

beforeEach(() => server.mailgun.reset());

afterEach(closeClients);

afterAll(async () => {
  await Promise.all([server?.stop(), offline?.stop()]);
});

const QUEUED = "250 OK: message queued";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const signIn = async (username: string, password: string, listener: Listener = "smtps"): Promise<SmtpClient> => {
  const smtp = await open(server, listener);
  await smtp.ehlo();
  const reply = await smtp.authPlain(username, password);
  if (reply.code !== 235) throw new Error(`Could not sign in as ${username}: ${reply.raw}`);
  return smtp;
};

/** A user with nothing stored, signed in on the implicit-TLS port. */
const freshSender = async () => {
  const user = await createUser(server, uniqueName("s"));
  const smtp = await signIn(user.username, user.password);
  return { user, smtp, at: (local: string) => `${local}@${user.username}.mail.test` };
};

/** One field of a Mailgun request; fails when the field was sent more than once. */
const field = (request: MailgunRequest, name: string): string | undefined => {
  const values = request.fields[name];
  if (values && values.length > 1) throw new Error(`Mailgun field ${name} was sent ${values.length} times`);
  return values?.[0];
};

/** Submits `lines` as alice and returns the Mailgun requests that submission caused. */
const sendAsAlice = async (envelope: { from?: string; to: string[] }, ...lines: string[]) => {
  const smtp = await signIn("alice", alice.password);
  const seen = server.mailgun.requests.length;
  const result = await smtp.transaction({ from: envelope.from ?? "me@alice.mail.test", to: envelope.to, data: crlf(...lines) });
  smtp.close();
  return { result, requests: server.mailgun.requests.slice(seen) };
};

const sentRows = async (username: string): Promise<Row[]> => (await mailsOf(server, username)).filter((row) => row.sent);

describe("a submission to an outside address", () => {
  test("the request made to Mailgun", async () => {
    const { smtp, at } = await freshSender();
    const result = await smtp.transaction({
      from: at("me"),
      to: ["bob@remote.example", "carol@remote.example", "hidden@remote.example"],
      data: crlf(
        `From: Alice Example <${at("me")}>`,
        "To: Bob <bob@remote.example>",
        "Cc: carol@remote.example",
        "Subject: Outgoing subject",
        `Date: ${FIXED_DATE}`,
        "Message-ID: <client-generated@remote.example>",
        "",
        "Hello Bob,",
        "",
        "> quoted line",
        "see https://example.com/x?a=1&b=2 & <tags>"
      ),
    });
    expect(raws(result.replies)).toEqual(["250 Accepted", "250 Accepted", "250 Accepted", "250 Accepted", QUEUED]);

    expect(server.mailgun.requests).toHaveLength(1);
    const request = server.mailgun.requests[0]!;
    expect(request.method).toBe("POST");
    // The domain in the path is the served domain, not the user's subdomain.
    expect(request.path).toBe("/v3/mail.test/messages");
    expect(request.authorization).toBe(`Basic ${Buffer.from(`api:${MAILGUN_KEY}`).toString("base64")}`);
    expect(request.contentType).toMatch(/^multipart\/form-data; boundary=-{26}[0-9a-f]{32}$/);
    expect(request.fieldOrder).toEqual(["from", "to", "cc", "bcc", "subject", "html", "text"]);
    expect(request.fields).toEqual({
      from: [`Alice Example <${at("me")}>`],
      to: ["bob@remote.example"],
      cc: ["carol@remote.example"],
      bcc: ["hidden@remote.example"],
      subject: ["Outgoing subject"],
      // A text-only message is sent as HTML that keeps its line breaks.
      html: [
        '<div style="white-space: pre-wrap">Hello Bob,\n' +
          "<blockquote>quoted line</blockquote>" +
          'see <a href="https://example.com/x?a=1&amp;b=2">https://example.com/x?a=1&amp;b=2</a> &amp; &lt;tags&gt;\n' +
          "</div>",
      ],
      // And its text is derived back from that HTML, with URLs masked.
      text: ["Hello Bob,\n> quoted line\nsee [url] & <tags>"],
    });
    expect(request.attachments).toEqual([]);
  });

  test("the Sent record it stores", async () => {
    const { user, smtp, at } = await freshSender();
    server.mailgun.replyOnce(() => Response.json({ id: "<20260303.fixed@mail.test>", message: "Queued. Thank you." }));
    const before = Date.now();
    const result = await smtp.transaction({
      from: at("me"),
      to: ["bob@remote.example", "carol@remote.example", "hidden@remote.example"],
      data: crlf(
        `From: Alice Example <${at("me")}>`,
        "To: Bob <bob@remote.example>",
        "Cc: carol@remote.example",
        "Reply-To: elsewhere@remote.example",
        "Subject: Outgoing subject",
        `Date: ${FIXED_DATE}`,
        "Message-ID: <client-generated@remote.example>",
        "",
        "Hello Bob"
      ),
    });
    expect(result.final.raw).toBe(QUEUED);

    const rows = await mailsOf(server, user.username);
    expect(rows).toHaveLength(1);
    const { mail_id, updated, date, rfc822_size, search_vector, ...row } = rows[0]!;
    expect(mail_id).toMatch(/^[0-9a-f-]{36}$/);
    // The time of sending, not the message's own Date header.
    for (const stamp of [updated, date]) {
      expect(new Date(stamp).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(new Date(stamp).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(Number(rfc822_size)).toBeGreaterThan(0);
    expect(search_vector).toContain("'outgo':1");
    expect(row).toEqual({
      user_id: user.id,
      // NOTE: the stored id is Mailgun's; the Message-ID the client wrote is dropped.
      message_id: "<20260303.fixed@mail.test>",
      subject: "Outgoing subject",
      html: '<div style="white-space: pre-wrap">Hello Bob\n</div>',
      text: "Hello Bob",
      from_address: [{ name: "Alice Example", address: at("me") }],
      from_text: `Alice Example <${at("me")}>`,
      // Recipient lists hold bare addresses; the names in the headers are dropped.
      to_address: [{ address: "bob@remote.example" }],
      to_text: "bob@remote.example",
      cc_address: [{ address: "carol@remote.example" }],
      cc_text: "carol@remote.example",
      bcc_address: [{ address: "hidden@remote.example" }],
      bcc_text: "hidden@remote.example",
      // Always the sender itself; the message's Reply-To header is ignored.
      reply_to_address: [{ name: "Alice Example", address: at("me") }],
      reply_to_text: at("me"),
      envelope_from: [{ name: "Alice Example", address: at("me") }],
      envelope_to: [{ address: "bob@remote.example" }, { address: "carol@remote.example" }, { address: "hidden@remote.example" }],
      attachments: [],
      read: true,
      saved: false,
      sent: true,
      deleted: false,
      draft: false,
      answered: false,
      expunged: false,
      insight: null,
      uid_domain: 1,
      modseq: "1",
      spam_score: 0,
      spam_reasons: null,
      is_spam: false,
      text_line_count: null,
      html_line_count: null,
      in_reply_to: null,
      reference_ids: null,
    });

    // Filed under the sender's Sent box only, numbered in the sent sequences.
    expect(await mappingsOf(server, mail_id)).toEqual([{ mailbox: "Sent Messages/accounts/me", uid: 1 }]);
    expect(await countersOf(server, user.username)).toEqual([
      { kind: "account", scope: at("me"), sent: true, last: 1 },
      { kind: "domain", scope: "", sent: true, last: 1 },
      { kind: "modseq", scope: "", sent: false, last: 1 },
    ]);
  });

  test("when Mailgun's answer carries no id, the Sent record gets a UUID under the user's domain", async () => {
    const { user, smtp, at } = await freshSender();
    server.mailgun.replyOnce(() => new Response("Queued", { status: 200 }));
    const result = await smtp.transaction({ from: at("me"), to: ["bob@remote.example"], data: crlf("Subject: No id", "", "x") });
    expect(result.final.raw).toBe(QUEUED);
    const [row] = await sentRows(user.username);
    expect(row!.message_id).toMatch(
      new RegExp(`^<[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@${user.username}\\.mail\\.test>$`)
    );
  });

  test("it works the same on every listener that takes AUTH", async () => {
    for (const listener of ["smtps", "submission"] as const) {
      server.mailgun.reset();
      const smtp = await signIn("alice", alice.password, listener);
      const result = await smtp.transaction({ from: "me@alice.mail.test", to: ["bob@remote.example"], data: crlf(`Subject: via ${listener}`, "", "x") });
      expect({ listener, reply: result.final.raw }).toEqual({ listener, reply: QUEUED });
      expect(server.mailgun.requests.map((request) => field(request, "subject"))).toEqual([`via ${listener}`]);
    }
    // Port 25, once encrypted.
    server.mailgun.reset();
    const smtp = await open(server, "smtp");
    await smtp.ehlo();
    await smtp.startTls();
    await smtp.ehlo();
    await smtp.authLogin("alice", alice.password);
    expect((await smtp.transaction({ from: "me@alice.mail.test", to: ["bob@remote.example"], data: crlf("Subject: via smtp", "", "x") })).final.raw).toBe(QUEUED);
    expect(server.mailgun.requests.map((request) => field(request, "subject"))).toEqual(["via smtp"]);
  });

  test("several messages on one session", async () => {
    const { user, smtp, at } = await freshSender();
    for (const subject of ["one", "two", "three"]) {
      expect((await smtp.transaction({ from: at("me"), to: ["bob@remote.example"], data: crlf(`Subject: ${subject}`, "", "x") })).final.raw).toBe(QUEUED);
    }
    expect(server.mailgun.requests.map((request) => field(request, "subject"))).toEqual(["one", "two", "three"]);
    expect((await sentRows(user.username)).map((row) => [row.subject, row.uid_domain])).toEqual([
      ["one", 1],
      ["two", 2],
      ["three", 3],
    ]);
  });
});

describe("the body that is sent", () => {
  test("an HTML message is sent as written, with its text derived from it", async () => {
    const html = '<p>Hello <b>Bob</b>,</p><p>see <a href="https://example.com/x">this page</a> at https://example.com/y</p>';
    const { requests } = await sendAsAlice({ to: ["bob@remote.example"] }, "Subject: html", "Content-Type: text/html; charset=utf-8", "", html);
    expect(field(requests[0]!, "html")).toBe(`${html}\n`);
    expect(field(requests[0]!, "text")).toBe("Hello Bob,\nsee this page at [url]");
  });

  test("of a multipart/alternative the HTML part is sent and the text part discarded", async () => {
    const { requests } = await sendAsAlice(
      { to: ["bob@remote.example"] },
      "Subject: alt",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain",
      "",
      "The plain wording",
      "--alt",
      "Content-Type: text/html",
      "",
      "<p>The HTML wording</p>",
      "--alt--"
    );
    expect(field(requests[0]!, "html")).toBe("<p>The HTML wording</p>");
    expect(field(requests[0]!, "text")).toBe("The HTML wording");
  });

  test("non-ASCII text and an encoded subject arrive decoded", async () => {
    const { requests } = await sendAsAlice(
      { to: ["bob@remote.example"] },
      "Subject: =?utf-8?B?R3LDvMOfZSDinJM=?=",
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=E9 cr=E8me"
    );
    expect(field(requests[0]!, "subject")).toBe("Grüße ✓");
    expect(field(requests[0]!, "html")).toBe('<div style="white-space: pre-wrap">Café crème\n</div>');
    expect(field(requests[0]!, "text")).toBe("Café crème");
  });

  test("a NUL character is left out of the Sent record", async () => {
    // PostgreSQL text cannot hold one: the Sent copy used to fail to save
    // while the client was told 250.
    const { result } = await sendAsAlice({ to: ["bob@remote.example"] }, "To: bob@remote.example", "Subject: nu\0l", "", "a\0b");
    expect(result.final.raw).toBe(QUEUED);
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.subject, row!.html, row!.text]).toEqual(["nul", '<div style="white-space: pre-wrap">ab\n</div>', "ab"]);
  });

  test("a message with no subject goes out as No Subject, and one with no body sends no body fields", async () => {
    const { result, requests } = await sendAsAlice({ to: ["bob@remote.example"] }, "To: bob@remote.example");
    expect(result.final.raw).toBe(QUEUED);
    expect(requests[0]!.fieldOrder).toEqual(["from", "to", "subject"]);
    expect(field(requests[0]!, "subject")).toBe("No Subject");
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.subject, row!.html, row!.text]).toEqual(["No Subject", "", ""]);
  });

  test("an inline image of a submission is sent inside the HTML as a data: URL, and as an attachment", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const { requests } = await sendAsAlice(
      { to: ["bob@remote.example"] },
      "Subject: inline",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      "Content-Type: text/html",
      "",
      '<p><img src="cid:logo@x"></p>',
      "--rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@x>",
      "",
      png,
      "--rel--"
    );
    expect(field(requests[0]!, "html")).toBe(`<p><img src="data:image/png;base64,${png}"></p>`);
    // The HTTP send has no inline parts of its own, so the image also goes
    // out as a file, and the Sent copy lists it as received mail does.
    const bytes = Buffer.from(png, "base64");
    expect(requests[0]!.attachments).toEqual([
      { filename: "attachment", contentType: "image/png", size: bytes.length, sha256: sha256(bytes), text: expect.any(String) },
    ]);
    const [row] = (await sentRows("alice")).slice(-1);
    expect(row!.subject).toBe("inline");
    expect(row!.attachments).toEqual([{ size: bytes.length, content: { data: expect.stringMatching(UUID) }, filename: "attachment", contentType: "image/png" }]);
    expect(attachmentBytes(server, row!.attachments[0].content.data).equals(bytes)).toBe(true);
  });
});

describe("the attachments of a submission", () => {
  const PDF = Buffer.from("%PDF-1.4 the contract");

  /** A multipart/mixed submission: a line of text, then each part as given. */
  const withParts = (subject: string, ...parts: string[][]) =>
    sendAsAlice(
      { to: ["bob@remote.example"] },
      "To: bob@remote.example",
      `Subject: ${subject}`,
      'Content-Type: multipart/mixed; boundary="mix"',
      "",
      "--mix",
      "Content-Type: text/plain",
      "",
      "See attached.",
      ...parts.flatMap((part) => ["--mix", ...part]),
      "--mix--"
    );

  const pdfPart = (disposition = 'attachment; filename="contract.pdf"') => [
    "Content-Type: application/pdf",
    `Content-Disposition: ${disposition}`,
    "Content-Transfer-Encoding: base64",
    "",
    PDF.toString("base64"),
  ];

  test("are sent to Mailgun as files and stored on the Sent record, as an HTTP send's are", async () => {
    const files = attachmentFiles(server).length;
    const { result, requests } = await withParts("with a file", pdfPart());
    expect(result.final.raw).toBe(QUEUED);
    expect(requests).toHaveLength(1);
    // The file parts come after the text fields, as they do for an HTTP send.
    expect(requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "attachment"]);
    expect(field(requests[0]!, "text")).toBe("See attached.");
    expect(requests[0]!.attachments).toEqual([
      { filename: "contract.pdf", contentType: "application/pdf", size: PDF.length, sha256: sha256(PDF), text: PDF.toString() },
    ]);

    const [row] = (await sentRows("alice")).slice(-1);
    expect(row!.subject).toBe("with a file");
    expect(row!.attachments).toEqual([{ size: PDF.length, content: { data: expect.stringMatching(UUID) }, filename: "contract.pdf", contentType: "application/pdf" }]);
    expect(attachmentBytes(server, row!.attachments[0].content.data).equals(PDF)).toBe(true);
    expect(attachmentFiles(server).length).toBe(files + 1);
    // The transaction's working copy is gone once the client has its answer.
    await waitFor(() => incomingLeftovers(server).length === 0, { what: "the transaction's working files to go" });
  });

  test("several are sent in message order and stored each under its own id", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 13, 10]);
    const { result, requests } = await withParts(
      "several",
      pdfPart(),
      ["Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="data.bin"', "Content-Transfer-Encoding: base64", "", bytes.toString("base64")],
      ["Content-Type: text/csv", 'Content-Disposition: attachment; filename="rows.csv"', "", "a,b"],
      pdfPart()
    );
    expect(result.final.raw).toBe(QUEUED);
    expect(requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "attachment", "attachment", "attachment", "attachment"]);
    expect(requests[0]!.attachments.map((a) => [a.filename, a.size, a.sha256])).toEqual([
      ["contract.pdf", PDF.length, sha256(PDF)],
      ["data.bin", bytes.length, sha256(bytes)],
      ["rows.csv", 3, sha256("a,b")],
      ["contract.pdf", PDF.length, sha256(PDF)],
    ]);

    const [row] = (await sentRows("alice")).slice(-1);
    const stored = row!.attachments as { filename: string; contentType: string; size: number; content: { data: string } }[];
    // The HTTP send stores its files concurrently, so the Sent record lists
    // them in no fixed order.
    expect(stored.map((a) => [a.filename, a.contentType, a.size]).sort()).toEqual([
      ["contract.pdf", "application/pdf", PDF.length],
      ["contract.pdf", "application/pdf", PDF.length],
      ["data.bin", "application/octet-stream", bytes.length],
      ["rows.csv", "text/csv", 3],
    ]);
    expect(new Set(stored.map((a) => a.content.data)).size).toBe(4);
    const data = stored.find((a) => a.filename === "data.bin")!;
    expect(attachmentBytes(server, data.content.data).equals(bytes)).toBe(true);
    await waitFor(() => incomingLeftovers(server).length === 0, { what: "the transaction's working files to go" });
  });

  test("a file name in non-ASCII characters arrives and is stored decoded", async () => {
    const name = "Vertrag ünï 😀.pdf";
    for (const disposition of [
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      `attachment; filename="=?UTF-8?B?${Buffer.from(name).toString("base64")}?="`,
    ]) {
      const { result, requests } = await withParts("named", pdfPart(disposition));
      expect({ disposition, reply: result.final.raw }).toEqual({ disposition, reply: QUEUED });
      expect(requests[0]!.attachments.map((a) => a.filename)).toEqual([name]);
      const [row] = (await sentRows("alice")).slice(-1);
      expect(row!.attachments.map((a: { filename: string }) => a.filename)).toEqual([name]);
    }
  });

  test("go to every per-recipient message of a Bcc-only submission, and are stored once", async () => {
    const smtp = await signIn("alice", alice.password);
    const result = await smtp.transaction({
      from: "me@alice.mail.test",
      to: ["dave@remote.example", "erin@remote.example"],
      data: crlf("Subject: bcc files", 'Content-Type: multipart/mixed; boundary="mix"', "", "--mix", "Content-Type: text/plain", "", "x", "--mix", ...pdfPart(), "--mix--"),
    });
    expect(result.final.raw).toBe(QUEUED);
    expect(server.mailgun.requests).toHaveLength(2);
    for (const request of server.mailgun.requests) {
      expect(request.attachments.map((a) => [a.filename, a.sha256])).toEqual([["contract.pdf", sha256(PDF)]]);
    }
    const [row] = (await sentRows("alice")).slice(-1);
    expect(row!.attachments.map((a: { filename: string }) => a.filename)).toEqual(["contract.pdf"]);
  });
});

describe("who the message is sent as", () => {
  const fromOf = async (envelopeFrom: string, ...headers: string[]) => {
    const { result, requests } = await sendAsAlice({ from: envelopeFrom, to: ["bob@remote.example"] }, ...headers, "Subject: sender", "", "x");
    if (result.final.code !== 250) return result.final.raw;
    return field(requests[0]!, "from");
  };

  test("the From header's local part and name, when it is an address of the user's own domain", async () => {
    expect(await fromOf("me@alice.mail.test", "From: Sales Team <sales@alice.mail.test>")).toBe("Sales Team <sales@alice.mail.test>");
    expect(await fromOf("me@alice.mail.test", "From: Sales@ALICE.Mail.Test")).toBe("sales <sales@alice.mail.test>");
    expect(await fromOf("me@alice.mail.test", "From: =?utf-8?Q?J=C3=B6rg?= <joerg@alice.mail.test>")).toBe("Jörg <joerg@alice.mail.test>");
  });

  test("without a From header, the envelope sender's local part, which also serves as the name", async () => {
    expect(await fromOf("me@alice.mail.test")).toBe("me <me@alice.mail.test>");
    expect(await fromOf("Billing@Alice.Mail.Test")).toBe("billing <billing@alice.mail.test>");
  });

  test("a From header outside the user's domain lends only its name", async () => {
    // NOTE: the display name of an address the user does not own is kept and
    // attached to the user's own address.
    expect(await fromOf("me@alice.mail.test", "From: The CEO <ceo@bank.example>")).toBe("The CEO <me@alice.mail.test>");
    expect(await fromOf("me@alice.mail.test", "From: ceo@bank.example")).toBe("me <me@alice.mail.test>");
    expect(await fromOf("me@alice.mail.test", "From: Bob <x@bob.mail.test>")).toBe("Bob <me@alice.mail.test>");
  });

  test("an envelope sender under another local domain is rewritten onto the user's own domain", async () => {
    expect(await fromOf("x@bob.mail.test")).toBe("x <x@alice.mail.test>");
    expect(await fromOf("postmaster@mail.test")).toBe("postmaster <postmaster@alice.mail.test>");
    expect(await fromOf("x@bob.mail.test", "From: Bob <x@bob.mail.test>")).toBe("Bob <x@alice.mail.test>");
  });

  test("the built-in admin sends from the bare domain", async () => {
    const smtp = await signIn("admin", ADMIN_PASSWORD);
    const result = await smtp.transaction({
      from: "office@mail.test",
      to: ["bob@remote.example"],
      data: crlf("From: The Office <office@mail.test>", "Subject: admin", "", "x"),
    });
    expect(result.final.raw).toBe(QUEUED);
    expect(field(server.mailgun.requests[0]!, "from")).toBe("The Office <office@mail.test>");
    const [row] = (await sentRows("admin")).slice(-1);
    expect(row!.from_address).toEqual([{ name: "The Office", address: "office@mail.test" }]);
    expect(await mappingsOf(server, row!.mail_id)).toEqual([{ mailbox: "Sent Messages/accounts/office", uid: expect.any(Number) }]);
  });

  test("a sender local part outside letters, digits, dot, underscore and hyphen is refused", async () => {
    // NOTE: a permanent condition answered with the transient default code.
    expect(await fromOf("a+tag@alice.mail.test")).toBe("450 Invalid sender format");
    expect(await fromOf("me@alice.mail.test", "From: a+tag@alice.mail.test")).toBe("450 Invalid sender format");
    expect(server.mailgun.requests).toEqual([]);
  });

  test("an envelope recipient at the user's own domain that the To header does not name becomes the sender", async () => {
    // A client that cannot set the sender puts the identity among the
    // recipients; it is taken out of them and used as the From.
    const { result, requests } = await sendAsAlice(
      { from: "alice@alice.mail.test", to: ["bob@remote.example", "sales@alice.mail.test"] },
      "From: alice@alice.mail.test",
      "To: bob@remote.example",
      "Subject: send as",
      "",
      "x"
    );
    expect(result.final.raw).toBe(QUEUED);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.fields).toMatchObject({ from: ["sales <sales@alice.mail.test>"], to: ["bob@remote.example"] });
    expect(requests[0]!.fields.cc).toBeUndefined();
    expect(requests[0]!.fields.bcc).toBeUndefined();
    const [row] = (await sentRows("alice")).slice(-1);
    expect(row!.envelope_to).toEqual([{ address: "bob@remote.example" }]);
    expect(row!.from_address).toEqual([{ name: "sales", address: "sales@alice.mail.test" }]);
  });

  test("one that the To header does name stays a recipient", async () => {
    const { requests } = await sendAsAlice(
      { from: "alice@alice.mail.test", to: ["bob@remote.example", "sales@alice.mail.test"] },
      "From: alice@alice.mail.test",
      "To: bob@remote.example, sales@alice.mail.test",
      "Subject: to own domain",
      "",
      "x"
    );
    expect(requests[0]!.fields).toMatchObject({ from: ["alice <alice@alice.mail.test>"], to: ["bob@remote.example", "sales@alice.mail.test"] });
  });
});

describe("how the envelope recipients are sorted into To, Cc and Bcc", () => {
  test("by the headers that name them, in any letter case; the rest are Bcc", async () => {
    const { requests } = await sendAsAlice(
      { to: ["Bob@Remote.Example", "carol@remote.example", "dave@remote.example", "erin@remote.example"] },
      "To: Bob <bob@remote.example>, not-in-envelope@remote.example",
      "Cc: CAROL@remote.example",
      "Subject: sorting",
      "",
      "x"
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.fields).toMatchObject({
      to: ["Bob@Remote.Example"],
      cc: ["carol@remote.example"],
      bcc: ["dave@remote.example,erin@remote.example"],
    });
    const [row] = (await sentRows("alice")).slice(-1);
    // The stored lists are lower-cased; the text keeps what the envelope said.
    expect([row!.to_address, row!.to_text]).toEqual([[{ address: "bob@remote.example" }], "Bob@Remote.Example"]);
    expect([row!.bcc_address, row!.bcc_text]).toEqual([
      [{ address: "dave@remote.example" }, { address: "erin@remote.example" }],
      "dave@remote.example,erin@remote.example",
    ]);
  });

  test("an address named in an RFC 5322 group counts as named", async () => {
    const { requests } = await sendAsAlice(
      { to: ["bob@remote.example", "carol@remote.example"] },
      "To: Team: bob@remote.example, Carol <carol@remote.example>;",
      "Subject: group",
      "",
      "x"
    );
    expect(requests[0]!.fields).toMatchObject({ to: ["bob@remote.example", "carol@remote.example"] });
    expect(requests[0]!.fields.bcc).toBeUndefined();
  });

  test("with only Cc recipients outside, they are promoted to Mailgun's to and not repeated as cc", async () => {
    const { requests } = await sendAsAlice(
      { to: ["carol@remote.example", "dave@remote.example"] },
      "Cc: carol@remote.example, dave@remote.example",
      "Subject: cc only",
      "",
      "x"
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.fields.to).toEqual(["carol@remote.example", "dave@remote.example"]);
    expect(requests[0]!.fields.cc).toBeUndefined();
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.to_address, row!.cc_text]).toEqual([null, "carol@remote.example,dave@remote.example"]);
  });

  test("with only Bcc recipients, one request goes out per recipient", async () => {
    const { result, requests } = await sendAsAlice({ to: ["dave@remote.example", "erin@remote.example", "frank@remote.example"] }, "Subject: bcc only", "", "x");
    expect(result.final.raw).toBe(QUEUED);
    expect(requests.map((request) => request.fields.to).sort()).toEqual([["dave@remote.example"], ["erin@remote.example"], ["frank@remote.example"]]);
    for (const request of requests) {
      expect(request.fields.cc).toBeUndefined();
      expect(request.fields.bcc).toBeUndefined();
    }
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.to_address, row!.to_text, row!.cc_address]).toEqual([null, null, null]);
    expect(row!.bcc_text).toBe("dave@remote.example,erin@remote.example,frank@remote.example");
    expect(row!.envelope_to).toEqual([
      { address: "dave@remote.example" },
      { address: "erin@remote.example" },
      { address: "frank@remote.example" },
    ]);
  });
});

describe("local recipients of a submission", () => {
  test("a recipient at the bare domain is neither relayed nor delivered", async () => {
    // NOTE: looks like a bug. Addresses ending in "@mail.test" are held back
    // from Mailgun so they do not loop through the MX — but nothing stores
    // them locally either. The Sent record claims the message went out.
    const id = messageId("lost");
    const before = (await mailsOf(server, "admin")).length;
    const { result, requests } = await sendAsAlice(
      { to: ["hello@mail.test"] },
      "To: hello@mail.test",
      `Message-ID: ${id}`,
      "Subject: to the admin",
      "",
      "x"
    );
    expect(result.final.raw).toBe(QUEUED);
    expect(requests).toEqual([]);
    expect((await mailsOf(server, "admin")).length).toBe(before);
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.subject, row!.sent, row!.to_text]).toEqual(["to the admin", true, "hello@mail.test"]);
    // With no Mailgun id the Sent record gets a fresh UUID.
    expect(row!.message_id).toMatch(/^<[0-9a-f-]{36}@alice\.mail\.test>$/);
    expect(await mailsByMessageId(server, id)).toEqual([]);
  });

  test("beside an outside recipient, the bare-domain one is silently left out of the request", async () => {
    const { requests } = await sendAsAlice(
      { to: ["bob@remote.example", "hello@mail.test", "other@mail.test"] },
      "To: bob@remote.example, hello@mail.test",
      "Subject: mixed",
      "",
      "x"
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.fields.to).toEqual(["bob@remote.example"]);
    expect(requests[0]!.fields.bcc).toBeUndefined();
    const [row] = (await sentRows("alice")).slice(-1);
    expect(row!.to_text).toBe("bob@remote.example,hello@mail.test");
    expect(row!.bcc_text).toBe("other@mail.test");
  });

  test("a recipient at another user's subdomain is handed to Mailgun, not stored locally", async () => {
    const { result, requests } = await sendAsAlice({ to: ["x@bob.mail.test"] }, "To: x@bob.mail.test", "Subject: to bob", "", "x");
    expect(result.final.raw).toBe(QUEUED);
    expect(requests.map((request) => request.fields.to)).toEqual([["x@bob.mail.test"]]);
    expect(await mailsOf(server, "bob")).toEqual([]);
  });

  test("a signed-in user's message with an outside envelope sender is ordinary inbound mail", async () => {
    const id = messageId("inbound");
    const smtp = await signIn("alice", alice.password);
    const result = await smtp.transaction({
      from: "alice@gmail.example",
      to: ["x@bob.mail.test"],
      data: crlf("From: alice@gmail.example", `Message-ID: ${id}`, "Subject: inbound while signed in", "", "x"),
    });
    expect(result.final.raw).toBe(QUEUED);
    expect(server.mailgun.requests).toEqual([]);
    const rows = await mailsByMessageId(server, id);
    expect(rows.map((row) => [row.username, row.sent])).toEqual([["bob", false]]);
  });

  test("signing in does not make the server a relay for outside senders", async () => {
    const smtp = await signIn("alice", alice.password);
    const result = await smtp.transaction({ from: "alice@gmail.example", to: ["bob@remote.example"], data: crlf("Subject: relay", "", "x") });
    expect(result.final.raw).toBe("550 Error: relay access denied");
    expect((await smtp.transaction({ from: "", to: ["bob@remote.example"], data: crlf("Subject: relay", "", "x") })).final.raw).toBe(
      "550 Error: relay access denied"
    );
    expect(server.mailgun.requests).toEqual([]);
  });
});

describe("replies", () => {
  test("In-Reply-To and References go out as headers and onto the Sent record", async () => {
    const { requests } = await sendAsAlice(
      { to: ["bob@remote.example"] },
      "To: bob@remote.example",
      "Subject: Re: thread",
      "In-Reply-To: <parent@remote.example>",
      "References: <root@remote.example> <parent@remote.example>",
      "",
      "x"
    );
    expect(requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "h:In-Reply-To", "h:References"]);
    expect(field(requests[0]!, "h:In-Reply-To")).toBe("<parent@remote.example>");
    expect(field(requests[0]!, "h:References")).toBe("<root@remote.example> <parent@remote.example>");
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.in_reply_to, row!.reference_ids]).toEqual(["<parent@remote.example>", ["<root@remote.example>", "<parent@remote.example>"]]);
  });

  test("without References, they are rebuilt from the answered mail the user holds", async () => {
    const parent = messageId("parent");
    await deliver(server, {
      to: ["me@alice.mail.test"],
      data: crlf("From: bob@remote.example", `Message-ID: ${parent}`, "References: <r1@remote.example> <r2@remote.example>", "Subject: thread", "", "x"),
    });
    const { requests } = await sendAsAlice({ to: ["bob@remote.example"] }, "To: bob@remote.example", "Subject: Re: thread", `In-Reply-To: ${parent}`, "", "x");
    expect(field(requests[0]!, "h:In-Reply-To")).toBe(parent);
    expect(field(requests[0]!, "h:References")).toBe(`<r1@remote.example> <r2@remote.example> ${parent}`);
  });

  test("answering a mail the user does not hold threads under that mail alone", async () => {
    const { requests } = await sendAsAlice({ to: ["bob@remote.example"] }, "To: bob@remote.example", "Subject: Re: unknown", "In-Reply-To: <unknown@remote.example>", "", "x");
    expect(field(requests[0]!, "h:References")).toBe("<unknown@remote.example>");
  });

  test("References without In-Reply-To are not sent", async () => {
    const { requests } = await sendAsAlice({ to: ["bob@remote.example"] }, "To: bob@remote.example", "Subject: refs only", "References: <root@remote.example>", "", "x");
    expect(requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "h:References"]);
    expect(field(requests[0]!, "h:References")).toBe("<root@remote.example>");
  });
});

describe("when Mailgun refuses", () => {
  const attempt = async (reply: () => Response) => {
    const smtp = await signIn("alice", alice.password);
    const before = (await sentRows("alice")).length;
    server.mailgun.replyOnce(reply);
    const result = await smtp.transaction({ from: "me@alice.mail.test", to: ["bob@remote.example"], data: crlf("To: bob@remote.example", "Subject: refused", "", "x") });
    // Nothing is stored for a message that was not sent.
    expect((await sentRows("alice")).length).toBe(before);
    return { smtp, reply: result.final.raw };
  };
  const json = (status: number, body: unknown) => () => Response.json(body, { status });

  test("every failure is a transient 450; the text depends on the status", async () => {
    // NOTE: 450 even where retrying cannot help (a misconfigured key, a
    // request Mailgun calls bad): the code is the default for any error
    // without one of its own.
    expect((await attempt(json(401, { message: "Forbidden" }))).reply).toBe("450 Email service not configured correctly");
    expect((await attempt(json(403, { message: "Forbidden" }))).reply).toBe("450 Email service not configured correctly");
    expect((await attempt(json(429, { message: "slow down" }))).reply).toBe("450 Too many requests. Please try again later.");
    expect((await attempt(json(500, { message: "boom" }))).reply).toBe("450 Failed to send email. Please try again.");
    expect((await attempt(json(503, { message: "down" }))).reply).toBe("450 Failed to send email. Please try again.");
    expect((await attempt(json(404, { message: "Domain not found" }))).reply).toBe("450 Failed to send email. Please try again.");
  });

  test("a 400 passes on Mailgun's own error text, or the status text when it gives none", async () => {
    expect((await attempt(json(400, { error: "to parameter is not a valid address" }))).reply).toBe("450 to parameter is not a valid address");
    expect((await attempt(json(400, { message: "only a message field" }))).reply).toBe("450 Bad Request");
    expect((await attempt(() => new Response("plain text", { status: 400 }))).reply).toBe("450 Bad Request");
  });

  test("a 200 that is Mailgun's landing page, not its API, is a failure", async () => {
    expect((await attempt(() => new Response("Mailgun Magnificent API", { status: 200 }))).reply).toBe("450 Incorrect url");
  });

  test("the session carries on, and an alarm is raised", async () => {
    const { smtp, reply } = await attempt(json(500, { message: "boom" }));
    expect(reply).toBe("450 Failed to send email. Please try again.");
    expect((await smtp.send("RCPT TO:<bob@remote.example>")).raw).toBe("503 Error: need MAIL command");
    const retry = await smtp.transaction({ from: "me@alice.mail.test", to: ["bob@remote.example"], data: crlf("Subject: retry", "", "x") });
    expect(retry.final.raw).toBe(QUEUED);
    const alarm = await waitFor(() => server.alarms.alarms.find((entry) => entry.title.includes("Mail Send Failed")), { what: "the send-failure alarm" });
    expect(alarm.title).toBe("🚨 Mail Server Error: Mail Send Failed");
    expect(alarm.description).toMatch(/^\*\*Error:\*\* /);
  });

  test("when Mailgun cannot be reached at all, the 450 carries the connection error's code", async () => {
    const smtp = await open(offline, "smtps");
    await smtp.ehlo();
    expect((await smtp.authPlain("admin", ADMIN_PASSWORD)).raw).toBe("235 Authentication successful");
    const result = await smtp.transaction({ from: "office@mail.test", to: ["bob@remote.example"], data: crlf("Subject: offline", "", "x") });
    expect(result.final.raw).toBe("450 ECONNREFUSED");
    expect(await offline.db.query("SELECT 1 FROM mails")).toEqual([]);
  });

  test("with only Bcc recipients, one success is enough; if all fail the first failure answers", async () => {
    const smtp = await signIn("alice", alice.password);
    server.mailgun.replyAlways((request) =>
      request.fields.to?.[0] === "dave@remote.example" ? Response.json({ id: "<ok@mail.test>", message: "Queued" }) : Response.json({ message: "no" }, { status: 500 })
    );
    const partial = await smtp.transaction({ from: "me@alice.mail.test", to: ["dave@remote.example", "erin@remote.example"], data: crlf("Subject: partial", "", "x") });
    expect(partial.final.raw).toBe(QUEUED);
    const [row] = (await sentRows("alice")).slice(-1);
    expect([row!.subject, row!.bcc_text]).toEqual(["partial", "dave@remote.example,erin@remote.example"]);
    const alarm = await waitFor(() => server.alarms.alarms.find((entry) => entry.title.includes("Mail Send Partially Failed")), {
      what: "the partial-failure alarm",
    });
    expect(alarm.description).toBe("**Undelivered Bcc recipients:** erin@remote.example");

    server.mailgun.replyAlways(() => Response.json({ message: "no" }, { status: 429 }));
    const none = await smtp.transaction({ from: "me@alice.mail.test", to: ["erin@remote.example", "frank@remote.example"], data: crlf("Subject: none", "", "x") });
    expect(none.final.raw).toBe("450 Too many requests. Please try again later.");
  });
});

describe("submissions the server refuses itself", () => {
  const refused = async (envelope: { from?: string; to: string[] }, ...lines: string[]) => {
    const { result, requests } = await sendAsAlice(envelope, ...lines);
    expect(requests).toEqual([]);
    return result.final.raw;
  };

  test("a recipient that is not a plain name@domain.tld address", async () => {
    // NOTE: these were all accepted at RCPT TO; the refusal is transient.
    expect(await refused({ to: ["bob@[192.0.2.1]"] }, "Subject: literal", "", "x")).toBe("450 Invalid BCC address: bob@[192.0.2.1]");
    expect(await refused({ to: ["bob@localhost"] }, "To: bob@localhost", "Subject: no dot", "", "x")).toBe("450 Invalid recipient address: bob@localhost");
    expect(await refused({ to: ["ok@remote.example", "bob@localhost"] }, "To: ok@remote.example", "Cc: bob@localhost", "Subject: cc", "", "x")).toBe(
      "450 Invalid CC address: bob@localhost"
    );
    expect(await refused({ to: ["o'brien@remote.example"] }, "To: o'brien@remote.example", "Subject: apostrophe", "", "x")).toBe(
      "450 Invalid recipient address: o'brien@remote.example"
    );
  });

  test("a subject longer than 998 characters", async () => {
    expect(await refused({ to: ["bob@remote.example"] }, "To: bob@remote.example", `Subject: ${"s".repeat(999)}`, "", "x")).toBe(
      "450 Subject exceeds maximum length of 998 characters"
    );
    const { result } = await sendAsAlice({ to: ["bob@remote.example"] }, "To: bob@remote.example", `Subject: ${"s".repeat(998)}`, "", "x");
    expect(result.final.raw).toBe(QUEUED);
  });

  test("a message the parser gives up on", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 1000; i++) parts.push("--p", "", "x");
    expect(
      await refused({ to: ["bob@remote.example"] }, "Subject: too many parts", 'Content-Type: multipart/mixed; boundary="p"', "", ...parts, "--p--")
    ).toBe("450 Max allowed child nodes exceeded");
  });

  test("a message over the size ceiling is 552 and nothing is sent", async () => {
    const smtp = await signIn("alice", alice.password);
    await smtp.send("MAIL FROM:<me@alice.mail.test>");
    await smtp.send("RCPT TO:<bob@remote.example>");
    await smtp.send("DATA");
    const line = `${"x".repeat(998)}\r\n`;
    await smtp.writeFlushed(`Subject: huge\r\n\r\n${line.repeat(Math.ceil(MAX_MESSAGE_BYTES / line.length))}`);
    smtp.write(".\r\n");
    expect((await smtp.read(30_000)).raw).toBe(`552 Error: message exceeds fixed maximum message size ${MAX_MESSAGE_BYTES}`);
    expect(server.mailgun.requests).toEqual([]);
  }, 60_000);

  test("an account deleted after it signed in loses the session at the next MAIL FROM, as on a password change", async () => {
    const { user, smtp, at } = await freshSender();
    await server.db.query("DELETE FROM users WHERE username = $1", [user.username]);
    expect((await smtp.send(`MAIL FROM:<${at("me")}>`)).raw).toBe("421 4.4.2 Credential changed, please re-authenticate");
    expect(await smtp.waitForClose(5000)).toBe(true);
    expect(server.mailgun.requests).toEqual([]);
  });

  test("an account deleted between RCPT TO and DATA is refused at DATA, and nothing is sent", async () => {
    const { user, smtp, at } = await freshSender();
    expect((await smtp.send(`MAIL FROM:<${at("me")}>`)).raw).toBe("250 Accepted");
    expect((await smtp.send("RCPT TO:<bob@remote.example>")).raw).toBe("250 Accepted");
    await server.db.query("DELETE FROM users WHERE username = $1", [user.username]);
    expect((await smtp.data(crlf("Subject: ghost", "", "x"))).raw).toBe("450 User not authenticated");
    expect(server.mailgun.requests).toEqual([]);
  });
});
