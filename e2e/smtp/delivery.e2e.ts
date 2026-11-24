import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { ADMIN_PASSWORD, createUser, waitFor, type TestServer } from "../harness";
import {
  FIXED_DATE,
  FIXED_DATE_ISO,
  MAX_MESSAGE_BYTES,
  Mailer,
  attachmentBytes,
  attachmentFiles,
  boot,
  closeClients,
  countersOf,
  crlf,
  deliver,
  incomingLeftovers,
  mailByMessageId,
  mailsByMessageId,
  mailsOf,
  mappingsOf,
  messageId,
  octets,
  plain,
  raws,
  session,
  sha256,
  uniqueName,
} from "./support";

let server: TestServer;
let mailer: Mailer;

beforeAll(async () => {
  server = await boot();
  mailer = new Mailer(server);
}, 180_000);

afterEach(closeClients);

afterAll(async () => {
  mailer?.close();
  await server?.stop();
});

const QUEUED = "250 OK: message queued";
const GO_AHEAD = "354 End data with <CR><LF>.<CR><LF>";

/** A user with nothing stored yet, so UIDs and counters start from one. */
const freshUser = async () => {
  const user = await createUser(server, uniqueName("u"));
  return { ...user, at: (local: string) => `${local}@${user.username}.mail.test` };
};

describe("what one delivery stores", () => {
  test("every column of the mails row", async () => {
    const user = await freshUser();
    const before = Date.now();
    const result = await deliver(server, {
      from: "bounce@remote.example",
      to: [user.at("inbox")],
      data: crlf(
        "Received: from client.remote.example by mx; Tue, 03 Mar 2026 10:20:31 +0000",
        "From: Remote Sender <sender@remote.example>",
        `To: Inbox <${user.at("inbox")}>, second@remote.example`,
        "Cc: Carol <carol@remote.example>",
        "Bcc: hidden@remote.example",
        "Reply-To: Replies <replies@remote.example>",
        "Subject: First delivery",
        `Date: ${FIXED_DATE}`,
        "Message-ID: <first-1@remote.example>",
        "In-Reply-To: <parent-0@remote.example>",
        "References: <root@remote.example> <parent-0@remote.example>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "X-Custom: ignored",
        "",
        "Hello world",
        "Second line"
      ),
    });
    expect(raws(result.replies)).toEqual(["250 Accepted", "250 Accepted", QUEUED]);

    const rows = await mailsOf(server, user.username);
    expect(rows).toHaveLength(1);
    const { mail_id, updated, ...row } = rows[0]!;
    expect(mail_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Date(updated).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(updated).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row).toEqual({
      user_id: user.id,
      message_id: "<first-1@remote.example>",
      subject: "First delivery",
      date: new Date(FIXED_DATE_ISO),
      // A plain-text message has its text in both columns.
      html: "Hello world\nSecond line\n",
      text: "Hello world\nSecond line\n",
      from_address: [{ name: "Remote Sender", address: "sender@remote.example" }],
      from_text: '"Remote Sender" <sender@remote.example>',
      to_address: [
        { name: "Inbox", address: user.at("inbox") },
        { name: "", address: "second@remote.example" },
      ],
      to_text: `"Inbox" <${user.at("inbox")}>, second@remote.example`,
      cc_address: [{ name: "Carol", address: "carol@remote.example" }],
      cc_text: '"Carol" <carol@remote.example>',
      bcc_address: [{ name: "", address: "hidden@remote.example" }],
      bcc_text: "hidden@remote.example",
      reply_to_address: [{ name: "Replies", address: "replies@remote.example" }],
      reply_to_text: '"Replies" <replies@remote.example>',
      envelope_from: [{ address: "bounce@remote.example" }],
      envelope_to: [{ address: user.at("inbox") }],
      attachments: [],
      read: false,
      saved: false,
      sent: false,
      deleted: false,
      draft: false,
      answered: false,
      expunged: false,
      insight: null,
      uid_domain: 1,
      modseq: "1",
      spam_score: 0,
      spam_reasons: [],
      is_spam: false,
      rfc822_size: "809",
      text_line_count: null,
      html_line_count: null,
      in_reply_to: "<parent-0@remote.example>",
      reference_ids: ["<root@remote.example>", "<parent-0@remote.example>"],
      // Built by the table's trigger from the subject, the text and the From and To lines.
      search_vector:
        "'deliveri':2 'first':1 'hello':3 'inbox':10 " +
        `'${user.at("inbox")}':11 ` +
        "'line':6 'remot':7 'second':5 'second@remote.example':12 'sender':8 'sender@remote.example':9 'world':4",
    });
  });

  test("the mailbox rows and UID counters it creates", async () => {
    const user = await freshUser();
    const first = messageId("uid");
    const second = messageId("uid");
    const third = messageId("uid");
    await deliver(server, { to: [user.at("inbox")], data: plain({ messageId: first }) });

    const [one] = await mailsOf(server, user.username);
    // One row for the unified INBOX view (the domain UID) and one for the
    // per-address view, named after the local part of the address.
    expect(await mappingsOf(server, one!.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 1 },
      { mailbox: "INBOX/accounts/inbox", uid: 1 },
    ]);
    expect(await countersOf(server, user.username)).toEqual([
      { kind: "account", scope: user.at("inbox"), sent: false, last: 1 },
      { kind: "domain", scope: "", sent: false, last: 1 },
      { kind: "modseq", scope: "", sent: false, last: 1 },
    ]);

    await deliver(server, { to: [user.at("inbox")], data: plain({ messageId: second }) });
    await deliver(server, { to: [user.at("Other")], data: plain({ messageId: third }) });

    const rows = await mailsOf(server, user.username);
    expect(rows.map((row) => [row.message_id, row.uid_domain, row.modseq])).toEqual([
      [first, 1, "1"],
      [second, 2, "2"],
      [third, 3, "3"],
    ]);
    expect(await mappingsOf(server, rows[1]!.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 2 },
      { mailbox: "INBOX/accounts/inbox", uid: 2 },
    ]);
    // Each address of the user counts its own UIDs; the address is lower-cased first.
    expect(await mappingsOf(server, rows[2]!.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 3 },
      { mailbox: "INBOX/accounts/other", uid: 1 },
    ]);
    expect(await countersOf(server, user.username)).toEqual([
      { kind: "account", scope: user.at("inbox"), sent: false, last: 2 },
      { kind: "account", scope: user.at("other"), sent: false, last: 1 },
      { kind: "domain", scope: "", sent: false, last: 3 },
      { kind: "modseq", scope: "", sent: false, last: 3 },
    ]);
  });

  test("an envelope with a null sender stores no envelope_from", async () => {
    const id = messageId("null");
    const result = await deliver(server, { from: "", to: ["bounces@mail.test"], data: plain({ messageId: id }) });
    expect(result.final.raw).toBe(QUEUED);
    expect((await mailByMessageId(server, id)).envelope_from).toBeNull();
  });

  test("the envelope, not the To header, decides who receives the message", async () => {
    const user = await freshUser();
    const id = messageId("bcc");
    await deliver(server, {
      to: [user.at("secret")],
      data: plain({ messageId: id, to: "Someone Else <someone@elsewhere.example>" }),
    });
    const rows = await mailsByMessageId(server, id);
    expect(rows.map((row) => row.username)).toEqual([user.username]);
    expect(rows[0]!.to_address).toEqual([{ name: "Someone Else", address: "someone@elsewhere.example" }]);
    expect(rows[0]!.envelope_to).toEqual([{ address: user.at("secret") }]);
  });
});

describe("several recipients", () => {
  test("one row per local user, each numbered in its own user's sequences", async () => {
    const [one, two] = [await freshUser(), await freshUser()];
    const id = messageId("multi");
    // Give the second user an earlier mail so the two sequences differ.
    await deliver(server, { to: [two.at("x")], data: plain() });

    const result = await deliver(server, {
      to: [one.at("first"), two.at("second"), "outsider@remote.example"],
      data: plain({ messageId: id, subject: "To both" }),
    });
    expect(raws(result.replies)).toEqual(["250 Accepted", "250 Accepted", "250 Accepted", "250 Accepted", QUEUED]);

    const rows = await mailsByMessageId(server, id);
    const byUser = new Map(rows.map((row) => [row.username, row]));
    expect([...byUser.keys()].sort()).toEqual([one.username, two.username].sort());
    const [a, b] = [byUser.get(one.username)!, byUser.get(two.username)!];
    expect(a.mail_id).not.toBe(b.mail_id);
    // Both rows carry the whole envelope, foreign recipient included.
    const envelope = [{ address: one.at("first") }, { address: two.at("second") }, { address: "outsider@remote.example" }];
    expect(a.envelope_to).toEqual(envelope);
    expect(b.envelope_to).toEqual(envelope);
    expect([a.subject, b.subject]).toEqual(["To both", "To both"]);
    expect([a.uid_domain, b.uid_domain]).toEqual([1, 2]);

    // NOTE: the per-address mailbox is taken from the FIRST envelope recipient
    // for every user, so the second user's copy is filed under the first
    // user's local part ("first") rather than the address it was sent to
    // ("second"), and its UID counter is keyed by the first user's address.
    expect(await mappingsOf(server, a.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 1 },
      { mailbox: "INBOX/accounts/first", uid: 1 },
    ]);
    expect(await mappingsOf(server, b.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 2 },
      { mailbox: "INBOX/accounts/first", uid: 1 },
    ]);
    expect(await countersOf(server, two.username)).toEqual([
      { kind: "account", scope: one.at("first"), sent: false, last: 1 },
      { kind: "account", scope: two.at("x"), sent: false, last: 1 },
      { kind: "domain", scope: "", sent: false, last: 2 },
      { kind: "modseq", scope: "", sent: false, last: 2 },
    ]);
  });

  test("two addresses of one user in one transaction store a single row", async () => {
    const user = await freshUser();
    const id = messageId("twice");
    const result = await deliver(server, { to: [user.at("one"), user.at("two")], data: plain({ messageId: id }) });
    expect(result.final.raw).toBe(QUEUED);

    const rows = await mailsOf(server, user.username);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope_to).toEqual([{ address: user.at("one") }, { address: user.at("two") }]);
    // One owner, one save: the message is stored once, under one UID.
    expect(rows[0]!.uid_domain).toBe(1);
    const mappings = await mappingsOf(server, rows[0]!.mail_id);
    expect(mappings.map((mapping) => mapping.mailbox)).toEqual(["INBOX", "INBOX/accounts/one"]);
    expect(mappings[0]!.uid).toBe(rows[0]!.uid_domain);
    expect(await countersOf(server, user.username)).toEqual([
      { kind: "account", scope: user.at("one"), sent: false, last: 1 },
      { kind: "domain", scope: "", sent: false, last: 1 },
      { kind: "modseq", scope: "", sent: false, last: 1 },
    ]);
  });
});

describe("the same Message-ID again", () => {
  test("a redelivery to the same address is answered 250 and changes nothing but the counters", async () => {
    const user = await freshUser();
    const id = messageId("again");
    const first = plain({ messageId: id, subject: "Original", body: "first body" });
    const second = plain({ messageId: id, subject: "Changed", body: "second body" });
    expect((await deliver(server, { from: "one@remote.example", to: [user.at("inbox")], data: first })).final.raw).toBe(QUEUED);
    const [before] = await mailsOf(server, user.username);
    expect((await deliver(server, { from: "two@remote.example", to: [user.at("inbox")], data: second })).final.raw).toBe(QUEUED);

    const rows = await mailsOf(server, user.username);
    expect(rows).toHaveLength(1);
    const after = rows[0]!;
    // The first copy stands: content, envelope sender, UID and mod-sequence.
    expect(after.mail_id).toBe(before!.mail_id);
    expect(after.subject).toBe("Original");
    expect(after.text).toBe("first body\n");
    expect(after.envelope_from).toEqual([{ address: "one@remote.example" }]);
    expect(after.envelope_to).toEqual([{ address: user.at("inbox") }]);
    expect([after.uid_domain, after.modseq]).toEqual([1, "1"]);
    expect(await mappingsOf(server, after.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 1 },
      { mailbox: "INBOX/accounts/inbox", uid: 1 },
    ]);
    // The refused copy still consumed a UID in each sequence, and a mod-sequence.
    expect(await countersOf(server, user.username)).toEqual([
      { kind: "account", scope: user.at("inbox"), sent: false, last: 2 },
      { kind: "domain", scope: "", sent: false, last: 2 },
      { kind: "modseq", scope: "", sent: false, last: 2 },
    ]);
    // The next new message is numbered after the gap.
    const next = messageId("again");
    await deliver(server, { to: [user.at("inbox")], data: plain({ messageId: next }) });
    expect((await mailByMessageId(server, next)).uid_domain).toBe(3);
  });

  test("a redelivery to another address of the user adds the address and a mailbox row", async () => {
    const user = await freshUser();
    const id = messageId("again");
    await deliver(server, { to: [user.at("first")], data: plain({ messageId: id }) });
    await deliver(server, { to: [user.at("second"), "outsider@remote.example"], data: plain({ messageId: id }) });

    const rows = await mailsOf(server, user.username);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope_to).toEqual([
      { address: user.at("first") },
      { address: user.at("second") },
      { address: "outsider@remote.example" },
    ]);
    expect(await mappingsOf(server, rows[0]!.mail_id)).toEqual([
      { mailbox: "INBOX", uid: 1 },
      { mailbox: "INBOX/accounts/first", uid: 1 },
      { mailbox: "INBOX/accounts/second", uid: 1 },
    ]);
  });

  test("the same Message-ID for two users, delivered separately, is two rows", async () => {
    const [one, two] = [await freshUser(), await freshUser()];
    const id = messageId("again");
    await deliver(server, { to: [one.at("a")], data: plain({ messageId: id }) });
    await deliver(server, { to: [two.at("b")], data: plain({ messageId: id }) });
    const rows = await mailsByMessageId(server, id);
    expect(rows.map((row) => row.username).sort()).toEqual([one.username, two.username].sort());
    expect(rows.map((row) => row.envelope_to).flat().map((entry: { address: string }) => entry.address).sort()).toEqual(
      [one.at("a"), two.at("b")].sort()
    );
  });

  test("a Message-ID differing only in letter case is a different message", async () => {
    const user = await freshUser();
    await deliver(server, { to: [user.at("a")], data: plain({ messageId: "<CaseId@remote.example>" }) });
    await deliver(server, { to: [user.at("a")], data: plain({ messageId: "<caseid@remote.example>" }) });
    expect((await mailsOf(server, user.username)).map((row) => row.message_id)).toEqual([
      "<CaseId@remote.example>",
      "<caseid@remote.example>",
    ]);
  });
});

describe("missing headers", () => {
  test("no Date: the time of delivery is stored", async () => {
    const before = Date.now();
    const mail = await mailer.store(plain({ date: null }));
    const stored = new Date(mail.date).getTime();
    expect(stored).toBeGreaterThanOrEqual(before - 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("no Message-ID: eight random hex digits, without angle brackets", async () => {
    const first = await mailer.store(plain({ messageId: null }));
    const second = await mailer.store(plain({ messageId: null }));
    expect(first.message_id).toMatch(/^[0-9a-f]{8}$/);
    expect(second.message_id).toMatch(/^[0-9a-f]{8}$/);
    expect(first.message_id).not.toBe(second.message_id);
  });

  test("no From: null columns, and the missing-From spam rule scores", async () => {
    const mail = await mailer.store(plain({ from: null }));
    expect([mail.from_address, mail.from_text]).toEqual([null, null]);
    expect([mail.spam_score, mail.spam_reasons, mail.is_spam]).toEqual([20, ["Missing From header"], false]);
  });

  test("no Subject: an empty string, and the empty-subject spam rule scores", async () => {
    const mail = await mailer.store(plain({ subject: null }));
    expect(mail.subject).toBe("");
    expect([mail.spam_score, mail.spam_reasons, mail.is_spam]).toEqual([10, ["Empty subject line"], false]);
  });

  test("no To, Cc, Bcc or Reply-To: null columns", async () => {
    const mail = await mailer.store(plain({ to: null }));
    expect([mail.to_address, mail.to_text, mail.cc_address, mail.cc_text]).toEqual([null, null, null, null]);
    expect([mail.bcc_address, mail.bcc_text, mail.reply_to_address, mail.reply_to_text]).toEqual([null, null, null, null]);
    expect([mail.in_reply_to, mail.reference_ids]).toEqual([null, null]);
  });

  test("a body with no header block is read as headers and stores nothing of it", async () => {
    // NOTE: with no blank line the whole message is taken for the header
    // block, so the text the sender wrote is lost.
    const mail = await mailer.store("just a line of text\r\nand another\r\n");
    expect([mail.subject, mail.text, mail.html]).toEqual(["", "", ""]);
    expect(mail.message_id).toMatch(/^[0-9a-f]{8}$/);
    expect(mail.spam_reasons).toEqual(["Missing From header", "Empty subject line"]);
  });

  test("a message that starts with a blank line is all body", async () => {
    const mail = await mailer.store("\r\njust a line of text\r\nSubject: not a header\r\n");
    expect([mail.subject, mail.text]).toEqual(["", "just a line of text\nSubject: not a header\n"]);
  });

  test("headers with no body", async () => {
    const mail = await mailer.store(crlf("From: a@remote.example", "Subject: Only headers"));
    expect([mail.subject, mail.text, mail.html]).toEqual(["Only headers", "", ""]);
    const blank = await mailer.store(crlf("From: a@remote.example", "Subject: Blank body", ""));
    expect([blank.subject, blank.text, blank.html]).toEqual(["Blank body", "", ""]);
  });
});

describe("the DATA stream", () => {
  /** Sends raw bytes after DATA on a session addressed to a fresh mailbox, returning the stored text. */
  const sendRaw = async (chunks: (string | Uint8Array)[]) => {
    const recipient = `${uniqueName("raw")}@mail.test`;
    const smtp = await session(server);
    await smtp.send("MAIL FROM:<bounce@remote.example>");
    await smtp.send(`RCPT TO:<${recipient}>`);
    expect((await smtp.send("DATA")).raw).toBe(GO_AHEAD);
    for (const chunk of chunks) await smtp.writeFlushed(chunk);
    const reply = await smtp.read();
    const rows = await server.db.query("SELECT text FROM mails WHERE envelope_to @> $1", [[{ address: recipient }]]);
    return { smtp, reply: reply.raw, text: rows[0]?.text as string | undefined };
  };

  test("a leading dot is removed from each stuffed line", async () => {
    const { reply, text } = await sendRaw(["Subject: dots\r\n\r\n..one\r\n...two\r\n.. \r\n..\r\nplain\r\n.\r\n"]);
    expect(reply).toBe(QUEUED);
    expect(text).toBe(".one\n..two\n. \n.\nplain\n");
  });

  test("a line with a single leading dot that is not the terminator is kept as written", async () => {
    const { text } = await sendRaw(["Subject: dots\r\n\r\n.unstuffed\r\n. \r\n.\tx\r\n.\r\n"]);
    expect(text).toBe(".unstuffed\n. \n.\tx\n");
  });

  test("only CRLF.CRLF ends the message: bare LF and bare CR dot lines are content", async () => {
    const { reply, text } = await sendRaw([
      "Subject: dots\r\n\r\nbare\n.\nlf\r\nmixed\n.\r\nafter-bare-lf\r\n.\rcr\r\nend\r\n.\r\n",
    ]);
    expect(reply).toBe(QUEUED);
    expect(text).toBe("bare\n.\nlf\nmixed\n.\nafter-bare-lf\n.\rcr\nend\n");
  });

  test("the terminator is found when it is split across writes", async () => {
    for (const split of [
      ["Subject: split\r\n\r\nbody\r\n", ".", "\r\n"],
      ["Subject: split\r\n\r\nbody\r", "\n.\r", "\n"],
      ["Subject: split\r\n\r\nbody", "\r\n", ".\r\n"],
      ["Subject: split\r\n\r\nbody\r\n.", "\r", "\n"],
    ]) {
      const { reply, text } = await sendRaw(split);
      expect({ split, reply, text }).toEqual({ split, reply: QUEUED, text: "body\n" });
    }
  });

  test("a stuffed dot split across writes is still unstuffed", async () => {
    const { text } = await sendRaw(["Subject: split\r\n\r\n.", ".stuffed\r\n", ".\r\n"]);
    expect(text).toBe(".stuffed\n");
  });

  test("DATA written in the same packet as its content", async () => {
    const recipient = `${uniqueName("raw")}@mail.test`;
    const smtp = await session(server);
    await smtp.send("MAIL FROM:<bounce@remote.example>");
    await smtp.send(`RCPT TO:<${recipient}>`);
    smtp.write("DATA\r\nSubject: eager\r\n\r\nsent before the 354\r\n.\r\nNOOP\r\n");
    expect(raws([await smtp.read(), await smtp.read(), await smtp.read()])).toEqual([GO_AHEAD, QUEUED, "250 OK"]);
    const [row] = await server.db.query("SELECT text FROM mails WHERE envelope_to @> $1", [[{ address: recipient }]]);
    expect(row!.text).toBe("sent before the 354\n");
  });

  test("commands inside DATA are content, not commands", async () => {
    const { reply, text, smtp } = await sendRaw(["Subject: cmds\r\n\r\nQUIT\r\nRSET\r\nMAIL FROM:<x@y.example>\r\n.\r\n"]);
    expect(reply).toBe(QUEUED);
    expect(text).toBe("QUIT\nRSET\nMAIL FROM:<x@y.example>\n");
    expect((await smtp.send("NOOP")).raw).toBe("250 OK");
  });

  test("lines in DATA have no length limit", async () => {
    const long = "x".repeat(200_000);
    const { reply, text } = await sendRaw([`Subject: long\r\n\r\n${long}\r\n.\r\n`]);
    expect(reply).toBe(QUEUED);
    expect(text).toBe(`${long}\n`);
  });

  test("8-bit content is taken without BODY=8BITMIME", async () => {
    const mail = await mailer.store(
      octets("Subject: bytes\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ncaf", Buffer.from("é"), " \x01\x7f tab:\t:end\r\n")
    );
    expect(mail.text).toBe("café \x01\x7f tab:\t:end\n");
  });

  test("a NUL character is left out of everything stored, and the delivery is accepted", async () => {
    // PostgreSQL text cannot hold one, nor JSONB `\u0000`: kept, it would fail
    // the save on every retry of the delivery.
    const dumpDir = path.join(server.cwd, "error");
    const dumpsBefore = fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).length : 0;
    const alarmsBefore = server.alarms.alarms.length;

    const inBody = await mailer.store("Subject: nul\r\nMessage-ID: <nul-body@remote.example>\r\n\r\na\0b\r\n");
    expect([inBody.subject, inBody.text, inBody.html]).toEqual(["nul", "ab\n", "ab\n"]);
    const inHtml = await mailer.store("Subject: nul\r\nContent-Type: text/html\r\n\r\n<p>c\0d</p>\r\n");
    expect([inHtml.html, inHtml.text]).toEqual(["<p>cd</p>\n", "cd"]);
    const inSubject = await mailer.store("Subject: nu\0l\r\nMessage-ID: <nul-sub\0ject@remote.example>\r\n\r\nab\r\n");
    expect([inSubject.subject, inSubject.message_id]).toEqual(["nul", "<nul-subject@remote.example>"]);
    const inHeaders = await mailer.store(
      crlf("From: Jo\0e <jo@remote.example>", "Cc: Ca\0rol <carol@remote.example>", "In-Reply-To: <pa\0rent@remote.example>", "Subject: headers", "", "x")
    );
    expect([inHeaders.from_address, inHeaders.from_text]).toEqual([[{ name: "Joe", address: "jo@remote.example" }], '"Joe" <jo@remote.example>']);
    expect([inHeaders.cc_address, inHeaders.cc_text]).toEqual([[{ name: "Carol", address: "carol@remote.example" }], '"Carol" <carol@remote.example>']);
    expect(inHeaders.in_reply_to).toBe("<parent@remote.example>");
    const inFilename = await mailer.store(
      crlf(
        "Subject: file",
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        "Content-Type: text/plain",
        "",
        "See attached.",
        "--mix",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="re\0port.pdf"',
        "",
        "%PDF",
        "--mix--"
      )
    );
    expect(inFilename.attachments).toEqual([{ filename: "report.pdf", contentType: "application/pdf", size: 4, content: { data: expect.any(String) } }]);
    expect(attachmentBytes(server, inFilename.attachments[0].content.data).toString()).toBe("%PDF");

    // Nothing failed: no alarm, no dump.
    expect(server.alarms.alarms.slice(alarmsBefore)).toEqual([]);
    expect(fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).length : 0).toBe(dumpsBefore);
  });

  test("a database fault the message is not to blame for is a transient 450, alarmed and dumped", async () => {
    // A trigger stands in for a fault nobody foresaw. The message itself is
    // storable, so the sender's retry may well succeed.
    await server.db.query(
      "CREATE FUNCTION e2e_refuse_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
        "IF NEW.subject = 'refused by the database' THEN RAISE EXCEPTION 'the database is unwell'; END IF; RETURN NEW; END $$"
    );
    await server.db.query("CREATE TRIGGER e2e_refuse_mail BEFORE INSERT ON mails FOR EACH ROW EXECUTE FUNCTION e2e_refuse_mail()");
    try {
      const dumpDir = path.join(server.cwd, "error");
      const dumpsBefore = fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).length : 0;
      const alarmsBefore = server.alarms.alarms.length;
      const { final } = await mailer.send("Subject: refused by the database\r\nMessage-ID: <unwell@remote.example>\r\n\r\nbody\r\n");
      expect(final.raw).toBe("450 the database is unwell");
      expect(await server.db.query("SELECT 1 FROM mails WHERE message_id = '<unwell@remote.example>'")).toEqual([]);

      const alarm = await waitFor(
        () => server.alarms.alarms.slice(alarmsBefore).find((entry) => entry.title.includes("Mail Receive Failed")),
        { what: "the receive-failure alarm" }
      );
      expect(alarm.title).toBe("🚨 Mail Server Error: Mail Receive Failed");
      expect(alarm.description).toBe("**Error:** the database is unwell");

      const dumps = fs.readdirSync(dumpDir);
      expect(dumps.length).toBe(dumpsBefore + 1);
      for (const name of dumps) expect(name).toMatch(/^\d{13}$/);
      const dumped = dumps.map((name) => JSON.parse(fs.readFileSync(path.join(dumpDir, name), "utf8")).messageId);
      expect(dumped).toContain("<unwell@remote.example>");

      // The session survives it.
      expect((await mailer.store(plain())).subject).toBe("Test message");
    } finally {
      await server.db.query("DROP TRIGGER e2e_refuse_mail ON mails");
      await server.db.query("DROP FUNCTION e2e_refuse_mail()");
    }
  });

  test("a connection dropped before the terminator stores nothing and frees its delivery slot", async () => {
    const before = (await mailsOf(server, "admin")).length;
    // More abandoned transactions than the server runs at once (two).
    for (let i = 0; i < 4; i++) {
      const smtp = await session(server);
      await smtp.send("MAIL FROM:<bounce@remote.example>");
      await smtp.send("RCPT TO:<abandoned@mail.test>");
      expect((await smtp.send("DATA")).raw).toBe(GO_AHEAD);
      await smtp.writeFlushed("Subject: never finished\r\n\r\nhalf a mess");
      smtp.close();
    }
    // A delivery right behind them is still accepted: it takes its turn after
    // all four, so by its reply each of them has been given up on.
    const id = messageId("after");
    expect((await deliver(server, { to: ["after@mail.test"], data: plain({ messageId: id }) })).final.raw).toBe(QUEUED);
    expect((await mailsOf(server, "admin")).length).toBe(before + 1);
    expect(await server.db.query("SELECT 1 FROM mails WHERE subject = 'never finished'")).toEqual([]);
  });

  test("the reply waits for the terminator", async () => {
    const smtp = await session(server);
    await smtp.send("MAIL FROM:<bounce@remote.example>");
    await smtp.send("RCPT TO:<slow@mail.test>");
    await smtp.send("DATA");
    await smtp.writeFlushed("Subject: slow\r\n\r\nbody\r\n");
    expect(await smtp.staysQuiet(300)).toBe(true);
    await smtp.writeFlushed(".");
    expect(await smtp.staysQuiet(200)).toBe(true);
    smtp.write("\r\n");
    expect((await smtp.read()).raw).toBe(QUEUED);
  });
});

describe("message size ceiling", () => {
  const head = "Subject: big\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n";
  /** A message of exactly `total` octets as the server counts them: after unstuffing, before the terminator. */
  const sized = (total: number) => {
    const line = `${"x".repeat(998)}\r\n`;
    const body = total - head.length;
    const whole = Math.floor(body / line.length);
    const rest = body - whole * line.length;
    const tail = rest >= 2 ? `${"y".repeat(rest - 2)}\r\n` : "";
    const message = Buffer.concat([Buffer.from(head), Buffer.from(line.repeat(whole)), Buffer.from(tail)]);
    if (message.length !== total) throw new Error(`Built ${message.length} octets, wanted ${total}`);
    return message;
  };

  test("a message of exactly 36700160 octets is accepted whole", async () => {
    const message = sized(MAX_MESSAGE_BYTES);
    const mail = await mailer.store(message);
    const body = message.subarray(head.length);
    expect(mail.attachments).toEqual([
      {
        filename: "attachment",
        contentType: "application/octet-stream",
        size: body.length,
        content: { data: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      },
    ]);
    expect(sha256(attachmentBytes(server, mail.attachments[0].content.data))).toBe(sha256(body));
  }, 60_000);

  test("one octet more is answered 552 after the terminator, and the session carries on", async () => {
    const before = attachmentFiles(server).length;
    const smtp = await session(server);
    await smtp.send("MAIL FROM:<bounce@remote.example>");
    await smtp.send("RCPT TO:<toobig@mail.test>");
    expect((await smtp.send("DATA")).raw).toBe(GO_AHEAD);
    await smtp.writeFlushed(sized(MAX_MESSAGE_BYTES + 1));
    // Even past the ceiling nothing is said until the message ends.
    expect(await smtp.staysQuiet(300)).toBe(true);
    smtp.write(".\r\n");
    expect((await smtp.read(30_000)).raw).toBe(`552 Error: message exceeds fixed maximum message size ${MAX_MESSAGE_BYTES}`);

    expect(await server.db.query("SELECT 1 FROM mails WHERE envelope_to @> $1", [[{ address: "toobig@mail.test" }]])).toEqual([]);
    expect(attachmentFiles(server).length).toBe(before);
    await waitFor(() => incomingLeftovers(server).length === 0, { what: "the transaction's working files to go" });

    expect((await smtp.send("RCPT TO:<x@mail.test>")).raw).toBe("503 Error: need MAIL command");
    const id = messageId("small");
    expect((await smtp.transaction({ from: "a@remote.example", to: ["hello@mail.test"], data: plain({ messageId: id }) })).final.raw).toBe(QUEUED);
  }, 60_000);

  test("the declared SIZE is not held against the message that follows", async () => {
    const smtp = await session(server);
    expect((await smtp.send("MAIL FROM:<bounce@remote.example> SIZE=10")).raw).toBe("250 Accepted");
    await smtp.send("RCPT TO:<declared@mail.test>");
    expect((await smtp.data(plain({ body: "x".repeat(5000) }))).raw).toBe(QUEUED);
  });
});

describe("attachment files", () => {
  test("each attachment becomes a file under attachments/, named by a UUID the row points at", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const mail = await mailer.store(
      crlf(
        "Subject: With files",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "See attached.",
        "--b1",
        'Content-Type: image/png; name="pixel.png"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="pixel.png"',
        "",
        png.toString("base64"),
        "--b1",
        "Content-Type: application/json",
        'Content-Disposition: attachment; filename="data.json"',
        "",
        '{"a":1}',
        "--b1--"
      )
    );
    expect(mail.text).toBe("See attached.");
    expect(mail.attachments).toEqual([
      { filename: "pixel.png", contentType: "image/png", size: png.length, content: { data: expect.any(String) } },
      { filename: "data.json", contentType: "application/json", size: 7, content: { data: expect.any(String) } },
    ]);
    const ids = mail.attachments.map((attachment: { content: { data: string } }) => attachment.content.data);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(attachmentBytes(server, ids[0]).equals(png)).toBe(true);
    expect(attachmentBytes(server, ids[1]).toString()).toBe('{"a":1}');
    expect(attachmentFiles(server)).toEqual(expect.arrayContaining(ids));
    // The per-transaction working directory is emptied once the reply is out.
    await waitFor(() => incomingLeftovers(server).length === 0, { what: "the transaction's working files to go" });
  });

  test("each recipient's row points at its own copy of the file", async () => {
    const [one, two] = [await freshUser(), await freshUser()];
    const id = messageId("files");
    await deliver(server, {
      to: [one.at("a"), two.at("b")],
      data: crlf(
        `Message-ID: ${id}`,
        "Subject: Shared file",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="doc.pdf"',
        "",
        "%PDF-1.4 fake"
      ),
    });
    const rows = await mailsByMessageId(server, id);
    expect(rows).toHaveLength(2);
    const [first, second] = rows.map((row) => row.attachments[0].content.data as string);
    expect(first).not.toBe(second);
    expect(attachmentBytes(server, first!).toString()).toBe("%PDF-1.4 fake\r\n");
    expect(attachmentBytes(server, second!).toString()).toBe("%PDF-1.4 fake\r\n");
  });
});

describe("what the HTTP API shows afterwards", () => {
  test("the mail appears for its recipient, unread, and for nobody else", async () => {
    const user = await freshUser();
    const other = await freshUser();
    const id = messageId("http");
    await deliver(server, {
      to: [user.at("news")],
      data: plain({ messageId: id, subject: "Seen over HTTP", body: "Body over HTTP" }),
    });

    const client = server.client();
    await client.login(user.username, user.password);
    const accounts = await client.get("/api/mails/accounts");
    expect(accounts.body).toEqual({
      status: "success",
      body: {
        received: [
          { key: user.at("news"), doc_count: 1, unread_doc_count: 1, saved_doc_count: 0, updated: FIXED_DATE_ISO },
        ],
        sent: [],
        spam: [],
        shared: [],
        unread_mail_count: 1,
      },
    });

    const headers = await client.get(`/api/mails/headers/${user.at("news")}`);
    expect(headers.body.status).toBe("success");
    expect(headers.body.body).toHaveLength(1);
    const header = headers.body.body[0];
    const stored = await mailByMessageId(server, id);
    expect(header).toMatchObject({
      id: stored.mail_id,
      subject: "Seen over HTTP",
      date: FIXED_DATE_ISO,
      from: { value: [{ name: "Remote Sender", address: "sender@remote.example" }], text: '"Remote Sender" <sender@remote.example>' },
      to: { value: [{ name: "", address: "hello@mail.test" }], text: "hello@mail.test" },
      envelopeTo: { value: [{ address: user.at("news") }], text: "" },
      read: false,
      saved: false,
      sent: false,
      snippet: "Body over HTTP",
      messageId: id,
    });

    const body = await client.get(`/api/mails/body/${stored.mail_id}`);
    expect(body.body.status).toBe("success");
    expect(body.body.body.html).toContain("Body over HTTP");

    const stranger = server.client();
    await stranger.login(other.username, other.password);
    expect((await stranger.get("/api/mails/accounts")).body.body.received).toEqual([]);
    // Naming the address reads the stranger's own rows, which hold none of it.
    expect((await stranger.get(`/api/mails/headers/${user.at("news")}`)).body).toEqual({ status: "success", body: [] });
  });

  test("mail for the bare domain shows up for admin", async () => {
    const id = messageId("http");
    const local = uniqueName("box");
    await deliver(server, { to: [`${local}@mail.test`], data: plain({ messageId: id, subject: "For admin" }) });
    const client = server.client();
    await client.login("admin", ADMIN_PASSWORD);
    const { body } = await client.get(`/api/mails/headers/${local}@mail.test`);
    expect(body.body.map((header: { subject: string; messageId: string }) => [header.subject, header.messageId])).toEqual([
      ["For admin", id],
    ]);
  });

  test("an attachment is served to the recipient", async () => {
    const user = await freshUser();
    const id = messageId("http");
    await deliver(server, {
      to: [user.at("files")],
      data: crlf(
        `Message-ID: ${id}`,
        "From: a@remote.example",
        "Subject: File over HTTP",
        "Content-Type: text/csv",
        'Content-Disposition: attachment; filename="rows.csv"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("a,b\n1,2\n").toString("base64")
      ),
    });
    const stored = await mailByMessageId(server, id);
    const client = server.client();
    await client.login(user.username, user.password);
    const file = await client.get(`/api/mails/attachment/${stored.attachments[0].content.data}`);
    expect(file.status).toBe(200);
    expect(file.text).toBe("a,b\n1,2\n");
  });
});
