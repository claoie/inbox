import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_PASSWORD, addr, createUser, insertMail, startServer, type TestServer } from "../harness";
import { JSON_TYPE, adminMailbox, newMailbox, type Mailbox } from "./mails-helpers";

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

const accounts = async (box: Mailbox) => {
  const { status, body } = await box.client.get("/api/mails/accounts");
  expect(status).toBe(200);
  expect(body.status).toBe("success");
  return body.body as Record<"received" | "sent" | "spam" | "shared", Record<string, unknown>[]> & {
    unread_mail_count: number;
  };
};

const account = (key: string, doc: number, unread: number, saved: number, updated: string) => ({
  key,
  doc_count: doc,
  unread_doc_count: unread,
  saved_doc_count: saved,
  updated,
});

describe("GET /api/mails/domain", () => {
  test("answers the served domain with an exact body and ETag", async () => {
    const { status, text, headers } = await server.client().get("/api/mails/domain");
    expect(status).toBe(200);
    expect(text).toBe('{"status":"success","body":"mail.test"}');
    expect(headers.get("content-type")).toBe(JSON_TYPE);
    expect(headers.get("etag")).toBe('W/"27-R/W+pPAroHPBLe5jP7Dw3I1mXvc"');
    expect(headers.get("content-length")).toBe("39");
  });

  test("answers the same for a signed-in user and for admin", async () => {
    const box = await newMailbox(server);
    const admin = await adminMailbox(server);
    for (const client of [box.client, admin.client]) {
      expect((await client.get("/api/mails/domain")).body).toEqual({ status: "success", body: "mail.test" });
    }
  });

  test("follows EMAIL_DOMAIN", async () => {
    const other = await startServer({ env: { EMAIL_DOMAIN: "post.example", APP_HOSTNAME: "app.post.example" } });
    try {
      const { status, text } = await other.client().get("/api/mails/domain");
      expect(status).toBe(200);
      expect(text).toBe('{"status":"success","body":"post.example"}');

      // The account list follows the domain too: bob owns *@bob.post.example.
      const bob = await createUser(other, "bob");
      await insertMail(other, bob.id, { to: [addr("x@bob.post.example"), addr("y@bob.mail.test")] });
      const client = other.client();
      await client.login(bob.username, bob.password);
      const { body } = await client.get("/api/mails/accounts");
      expect(body.body.received.map((a: { key: string }) => a.key)).toEqual(["x@bob.post.example"]);
      const admin = other.client();
      await admin.login("admin", ADMIN_PASSWORD);
      expect((await admin.get("/api/mails/headers/x@bob.mail.test")).body.status).toBe("success");
      // Naming another address reads bob's own rows for it, and nobody else's.
      expect((await client.get("/api/mails/headers/y@bob.mail.test")).body.body).toHaveLength(1);
      expect((await admin.get("/api/mails/headers/y@bob.mail.test")).body).toEqual({ status: "success", body: [] });
    } finally {
      await other.stop();
    }
  }, 90_000);
});

describe("GET /api/mails/accounts", () => {
  test("is three empty lists and no unread mail for a user with no mail, with an exact body", async () => {
    const box = await newMailbox(server);
    const { status, text, headers } = await box.client.get("/api/mails/accounts");
    expect(status).toBe(200);
    expect(text).toBe('{"status":"success","body":{"received":[],"sent":[],"spam":[],"shared":[],"unread_mail_count":0}}');
    expect(headers.get("content-type")).toBe(JSON_TYPE);
    expect(headers.get("etag")).toBe('W/"61-HGIG4o6FKy+I9Z4IfHn4zU6L10Q"');
    expect(headers.get("content-length")).toBe("97");
  });

  test("lists one received account with its key order", async () => {
    const box = await newMailbox(server);
    await box.mail({ date: "2026-03-04T05:06:07.891Z" });
    const { text } = await box.client.get("/api/mails/accounts");
    expect(text).toBe(
      `{"status":"success","body":{"received":[{"key":"${box.address()}","doc_count":1,"unread_doc_count":1,` +
        `"saved_doc_count":0,"updated":"2026-03-04T05:06:07.891Z"}],"sent":[],"spam":[],"shared":[],"unread_mail_count":1}}`
    );
  });

  test("ignores the query string", async () => {
    const box = await newMailbox(server);
    await box.mail();
    const plain = await box.client.get("/api/mails/accounts");
    const queried = await box.client.get("/api/mails/accounts?sent=1&spam=1&limit=0&since=x");
    expect(queried.text).toBe(plain.text);
  });

  test("counts mails, unread and saved per address and dates the account by its newest mail", async () => {
    const box = await newMailbox(server);
    const a = box.address("a");
    const b = box.address("b");
    await box.mail({ to: [addr(a)], date: "2026-01-01T00:00:00Z" });
    await box.mail({ to: [addr(a)], date: "2026-01-03T00:00:00Z", read: true });
    await box.mail({ to: [addr(a)], date: "2026-01-02T00:00:00Z", read: true, saved: true });
    await box.mail({ to: [addr(a)], date: "2025-12-31T00:00:00Z", saved: true });
    await box.mail({ to: [addr(b)], date: "2026-01-02T12:00:00Z", read: true });
    expect(await accounts(box)).toEqual({
      received: [account(a, 4, 2, 2, "2026-01-03T00:00:00.000Z"), account(b, 1, 0, 0, "2026-01-02T12:00:00.000Z")],
      sent: [],
      spam: [],
      shared: [],
      unread_mail_count: 2,
    });
  });

  test("orders each list by its newest mail, newest first", async () => {
    const box = await newMailbox(server);
    for (const [local, date] of [
      ["old", "2024-05-01T00:00:00Z"],
      ["new", "2026-05-01T00:00:00Z"],
      ["mid", "2025-05-01T00:00:00Z"],
    ] as const) {
      await box.mail({ to: [addr(box.address(local))], date });
      await box.mail({ from: [addr(box.address(local))], to: [addr("x@remote.example")], envelope_to: [], sent: true, date });
      await box.mail({ to: [addr(box.address(local))], is_spam: true, date });
    }
    const body = await accounts(box);
    const order = [box.address("new"), box.address("mid"), box.address("old")];
    expect(body.received.map((a) => a.key)).toEqual(order);
    expect(body.sent.map((a) => a.key)).toEqual(order);
    expect(body.spam.map((a) => a.key)).toEqual(order);
  });

  test("an account is named by To, Cc, Bcc or the envelope recipient", async () => {
    const box = await newMailbox(server);
    await box.mail({
      to: [addr(box.address("to"), "To Name")],
      cc: [addr(box.address("cc"))],
      bcc: [addr(box.address("bcc"))],
      envelope_to: [{ address: box.address("envelope") }],
      date: "2026-02-01T00:00:00Z",
    });
    const { received } = await accounts(box);
    expect(received).toHaveLength(4);
    expect(received.map((a) => a.key).sort()).toEqual(
      [box.address("bcc"), box.address("cc"), box.address("envelope"), box.address("to")].sort()
    );
    for (const entry of received) {
      expect(entry).toEqual(account(entry.key as string, 1, 1, 0, "2026-02-01T00:00:00.000Z"));
    }
  });

  test("a mail naming one address several times counts once for it", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({
      to: [addr(me), addr(me, "Again")],
      cc: [addr(me)],
      bcc: [addr(me)],
      envelope_to: [{ address: me }],
      date: "2026-02-01T00:00:00Z",
    });
    expect((await accounts(box)).received).toEqual([account(me, 1, 1, 0, "2026-02-01T00:00:00.000Z")]);
  });

  test("addresses that differ only in letter case are separate accounts", async () => {
    const box = await newMailbox(server);
    const lower = box.address("mixed");
    const upper = `Mixed@${box.domain.toUpperCase()}`;
    await box.mail({ to: [addr(lower)], date: "2026-02-02T00:00:00Z" });
    await box.mail({ to: [addr(upper)], date: "2026-02-01T00:00:00Z" });
    expect((await accounts(box)).received).toEqual([
      account(lower, 1, 1, 0, "2026-02-02T00:00:00.000Z"),
      account(upper, 1, 1, 0, "2026-02-01T00:00:00.000Z"),
    ]);
  });

  test("only addresses on the user's own domain are accounts", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({
      to: [
        addr(me),
        addr("someone@remote.example"),
        addr("hello@mail.test"),
        addr(`x@sub.${box.domain}`),
        addr(`x@evil${box.domain}`),
        addr(`x@${box.domain}.evil.example`),
        addr(`x@${box.domain}x`),
      ],
      envelope_to: [{ address: "other@elsewhere.example" }],
      date: "2026-02-01T00:00:00Z",
    });
    expect((await accounts(box)).received).toEqual([account(me, 1, 1, 0, "2026-02-01T00:00:00.000Z")]);
  });

  test("an address with % or _ in it is an account under its literal spelling", async () => {
    const box = await newMailbox(server);
    await box.mail({ to: [addr(box.address("per%cent"))], date: "2026-02-02T00:00:00Z" });
    await box.mail({ to: [addr(box.address("under_score"))], date: "2026-02-01T00:00:00Z" });
    expect((await accounts(box)).received.map((a) => a.key)).toEqual([
      box.address("per%cent"),
      box.address("under_score"),
    ]);
  });

  test("sent accounts group by the From address, whatever the sent flag says", async () => {
    const box = await newMailbox(server);
    const me = box.address("me");
    // Sent by the user to someone else.
    await box.mail({ from: [addr(me, "Me")], to: [addr("x@remote.example")], envelope_to: [], sent: true, read: true, date: "2026-03-01T00:00:00Z" });
    // Same From on a row that is not flagged sent: still a sent account.
    await box.mail({ from: [addr(me)], to: [addr("y@remote.example")], envelope_to: [], sent: false, date: "2026-03-02T00:00:00Z", saved: true });
    // Flagged sent but From is someone else: not a sent account, and a received one for its recipient.
    await box.mail({ from: [addr("z@remote.example")], to: [addr(box.address("in"))], sent: true, read: true, date: "2026-03-03T00:00:00Z" });
    expect(await accounts(box)).toEqual({
      received: [account(box.address("in"), 1, 0, 0, "2026-03-03T00:00:00.000Z")],
      sent: [account(me, 2, 1, 1, "2026-03-02T00:00:00.000Z")],
      spam: [],
      shared: [],
      // The row not flagged sent is unread mail, whoever its From names.
      unread_mail_count: 1,
    });
  });

  test("a mail the user sent to their own address is in both lists", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({ from: [addr(me)], to: [addr(me)], sent: true, read: true, date: "2026-03-01T00:00:00Z" });
    expect(await accounts(box)).toEqual({
      received: [account(me, 1, 0, 0, "2026-03-01T00:00:00.000Z")],
      sent: [account(me, 1, 0, 0, "2026-03-01T00:00:00.000Z")],
      spam: [],
      shared: [],
      unread_mail_count: 0,
    });
  });

  test("spam is counted in its own list by recipient, and left out of the other two", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({ date: "2026-04-01T00:00:00Z" });
    await box.mail({ is_spam: true, date: "2026-04-02T00:00:00Z" });
    await box.mail({ is_spam: true, read: true, saved: true, date: "2026-04-03T00:00:00Z" });
    // Spam that is also flagged sent is in no list at all.
    await box.mail({ from: [addr(me)], to: [addr(box.address("other"))], is_spam: true, sent: true, date: "2026-04-04T00:00:00Z" });
    expect(await accounts(box)).toEqual({
      received: [account(me, 1, 1, 0, "2026-04-01T00:00:00.000Z")],
      sent: [],
      spam: [account(me, 2, 1, 1, "2026-04-03T00:00:00.000Z")],
      shared: [],
      unread_mail_count: 1,
    });
  });

  test("drafts and expunged mail are never counted; the deleted and answered flags do not matter", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({ draft: true });
    await box.mail({ expunged: true });
    await box.mail({ from: [addr(me)], to: [addr("x@remote.example")], envelope_to: [], sent: true, draft: true });
    await box.mail({ from: [addr(me)], to: [addr("x@remote.example")], envelope_to: [], sent: true, expunged: true });
    await box.mail({ is_spam: true, expunged: true });
    await box.mail({ is_spam: true, draft: true });
    expect(await accounts(box)).toEqual({ received: [], sent: [], spam: [], shared: [], unread_mail_count: 0 });
    await box.mail({ deleted: true, answered: true, date: "2026-04-01T00:00:00Z" });
    expect((await accounts(box)).received).toEqual([account(me, 1, 1, 0, "2026-04-01T00:00:00.000Z")]);
  });

  test("entries without an address, empty lists and NULL columns are skipped", async () => {
    const box = await newMailbox(server);
    await box.mail({
      to_address: [{ name: "No address" }, { address: null }, { address: "" }, { address: box.address("ok"), name: null }],
      to_text: "x",
      cc_address: [],
      cc_text: "",
      date: "2026-04-01T00:00:00Z",
    });
    await box.mail({ from_address: null, from_text: null, to_address: null, to_text: null, envelope_to: null });
    await box.mail({ from_address: [], from_text: "", to_address: [], to_text: "", envelope_to: [] });
    expect(await accounts(box)).toEqual({
      received: [account(box.address("ok"), 1, 1, 0, "2026-04-01T00:00:00.000Z")],
      sent: [],
      spam: [],
      shared: [],
      // No account, but all three are unread received mail.
      unread_mail_count: 3,
    });
  });

  // NOTE: the accounts query concatenates the recipient columns, and jsonb
  // `object || array` wraps the object in a list, so a recipient column
  // holding one object (not a list) is counted here although no list route
  // ever returns that mail (their `@>` match needs a list).
  test("a recipient column holding a bare object is counted although no list shows the mail", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({ to_address: { address: me }, to_text: me, date: "2026-04-01T00:00:00Z" });
    expect((await accounts(box)).received).toEqual([account(me, 1, 1, 0, "2026-04-01T00:00:00.000Z")]);
    expect((await box.client.get(`/api/mails/headers/${me}`)).body).toEqual({ status: "success", body: [] });
  });

  test("another user's mail is never counted", async () => {
    const first = await newMailbox(server);
    const second = await newMailbox(server);
    // Stored under the second user, but naming the first user's address.
    await second.mail({ to: [addr(first.address()), addr(second.address())], date: "2026-04-01T00:00:00Z" });
    expect(await accounts(first)).toEqual({ received: [], sent: [], spam: [], shared: [], unread_mail_count: 0 });
    expect((await accounts(second)).received).toEqual([account(second.address(), 1, 1, 0, "2026-04-01T00:00:00.000Z")]);
  });

  test("the unread mail count counts each message once, however many own addresses it names", async () => {
    const box = await newMailbox(server);
    const a = box.address("a");
    const b = box.address("b");
    await box.mail({ to: [addr(a), addr(b)], cc: [addr(box.address("c"))], envelope_to: [{ address: box.address("d") }] });
    await box.mail({ to: [addr(a)] });
    await box.mail({ to: [addr(b)], read: true });
    const body = await accounts(box);
    expect(body.received.reduce((sum, account) => sum + (account.unread_doc_count as number), 0)).toBe(5);
    expect(body.unread_mail_count).toBe(2);
  });

  test("the unread mail count is the new-mail push badge's: received, not spam, sent, draft or expunged", async () => {
    const box = await newMailbox(server);
    const me = box.address();
    await box.mail({});
    await box.mail({ from: [addr(me)], to: [addr(me)], sent: true });
    await box.mail({ is_spam: true });
    await box.mail({ draft: true });
    await box.mail({ expunged: true });
    // A received mail naming none of the user's addresses: no account, still new mail.
    await box.mail({ to: [addr("list@remote.example")], envelope_to: [] });
    const body = await accounts(box);
    expect(body.received).toEqual([account(me, 2, 2, 0, body.received[0]!.updated as string)]);
    expect(body.unread_mail_count).toBe(2);
  });

  test("the unread mail count is the user's own: another user's mail never adds to it", async () => {
    const first = await newMailbox(server);
    const second = await newMailbox(server);
    await second.mail({ to: [addr(first.address()), addr(second.address())] });
    expect((await accounts(first)).unread_mail_count).toBe(0);
    expect((await accounts(second)).unread_mail_count).toBe(1);
  });

  test("the account date keeps milliseconds and is in UTC", async () => {
    const box = await newMailbox(server);
    await box.mail({ date: "2026-07-01 10:00:00.123999+09" });
    expect((await accounts(box)).received[0]!.updated).toBe("2026-07-01T01:00:00.123Z");
  });
});

describe("GET /api/mails/accounts for admin", () => {
  // admin owns `mail.test` and its own `admin.mail.test`, so both are its
  // accounts; another user's name under the zone, or any other domain, is not.
  test("lists the addresses of both its domains: not users' subdomains, not others", async () => {
    const admin = await adminMailbox(server);
    await admin.mail({
      to: [
        addr("hello@mail.test"),
        addr("x@admin.mail.test"),
        addr("x@someuser.mail.test"),
        addr("x@remote.example"),
        addr("x@notmail.test"),
      ],
      date: "2026-04-01T00:00:00Z",
    });
    const body = await accounts(admin);
    expect(body.received).toEqual([
      account("hello@mail.test", 1, 1, 0, "2026-04-01T00:00:00.000Z"),
      account("x@admin.mail.test", 1, 1, 0, "2026-04-01T00:00:00.000Z"),
    ]);
    const direct = await admin.client.get("/api/mails/headers/x@admin.mail.test");
    expect(direct.body.body).toHaveLength(1);
    const unified = await admin.client.get("/api/mails/unified");
    expect(unified.body.body).toHaveLength(1);
  });

  test("does not see other users' accounts", async () => {
    const admin = await adminMailbox(server);
    const box = await newMailbox(server);
    await box.mail({ date: "2026-04-01T00:00:00Z" });
    const body = await accounts(admin);
    const keys = [...body.received, ...body.sent, ...body.spam].map((a) => a.key);
    expect(keys).not.toContain(box.address());
  });
});
