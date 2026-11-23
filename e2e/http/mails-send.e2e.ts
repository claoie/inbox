import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MAILGUN_KEY, startServer, type MailgunRequest, type TestServer } from "../harness";
import {
  BAD_REQUEST,
  INTERNAL_ERROR,
  JSON_TYPE,
  NON_OBJECT_BODIES,
  UUID,
  adminMailbox,
  countMails,
  failed,
  latestMail,
  newMailbox,
  subjects,
  type Mailbox,
} from "./mails-helpers";

let server: TestServer;
let box: Mailbox;

beforeAll(async () => {
  server = await startServer();
  box = await newMailbox(server);
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

beforeEach(() => {
  server.mailgun.reset();
});

const SUCCESS = { status: "success" };
const BASE = { sender: "box", to: "friend@remote.example", subject: "Hello", html: "<p>Hi</p>" };

const send = (body: unknown, client = box.client) => client.post("/api/mails/send", body);
const requests = (): MailgunRequest[] => server.mailgun.requests;
/** Has Mailgun answer the next send with a known message id. */
const queueId = (id: string) => server.mailgun.replyOnce(() => Response.json({ id, message: "Queued. Thank you." }));

describe("POST /api/mails/send — the answer and the Mailgun request", () => {
  test("answers success, byte for byte", async () => {
    const { status, text, headers } = await send(BASE);
    expect(status).toBe(200);
    expect(text).toBe('{"status":"success"}');
    expect(headers.get("content-type")).toBe(JSON_TYPE);
    expect(headers.get("etag")).toBe('W/"14-Y53wuE/mmbSikKcT/WualL1N65U"');
  });

  test("posts one multipart message to /v3/<mail domain>/messages with the API key", async () => {
    await send({ ...BASE, senderFullName: "Al Box" });
    expect(requests()).toHaveLength(1);
    const [request] = requests();
    expect(request!.method).toBe("POST");
    // The mail domain, not the user's subdomain.
    expect(request!.path).toBe("/v3/mail.test/messages");
    expect(request!.authorization).toBe(`Basic ${Buffer.from(`api:${MAILGUN_KEY}`).toString("base64")}`);
    expect(request!.contentType).toMatch(/^multipart\/form-data; boundary=\S+$/);
    expect(request!.fields).toEqual({
      from: [`Al Box <${box.address()}>`],
      to: ["friend@remote.example"],
      subject: ["Hello"],
      html: ["<p>Hi</p>"],
      text: ["Hi"],
    });
    expect(request!.fieldOrder).toEqual(["from", "to", "subject", "html", "text"]);
    expect(request!.attachments).toEqual([]);
  });

  test("every field, in wire order: from, to per address, cc, bcc, subject, html, text, reply headers", async () => {
    await box.mail({ message_id: "<answered@remote.example>" });
    await send({
      sender: "box",
      senderFullName: "Al Box",
      to: "a@remote.example, b@remote.example",
      cc: "c@remote.example,d@remote.example",
      bcc: "e@remote.example , f@remote.example",
      subject: "All fields",
      html: "<p>Body</p>",
      inReplyTo: "<answered@remote.example>",
    });
    const [request] = requests();
    expect(request!.fieldOrder).toEqual(["from", "to", "to", "cc", "bcc", "subject", "html", "text", "h:In-Reply-To", "h:References"]);
    expect(request!.fields).toEqual({
      from: [`Al Box <${box.address()}>`],
      to: ["a@remote.example", "b@remote.example"],
      cc: ["c@remote.example,d@remote.example"],
      bcc: ["e@remote.example,f@remote.example"],
      subject: ["All fields"],
      html: ["<p>Body</p>"],
      text: ["Body"],
      "h:In-Reply-To": ["<answered@remote.example>"],
      "h:References": ["<answered@remote.example>"],
    });
  });

  test("without a display name From is the bare address; the sender keeps its letter case on the wire", async () => {
    await send({ ...BASE, sender: "Box.Two-x_9" });
    expect(requests()[0]!.fields.from).toEqual([`Box.Two-x_9@${box.domain}`]);
    server.mailgun.reset();
    await send({ ...BASE, senderFullName: "" });
    expect(requests()[0]!.fields.from).toEqual([box.address()]);
    server.mailgun.reset();
    await send({ ...BASE, senderFullName: 'Näme 😀 "q" <x>' });
    expect(requests()[0]!.fields.from).toEqual([`Näme 😀 "q" <x> <${box.address()}>`]);
  });

  test("admin sends from the bare mail domain", async () => {
    const admin = await adminMailbox(server);
    await send({ ...BASE, sender: "hello", senderFullName: "Admin" }, admin.client);
    expect(requests()[0]!.fields.from).toEqual(["Admin <hello@mail.test>"]);
    expect(requests()[0]!.path).toBe("/v3/mail.test/messages");
  });

  test("subject defaults to No Subject; an empty body sends neither html nor text", async () => {
    await send({ sender: "box", to: "friend@remote.example" });
    expect(requests()[0]!.fields).toEqual({ from: [box.address()], to: ["friend@remote.example"], subject: ["No Subject"] });
    expect(requests()[0]!.fieldOrder).toEqual(["from", "to", "subject"]);
    server.mailgun.reset();
    await send({ ...BASE, subject: "", html: "" });
    expect(requests()[0]!.fields).toEqual({ from: [box.address()], to: ["friend@remote.example"], subject: ["No Subject"] });
  });

  test("recipient lists are split on commas and trimmed; empty items are dropped; duplicates are kept", async () => {
    await send({ ...BASE, to: " A@Remote.example ,, b@remote.example ,", cc: " c@remote.example ", bcc: ",a@remote.example," });
    expect(requests()[0]!.fields).toMatchObject({
      to: ["A@Remote.example", "b@remote.example"],
      cc: ["c@remote.example"],
      bcc: ["a@remote.example"],
    });
    server.mailgun.reset();
    await send({ ...BASE, to: "x@remote.example, x@remote.example", cc: "x@remote.example" });
    expect(requests()[0]!.fields).toMatchObject({ to: ["x@remote.example", "x@remote.example"], cc: ["x@remote.example"] });
  });

  test("the text part is the HTML reduced to plain text", async () => {
    const cases: [string, string][] = [
      ["<p>One</p><p>Two</p>", "One\nTwo"],
      ["Line<br>break<br/>again", "Line\nbreak\nagain"],
      ["<div>a</div><div>b</div>", "a\nb"],
      ["plain text only", "plain text only"],
      ["<p>Para   with    spaces</p>\n\n\n<p>after blank lines</p>", "Para with spaces\nafter blank lines"],
      ["<style>p{color:red}</style><script>alert(1)</script><p>visible</p>", "visible"],
      ['<a href="https://example.com/path">link text</a> and http://bare.example/x.', "link text and [url]."],
      ["<p>See https://example.com/x?y=1&z=2 now</p>", "See [url] now"],
      ["&amp; &lt; &gt; &quot; &#39; &copy; &#x1F600;", "& < > \" ' © 😀"],
      ["<blockquote>quoted</blockquote>reply", "> quoted\nreply"],
      ["<p>Ünï 😀 日本語</p>", "Ünï 😀 日本語"],
    ];
    for (const [html, text] of cases) {
      server.mailgun.reset();
      expect((await send({ ...BASE, html })).body).toEqual(SUCCESS);
      expect({ html, sent: requests()[0]!.fields.html, text: requests()[0]!.fields.text }).toEqual({ html, sent: [html], text: [text] });
    }
  });

  test("the reply fields `references` is never taken from the client", async () => {
    await send({ ...BASE, references: ["<planted@x>"] });
    expect(requests()[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text"]);
    server.mailgun.reset();
    await send({ ...BASE, inReplyTo: "<unknown@x>", references: ["<planted@x>", "<planted2@x>"] });
    expect(requests()[0]!.fields["h:References"]).toEqual(["<unknown@x>"]);
  });

  test("unknown fields are ignored", async () => {
    expect((await send({ ...BASE, id: "x", read: false, sent: false, user_id: "y", attachments: ["z"], date: "2000-01-01" })).body).toEqual(SUCCESS);
    expect(requests()[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text"]);
    const row = await latestMail(server, box.id);
    expect(row.read).toBe(true);
    expect(Date.parse(row.date)).toBeGreaterThan(Date.parse("2026-01-01"));
  });
});

describe("POST /api/mails/send — the stored Sent mail", () => {
  test("every column of the row", async () => {
    const fresh = await newMailbox(server);
    queueId("<fixed-id@mail.test>");
    const before = Date.now();
    await send(
      {
        sender: "Box",
        senderFullName: "Al Box",
        to: "A@Remote.example, b@remote.example ,",
        cc: "c@remote.example",
        bcc: "d@remote.example,e@remote.example",
        subject: "Stored subject",
        html: "<p>Hi <b>friend</b></p><p>See https://example.com/x?y=1</p>",
      },
      fresh.client
    );
    const after = Date.now();
    const rows = await server.db.query("SELECT * FROM mails WHERE user_id = $1", [fresh.id]);
    expect(rows).toHaveLength(1);
    const { mail_id, date, ingested, updated, rfc822_size, search_vector, ...row } = rows[0]!;
    const me = fresh.address();
    expect(row).toEqual({
      user_id: fresh.id,
      // NOTE: Mailgun's id already has angle brackets and a domain; the server
      // wraps it again as "<" + id + "@" + user domain + ">". The stored
      // Message-ID is therefore not the one the recipients see.
      message_id: `<<fixed-id@mail.test>@${fresh.domain}>`,
      subject: "Stored subject",
      html: "<p>Hi <b>friend</b></p><p>See https://example.com/x?y=1</p>",
      text: "Hi friend\nSee [url]",
      from_address: [{ name: "Al Box", address: me }],
      from_text: `Al Box <${me}>`,
      to_address: [{ address: "a@remote.example" }, { address: "b@remote.example" }],
      to_text: "A@Remote.example, b@remote.example ,",
      cc_address: [{ address: "c@remote.example" }],
      cc_text: "c@remote.example",
      bcc_address: [{ address: "d@remote.example" }, { address: "e@remote.example" }],
      bcc_text: "d@remote.example,e@remote.example",
      reply_to_address: [{ name: "Al Box", address: me }],
      reply_to_text: me,
      envelope_from: [{ name: "Al Box", address: me }],
      envelope_to: [
        { address: "a@remote.example" },
        { address: "b@remote.example" },
        { address: "c@remote.example" },
        { address: "d@remote.example" },
        { address: "e@remote.example" },
      ],
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
    expect(mail_id).toMatch(UUID);
    expect(+date).toBeGreaterThanOrEqual(before - 1000);
    expect(+date).toBeLessThanOrEqual(after + 1000);
    expect(+updated).toBeGreaterThanOrEqual(before - 1000);
    expect(+ingested).toBeGreaterThanOrEqual(before - 1000);
    expect(Number(rfc822_size)).toBeGreaterThan(0);
    expect(search_vector).toContain("'store':");
    // Filed in the sending account's Sent mailbox, under the lower-cased local part.
    expect(await server.db.query("SELECT mailbox, uid FROM mail_mailbox_uid WHERE mail_id = $1", [mail_id])).toEqual([
      { mailbox: "Sent Messages/accounts/box", uid: "1" },
    ]);
  });

  test("a NUL character is left out of the Sent mail", async () => {
    // PostgreSQL text cannot hold one: the Sent copy used to fail to save
    // while the send still reported success.
    const fresh = await newMailbox(server);
    expect((await send({ ...BASE, senderFullName: "Al\u0000 Box", subject: "nu\u0000l", html: "<p>a\u0000b</p>" }, fresh.client)).body).toEqual(SUCCESS);
    const row = await latestMail(server, fresh.id);
    expect([row.subject, row.html, row.text]).toEqual(["nul", "<p>ab</p>", "ab"]);
    expect([row.from_address, row.from_text]).toEqual([[{ name: "Al Box", address: fresh.address() }], `Al Box <${fresh.address()}>`]);
  });

  test("the address and display name are stored without a name key when no name is given", async () => {
    const fresh = await newMailbox(server);
    await send({ sender: "BOX", to: "x@remote.example" }, fresh.client);
    const row = await latestMail(server, fresh.id);
    const me = fresh.address();
    expect({ from_address: row.from_address, from_text: row.from_text, reply_to_address: row.reply_to_address, reply_to_text: row.reply_to_text, envelope_from: row.envelope_from }).toEqual({
      from_address: [{ address: me }],
      from_text: me,
      reply_to_address: [{ address: me }],
      reply_to_text: me,
      envelope_from: [{ address: me }],
    });
    expect({ subject: row.subject, html: row.html, text: row.text, cc_address: row.cc_address, cc_text: row.cc_text, bcc_address: row.bcc_address, bcc_text: row.bcc_text }).toEqual({
      subject: "No Subject",
      html: "",
      text: "",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
    });
  });

  test("each send takes the next uid and mod-sequence of the user", async () => {
    const fresh = await newMailbox(server);
    await send({ ...BASE, subject: "first" }, fresh.client);
    await send({ ...BASE, subject: "second", sender: "other" }, fresh.client);
    await send({ ...BASE, subject: "third" }, fresh.client);
    const rows = await server.db.query(
      `SELECT m.subject, m.uid_domain, m.modseq, x.mailbox, x.uid FROM mails m JOIN mail_mailbox_uid x USING (mail_id)
       WHERE m.user_id = $1 ORDER BY m.uid_domain`,
      [fresh.id]
    );
    expect(rows).toEqual([
      { subject: "first", uid_domain: 1, modseq: "1", mailbox: "Sent Messages/accounts/box", uid: "1" },
      { subject: "second", uid_domain: 2, modseq: "2", mailbox: "Sent Messages/accounts/other", uid: "1" },
      { subject: "third", uid_domain: 3, modseq: "3", mailbox: "Sent Messages/accounts/box", uid: "2" },
    ]);
  });

  test("the sent mail shows up in the sender's Sent view, accounts and search", async () => {
    const fresh = await newMailbox(server);
    queueId("<listed@mail.test>");
    await send({ sender: "box", senderFullName: "Al", to: "friend@remote.example", subject: "Listed kumquat", html: "<p>Body here</p>" }, fresh.client);
    const me = fresh.address();
    const row = await latestMail(server, fresh.id);
    const { body } = await fresh.client.get(`/api/mails/headers/${me}?sent=1`);
    expect(body.body).toEqual([
      {
        id: row.mail_id,
        subject: "Listed kumquat",
        date: new Date(row.date).toISOString(),
        from: { value: [{ name: "Al", address: me }], text: `Al <${me}>` },
        to: { value: [{ address: "friend@remote.example" }], text: "friend@remote.example" },
        envelopeTo: { value: [{ address: "friend@remote.example" }], text: "" },
        read: true,
        saved: false,
        sent: true,
        insight: null,
        snippet: "Body here",
        messageId: `<<listed@mail.test>@${fresh.domain}>`,
      },
    ]);
    expect((await fresh.client.get(`/api/mails/headers/${me}`)).body.body).toEqual([]);
    expect((await fresh.client.get("/api/mails/unified")).body.body).toEqual([]);
    const accounts = (await fresh.client.get("/api/mails/accounts")).body.body;
    expect(accounts.received).toEqual([]);
    expect(accounts.sent).toEqual([{ key: me, doc_count: 1, unread_doc_count: 0, saved_doc_count: 0, updated: new Date(row.date).toISOString() }]);
    expect(subjects((await fresh.client.get("/api/mails/search/kumquat")).body.body)).toEqual(["Listed kumquat"]);
    expect((await fresh.client.get(`/api/mails/body/${row.mail_id}`)).body.body).toEqual({
      id: row.mail_id,
      html: "<p>Body here</p>",
      attachments: [],
      messageId: `<<listed@mail.test>@${fresh.domain}>`,
      insight: null,
    });
  });

  test("a Mailgun answer without an id, or with a bare one, still stores a Message-ID on the user's domain", async () => {
    const fresh = await newMailbox(server);
    server.mailgun.replyOnce(() => Response.json({ message: "Queued" }));
    await send(BASE, fresh.client);
    expect((await latestMail(server, fresh.id)).message_id).toMatch(
      new RegExp(`^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@${fresh.domain.replace(/\./g, "\\.")}>$`)
    );
    server.mailgun.replyOnce(() => Response.json({ id: "bare-id", message: "Queued" }));
    await send(BASE, fresh.client);
    expect((await latestMail(server, fresh.id)).message_id).toBe(`<bare-id@${fresh.domain}>`);
    server.mailgun.replyOnce(() => new Response("OK queued", { status: 200 }));
    expect((await send(BASE, fresh.client)).body).toEqual(SUCCESS);
    server.mailgun.replyOnce(() => new Response(null, { status: 204 }));
    expect((await send(BASE, fresh.client)).body).toEqual(SUCCESS);
    expect(await countMails(server, fresh.id)).toBe(4);
  });

  test("a repeated Mailgun id does not store a second row", async () => {
    const fresh = await newMailbox(server);
    queueId("<same@mail.test>");
    expect((await send({ ...BASE, subject: "first" }, fresh.client)).body).toEqual(SUCCESS);
    queueId("<same@mail.test>");
    expect((await send({ ...BASE, subject: "second" }, fresh.client)).body).toEqual(SUCCESS);
    expect(requests()).toHaveLength(2);
    const rows = await server.db.query("SELECT subject FROM mails WHERE user_id = $1", [fresh.id]);
    expect(rows).toEqual([{ subject: "first" }]);
  });
});

describe("POST /api/mails/send — which recipients go to Mailgun", () => {
  // NOTE: a send whose recipients are all on the bare mail domain is treated
  // as "to myself": Mailgun is skipped and the mail is stored as sent — but
  // nothing delivers it. A user writing to hello@mail.test (admin's address)
  // gets a success and admin never receives anything.
  test("recipients on the bare mail domain only: no Mailgun request, a Sent row, and no delivery to the recipient", async () => {
    const fresh = await newMailbox(server);
    const admin = await adminMailbox(server);
    const adminBefore = await countMails(server, admin.id);
    const { status, body } = await send({ sender: "box", to: "hello@mail.test", cc: "info@mail.test", bcc: "x@mail.test", subject: "Internal", html: "<p>x</p>" }, fresh.client);
    expect(status).toBe(200);
    expect(body).toEqual(SUCCESS);
    expect(requests()).toEqual([]);
    const row = await latestMail(server, fresh.id);
    expect(row.message_id).toMatch(new RegExp(`^<[0-9a-f-]{36}@${fresh.domain.replace(/\./g, "\\.")}>$`));
    expect({ subject: row.subject, sent: row.sent, read: row.read, to_address: row.to_address, envelope_to: row.envelope_to }).toEqual({
      subject: "Internal",
      sent: true,
      read: true,
      to_address: [{ address: "hello@mail.test" }],
      envelope_to: [{ address: "hello@mail.test" }, { address: "info@mail.test" }, { address: "x@mail.test" }],
    });
    expect(await countMails(server, admin.id)).toBe(adminBefore);
  });

  test("only the outside addresses of a mixed send are handed to Mailgun; the stored row keeps them all", async () => {
    const fresh = await newMailbox(server);
    await send(
      { sender: "box", to: "hello@mail.test, out@remote.example", cc: "info@mail.test, cc@remote.example", bcc: "x@mail.test, bcc@remote.example", subject: "Mixed", html: "<p>x</p>" },
      fresh.client
    );
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.fields).toEqual({
      from: [fresh.address()],
      to: ["out@remote.example"],
      cc: ["cc@remote.example"],
      bcc: ["bcc@remote.example"],
      subject: ["Mixed"],
      html: ["<p>x</p>"],
      text: ["x"],
    });
    const row = await latestMail(server, fresh.id);
    expect(row.to_text).toBe("hello@mail.test, out@remote.example");
    expect(row.envelope_to).toHaveLength(6);
  });

  // NOTE: "outside" is decided by a case-sensitive suffix test against
  // "@mail.test". Addresses on a user's subdomain — the sender's own included
  // — and an upper-cased "@MAIL.TEST" all count as outside and are relayed
  // through Mailgun, back to this server's own MX.
  test("addresses on a user subdomain, and the mail domain in upper case, count as outside", async () => {
    await send({ ...BASE, to: `other@${box.domain}, someone@neighbour.mail.test, x@MAIL.TEST, hello@mail.test` });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.fields.to).toEqual([`other@${box.domain}`, "someone@neighbour.mail.test", "x@MAIL.TEST"]);
  });

  test("with no outside To, the outside Cc addresses become the To and are not repeated as Cc", async () => {
    await send({ sender: "box", to: "hello@mail.test", cc: "cc1@remote.example, cc2@remote.example", bcc: "bcc@remote.example", subject: "CcOnly", html: "<p>x</p>" });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.fieldOrder).toEqual(["from", "to", "to", "bcc", "subject", "html", "text"]);
    expect(requests()[0]!.fields).toMatchObject({ to: ["cc1@remote.example", "cc2@remote.example"], bcc: ["bcc@remote.example"] });
    expect(requests()[0]!.fields.cc).toBeUndefined();
    server.mailgun.reset();
    await send({ sender: "box", cc: "only@remote.example", subject: "CcOnly2" });
    expect(requests()[0]!.fields).toEqual({ from: [box.address()], to: ["only@remote.example"], subject: ["CcOnly2"] });
  });

  test("with outside Bcc only, each Bcc address gets its own message naming it as To", async () => {
    const fresh = await newMailbox(server);
    const { body } = await send({ sender: "box", to: "hello@mail.test", bcc: "b1@remote.example, b2@remote.example, b3@remote.example", subject: "BccOnly", html: "<p>x</p>" }, fresh.client);
    expect(body).toEqual(SUCCESS);
    expect(requests()).toHaveLength(3);
    const byTo = [...requests()].sort((a, b) => a.fields.to![0]!.localeCompare(b.fields.to![0]!));
    expect(byTo.map((r) => r.fields)).toEqual(
      ["b1", "b2", "b3"].map((name) => ({
        from: [fresh.address()],
        to: [`${name}@remote.example`],
        subject: ["BccOnly"],
        html: ["<p>x</p>"],
        text: ["x"],
      }))
    );
    for (const request of byTo) expect(request.fieldOrder).toEqual(["from", "to", "subject", "html", "text"]);
    // One Sent row for the whole send, naming every recipient.
    expect(await countMails(server, fresh.id)).toBe(1);
    const row = await latestMail(server, fresh.id);
    expect({ to_address: row.to_address, bcc_address: row.bcc_address, bcc_text: row.bcc_text, envelope_to: row.envelope_to }).toEqual({
      to_address: [{ address: "hello@mail.test" }],
      bcc_address: [{ address: "b1@remote.example" }, { address: "b2@remote.example" }, { address: "b3@remote.example" }],
      bcc_text: "b1@remote.example, b2@remote.example, b3@remote.example",
      envelope_to: [{ address: "hello@mail.test" }, { address: "b1@remote.example" }, { address: "b2@remote.example" }, { address: "b3@remote.example" }],
    });
  });

  test("a Bcc-only send with no To at all stores a NULL To", async () => {
    const fresh = await newMailbox(server);
    expect((await send({ sender: "box", bcc: "b1@remote.example", subject: "NoTo" }, fresh.client)).body).toEqual(SUCCESS);
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.fields).toEqual({ from: [fresh.address()], to: ["b1@remote.example"], subject: ["NoTo"] });
    const row = await latestMail(server, fresh.id);
    expect({ to_address: row.to_address, to_text: row.to_text, envelope_to: row.envelope_to }).toEqual({
      to_address: null,
      to_text: null,
      envelope_to: [{ address: "b1@remote.example" }],
    });
    server.mailgun.reset();
    expect((await send({ sender: "box", to: "", bcc: "b2@remote.example" }, fresh.client)).body).toEqual(SUCCESS);
    expect((await latestMail(server, fresh.id)).to_address).toBeNull();
  });

  test("seven Bcc-only recipients get seven messages", async () => {
    const bcc = Array.from({ length: 7 }, (_, i) => `b${i}@remote.example`);
    expect((await send({ sender: "box", bcc: bcc.join(","), subject: "Seven" })).body).toEqual(SUCCESS);
    expect(requests().map((r) => r.fields.to![0]).sort()).toEqual(bcc);
  });
});

describe("POST /api/mails/send — replies", () => {
  test("inReplyTo becomes In-Reply-To, and References is the answered mail's References plus its id", async () => {
    const fresh = await newMailbox(server);
    await fresh.mail({ message_id: "<orig@remote.example>", reference_ids: ["<r0@remote.example>", "<r1@remote.example>"] });
    await send({ ...BASE, inReplyTo: "<orig@remote.example>" }, fresh.client);
    expect(requests()[0]!.fields["h:In-Reply-To"]).toEqual(["<orig@remote.example>"]);
    expect(requests()[0]!.fields["h:References"]).toEqual(["<r0@remote.example> <r1@remote.example> <orig@remote.example>"]);
    const row = await latestMail(server, fresh.id);
    expect({ in_reply_to: row.in_reply_to, reference_ids: row.reference_ids }).toEqual({
      in_reply_to: "<orig@remote.example>",
      reference_ids: ["<r0@remote.example>", "<r1@remote.example>", "<orig@remote.example>"],
    });
    // The stored reply threads with the mail it answers.
    const thread = await fresh.client.get(`/api/mails/thread/${row.mail_id}`);
    expect(thread.body.body).toHaveLength(2);
  });

  test("ids are put in angle brackets whichever way the client or the stored mail spells them", async () => {
    const fresh = await newMailbox(server);
    await fresh.mail({ message_id: "<bracketed@x>", reference_ids: ["bare-ref@x", "<bracketed-ref@x>"] });
    await fresh.mail({ message_id: "bare-stored@x", reference_ids: ["<first@x>"] });
    const referencesFor = async (inReplyTo: string) => {
      server.mailgun.reset();
      expect((await send({ ...BASE, inReplyTo }, fresh.client)).body).toEqual(SUCCESS);
      return [requests()[0]!.fields["h:In-Reply-To"]![0], requests()[0]!.fields["h:References"]![0]];
    };
    expect(await referencesFor("bracketed@x")).toEqual(["<bracketed@x>", "<bare-ref@x> <bracketed-ref@x> <bracketed@x>"]);
    expect(await referencesFor("  <bracketed@x>  ")).toEqual(["<bracketed@x>", "<bare-ref@x> <bracketed-ref@x> <bracketed@x>"]);
    expect(await referencesFor("<bare-stored@x>")).toEqual(["<bare-stored@x>", "<first@x> <bare-stored@x>"]);
    expect(await referencesFor("bare-stored@x")).toEqual(["<bare-stored@x>", "<first@x> <bare-stored@x>"]);
  });

  test("an id the user holds no mail for threads under itself alone", async () => {
    await send({ ...BASE, inReplyTo: "<nowhere@remote.example>" });
    expect(requests()[0]!.fields["h:References"]).toEqual(["<nowhere@remote.example>"]);
    const row = await latestMail(server, box.id);
    expect(row.reference_ids).toEqual(["<nowhere@remote.example>"]);
  });

  test("another user's mail with that id lends no References", async () => {
    const other = await newMailbox(server);
    await other.mail({ message_id: "<theirs@x>", reference_ids: ["<their-secret-ref@x>"] });
    await send({ ...BASE, inReplyTo: "<theirs@x>" });
    expect(requests()[0]!.fields["h:References"]).toEqual(["<theirs@x>"]);
  });

  test("the answered id is listed once, last, even when the answered mail references itself", async () => {
    const fresh = await newMailbox(server);
    await fresh.mail({ message_id: "<self@x>", reference_ids: ["<a@x>", "<self@x>", "<b@x>"] });
    await send({ ...BASE, inReplyTo: "<self@x>" }, fresh.client);
    expect(requests()[0]!.fields["h:References"]).toEqual(["<a@x> <b@x> <self@x>"]);
  });

  test("References is cut to the last 50 ids", async () => {
    const fresh = await newMailbox(server);
    await fresh.mail({ message_id: "<many@x>", reference_ids: Array.from({ length: 120 }, (_, i) => `<m${i}@x>`) });
    await send({ ...BASE, inReplyTo: "<many@x>" }, fresh.client);
    const references = requests()[0]!.fields["h:References"]![0]!.split(" ");
    expect(references).toHaveLength(50);
    expect(references[0]).toBe("<m71@x>");
    expect(references[49]).toBe("<many@x>");
    expect((await latestMail(server, fresh.id)).reference_ids).toEqual(references);
  });

  test("an expunged mail lends no References; a draft or spam mail does", async () => {
    const fresh = await newMailbox(server);
    await fresh.mail({ message_id: "<gone@x>", reference_ids: ["<gone-ref@x>"], expunged: true });
    await fresh.mail({ message_id: "<spam@x>", reference_ids: ["<spam-ref@x>"], is_spam: true });
    await send({ ...BASE, inReplyTo: "<gone@x>" }, fresh.client);
    expect(requests()[0]!.fields["h:References"]).toEqual(["<gone@x>"]);
    server.mailgun.reset();
    await send({ ...BASE, inReplyTo: "<spam@x>" }, fresh.client);
    expect(requests()[0]!.fields["h:References"]).toEqual(["<spam-ref@x> <spam@x>"]);
  });

  test("an empty, false or null inReplyTo is no reply", async () => {
    for (const inReplyTo of ["", false, null]) {
      server.mailgun.reset();
      expect((await send({ ...BASE, inReplyTo })).body).toEqual(SUCCESS);
      expect({ inReplyTo, order: requests()[0]!.fieldOrder }).toEqual({ inReplyTo, order: ["from", "to", "subject", "html", "text"] });
    }
    expect((await latestMail(server, box.id)).in_reply_to).toBeNull();
  });

  // NOTE: inReplyTo is used as a string before anything checks that it is
  // one. A number, true, a list or an object is a 500 — the only field of the
  // body whose wrong type is not answered as a 200 refusal.
  test("an inReplyTo that is a number, true, a list or an object is a 500", async () => {
    const before = await countMails(server, box.id);
    for (const inReplyTo of [5, true, ["<a@x>"], { id: "<a@x>" }]) {
      const { status, body } = await send({ ...BASE, inReplyTo });
      expect({ inReplyTo, status, body }).toEqual({ inReplyTo, status: 500, body: INTERNAL_ERROR });
    }
    expect(requests()).toEqual([]);
    expect(await countMails(server, box.id)).toBe(before);
  });
});

describe("POST /api/mails/send — validation", () => {
  const refused = async (body: unknown, message: string) => {
    server.mailgun.reset();
    const before = await countMails(server, box.id);
    const { status, body: answer } = await send(body);
    expect({ body, status, answer }).toEqual({ body, status: 200, answer: failed(message) });
    expect(requests()).toEqual([]);
    expect(await countMails(server, box.id)).toBe(before);
  };
  const accepted = async (body: unknown) => {
    server.mailgun.reset();
    const { status, body: answer } = await send(body);
    expect({ body, status, answer }).toEqual({ body, status: 200, answer: SUCCESS });
    expect(requests()).toHaveLength(1);
  };

  test("sender is required and must be a string", async () => {
    const { sender: _sender, ...withoutSender } = BASE;
    await refused(withoutSender, "Sender is required");
    for (const sender of ["", 5, 0, true, false, null, ["box"], [], { a: 1 }]) await refused({ ...BASE, sender }, "Sender is required");
  });

  test("sender is a local part of letters, digits, dot, hyphen and underscore", async () => {
    for (const sender of ["a b", "a@b", `box@${box.domain}`, "ü", "a+b", "box\n", "<box>", "a,b", "a/b", "日本", " box", "box "]) {
      await refused({ ...BASE, sender }, "Invalid sender format");
    }
    for (const sender of ["A.B-c_d9", ".", "-", "_", "0", "a".repeat(300)]) await accepted({ ...BASE, sender });
  });

  test("a display name with a line break is refused; anything else is accepted", async () => {
    for (const senderFullName of ["Name\r\nBcc: x@y.z", "Name\nX", "Name\rX", "\n"]) {
      await refused({ ...BASE, senderFullName }, "Invalid sender name");
    }
    for (const senderFullName of ["Tab\tName", "a".repeat(2000), "", null, false, 0, 5, true, ["A"], { a: 1 }]) {
      await accepted({ ...BASE, senderFullName });
    }
  });

  test("at least one recipient is required across To, Cc and Bcc", async () => {
    const { to: _to, ...withoutTo } = BASE;
    await refused(withoutTo, "Recipient email address is required");
    for (const to of ["", ",", " ", " , ,"]) await refused({ ...BASE, to }, "Recipient email address is required");
    await refused({ ...BASE, to: "", cc: "", bcc: "" }, "Recipient email address is required");
    await accepted({ ...withoutTo, cc: "c@remote.example" });
    await accepted({ ...withoutTo, bcc: "b@remote.example" });
    await accepted({ ...BASE, to: "", cc: " c@remote.example " });
  });

  test("To, Cc and Bcc must each be a string or absent: any other type refuses the whole send", async () => {
    for (const field of ["to", "cc", "bcc"]) {
      for (const value of [5, 0, true, false, null, ["x@remote.example"], [], { a: 1 }]) {
        await refused({ ...BASE, [field]: value }, "Recipient email address is required");
      }
    }
  });

  test("each address must be plain local@domain.tld; the first bad one is named", async () => {
    for (const to of [
      "abc", "a@b", "a@localhost", "Name <a@b.co>", "<a@b.co>", "a@b.co;c@d.co", "a@b.co c@d.co", "a@@b.co", "ü@b.co",
      "a@bü.co", '"a b"@b.co', "a@[127.0.0.1]", "a@b_c.co", "a'b@c.co", "a@b.co\r\nBcc: z@z.zz", "a!b@c.co",
    ]) {
      await refused({ ...BASE, to }, `Invalid recipient address: ${to}`);
    }
    // A comma splits the list, so each half is judged on its own.
    await refused({ ...BASE, to: "a@b,co" }, "Invalid recipient address: a@b");
    await refused({ ...BASE, to: "good@remote.example, bad1, bad2" }, "Invalid recipient address: bad1");
    await refused({ ...BASE, cc: "nope" }, "Invalid CC address: nope");
    await refused({ ...BASE, cc: "ok@remote.example,  also bad " }, "Invalid CC address: also bad");
    await refused({ ...BASE, bcc: "nope" }, "Invalid BCC address: nope");
    // To is checked before Cc, Cc before Bcc.
    await refused({ ...BASE, to: "bad-to", cc: "bad-cc", bcc: "bad-bcc" }, "Invalid recipient address: bad-to");
    await refused({ ...BASE, cc: "bad-cc", bcc: "bad-bcc" }, "Invalid CC address: bad-cc");
  });

  test("addresses the check lets through", async () => {
    for (const to of [
      "X@REMOTE.EXAMPLE", "a@b.c", "a+b@c.co", "a.b@c.co", ".a@b.co", "a.@b.co", "a..b@c.co", "a@b..co", "a@-b.co", "a@b-.co",
      "a_b@c.co", "a-b@c.co", "a@b.c0m", "a@1.2.3.4", `${"a".repeat(65)}@b.co`, `a@${"b".repeat(250)}.co`,
    ]) {
      await accepted({ ...BASE, to });
    }
  });

  test("a subject may be 998 UTF-16 units long, not 999", async () => {
    await accepted({ ...BASE, subject: "s".repeat(998) });
    await refused({ ...BASE, subject: "s".repeat(999) }, "Subject exceeds maximum length of 998 characters");
    // An emoji is two units.
    await accepted({ ...BASE, subject: "😀".repeat(499) });
    await refused({ ...BASE, subject: "😀".repeat(500) }, "Subject exceeds maximum length of 998 characters");
  });

  test("the first failing check is the one reported: sender, name, recipients, addresses, subject", async () => {
    await refused({ sender: "", senderFullName: "a\nb", to: "bad", subject: "s".repeat(999) }, "Sender is required");
    await refused({ sender: "a b", senderFullName: "a\nb", to: "bad", subject: "s".repeat(999) }, "Invalid sender format");
    await refused({ sender: "box", senderFullName: "a\nb", to: "bad", subject: "s".repeat(999) }, "Invalid sender name");
    await refused({ sender: "box", to: "", subject: "s".repeat(999) }, "Recipient email address is required");
    await refused({ sender: "box", to: "bad", subject: "s".repeat(999) }, "Invalid recipient address: bad");
  });

  test("subject and html of other JSON types are accepted", async () => {
    for (const field of ["subject", "html"]) {
      for (const value of ["", 5, 0, true, false, null, { a: 1 }]) await accepted({ ...BASE, [field]: value });
    }
    await accepted({ ...BASE, subject: ["a", "b"] });
  });

  // NOTE: an html that is a list passes validation and then breaks the
  // plain-text conversion; that is reported as a delivery failure although
  // Mailgun was never contacted.
  test("an html that is a list is answered as a failed delivery", async () => {
    await refused({ ...BASE, html: ["<p>x</p>"] }, "Failed to send email. Please try again.");
  });

  test("the refusals are exact", async () => {
    const { status, text, headers } = await send({});
    expect(status).toBe(200);
    expect(text).toBe('{"status":"failed","message":"Sender is required"}');
    expect(headers.get("content-type")).toBe(JSON_TYPE);
    expect((await send({ ...BASE, to: "x" })).text).toBe('{"status":"failed","message":"Invalid recipient address: x"}');
  });

  test("bodies that are not a JSON object", async () => {
    for (const { label, body, headers, parsed } of NON_OBJECT_BODIES) {
      const response = await box.client.request("POST", "/api/mails/send", { body, headers });
      const expected = parsed === "bad-request" ? { status: 400, body: BAD_REQUEST } : { status: 200, body: failed("Sender is required") };
      expect({ label, status: response.status, body: response.body }).toEqual({ label, ...expected });
    }
    for (const [label, options] of [
      ["text/plain", { body: JSON.stringify(BASE), headers: { "Content-Type": "text/plain" } }],
      ["form-encoded", { body: "sender=box&to=x%40remote.example", headers: { "Content-Type": "application/x-www-form-urlencoded" } }],
    ] as const) {
      const { status, body } = await box.client.request("POST", "/api/mails/send", options);
      expect({ label, status, body }).toEqual({ label, status: 200, body: failed("Sender is required") });
    }
    expect(requests()).toEqual([]);
  });

  test("a JSON body over 10 MiB is a 413; one just under is sent", async () => {
    const over = await send({ ...BASE, html: "x".repeat(10 * 1024 * 1024) });
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ status: "error", message: "Payload Too Large" });
    expect(requests()).toEqual([]);
    const html = "x".repeat(10 * 1024 * 1024 - 1024);
    const under = await send({ ...BASE, html });
    expect(under.body).toEqual(SUCCESS);
    expect((await latestMail(server, box.id)).html).toHaveLength(html.length);
  }, 60_000);
});

describe("POST /api/mails/send — the sender's identity", () => {
  test("the From domain always comes from the session, never from the body", async () => {
    const other = await newMailbox(server);
    await send({ ...BASE, sender: "box", username: other.username, domain: other.domain, from: `x@${other.domain}` });
    expect(requests()[0]!.fields.from).toEqual([box.address()]);
    const row = await latestMail(server, box.id);
    expect(row.from_address).toEqual([{ address: box.address() }]);
    expect(await countMails(server, other.id)).toBe(0);
  });

  test("any local part may be used as sender, including one that has received no mail", async () => {
    await send({ ...BASE, sender: "never-seen-before" });
    expect(requests()[0]!.fields.from).toEqual([`never-seen-before@${box.domain}`]);
    expect((await box.client.get("/api/mails/accounts")).body.body.sent.map((a: { key: string }) => a.key)).toContain(
      `never-seen-before@${box.domain}`
    );
  });
});
