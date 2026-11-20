import { describe, it, expect, afterAll, afterEach, beforeEach } from "bun:test";
import type { RuntimeSessionType } from "common";

import { resetAlarmState } from "../alarm";
import { signSessionCookie, type SessionStore } from "./session";

const makeReq = (path: string) => ({ method: "GET", path, sessionId: "sid-abc" });

/** A handler response read back as status, content type and parsed body. */
const read = async (response: Response) => {
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    type,
    body: type.includes("application/json") ? (JSON.parse(text) as unknown) : text,
  };
};

const originalConsoleError = console.error;
const originalAlarmWebhook = process.env.DISCORD_ALARM_WEBHOOK;

// Ahead of every test in every suite, not after each test in one: bun
// auto-loads `.env`, and alarm.ts is a no-op only while this is unset. The two
// sink tests set it inside their own bodies, so they run with it present.
beforeEach(() => {
  delete process.env.DISCORD_ALARM_WEBHOOK;
});

// The last sink test leaves it pointing at a sink that is already closed — put
// back what the run started with, or every later file's real `sendAlarm` dials
// that dead port.
afterAll(() => {
  if (originalAlarmWebhook !== undefined) process.env.DISCORD_ALARM_WEBHOOK = originalAlarmWebhook;
  else delete process.env.DISCORD_ALARM_WEBHOOK;
});

afterEach(() => {
  console.error = originalConsoleError;
});

const captureErrorLogs = () => {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return lines;
};

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

describe("errorHandler", () => {
  it("answers /api/* with a 500 JSON error body", async () => {
    const { errorHandler } = await import("./error-handler");

    const res = await read(errorHandler(new Error("connection terminated unexpectedly"), makeReq("/api/mails")));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: "error", message: "Internal server error" });
  });

  // The driver message names the table and column it failed on, and the
  // deployment sets no NODE_ENV — so an environment-gated body would disclose
  // it by default rather than withhold it by default.
  it("keeps the underlying driver message out of the response body", async () => {
    const { errorHandler } = await import("./error-handler");
    const fault = new Error('relation "sessions" does not exist');

    const api = await read(errorHandler(fault, makeReq("/api/mails")));
    const page = await read(errorHandler(fault, makeReq("/")));

    expect([JSON.stringify(api.body), page.body]).toEqual([
      JSON.stringify({ status: "error", message: "Internal server error" }),
      "Internal server error",
    ]);
  });

  it("answers a non-API path with a plain-text 500 rather than JSON", async () => {
    const { errorHandler } = await import("./error-handler");

    const res = await read(errorHandler(new Error("connection terminated unexpectedly"), makeReq("/")));

    expect(res.status).toBe(500);
    expect(res.type).toBe("text/plain; charset=utf-8");
  });

  it("passes through the status a body parser asked for", async () => {
    const { errorHandler } = await import("./error-handler");

    const malformed = await read(errorHandler(badRequest("Unexpected end of JSON input"), makeReq("/api/mails")));
    const tooLarge = await read(
      errorHandler(Object.assign(new Error("request entity too large"), { statusCode: 413 }), makeReq("/api/mails"))
    );

    expect([malformed.status, malformed.body, tooLarge.status, tooLarge.body]).toEqual([
      400,
      { status: "error", message: "Bad Request" },
      413,
      { status: "error", message: "Payload Too Large" },
    ]);
  });

  it("treats a 5xx carried on the error as ours, not as a passthrough", async () => {
    const { errorHandler } = await import("./error-handler");

    const res = await read(errorHandler(Object.assign(new Error("bad gateway"), { status: 502 }), makeReq("/api/mails")));

    expect([res.status, res.body]).toEqual([500, { status: "error", message: "Internal server error" }]);
  });

  it("logs the failing request and its session id", async () => {
    const { errorHandler } = await import("./error-handler");
    const lines = captureErrorLogs();

    errorHandler(new Error("connection terminated unexpectedly"), makeReq("/api/mails"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Unhandled middleware error");
    expect(lines[0]).toContain("sid-abc");
    expect(lines[0]).toContain("/api/mails");
  });

  it("does not log a client error as a server fault", async () => {
    const { errorHandler } = await import("./error-handler");
    const lines = captureErrorLogs();

    errorHandler(badRequest("Unexpected end of JSON input"), makeReq("/api/mails"));

    expect(lines).toEqual([]);
  });
});

/**
 * The properties below cannot be observed on the exported function: that the
 * handler is wired into the pipeline the server actually runs, that a fault
 * raised before any route runs reaches it, and that it alarms. Each one is
 * asserted against the real pipeline, with only the session store swapped out.
 */
const SECRET = "error-handler-test-secret-not-published-0123456789";

const STORED_SESSION = {
  user: { id: "u1", username: "alice", email: "alice@example.com" },
  cookie: {
    originalMaxAge: 604800000,
    _expires: new Date(Date.now() + 604800000 - 86400000),
    httpOnly: true,
    path: "/",
    secure: false,
    sameSite: "strict",
  },
} as unknown as RuntimeSessionType;

/** A store whose reads fail, or — with `failWrites` — whose reads succeed and writes fail. */
class FaultingStore implements SessionStore {
  constructor(private readonly failWrites = false) {}
  get = async () => {
    if (this.failWrites) return STORED_SESSION;
    throw new Error("connection terminated unexpectedly");
  };
  set = async () => {
    if (this.failWrites) throw new Error("could not serialize session write");
  };
  touch = async () => {
    if (this.failWrites) throw new Error("could not serialize session write");
  };
  destroy = async () => {};
}

/** Stands in for the Discord webhook so a real `sendAlarm` is observable. */
const startAlarmSink = async () => {
  const received: Array<Record<string, unknown>> = [];
  let announce: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push((await request.json()) as Record<string, unknown>);
      announce?.();
      return new Response(null, { status: 204 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/hook`,
    received,
    firstPayload: () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no alarm within 2s")), 2000);
        const settle = () => {
          if (!received.length) return;
          clearTimeout(timer);
          resolve(received[0]!);
        };
        announce = settle;
        settle();
      }),
    close: () => server.stop(true),
  };
};

const alarmTitle = (payload: Record<string, unknown>) =>
  String((payload.embeds as Array<{ title?: string }>)[0]?.title ?? "");

const alarmDetail = (payload: Record<string, unknown>) =>
  String((payload.embeds as Array<{ description?: string }>)[0]?.description ?? "");

describe("errorHandler in the assembled app", () => {
  const originalSecret = process.env.SECRET;

  beforeEach(() => {
    process.env.SECRET = SECRET;
    resetAlarmState();
  });

  afterEach(() => {
    if (originalSecret !== undefined) process.env.SECRET = originalSecret;
    else delete process.env.SECRET;
  });

  const call = async (path: string, init?: RequestInit, store = new FaultingStore()) => {
    const { createHttpApp } = await import("./index");
    return createHttpApp(store)(new Request(`http://localhost${path}`, init), "127.0.0.1");
  };

  const faultingCookie = { Cookie: `connect.sid=${encodeURIComponent(signSessionCookie("fault-sid", SECRET))}` };

  it("answers a store fault on /api/* with JSON on the wire", async () => {
    const res = await call("/api/mails", { headers: faultingCookie });

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "error", message: "Internal server error" });
  });

  it("serves a path outside /api without reading the session store", async () => {
    const res = await call("/.well-known/autoconfig/mail/config-v1.1.xml", { headers: faultingCookie });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
  });

  it("raises the alarm for the store fault", async () => {
    const sink = await startAlarmSink();
    process.env.DISCORD_ALARM_WEBHOOK = sink.url;
    try {
      await call("/api/mails", { headers: faultingCookie });
      const payload = await sink.firstPayload();

      expect(alarmTitle(payload)).toContain("Unhandled Middleware Error");
      expect(alarmDetail(payload)).toContain("connection terminated unexpectedly");
    } finally {
      sink.close();
    }
  });

  // The route's answer is already decided when the session is written back,
  // so a failed write is reported without rewriting a complete response.
  it("keeps the route's answer and alarms when the session write fails", async () => {
    const sink = await startAlarmSink();
    process.env.DISCORD_ALARM_WEBHOOK = sink.url;
    try {
      const res = await call("/api/users/login", { headers: faultingCookie }, new FaultingStore(true));
      const body = (await res.json()) as { status: string; body: { user?: { username: string } } };
      expect([res.status, body.status, body.body.user?.username]).toEqual([200, "success", "alice"]);

      const payload = await sink.firstPayload();
      expect(alarmTitle(payload)).toContain("Unhandled Middleware Error");
      expect(alarmDetail(payload)).toContain("could not serialize session write");
    } finally {
      sink.close();
    }
  });

  // Every alarm here shares one cooldown key, so a client error that alarmed
  // would take the bucket and suppress the store fault behind it.
  it("lets a malformed body through as a 400 without spending the alarm", async () => {
    const sink = await startAlarmSink();
    process.env.DISCORD_ALARM_WEBHOOK = sink.url;
    try {
      const malformed = await call("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      });
      expect(malformed.status).toBe(400);

      await call("/api/mails", { headers: faultingCookie });
      const payload = await sink.firstPayload();

      expect(alarmDetail(payload)).toContain("connection terminated unexpectedly");
      expect(sink.received).toHaveLength(1);
    } finally {
      sink.close();
    }
  });

  it("does not disclose a stack trace on a malformed body in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await call("/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      });
      const body = await res.text();

      expect(res.status).toBe(400);
      expect([body.includes("SyntaxError"), body.includes("at "), body.includes(".js:")]).toEqual([
        false,
        false,
        false,
      ]);
    } finally {
      if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });
});

describe("serverErrorHandler", () => {
  beforeEach(() => resetAlarmState());

  it("raises the alarm when a file body fails to open after the response was returned", async () => {
    const sink = await startAlarmSink();
    process.env.DISCORD_ALARM_WEBHOOK = sink.url;
    const logs = captureErrorLogs();
    const { serverErrorHandler } = await import("./error-handler");
    const { sendFile } = await import("./respond");
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        sendFile(Bun.file("./attachments/server-error-handler-never-written"), {
          contentType: "application/octet-stream",
        }),
      error: serverErrorHandler,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal server error");
      const payload = await sink.firstPayload();
      expect(alarmTitle(payload)).toContain("Unhandled HTTP Server Error");
      expect(alarmDetail(payload)).toContain("ENOENT");
      expect(logs.some((line) => line.includes("Unhandled HTTP server error"))).toBe(true);
    } finally {
      server.stop(true);
      sink.close();
    }
  });
});
