import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MAILGUN_KEY, startServer, waitFor, type MailgunReply, type TestServer } from "../harness";
import { JSON_TYPE, countMails, failed, fields, latestMail, multipart, newMailbox, type Mailbox } from "./mails-helpers";

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
const GENERIC = "Failed to send email. Please try again.";

/** Sends with Mailgun answering `reply`, and reports the answer, the request count and whether a row was stored. */
const sendAgainst = async (reply: MailgunReply, body: unknown = BASE, owner = box) => {
  server.mailgun.reset();
  server.mailgun.replyAlways(reply);
  const before = await countMails(server, owner.id);
  const response = await owner.client.post("/api/mails/send", body);
  const stored = (await countMails(server, owner.id)) - before;
  const requests = server.mailgun.requests.length;
  server.mailgun.reset();
  return { status: response.status, body: response.body, text: response.text, requests, stored };
};

describe("POST /api/mails/send — Mailgun refuses the message", () => {
  test("401 and 403 are reported as a configuration problem", async () => {
    for (const reply of [
      () => new Response("Forbidden", { status: 401 }),
      () => Response.json({ message: "Invalid private key" }, { status: 401 }),
      () => Response.json({ message: "nope" }, { status: 403 }),
      () => new Response("", { status: 403 }),
    ]) {
      expect(await sendAgainst(reply)).toMatchObject({
        status: 200,
        body: failed("Email service not configured correctly"),
        requests: 1,
        stored: 0,
      });
    }
  });

  test("the refusal is exact and is a 200", async () => {
    const result = await sendAgainst(() => new Response("Forbidden", { status: 401 }));
    expect(result.text).toBe('{"status":"failed","message":"Email service not configured correctly"}');
    server.mailgun.replyAlways(() => new Response("Forbidden", { status: 401 }));
    const { headers } = await box.client.post("/api/mails/send", BASE);
    expect(headers.get("content-type")).toBe(JSON_TYPE);
  });

  test("400 passes on Mailgun's `error` text", async () => {
    expect(await sendAgainst(() => Response.json({ error: "custom error text", message: "ignored" }, { status: 400 }))).toMatchObject({
      status: 200,
      body: failed("custom error text"),
      requests: 1,
      stored: 0,
    });
  });

  // NOTE: Mailgun words a 400 in `message`, not `error`. Only `error` is
  // read, so a real Mailgun 400 ("to parameter is not a valid address…")
  // reaches the user as the bare status text "Bad Request".
  test("400 without an `error` field is reported as the status text, not Mailgun's message", async () => {
    for (const reply of [
      () => Response.json({ message: "to parameter is not a valid address. please check documentation" }, { status: 400 }),
      () => new Response("plain bad", { status: 400 }),
      () => new Response("", { status: 400 }),
      () => Response.json({ error: "" }, { status: 400 }),
    ]) {
      expect(await sendAgainst(reply)).toMatchObject({ status: 200, body: failed("Bad Request"), requests: 1, stored: 0 });
    }
  });

  test("429 asks the user to retry later", async () => {
    expect(await sendAgainst(() => Response.json({ message: "slow down" }, { status: 429 }))).toMatchObject({
      status: 200,
      body: failed("Too many requests. Please try again later."),
      requests: 1,
      stored: 0,
    });
  });

  test("every other error status is a generic failure, whatever Mailgun says", async () => {
    for (const [status, body] of [
      [402, JSON.stringify({ message: "pay" })],
      [404, "not found"],
      [413, "too big"],
      [500, "oops"],
      [502, JSON.stringify({ error: "upstream error text" })],
      [503, ""],
    ] as const) {
      const result = await sendAgainst(() => new Response(body, { status }));
      expect({ status, result }).toEqual({
        status,
        result: { status: 200, body: failed(GENERIC), text: `{"status":"failed","message":"${GENERIC}"}`, requests: 1, stored: 0 },
      });
    }
  });

  test("the Mailgun marketing page (a 200 saying Mailgun Magnificent API) is reported as a wrong URL", async () => {
    expect(await sendAgainst(() => new Response("Mailgun Magnificent API", { status: 200 }))).toMatchObject({
      status: 200,
      body: failed("Incorrect url"),
      requests: 1,
      stored: 0,
    });
  });

  test("any other 2xx is a success, whatever the body", async () => {
    for (const reply of [
      () => new Response("OK queued", { status: 200 }),
      () => new Response("", { status: 200 }),
      () => new Response("null", { status: 200 }),
      () => Response.json([1, 2]),
      () => Response.json({ message: "Queued" }),
      () => Response.json({ id: "<x@y>" }, { status: 201 }),
      () => new Response(null, { status: 204 }),
      () => new Response("Mailgun Magnificent API!", { status: 200 }),
    ]) {
      expect(await sendAgainst(reply)).toMatchObject({ status: 200, body: SUCCESS, requests: 1, stored: 1 });
    }
  });

  test("a failed send stores nothing and can simply be sent again", async () => {
    const fresh = await newMailbox(server);
    expect(await sendAgainst(() => new Response("oops", { status: 500 }), BASE, fresh)).toMatchObject({ body: failed(GENERIC), stored: 0 });
    expect((await fresh.client.get(`/api/mails/headers/${fresh.address()}?sent=1`)).body.body).toEqual([]);
    expect((await fresh.client.post("/api/mails/send", BASE)).body).toEqual(SUCCESS);
    expect(await countMails(server, fresh.id)).toBe(1);
  });

  test("a failed send with attachments stores no mail", async () => {
    server.mailgun.replyAlways(() => new Response("oops", { status: 500 }));
    const before = await countMails(server, box.id);
    const form = multipart([...fields(BASE), { name: "attachments", filename: "a.txt", contentType: "text/plain", value: "a" }]);
    const { status, body } = await box.client.request("POST", "/api/mails/send", { body: form.body, headers: form.headers });
    expect(status).toBe(200);
    expect(body).toEqual(failed(GENERIC));
    expect(server.mailgun.requests).toHaveLength(1);
    expect(server.mailgun.requests[0]!.attachments).toHaveLength(1);
    expect(await countMails(server, box.id)).toBe(before);
  });

  test("the request is not retried", async () => {
    let calls = 0;
    const result = await sendAgainst(() => {
      calls++;
      return new Response("oops", { status: 503 });
    });
    expect(result.requests).toBe(1);
    expect(calls).toBe(1);
  });

  test("the first failure raises a Mail Send Failed alarm", async () => {
    // Alarms of one kind are held to one a minute, so only the first failure of this server is seen.
    await sendAgainst(() => new Response("oops", { status: 500 }));
    const alarm = await waitFor(() => server.alarms.alarms.find((a) => a.title.includes("Mail Send Failed")), {
      what: "the send failure alarm",
    });
    expect(alarm.title).toBe("🚨 Mail Server Error: Mail Send Failed");
    expect(alarm.description).toMatch(/^\*\*Error:\*\* /);
  });
});

describe("POST /api/mails/send — some Bcc-only recipients fail", () => {
  const BCC = { sender: "box", bcc: "b1@remote.example,b2@remote.example,b3@remote.example", subject: "Bcc", html: "<p>x</p>" };

  test("one failed recipient of several: the send succeeds, is stored once, and the gap is alarmed", async () => {
    const fresh = await newMailbox(server);
    const result = await sendAgainst(
      (request) => (request.fields.to![0] === "b2@remote.example" ? new Response("oops", { status: 500 }) : Response.json({ id: `<ok-${request.fields.to![0]}>` })),
      BCC,
      fresh
    );
    expect(result).toMatchObject({ status: 200, body: SUCCESS, requests: 3, stored: 1 });
    const row = await latestMail(server, fresh.id);
    // The Message-ID comes from the first recipient that was accepted; every recipient stays on the row.
    expect(row.message_id).toBe("<ok-b1@remote.example>");
    expect(row.bcc_address).toEqual([{ address: "b1@remote.example" }, { address: "b2@remote.example" }, { address: "b3@remote.example" }]);
    const alarm = await waitFor(() => server.alarms.alarms.find((a) => a.title.includes("Partially Failed")), {
      what: "the partial failure alarm",
    });
    expect(alarm).toMatchObject({
      title: "🚨 Mail Server Error: Mail Send Partially Failed",
      description: "**Undelivered Bcc recipients:** b2@remote.example",
    });
  });

  test("when the first recipient fails, the stored id is the next accepted one", async () => {
    const fresh = await newMailbox(server);
    const result = await sendAgainst(
      (request) => (request.fields.to![0] === "b1@remote.example" ? new Response("", { status: 429 }) : Response.json({ id: `<ok-${request.fields.to![0]}>` })),
      BCC,
      fresh
    );
    expect(result).toMatchObject({ body: SUCCESS, requests: 3, stored: 1 });
    expect((await latestMail(server, fresh.id)).message_id).toBe("<ok-b2@remote.example>");
  });

  test("when every recipient fails, the first recipient's failure is the one reported", async () => {
    const byRecipient: Record<string, number> = { "b1@remote.example": 429, "b2@remote.example": 401, "b3@remote.example": 500 };
    const result = await sendAgainst((request) => new Response("", { status: byRecipient[request.fields.to![0]!]! }), BCC);
    expect(result).toMatchObject({ status: 200, body: failed("Too many requests. Please try again later."), requests: 3, stored: 0 });
    const reversed = await sendAgainst(
      (request) => new Response("", { status: byRecipient[request.fields.to![0]!]! }),
      { ...BCC, bcc: "b2@remote.example,b1@remote.example" }
    );
    expect(reversed).toMatchObject({ body: failed("Email service not configured correctly"), requests: 2, stored: 0 });
  });
});

describe("POST /api/mails/send — Mailgun cannot be reached", () => {
  let offline: TestServer;
  let user: Mailbox;
  beforeAll(async () => {
    offline = await startServer({ env: { MAILGUN_URL: "http://127.0.0.1:1" } });
    user = await newMailbox(offline);
  }, 90_000);
  afterAll(async () => {
    await offline?.stop();
  });

  // NOTE: a refused connection is meant to read "Unable to reach email
  // service. Please try again later." — the server has that sentence — but
  // the network failure is first recast as a 400 whose text is the error
  // code, and the 400 branch wins. The user is shown "ECONNREFUSED".
  test("a refused connection is answered with the raw error code", async () => {
    const { status, text } = await user.client.post("/api/mails/send", BASE);
    expect(status).toBe(200);
    expect(text).toBe('{"status":"failed","message":"ECONNREFUSED"}');
    expect(await countMails(offline, user.id)).toBe(0);
    const alarm = await waitFor(() => offline.alarms.alarms.find((a) => a.title.includes("Mail Send Failed")), {
      what: "the send failure alarm",
    });
    expect(alarm).toMatchObject({ title: "🚨 Mail Server Error: Mail Send Failed", description: "**Error:** ECONNREFUSED" });
  });

  test("a send that needs no Mailgun still succeeds", async () => {
    const { body } = await user.client.post("/api/mails/send", { ...BASE, to: "hello@mail.test" });
    expect(body).toEqual(SUCCESS);
    expect(await countMails(offline, user.id)).toBe(1);
  });

  test("validation still comes first", async () => {
    expect((await user.client.post("/api/mails/send", { ...BASE, to: "nope" })).body).toEqual(failed("Invalid recipient address: nope"));
  });
});

describe("POST /api/mails/send — Mailgun configuration", () => {
  test("MAILGUN_URL may end with slashes, and MAILGUN_KEY is the Basic password for user api", async () => {
    const stub = server.mailgun.url;
    const configured = await startServer({ env: { MAILGUN_KEY: "another-key:with colon", MAILGUN_URL: `${stub}///` } });
    try {
      const user = await newMailbox(configured);
      server.mailgun.reset();
      expect((await user.client.post("/api/mails/send", BASE)).body).toEqual(SUCCESS);
      // The request went to this file's stub, the one the override names.
      expect(server.mailgun.requests).toHaveLength(1);
      expect(server.mailgun.requests[0]!.path).toBe("/v3/mail.test/messages");
      expect(server.mailgun.requests[0]!.authorization).toBe(`Basic ${Buffer.from("api:another-key:with colon").toString("base64")}`);
      expect(configured.mailgun.requests).toEqual([]);
      expect(MAILGUN_KEY).not.toBe("another-key:with colon");
    } finally {
      await configured.stop();
    }
  }, 90_000);
});
