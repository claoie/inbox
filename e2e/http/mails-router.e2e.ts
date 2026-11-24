import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_PASSWORD, missingId, rawHttp, readMail, startServer, type ApiClient, type TestServer } from "../harness";
import {
  BAD_REQUEST,
  BODY_ETAG,
  JSON_TYPE,
  NOT_FOUND,
  NOT_LOGGED_IN,
  adminMailbox,
  failed,
  newMailbox,
  type Mailbox,
} from "./mails-helpers";

let server: TestServer;
let admin: Mailbox;
let anon: ApiClient;

beforeAll(async () => {
  server = await startServer();
  admin = await adminMailbox(server);
  anon = server.client();
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

const raw = (requestLine: string, client?: ApiClient, extraHeaders = "") =>
  rawHttp(
    server.ports.http,
    `${requestLine} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n` +
      (client ? `Cookie: ${client.cookieHeader()}\r\n` : "") +
      `${extraHeaders}\r\n`
  );

const id = missingId();

/** Every route of the router, with a request that reaches its handler. */
const ROUTES: [string, string][] = [
  ["GET", "/api/mails/accounts"],
  ["GET", "/api/mails/headers/hello@mail.test"],
  ["GET", "/api/mails/unified"],
  ["GET", `/api/mails/body/${id}`],
  ["GET", `/api/mails/thread/${id}`],
  ["GET", `/api/mails/attachment/${id}`],
  ["GET", "/api/mails/search/hello"],
  ["GET", "/api/mails/search-accounts/hello"],
  ["POST", "/api/mails/mark"],
  ["POST", "/api/mails/send"],
  ["DELETE", `/api/mails/${id}`],
  ["POST", "/api/mails/spam/mark"],
  ["GET", "/api/mails/spam-allowlist"],
  ["POST", "/api/mails/spam-allowlist"],
  ["DELETE", "/api/mails/spam-allowlist/a@b.co"],
];

describe("the session gate of /api/mails", () => {
  test("every route answers 401 without a session", async () => {
    for (const [method, path] of ROUTES) {
      const { status, body, headers } = await anon.request(method, path);
      expect({ method, path, status, body, type: headers.get("content-type") }).toEqual({
        method,
        path,
        status: 401,
        body: NOT_LOGGED_IN,
        type: JSON_TYPE,
      });
    }
  });

  test("the 401 body is exact and carries a weak ETag", async () => {
    const { status, text, headers } = await anon.get("/api/mails/accounts");
    expect(status).toBe(401);
    expect(text).toBe('{"status":"failed","message":"Request user is not logged in."}');
    expect(headers.get("etag")).toBe('W/"3e-/JQ6wQJ6P06hPgIU/qXOgYmeAHA"');
    expect(headers.get("content-length")).toBe("62");
  });

  test("a write without a session changes nothing", async () => {
    const mail = await admin.mail();
    const refusals = await Promise.all([
      anon.post("/api/mails/mark", { mail_id: mail.mail_id, read: true, save: true }),
      anon.post("/api/mails/spam/mark", { mail_id: mail.mail_id, is_spam: true }),
      anon.delete(`/api/mails/${mail.mail_id}`),
      anon.post("/api/mails/spam-allowlist", { pattern: "anon@example.com" }),
      anon.post("/api/mails/send", { sender: "hello", to: "x@remote.example", subject: "s", html: "h" }),
      anon.get(`/api/mails/body/${mail.mail_id}`),
    ]);
    expect(refusals.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    const row = await readMail(server, mail.mail_id);
    expect({ read: row!.read, saved: row!.saved, is_spam: row!.is_spam }).toEqual({
      read: false,
      saved: false,
      is_spam: false,
    });
    expect(server.mailgun.requests).toEqual([]);
    expect(await server.db.query("SELECT 1 FROM spam_allowlist WHERE pattern = 'anon@example.com'")).toEqual([]);
  });

  test("an unknown path under /api/mails is 401 without a session and 404 with one", async () => {
    for (const path of ["/api/mails", "/api/mails/", "/api/mails/nope", "/api/mails/body", "/api/mails/a/b/c"]) {
      const without = await anon.get(path);
      expect({ path, status: without.status, body: without.body }).toEqual({ path, status: 401, body: NOT_LOGGED_IN });
      const withSession = await admin.client.get(path);
      expect({ path, status: withSession.status, body: withSession.body }).toEqual({
        path,
        status: 404,
        body: NOT_FOUND,
      });
    }
  });

  test("a method no route answers is 401 without a session, before it is a 404", async () => {
    for (const method of ["PUT", "PATCH", "OPTIONS"]) {
      const { status, body } = await anon.request(method, "/api/mails/accounts");
      expect({ method, status, body }).toEqual({ method, status: 401, body: NOT_LOGGED_IN });
    }
  });

  test("a cookie that names no session is refused like no cookie", async () => {
    for (const cookie of ["connect.sid=nope", "connect.sid=s%3Aabc.def", "other=1"]) {
      const { status, body } = await anon.get("/api/mails/accounts", { headers: { Cookie: cookie } });
      expect({ cookie, status, body }).toEqual({ cookie, status: 401, body: NOT_LOGGED_IN });
    }
  });

  test("a session that signed out is refused", async () => {
    const box = await newMailbox(server);
    expect((await box.client.get("/api/mails/accounts")).status).toBe(200);
    await box.client.delete("/api/users/login");
    const { status, body } = await box.client.get("/api/mails/accounts");
    expect(status).toBe(401);
    expect(body).toEqual(NOT_LOGGED_IN);
  });

  test("an undecodable path segment is 401 without a session", async () => {
    for (const path of ["/api/mails/body/%E0%A4%A", "/api/mails/search/%E0%A4%A", "/api/mails/%E0%A4%A"]) {
      const response = await raw(`GET ${path}`);
      expect({ path, status: response.status, body: response.body }).toEqual({
        path,
        status: 401,
        body: JSON.stringify(NOT_LOGGED_IN),
      });
    }
  });
});

describe("GET /api/mails/domain and the gate", () => {
  test("is public at exactly /domain", async () => {
    const { status, text, headers, setCookies } = await anon.get("/api/mails/domain");
    expect(status).toBe(200);
    expect(text).toBe('{"status":"success","body":"mail.test"}');
    expect(headers.get("content-type")).toBe(JSON_TYPE);
    expect(setCookies).toEqual([]);
  });

  test("is public with a query string", async () => {
    const { status, body } = await anon.get("/api/mails/domain?x=1&x=2");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "success", body: "mail.test" });
  });

  // NOTE: the gate compares the path with "/domain" exactly, while the route
  // itself matches any letter case and a trailing slash. So the public route
  // is not public in the spellings the router otherwise treats as the same.
  test("is 401 without a session with a trailing slash or in another letter case", async () => {
    for (const path of ["/api/mails/domain/", "/api/mails/Domain", "/api/mails/DOMAIN/", "/API/MAILS/DOMAIN"]) {
      const { status, body } = await anon.get(path);
      expect({ path, status, body }).toEqual({ path, status: 401, body: NOT_LOGGED_IN });
    }
  });

  test("answers in any letter case of the prefix when the last segment is exactly domain", async () => {
    const { status, body } = await anon.get("/API/Mails/domain");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "success", body: "mail.test" });
  });

  test("answers those spellings with a session", async () => {
    for (const path of ["/api/mails/domain/", "/api/mails/Domain", "/api/mails/DOMAIN/"]) {
      const { status, body } = await admin.client.get(path);
      expect({ path, status, body }).toEqual({ path, status: 200, body: { status: "success", body: "mail.test" } });
    }
  });

  test("answers HEAD without a session and has no body", async () => {
    const get = await anon.get("/api/mails/domain");
    const head = await anon.head("/api/mails/domain");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.headers.get("content-length")).toBe("39");
  });

  test("is a 404 for POST and PUT without a session, not a 401", async () => {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const { status, body } = await anon.request(method, "/api/mails/domain");
      expect({ method, status, body }).toEqual({ method, status: 404, body: NOT_FOUND });
    }
  });

  // NOTE: "/domain" skips the session gate for every method, and DELETE /:id
  // matches the segment "domain". So this one request reaches the delete
  // handler with no session at all. It is refused only because "domain" is
  // not a UUID; the handler never reads the (absent) user before that check.
  test("DELETE /domain without a session reaches the delete handler and is refused as a bad id", async () => {
    const { status, body } = await anon.delete("/api/mails/domain");
    expect(status).toBe(200);
    expect(body).toEqual(failed("Invalid request. You may not manipulate other users' email"));
  });

  test("does not match a longer path", async () => {
    const without = await anon.get("/api/mails/domain/extra");
    expect(without.status).toBe(401);
    const withSession = await admin.client.get("/api/mails/domain/extra");
    expect(withSession.status).toBe(404);
    expect(withSession.body).toEqual(NOT_FOUND);
  });
});

describe("path matching with a session", () => {
  test("every route answers with a trailing slash and in upper case", async () => {
    const box = await newMailbox(server);
    const mail = await box.mail();
    const cases: [string, string, unknown][] = [
      ["GET", "/api/mails/accounts", "success"],
      ["GET", `/api/mails/headers/${box.address()}`, "success"],
      ["GET", "/api/mails/unified", "success"],
      ["GET", `/api/mails/body/${mail.mail_id}`, "success"],
      ["GET", `/api/mails/thread/${mail.mail_id}`, "success"],
      ["GET", "/api/mails/search/fixture", "success"],
      ["GET", "/api/mails/search-accounts/fixture", "success"],
      ["GET", "/api/mails/spam-allowlist", "success"],
      ["POST", "/api/mails/mark", "failed"],
      ["POST", "/api/mails/send", "failed"],
      ["POST", "/api/mails/spam/mark", "failed"],
      ["POST", "/api/mails/spam-allowlist", "failed"],
      ["DELETE", "/api/mails/spam-allowlist/nobody@example.com", "failed"],
      ["DELETE", `/api/mails/${missingId()}`, "failed"],
    ];
    for (const [method, path, outcome] of cases) {
      for (const spelled of [`${path}/`, path.replace("/api/mails/", "/API/MAILS/"), upperRoute(path)]) {
        const { status, body } = await box.client.request(method, spelled);
        expect({ method, spelled, status, outcome: body?.status }).toEqual({ method, spelled, status: 200, outcome });
      }
    }
  });

  test("a mail id matches in upper case and with percent-encoded characters", async () => {
    const box = await newMailbox(server);
    const mail = await box.mail({ read: true });
    const encoded = `%${mail.mail_id.charCodeAt(0).toString(16)}${mail.mail_id.slice(1)}`;
    for (const spelled of [mail.mail_id.toUpperCase(), encoded]) {
      const response = await raw(`GET /api/mails/body/${spelled}`, box.client);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).body.id).toBe(mail.mail_id);
    }
  });

  test("two trailing slashes, an empty segment or an extra segment match nothing", async () => {
    const box = await newMailbox(server);
    const mail = await box.mail();
    for (const path of [
      "/api/mails/accounts//",
      "/api/mails//accounts",
      "/api//mails/accounts",
      "/api/mails/body/",
      "/api/mails/body//",
      `/api/mails/body/${mail.mail_id}/extra`,
      "/api/mails/search/",
      "/api/mails/search/a/b",
      "/api/mails/headers/",
      "/api/mails/spam",
      "/api/mails/spam/mark/extra",
    ]) {
      const response = await raw(`GET ${path}`, box.client);
      expect({ path, status: response.status, body: response.body }).toEqual({
        path,
        status: 404,
        body: JSON.stringify(NOT_FOUND),
      });
    }
  });

  test("an encoded slash stays inside its segment", async () => {
    const box = await newMailbox(server);
    const mail = await box.mail();
    const response = await raw(`GET /api/mails/body/${mail.mail_id}%2F`, box.client);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(failed("No email is found."));
  });

  test("an undecodable escape in a path parameter is a 400 on every route that takes one", async () => {
    for (const requestLine of [
      "GET /api/mails/headers/%E0%A4%A",
      "GET /api/mails/body/%E0%A4%A",
      "GET /api/mails/thread/%E0%A4%A",
      "GET /api/mails/attachment/%E0%A4%A",
      "GET /api/mails/search/%E0%A4%A",
      "GET /api/mails/search-accounts/%E0%A4%A",
      "GET /api/mails/search/%",
      "GET /api/mails/search/100%",
      "DELETE /api/mails/%E0%A4%A",
      "DELETE /api/mails/spam-allowlist/%E0%A4%A",
    ]) {
      const response = await raw(requestLine, admin.client);
      expect({ requestLine, status: response.status, body: response.body, type: response.headers["content-type"] }).toEqual({
        requestLine,
        status: 400,
        body: JSON.stringify(BAD_REQUEST),
        type: JSON_TYPE,
      });
    }
  });

  test("an undecodable escape in a path no route matches is a 404", async () => {
    const response = await raw("GET /api/mails/accounts/%E0%A4%A", admin.client);
    expect(response.status).toBe(404);
    expect(response.body).toBe(JSON.stringify(NOT_FOUND));
  });

  test("a query string never takes part in matching", async () => {
    const { status, body } = await admin.client.get("/api/mails/accounts?/extra=1&x=%E0%A4%A");
    expect(status).toBe(200);
    expect(body.status).toBe("success");
  });
});

const upperRoute = (path: string) => {
  // Upper-cases the literal route words only; ids, addresses and search values keep their case.
  const [, , , first, ...rest] = path.split("/");
  const literalSecond = first === "spam" && rest[0] === "mark";
  return `/api/mails/${first!.toUpperCase()}${rest.length ? `/${literalSecond ? "MARK" : rest.join("/")}` : ""}`;
};

describe("methods", () => {
  test("HEAD answers every GET route with the headers of GET and no body", async () => {
    const box = await newMailbox(server);
    const mail = await box.mail({ read: true });
    for (const path of [
      "/api/mails/accounts",
      `/api/mails/headers/${box.address()}`,
      `/api/mails/headers/${box.address()}?limit=5`,
      `/api/mails/unified`,
      `/api/mails/unified?limit=5`,
      `/api/mails/body/${mail.mail_id}`,
      `/api/mails/thread/${mail.mail_id}`,
      "/api/mails/search/fixture",
      "/api/mails/search-accounts/fixture",
      "/api/mails/spam-allowlist",
    ]) {
      const get = await box.client.get(path);
      const head = await box.client.head(path);
      expect({ path, status: head.status, text: head.text }).toEqual({ path, status: 200, text: "" });
      expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
      expect(head.headers.get("etag")).toMatch(BODY_ETAG);
    }
  });

  test("HEAD is not answered on the POST and DELETE routes", async () => {
    for (const path of [
      "/api/mails/mark",
      "/api/mails/send",
      "/api/mails/spam/mark",
      `/api/mails/${missingId()}`,
      "/api/mails/spam-allowlist/a@b.co",
    ]) {
      const head = await admin.client.head(path);
      expect({ path, status: head.status, text: head.text }).toEqual({ path, status: 404, text: "" });
      const get = await admin.client.get(path);
      expect({ path, status: get.status, body: get.body }).toEqual({ path, status: 404, body: NOT_FOUND });
    }
  });

  test("POST, PUT, PATCH and OPTIONS are not answered on the GET routes", async () => {
    const mail = await admin.mail();
    for (const path of [
      "/api/mails/domain",
      "/api/mails/accounts",
      "/api/mails/headers/hello@mail.test",
      "/api/mails/unified",
      `/api/mails/body/${mail.mail_id}`,
      `/api/mails/thread/${mail.mail_id}`,
      "/api/mails/attachment/x",
      "/api/mails/search/x",
      "/api/mails/search-accounts/x",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "OPTIONS"]) {
        const { status, body } = await admin.client.request(method, path);
        expect({ method, path, status, body }).toEqual({ method, path, status: 404, body: NOT_FOUND });
      }
    }
    expect((await readMail(server, mail.mail_id))!.read).toBe(false);
  });

  test("PUT and PATCH are not answered on the write routes", async () => {
    for (const path of ["/api/mails/mark", "/api/mails/send", "/api/mails/spam/mark", "/api/mails/spam-allowlist"]) {
      for (const method of ["PUT", "PATCH"]) {
        const { status, body } = await admin.client.request(method, path, { json: {} });
        expect({ method, path, status, body }).toEqual({ method, path, status: 404, body: NOT_FOUND });
      }
    }
  });

  // NOTE: DELETE /:id takes any single segment, so a DELETE aimed at another
  // route's one-segment path is answered by the delete handler (200, refused
  // as "not your mail") instead of a 404.
  test("DELETE on a one-segment path of another route reaches the delete handler", async () => {
    for (const path of [
      "/api/mails/accounts",
      "/api/mails/unified",
      "/api/mails/domain2",
      "/api/mails/mark",
      "/api/mails/send",
      "/api/mails/spam-allowlist",
      "/api/mails/spam-allowlist/",
    ]) {
      const { status, body } = await admin.client.delete(path);
      expect({ path, status, body }).toEqual({
        path,
        status: 200,
        body: failed("Invalid request. You may not manipulate other users' email"),
      });
    }
  });

  test("DELETE on a path of two or more segments that is not the allowlist is a 404", async () => {
    for (const path of ["/api/mails", "/api/mails/", "/api/mails/spam/mark", "/api/mails/body/x", "/api/mails/a/b"]) {
      const { status, body } = await admin.client.delete(path);
      expect({ path, status, body }).toEqual({ path, status: 404, body: NOT_FOUND });
    }
  });
});

describe("conditional requests", () => {
  let box: Mailbox;
  beforeAll(async () => {
    box = await newMailbox(server);
    await box.mail({ read: true });
  });

  const listPaths = () => [
    "/api/mails/accounts",
    `/api/mails/headers/${box.address()}`,
    `/api/mails/headers/${box.address()}?limit=10`,
    "/api/mails/unified",
    "/api/mails/unified?limit=10",
    "/api/mails/search/fixture",
    "/api/mails/search-accounts/fixture",
    "/api/mails/spam-allowlist",
  ];

  test("If-None-Match with the current ETag answers 304 with no body on every list route", async () => {
    for (const path of listPaths()) {
      const first = await box.client.get(path);
      const etag = first.headers.get("etag")!;
      expect(etag).toMatch(BODY_ETAG);
      const again = await box.client.get(path, { headers: { "If-None-Match": etag } });
      expect({ path, status: again.status, text: again.text }).toEqual({ path, status: 304, text: "" });
      expect(again.headers.get("etag")).toBe(etag);
      expect(again.headers.get("content-type")).toBeNull();
    }
  });

  test("the strong spelling, a list of tags and * all match", async () => {
    const path = `/api/mails/headers/${box.address()}`;
    const etag = (await box.client.get(path)).headers.get("etag")!;
    for (const value of [etag.slice(2), `"other", ${etag}`, `W/"0-x" , ${etag.slice(2)}`, "*"]) {
      const { status } = await box.client.get(path, { headers: { "If-None-Match": value } });
      expect({ value, status }).toEqual({ value, status: 304 });
    }
  });

  test("another tag, or Cache-Control: no-cache, gets the full answer", async () => {
    const path = `/api/mails/headers/${box.address()}`;
    const first = await box.client.get(path);
    const etag = first.headers.get("etag")!;
    const other = await box.client.get(path, { headers: { "If-None-Match": 'W/"1e-ZirBHndQgB0ZQPCHGvcJtDrJf6U"' } });
    expect(other.status).toBe(200);
    expect(other.text).toBe(first.text);
    const noCache = await box.client.get(path, { headers: { "If-None-Match": etag, "Cache-Control": "no-cache" } });
    expect(noCache.status).toBe(200);
    expect(noCache.text).toBe(first.text);
  });

  test("HEAD with the current ETag is a 304 too", async () => {
    const path = "/api/mails/unified";
    const etag = (await box.client.get(path)).headers.get("etag")!;
    const head = await box.client.head(path, { headers: { "If-None-Match": etag } });
    expect(head.status).toBe(304);
    expect(head.headers.get("etag")).toBe(etag);
  });

  test("the ETag changes when the list changes", async () => {
    const path = `/api/mails/headers/${box.address()}`;
    const before = (await box.client.get(path)).headers.get("etag")!;
    await box.mail();
    const after = await box.client.get(path, { headers: { "If-None-Match": before } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
    expect(after.body.body).toHaveLength(2);
  });

  test("a refusal answered 200 is revalidated like any other body", async () => {
    const path = "/api/mails/body/not-a-uuid";
    const first = await box.client.get(path);
    expect(first.body).toEqual(failed("No email is found."));
    const again = await box.client.get(path, { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  test("a 401 and a 404 are never turned into a 304", async () => {
    const unauthorized = await anon.get("/api/mails/accounts");
    const again = await anon.get("/api/mails/accounts", {
      headers: { "If-None-Match": unauthorized.headers.get("etag")! },
    });
    expect(again.status).toBe(401);
    expect(again.body).toEqual(NOT_LOGGED_IN);
    const missing = await box.client.get("/api/mails/nope");
    const missingAgain = await box.client.get("/api/mails/nope", {
      headers: { "If-None-Match": missing.headers.get("etag")! },
    });
    expect(missingAgain.status).toBe(404);
  });

  test("a POST is never answered 304", async () => {
    const first = await box.client.post("/api/mails/mark", {});
    const again = await box.client.post("/api/mails/mark", {}, { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(failed("mail_id must be a valid id"));
  });
});

describe("response framing", () => {
  test("a streamed list has no Content-Length and is chunked; other answers have a length", async () => {
    const box = await newMailbox(server);
    await box.mail();
    for (const path of [`/api/mails/headers/${box.address()}`, "/api/mails/unified", "/api/mails/unified?limit=3"]) {
      const response = await raw(`GET ${path}`, box.client);
      expect(response.status).toBe(200);
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.headers["transfer-encoding"]).toBe("chunked");
      expect(response.headers["content-type"]).toBe(JSON_TYPE);
      const parsed = JSON.parse(response.body);
      expect(parsed.status).toBe("success");
      // The ETag's first half is the byte length of the body, in hex.
      const length = Buffer.byteLength(response.body, "utf8").toString(16);
      expect(response.headers.etag!.startsWith(`W/"${length}-`)).toBe(true);
    }
    for (const path of ["/api/mails/accounts", "/api/mails/search/fixture", `/api/mails/headers/${box.address()}?since=2020-01-01T00:00:00Z`]) {
      const response = await raw(`GET ${path}`, box.client);
      expect(response.status).toBe(200);
      expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(response.body, "utf8")));
    }
  });
});

describe("a production server", () => {
  let production: TestServer;
  beforeAll(async () => {
    production = await startServer({ production: true });
  }, 90_000);
  afterAll(async () => {
    await production?.stop();
  });

  test("keeps the same gate, with independent clients", async () => {
    const first = production.client();
    const second = production.client();
    const login = await first.login("admin", ADMIN_PASSWORD);
    expect(login.setCookies.join(";")).toContain("Secure");
    expect((await first.get("/api/mails/accounts")).body).toEqual({
      status: "success",
      body: { received: [], sent: [], spam: [], shared: [], unread_mail_count: 0 },
    });
    const refused = await second.get("/api/mails/accounts");
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual(NOT_LOGGED_IN);
    expect((await second.get("/api/mails/domain")).body).toEqual({ status: "success", body: "mail.test" });
    expect(refused.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });
});
