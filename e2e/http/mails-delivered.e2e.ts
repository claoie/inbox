/**
 * The mail routes over mail that really arrived: each message here is
 * delivered over SMTP, so the rows are whatever the receive pipeline writes.
 */
import fs from "fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deliverMail, readMail, rfc822, startServer, waitFor, type TestServer } from "../harness";
import { ISO_MS, UUID, adminMailbox, attachmentPath, newMailbox, subjects, type Mailbox } from "./mails-helpers";

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

const SENDER = "someone@remote.example";
let sequence = 0;
const nextId = () => `<delivered-${++sequence}-${Date.now()}@remote.example>`;

/** Delivers one message and returns the row stored for `owner`. */
const deliver = async (owner: Mailbox, recipients: string[], data: string, messageId: string) => {
  const result = await deliverMail(server, { from: SENDER, to: recipients, data });
  expect(result.accepted).toBe(true);
  return waitFor(
    async () => (await server.db.query("SELECT * FROM mails WHERE user_id = $1 AND message_id = $2", [owner.id, messageId]))[0],
    { what: `the delivered mail ${messageId}` }
  );
};

const listRow = async (owner: Mailbox, account: string, mailId: string) => {
  const { body } = await owner.client.get(`/api/mails/headers/${account}`);
  return (body.body as Record<string, any>[]).find((row) => row.id === mailId);
};

describe("a plain-text delivery", () => {
  let box: Mailbox;
  let row: Record<string, any>;
  const messageId = nextId();
  beforeAll(async () => {
    box = await newMailbox(server);
    row = await deliver(
      box,
      [box.address()],
      rfc822({
        from: `"Some One" <${SENDER}>`,
        to: `Box <${box.address()}>`,
        cc: "Other <other@remote.example>, third@remote.example",
        subject: "Delivered plain",
        text: "Hello plain\nSecond line",
        messageId,
        date: new Date("2026-03-01T10:00:00Z"),
      }),
      messageId
    );
  });

  test("is listed with the addresses as the pipeline stores them", async () => {
    const me = box.address();
    expect(await listRow(box, me, row.mail_id)).toEqual({
      id: row.mail_id,
      subject: "Delivered plain",
      date: "2026-03-01T10:00:00.000Z",
      from: { value: [{ name: "Some One", address: SENDER }], text: `"Some One" <${SENDER}>` },
      to: { value: [{ name: "Box", address: me }], text: `"Box" <${me}>` },
      cc: {
        value: [{ name: "Other", address: "other@remote.example" }, { name: "", address: "third@remote.example" }],
        text: '"Other" <other@remote.example>, third@remote.example',
      },
      envelopeTo: { value: [{ address: me }], text: "" },
      read: false,
      saved: false,
      sent: false,
      insight: null,
      snippet: "Hello plain Second line",
      messageId,
    });
  });

  test("counts as one unread mail of the account", async () => {
    const { body } = await box.client.get("/api/mails/accounts");
    expect(body.body).toEqual({
      received: [{ key: box.address(), doc_count: 1, unread_doc_count: 1, saved_doc_count: 0, updated: "2026-03-01T10:00:00.000Z" }],
      sent: [],
      spam: [],
      shared: [],
      unread_mail_count: 1,
    });
  });

  test("is in the unified list, a page and a delta", async () => {
    expect((await box.client.get("/api/mails/unified")).body.body.map((h: { id: string }) => h.id)).toEqual([row.mail_id]);
    expect((await box.client.get("/api/mails/unified?limit=5")).body.body.headers.map((h: { id: string }) => h.id)).toEqual([row.mail_id]);
    const since = new Date(Date.now() - 600_000).toISOString();
    const delta = (await box.client.get(`/api/mails/headers/${box.address()}?since=${since}`)).body.body;
    expect(delta.headers.map((h: { id: string }) => h.id)).toEqual([row.mail_id]);
    expect(delta.expunged_ids).toEqual([]);
    expect(delta.as_of).toMatch(ISO_MS);
  });

  test("is found by a word of its text, with highlights", async () => {
    const { body } = await box.client.get("/api/mails/search/second");
    expect(body.body).toHaveLength(1);
    expect(body.body[0]).toMatchObject({
      id: row.mail_id,
      highlight: { text: ["Hello plain\n<em>Second</em> line\n"] },
      snippet: "Hello plain Second line",
    });
    expect((await box.client.get("/api/mails/search-accounts/second")).body.body.map((a: { key: string }) => a.key)).toEqual([box.address()]);
  });

  test("its body is the text made into HTML, with an empty attachment list, and reading marks it", async () => {
    const { body } = await box.client.get(`/api/mails/body/${row.mail_id}`);
    expect(body.body).toEqual({
      id: row.mail_id,
      html: '<div style="white-space: pre-wrap">Hello plain\nSecond line\n</div>',
      attachments: [],
      messageId,
      insight: null,
    });
    const after = await readMail(server, row.mail_id);
    expect(after!.read).toBe(true);
    expect(Number(after!.modseq)).toBeGreaterThan(Number(row.modseq));
  });
});

describe("an HTML delivery to undisclosed recipients", () => {
  test("has no To: only the envelope recipient files it under the account", async () => {
    const box = await newMailbox(server);
    const messageId = nextId();
    const row = await deliver(
      box,
      [box.address()],
      rfc822({
        from: SENDER,
        to: "undisclosed-recipients:;",
        subject: "Bcc delivery",
        html: "<p>Hello <b>html</b></p><blockquote>quoted</blockquote>",
        messageId,
        date: new Date("2026-03-01T11:00:00+09:00"),
      }),
      messageId
    );
    const listed = await listRow(box, box.address(), row.mail_id);
    expect(listed).toEqual({
      id: row.mail_id,
      subject: "Bcc delivery",
      date: "2026-03-01T02:00:00.000Z",
      from: { value: [{ name: "", address: SENDER }], text: SENDER },
      envelopeTo: { value: [{ address: box.address() }], text: "" },
      read: false,
      saved: false,
      sent: false,
      insight: null,
      snippet: "Hello html",
      messageId,
    });
    expect("to" in listed!).toBe(false);
    expect((await box.client.get("/api/mails/unified")).body.body).toEqual([listed]);
    expect((await box.client.get(`/api/mails/body/${row.mail_id}`)).body.body.html).toBe(
      "<p>Hello <b>html</b></p><blockquote>quoted</blockquote>\n"
    );
  });
});

describe("a delivery with text and HTML parts", () => {
  test("lists the text part as snippet and serves the HTML part as body", async () => {
    const box = await newMailbox(server);
    const messageId = nextId();
    const row = await deliver(
      box,
      [box.address()],
      rfc822({
        from: SENDER,
        to: box.address(),
        subject: "=?UTF-8?B?w5xuw68g8J+YgCDml6XmnKzoqp4=?=",
        text: "Text part ünï 😀\n\n> quoted line\nOn Monday someone wrote:",
        html: "<div>HTML part <i>ünï</i> 😀</div>",
        messageId,
      }),
      messageId
    );
    const listed = await listRow(box, box.address(), row.mail_id);
    expect(listed).toMatchObject({ subject: "Ünï 😀 日本語", snippet: "Text part ünï 😀" });
    expect((await box.client.get(`/api/mails/body/${row.mail_id}`)).body.body.html).toBe("<div>HTML part <i>ünï</i> 😀</div>");
    expect(subjects((await box.client.get(`/api/mails/search/${encodeURIComponent("日本語")}`)).body.body)).toEqual(["Ünï 😀 日本語"]);
  });

  test("a message without a Date header is dated when it arrived", async () => {
    const box = await newMailbox(server);
    const messageId = nextId();
    const data = [`From: ${SENDER}`, `To: ${box.address()}`, "Subject: No date", `Message-ID: ${messageId}`, "", "Body", ""].join("\r\n");
    const before = Date.now();
    const row = await deliver(box, [box.address()], data, messageId);
    const listed = await listRow(box, box.address(), row.mail_id);
    expect(listed!.date).toMatch(ISO_MS);
    expect(Date.parse(listed!.date)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(listed!.date)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("a delivery with an attachment", () => {
  test("records the attachment on the body and serves the file", async () => {
    const box = await newMailbox(server);
    const messageId = nextId();
    const boundary = "mixed-boundary-e2e";
    const data = [
      `From: ${SENDER}`,
      `To: ${box.address()}`,
      "Subject: With attachment",
      `Message-ID: ${messageId}`,
      "Date: Sun, 01 Mar 2026 12:00:00 +0000",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached",
      `--${boundary}`,
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("attached text\n").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const row = await deliver(box, [box.address()], data, messageId);
    const { body } = await box.client.get(`/api/mails/body/${row.mail_id}`);
    expect(body.body.attachments).toHaveLength(1);
    const [attachment] = body.body.attachments;
    expect(attachment).toEqual({ size: 14, content: { data: attachment.content.data }, filename: "note.txt", contentType: "text/plain" });
    expect(attachment.content.data).toMatch(UUID);
    expect(body.body.html).toBe('<div style="white-space: pre-wrap">See attached</div>');
    expect(fs.readFileSync(attachmentPath(server, attachment.content.data), "utf8")).toBe("attached text\n");

    const download = await box.client.get(`/api/mails/attachment/${attachment.content.data}`);
    expect(download.status).toBe(200);
    expect(download.text).toBe("attached text\n");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe(`filename="${attachment.content.data}"`);
    expect(download.headers.get("etag")).toMatch(/^W\/"e-[0-9a-f]+"$/);

    const other = await newMailbox(server);
    expect((await other.client.get(`/api/mails/attachment/${attachment.content.data}`)).body).toEqual({ status: "failed", message: "Not found" });
    // The list row says nothing about attachments.
    expect("attachments" in (await listRow(box, box.address(), row.mail_id))!).toBe(false);
  });
});

describe("one delivery to several recipients", () => {
  test("each user gets their own row, listed under each of their addresses", async () => {
    const first = await newMailbox(server);
    const second = await newMailbox(server);
    const messageId = nextId();
    const to = [first.address(), first.address("second"), second.address()];
    const data = rfc822({ from: SENDER, to: to.join(", "), subject: "To several", text: "shared", messageId });
    const firstRow = await deliver(first, to, data, messageId);
    const secondRow = await waitFor(
      async () => (await server.db.query("SELECT * FROM mails WHERE user_id = $1 AND message_id = $2", [second.id, messageId]))[0]
    );
    expect(firstRow.mail_id).not.toBe(secondRow.mail_id);

    const accounts = (await first.client.get("/api/mails/accounts")).body.body.received;
    expect(accounts.map((a: { key: string }) => a.key).sort()).toEqual([first.address(), first.address("second")].sort());
    for (const account of [first.address(), first.address("second")]) {
      expect(subjects((await first.client.get(`/api/mails/headers/${account}`)).body.body)).toEqual(["To several"]);
    }
    // One row for the user, so the unified list shows it once.
    expect((await first.client.get("/api/mails/unified")).body.body).toHaveLength(1);
    expect(subjects((await second.client.get(`/api/mails/headers/${second.address()}`)).body.body)).toEqual(["To several"]);

    // Reading it as one user leaves the other's copy unread.
    await first.client.get(`/api/mails/body/${firstRow.mail_id}`);
    expect((await readMail(server, secondRow.mail_id))!.read).toBe(false);
    expect((await second.client.get(`/api/mails/body/${firstRow.mail_id}`)).body).toEqual({ status: "failed", message: "No email is found." });
  });

  test("a Bcc'd recipient's address is not shown to the other recipients through envelopeTo", async () => {
    const visible = await newMailbox(server);
    const hidden = await newMailbox(server);
    const messageId = nextId();
    const data = rfc822({ from: SENDER, to: visible.address(), subject: "With a hidden recipient", text: "x", messageId });
    const row = await deliver(visible, [visible.address(), hidden.address()], data, messageId);
    const listed = await listRow(visible, visible.address(), row.mail_id);
    expect(listed!.to).toEqual({ value: [{ name: "", address: visible.address() }], text: visible.address() });
    expect(listed!.envelopeTo).toEqual({ value: [{ address: visible.address() }], text: "" });
    const thread = (await visible.client.get(`/api/mails/thread/${row.mail_id}`)).body.body;
    expect(thread[0].envelopeTo).toEqual({ value: [{ address: visible.address() }], text: "" });
  });

  test("a mail Bcc'd to two local users: each sees only their own address, in every list", async () => {
    const first = await newMailbox(server);
    const second = await newMailbox(server);
    const messageId = nextId();
    const recipients = [first.address(), second.address(), "outsider@remote.example"];
    const data = rfc822({ from: SENDER, to: "list@remote.example", subject: "Bcc'd quince", text: "quince", messageId });
    const firstRow = await deliver(first, recipients, data, messageId);
    const secondRow = await waitFor(
      async () => (await server.db.query("SELECT * FROM mails WHERE user_id = $1 AND message_id = $2", [second.id, messageId]))[0]
    );
    // The rows still store the whole envelope; what a user is shown of it is cut when it is read.
    expect(secondRow.envelope_to).toEqual(recipients.map((address) => ({ address })));

    const since = new Date(Date.now() - 600_000).toISOString();
    for (const [box, row] of [
      [first, firstRow],
      [second, secondRow],
    ] as const) {
      const me = box.address();
      const own = { value: [{ address: me }], text: "" };
      const find = (headers: Record<string, any>[]) => headers.find((header) => header.id === row.mail_id)?.envelopeTo;
      const get = async (route: string) => (await box.client.get(route)).body.body;
      expect({ me, list: find(await get(`/api/mails/headers/${me}`)) }).toEqual({ me, list: own });
      expect(find((await get(`/api/mails/headers/${me}?limit=5`)).headers)).toEqual(own);
      expect(find((await get(`/api/mails/headers/${me}?since=${since}`)).headers)).toEqual(own);
      expect(find(await get("/api/mails/unified"))).toEqual(own);
      expect(find((await get("/api/mails/unified?limit=5")).headers)).toEqual(own);
      expect(find((await get(`/api/mails/unified?since=${since}`)).headers)).toEqual(own);
      expect(find(await get(`/api/mails/thread/${row.mail_id}`))).toEqual(own);
      expect(find(await get("/api/mails/search/quince"))).toEqual(own);
    }
  });

  test("a user with several addresses on the envelope sees all of theirs and no one else's", async () => {
    const box = await newMailbox(server);
    const other = await newMailbox(server);
    const messageId = nextId();
    const recipients = [box.address("one"), other.address(), box.address("two")];
    const data = rfc822({ from: SENDER, to: "list@remote.example", subject: "To two of mine", text: "x", messageId });
    const row = await deliver(box, recipients, data, messageId);
    const mine = { value: [{ address: box.address("one") }, { address: box.address("two") }], text: "" };
    for (const account of [box.address("one"), box.address("two")]) {
      expect({ account, envelopeTo: (await listRow(box, account, row.mail_id))!.envelopeTo }).toEqual({ account, envelopeTo: mine });
    }
    expect((await box.client.get("/api/mails/unified")).body.body[0].envelopeTo).toEqual(mine);
    const theirs = await waitFor(
      async () => (await server.db.query("SELECT mail_id FROM mails WHERE user_id = $1 AND message_id = $2", [other.id, messageId]))[0]
    );
    expect((await listRow(other, other.address(), theirs.mail_id))!.envelopeTo).toEqual({ value: [{ address: other.address() }], text: "" });
  });

  test("a sent row keeps its whole envelope: the recipients its sender chose", async () => {
    const box = await newMailbox(server);
    const other = await newMailbox(server);
    const me = box.address();
    const sent = await box.client.post("/api/mails/send", {
      sender: "box",
      to: "friend@remote.example",
      bcc: other.address(),
      subject: "Sent with a Bcc",
      html: "<p>x</p>",
    });
    expect(sent.body).toEqual({ status: "success" });
    const [row] = (await box.client.get(`/api/mails/headers/${me}?sent=1`)).body.body;
    expect(row.bcc).toEqual({ value: [{ address: other.address() }], text: other.address() });
    expect(row.envelopeTo).toEqual({ value: [{ address: "friend@remote.example" }, { address: other.address() }], text: "" });
  });

  test("recipient addresses are stored in lower case whatever case they arrive in", async () => {
    const box = await newMailbox(server);
    const messageId = nextId();
    const upper = `Box@${box.domain.toUpperCase()}`;
    const data = rfc822({ from: SENDER.toUpperCase(), to: upper, subject: "Upper case", text: "x", messageId });
    const row = await deliver(box, [upper], data, messageId);
    const listed = await listRow(box, box.address(), row.mail_id);
    expect(listed).toMatchObject({
      from: { value: [{ name: "", address: SENDER }], text: SENDER.toUpperCase() },
      to: { value: [{ name: "", address: box.address() }], text: upper },
      envelopeTo: { value: [{ address: box.address() }], text: "" },
    });
    expect((await box.client.get("/api/mails/accounts")).body.body.received.map((a: { key: string }) => a.key)).toEqual([box.address()]);
  });
});

describe("delivered conversations", () => {
  test("a reply delivered with In-Reply-To and References threads with the mail it answers", async () => {
    const box = await newMailbox(server);
    const rootId = nextId();
    const replyId = nextId();
    const looseId = nextId();
    const root = await deliver(
      box,
      [box.address()],
      rfc822({ from: SENDER, to: box.address(), subject: "Plans", text: "first", messageId: rootId, date: new Date("2026-03-01T10:00:00Z") }),
      rootId
    );
    const reply = await deliver(
      box,
      [box.address()],
      rfc822({
        from: SENDER,
        to: box.address(),
        subject: "Something else",
        text: "second",
        messageId: replyId,
        date: new Date("2026-03-02T10:00:00Z"),
        headers: [`In-Reply-To: ${rootId}`, `References: <older@remote.example> ${rootId}`],
      }),
      replyId
    );
    // A header-less "Re:" of the root's subject from the same sender joins by subject.
    await deliver(
      box,
      [box.address()],
      rfc822({ from: SENDER, to: box.address(), subject: "RE: plans", text: "third", messageId: looseId, date: new Date("2026-03-03T10:00:00Z") }),
      looseId
    );
    const listed = await listRow(box, box.address(), reply.mail_id);
    expect(listed).toMatchObject({ messageId: replyId, inReplyTo: rootId, references: ["<older@remote.example>", rootId] });
    expect(subjects((await box.client.get(`/api/mails/thread/${root.mail_id}`)).body.body)).toEqual(["Plans", "Something else", "RE: plans"]);
    expect(subjects((await box.client.get(`/api/mails/thread/${reply.mail_id}`)).body.body)).toEqual(["Plans", "Something else"]);
  });

  test("answering a delivered mail through /send continues its References", async () => {
    const box = await newMailbox(server);
    const rootId = nextId();
    await deliver(
      box,
      [box.address()],
      rfc822({ from: SENDER, to: box.address(), subject: "Question", text: "?", messageId: rootId, headers: ["References: <before@remote.example>"] }),
      rootId
    );
    server.mailgun.reset();
    const { body } = await box.client.post("/api/mails/send", { sender: "box", to: SENDER, subject: "Re: Question", html: "<p>Answer</p>", inReplyTo: rootId });
    expect(body).toEqual({ status: "success" });
    expect(server.mailgun.requests[0]!.fields["h:In-Reply-To"]).toEqual([rootId]);
    expect(server.mailgun.requests[0]!.fields["h:References"]).toEqual([`<before@remote.example> ${rootId}`]);
    const sent = (await box.client.get(`/api/mails/headers/${box.address()}?sent=1`)).body.body[0];
    expect(subjects((await box.client.get(`/api/mails/thread/${sent.id}`)).body.body)).toEqual(["Question", "Re: Question"]);
  });
});

describe("delivered mail and the write routes", () => {
  test("mark, spam mark and delete act on a delivered mail", async () => {
    const box = await newMailbox(server);
    const messageId = nextId();
    const row = await deliver(box, [box.address()], rfc822({ from: SENDER, to: box.address(), subject: "Writable", text: "x", messageId }), messageId);
    expect((await box.client.post("/api/mails/mark", { mail_id: row.mail_id, read: true, save: true })).body).toEqual({ status: "success" });
    expect(await listRow(box, box.address(), row.mail_id)).toMatchObject({ read: true, saved: true });
    expect((await box.client.post("/api/mails/spam/mark", { mail_id: row.mail_id, is_spam: true })).body).toEqual({ status: "success" });
    expect(await listRow(box, box.address(), row.mail_id)).toBeUndefined();
    expect(subjects((await box.client.get(`/api/mails/headers/${box.address()}?spam=1`)).body.body)).toEqual(["Writable"]);
    expect((await box.client.delete(`/api/mails/${row.mail_id}`)).body).toEqual({ status: "success" });
    expect(await readMail(server, row.mail_id)).toBeUndefined();
    expect((await box.client.get("/api/mails/accounts")).body.body).toEqual({ received: [], sent: [], spam: [], shared: [], unread_mail_count: 0 });
  });
});

describe("deliveries to admin", () => {
  test("mail for the bare domain and for admin.<domain> both land with admin, as accounts of both its domains", async () => {
    const admin = await adminMailbox(server);
    const bareId = nextId();
    const subId = nextId();
    const bare = await deliver(admin, ["delivered-bare@mail.test"], rfc822({ from: SENDER, to: "delivered-bare@mail.test", subject: "To the bare domain", text: "x", messageId: bareId }), bareId);
    const sub = await deliver(admin, ["delivered-sub@admin.mail.test"], rfc822({ from: SENDER, to: "delivered-sub@admin.mail.test", subject: "To admin.domain", text: "x", messageId: subId }), subId);
    expect(subjects((await admin.client.get("/api/mails/headers/delivered-bare@mail.test")).body.body)).toEqual(["To the bare domain"]);
    expect(subjects((await admin.client.get("/api/mails/headers/delivered-sub@admin.mail.test")).body.body)).toEqual(["To admin.domain"]);
    const keys = (await admin.client.get("/api/mails/accounts")).body.body.received.map((a: { key: string }) => a.key);
    expect(keys).toContain("delivered-bare@mail.test");
    expect(keys).toContain("delivered-sub@admin.mail.test");
    const unified = (await admin.client.get("/api/mails/unified")).body.body.map((h: { id: string }) => h.id);
    expect(unified).toContain(bare.mail_id);
    expect(unified).toContain(sub.mail_id);
  });
});
