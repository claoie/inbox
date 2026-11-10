import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// ── Mock net, tls, fs, and postgres BEFORE importing health router ───────────

const makeSocketMock = () => {
  const socket: Record<string, unknown> = {};
  const handlers: Record<string, () => void> = {};
  socket.destroy = mock(() => {});
  socket.end = mock((arg?: unknown) => { if (typeof arg === "function") arg(); return socket; });
  socket.write = mock(() => true);
  socket.setTimeout = mock(() => socket);
  socket.on = mock((event: string, cb: () => void) => {
    handlers[event] = cb;
    return socket;
  });
  (socket as { _handlers: Record<string, () => void> })._handlers = handlers;
  return socket;
};

let netSocketMock = makeSocketMock();
let tlsSocketMock = makeSocketMock();

// Controls what happens when a TCP connection is attempted:
// "connect" = call the connect callback (success)
// "error"   = fire the error event handler
// "timeout" = fire the timeout event handler
let netBehavior: "connect" | "error" | "timeout" = "connect";
let tlsBehavior: "connect" | "error" | "timeout" = "connect";

const netSockets: Record<string, unknown>[] = [];

const mockCreateConnection = mock((_opts: unknown, cb?: () => void) => {
  const socket = makeSocketMock();
  netSocketMock = socket;
  netSockets.push(socket);
  setTimeout(() => {
    if (netBehavior === "connect") cb?.();
    else if (netBehavior === "error") (socket as { _handlers: Record<string, () => void> })._handlers["error"]?.();
    else if (netBehavior === "timeout") (socket as { _handlers: Record<string, () => void> })._handlers["timeout"]?.();
  }, 0);
  return socket;
});

const mockTlsConnect = mock((_opts: unknown, cb: () => void) => {
  const socket = makeSocketMock();
  tlsSocketMock = socket;
  setTimeout(() => {
    if (tlsBehavior === "connect") cb();
    else if (tlsBehavior === "error") (socket as { _handlers: Record<string, () => void> })._handlers["error"]?.();
    else if (tlsBehavior === "timeout") (socket as { _handlers: Record<string, () => void> })._handlers["timeout"]?.();
  }, 0);
  return socket;
});

mock.module("net", () => ({ createConnection: mockCreateConnection }));
mock.module("tls", () => ({ connect: mockTlsConnect }));

// fs.accessSync is consulted by the shared TLS gate (`lib/tls.ts`). When the
// test sets SSL_CERTIFICATE/_KEY env vars, the mock lets the access check pass
// so the SSL gate opens. Only `accessSync` is overridden: the gate stopped
// reading `existsSync`, and leaving a stub on it would hand a wrong answer to
// any future named `import { existsSync }` in a file that links after this one.
//
// The real module is spread back in rather than replaced wholesale. bun's
// `mock.module` is process-global, so a bare `{ accessSync }` factory leaves
// every OTHER export of `node:fs` undefined for any file that links after this
// one — including `scripts/test-helpers.ts`, which now imports mkdtempSync /
// writeFileSync / rmSync for the TLS fixture. Reverting the spread does not
// reproduce a failure on this tree (checked: still 1682 pass), so this is a
// guard against an order-dependent break rather than a fix for a live one —
// but a shared helper should not depend on which file bun links first.
import * as realFs from "fs";
let sslFilesReadable = true;
mock.module("fs", () => ({
  ...realFs,
  default: realFs,
  accessSync: (path: Parameters<typeof realFs.accessSync>[0]) => {
    if (!sslFilesReadable) throw new Error(`ENOENT: no such file or directory, access '${String(path)}'`);
  },
}));

const mockPoolQuery = mock(async () => [{ "?column?": 1 }]);
// Mock the driver LEAF, not the postgres client module: mock.module is
// process-global, and mocking the client module leaked its stub pool into
// every file that imported the client afterwards — it broke
// mailgun-events.test.ts's store assertions (the insert went to this stub
// instead of that file's driver mock, so its mockQuery saw zero calls).
// Mocking the driver instead lets client.ts bind the fake Pool class when the
// health handler is first imported, and afterAll restores it via restoreLeaves.
class FakePool {
  query = mockPoolQuery;
  end = async () => {};
  connect = async () => ({ query: mockPoolQuery, release: () => {} });
  on() {}
}
const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});
mock.module("server/lib/postgres/pool", pgMock);
// The client module is already loaded (preload imports the server barrel),
// and its pool Proxy caches the real Pool instance at load — so the driver mock
// above alone does not rebind it. Re-registering the mock plus resetPool()
// (the mailgun-events.test.ts pattern) drops the cached pool and makes the
// next query construct the fake Pool instead.
import { resetPool } from "../../postgres/client";

// ── Helper to call the health handler GET "/" directly ────────────────────────

import type { HttpRequest } from "../request";

/** Invoke the health handler for GET /api/health and read its response back. */
const invokeHealthGet = async (
  handleHealth: (req: HttpRequest, path: string) => Promise<Response | undefined>
): Promise<{ _code: number; _body: unknown }> => {
  const res = await handleHealth({ method: "GET", path: "/api/health" } as HttpRequest, "/");
  if (!res) throw new Error("health handler did not answer GET /");
  return { _code: res.status, _body: await res.json() };
};

// ── Tests ─────────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = {
  SSL_CERTIFICATE: process.env.SSL_CERTIFICATE,
  SSL_CERTIFICATE_KEY: process.env.SSL_CERTIFICATE_KEY,
  SMTP_PORT: process.env.SMTP_PORT,
  IMAP_PORT: process.env.IMAP_PORT,
  SMTPS_PORT: process.env.SMTPS_PORT,
  SMTP_SUBMISSION_PORT: process.env.SMTP_SUBMISSION_PORT,
  IMAP_TLS_PORT: process.env.IMAP_TLS_PORT,
  PROXY_PROTOCOL: process.env.PROXY_PROTOCOL,
};

const restoreEnv = () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe("health GET /", () => {
  beforeEach(() => {
    mock.module("server/lib/postgres/pool", pgMock);
    resetPool();
    mockPoolQuery.mockClear();
    mockCreateConnection.mockClear();
    mockTlsConnect.mockClear();
    netBehavior = "connect";
    tlsBehavior = "connect";
    sslFilesReadable = true;
    // Default: SSL configured so existing assertions about TLS ports apply.
    process.env.SSL_CERTIFICATE = "/fake/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/fake/key.pem";
    delete process.env.IMAP_PORT;
    delete process.env.SMTP_PORT;
    delete process.env.SMTPS_PORT;
    delete process.env.SMTP_SUBMISSION_PORT;
    delete process.env.IMAP_TLS_PORT;
    delete process.env.PROXY_PROTOCOL;
    netSockets.length = 0;
  });

  afterAll(() => {
    restoreEnv();
    restoreLeaves();
    const realFsSnapshot = (globalThis as Record<string, unknown>).__REAL_FS;
    if (realFsSnapshot) mock.module("fs", () => realFsSnapshot);
    const realNetSnapshot = (globalThis as Record<string, unknown>).__REAL_NET;
    if (realNetSnapshot) mock.module("net", () => realNetSnapshot);
    const realTlsSnapshot = (globalThis as Record<string, unknown>).__REAL_TLS;
    if (realTlsSnapshot) mock.module("tls", () => realTlsSnapshot);
  });

  it("returns 200 with status:'success' when everything is healthy (SSL configured)", async () => {
    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.status).toBe("success");
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks.database).toBe("ok");
    expect(body.body.checks.http).toBe("ok");
    expect(body.body.checks["smtp:465"]).toBe("ok");
    expect(body.body.checks["imap:993"]).toBe("ok");
  });

  it("opens each probe with a PROXY header when PROXY_PROTOCOL is set", async () => {
    process.env.PROXY_PROTOCOL = "true";
    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const calls = (socket: Record<string, unknown>, name: string) =>
      (socket[name] as { mock: { calls: unknown[][] } }).mock.calls;
    // Plain and STARTTLS ports: SMTP 25, IMAP 143, submission 587.
    const plain = netSockets.filter((socket) => calls(socket, "end").length > 0);
    expect(plain.map((socket) => calls(socket, "end")[0][0])).toEqual([
      "PROXY UNKNOWN\r\n",
      "PROXY UNKNOWN\r\n",
      "PROXY UNKNOWN\r\n"
    ]);
    // Implicit-TLS ports: the header goes on the raw socket the handshake then runs over.
    const underTls = netSockets.filter((socket) => calls(socket, "write").length > 0);
    expect(underTls.map((socket) => calls(socket, "write")[0][0])).toEqual([
      "PROXY UNKNOWN\r\n",
      "PROXY UNKNOWN\r\n"
    ]);
    const tlsOptions = mockTlsConnect.mock.calls.map((call) => (call[0] as { socket?: unknown }).socket);
    expect(tlsOptions).toEqual(underTls);
  });

  it("sends no PROXY header when PROXY_PROTOCOL is unset", async () => {
    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const used = (socket: Record<string, unknown>, name: string) =>
      (socket[name] as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(netSockets.length).toBe(3);
    expect(netSockets.filter((socket) => used(socket, "end") || used(socket, "write"))).toEqual([]);
    expect(netSockets.filter((socket) => used(socket, "destroy")).length).toBe(3);
    expect(mockTlsConnect.mock.calls.map((call) => (call[0] as { socket?: unknown }).socket)).toEqual([
      undefined,
      undefined
    ]);
  });

  it("returns 503 when DB is unhealthy", async () => {
    mockPoolQuery.mockImplementationOnce(async () => { throw new Error("DB down"); });

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.status).toBe("error");
    expect(body.body.healthy).toBe(false);
    expect(body.body.checks.database).toBe("unhealthy");
  });

  it("returns 503 when a TCP port fails (error event)", async () => {
    netBehavior = "error";

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(false);
  });

  it("returns 503 when a TLS port fails (SSL configured)", async () => {
    tlsBehavior = "error";

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(503);
  });

  it("always marks HTTP check as ok", async () => {
    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.checks.http).toBe("ok");
  });

  it("includes a numeric timestamp", async () => {
    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(typeof body.body.timestamp).toBe("number");
    expect(body.body.timestamp).toBeGreaterThan(0);
  });

  it("returns 200 and marks TLS ports 'not_configured' when SSL_CERTIFICATE is unset", async () => {
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks["smtp:465"]).toBe("not_configured");
    expect(body.body.checks["smtp:587"]).toBe("not_configured");
    expect(body.body.checks["imap:993"]).toBe("not_configured");
    // Plain ports remain required
    expect(body.body.checks["smtp:25"]).toBe("ok");
    expect(body.body.checks["imap:143"]).toBe("ok");
    // TLS probe never invoked when SSL not configured
    expect(mockTlsConnect).not.toHaveBeenCalled();
  });

  it("returns 200 and marks TLS ports 'not_configured' when the cert files are unreadable", async () => {
    process.env.SSL_CERTIFICATE = "/fake/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/fake/key.pem";
    sslFilesReadable = false;

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks["imap:993"]).toBe("not_configured");
    expect(mockTlsConnect).not.toHaveBeenCalled();
  });

  it("returns 503 when SSL configured but TLS port fails (regression)", async () => {
    tlsBehavior = "error";

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(false);
    expect(body.body.checks["imap:993"]).toBe("unhealthy");
  });

  it("uses IMAP_PORT env when set", async () => {
    process.env.IMAP_PORT = "21001";

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.checks["imap:21001"]).toBe("ok");
    expect(body.body.checks["imap:143"]).toBeUndefined();
  });

  it("uses SMTPS_PORT / SMTP_SUBMISSION_PORT / IMAP_TLS_PORT env vars when set", async () => {
    process.env.SMTPS_PORT = "9465";
    process.env.SMTP_SUBMISSION_PORT = "9587";
    process.env.IMAP_TLS_PORT = "9993";

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.checks["smtp:9465"]).toBe("ok");
    expect(body.body.checks["smtp:9587"]).toBe("ok");
    expect(body.body.checks["imap:9993"]).toBe("ok");
    // Hardcoded labels should no longer appear when overridden
    expect(body.body.checks["smtp:465"]).toBeUndefined();
    expect(body.body.checks["smtp:587"]).toBeUndefined();
    expect(body.body.checks["imap:993"]).toBeUndefined();
  });

  it("uses configured TLS port labels in 'not_configured' state too", async () => {
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    process.env.SMTPS_PORT = "9465";
    process.env.IMAP_TLS_PORT = "9993";

    const { default: handleHealth } = await import("./health");
    const res = await invokeHealthGet(handleHealth);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.checks["smtp:9465"]).toBe("not_configured");
    expect(body.body.checks["imap:9993"]).toBe("not_configured");
  });
});
