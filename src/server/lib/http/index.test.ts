import { describe, it, expect, afterEach } from "bun:test";
import type { RuntimeSessionType } from "common";

import { createHttpApp } from "./index";
import { DEVELOPMENT_FALLBACK } from "./session-secret";
import { signSessionCookie, type SessionStore } from "./session";

/**
 * The security headers are defined in exactly one place in
 * {@link createHttpApp}. This assertion pins the exact security-header set on
 * a representative response, so a divergent value or a re-added
 * X-XSS-Protection fails loudly here.
 */
const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

const SECURITY_HEADER_NAMES = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "strict-transport-security",
  "x-xss-protection"
] as const;

const originalNodeEnv = process.env.NODE_ENV;
// When the outer environment already provides SECRET it is left untouched;
// the placeholder below is only installed when production boot would
// otherwise refuse, and removed afterwards.
const secretWasSet = process.env.SECRET !== undefined;
const originalEmailDomain = process.env.EMAIL_DOMAIN;
const originalAppHostname = process.env.APP_HOSTNAME;
const restoreEnv = () => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
  if (!secretWasSet) delete process.env.SECRET;
  if (originalEmailDomain !== undefined) process.env.EMAIL_DOMAIN = originalEmailDomain;
  else delete process.env.EMAIL_DOMAIN;
  if (originalAppHostname !== undefined) process.env.APP_HOSTNAME = originalAppHostname;
  else delete process.env.APP_HOSTNAME;
};

/** Session rows by id, standing in for the Postgres store. */
class MemoryStore implements SessionStore {
  readonly rows = new Map<string, RuntimeSessionType>();
  readonly calls: string[] = [];
  get = async (id: string) => {
    this.calls.push(`get ${id}`);
    return this.rows.get(id) ?? null;
  };
  set = async (id: string, session: RuntimeSessionType) => {
    this.calls.push(`set ${id}`);
    this.rows.set(id, session);
  };
  touch = async (id: string, expires: Date) => {
    this.calls.push(`touch ${id}`);
    const row = this.rows.get(id);
    if (row) row.cookie._expires = expires;
  };
  destroy = async (id: string) => {
    this.rows.delete(id);
  };
}

const useMode = (mode: "production" | "development") => {
  if (mode === "production") {
    process.env.NODE_ENV = "production";
    if (!secretWasSet) process.env.SECRET = "<test-only-secret>";
  } else {
    process.env.NODE_ENV = "development";
  }
};

const call = (
  store: SessionStore,
  path: string,
  init?: RequestInit,
  peer = "127.0.0.1"
): Promise<Response> => createHttpApp(store)(new Request(`http://localhost${path}`, init), peer);

const fetchSecurityHeaders = async (
  mode: "production" | "development"
): Promise<{ status: number; headers: Record<string, string> }> => {
  useMode(mode);
  const res = await call(new MemoryStore(), "/.well-known/autoconfig/mail/config-v1.1.xml");
  await res.text();
  const headers: Record<string, string> = {};
  for (const [name, value] of res.headers.entries()) {
    headers[name] = value;
  }
  return { status: res.status, headers };
};

const securityHeadersOf = (
  headers: Record<string, string>
): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    if (headers[name] !== undefined) picked[name] = headers[name]!;
  }
  return picked;
};

describe("createHttpApp security headers", () => {
  afterEach(restoreEnv);

  it("emits exactly the expected security-header set in development", async () => {
    const { status, headers } = await fetchSecurityHeaders("development");

    expect(status).toBe(200);
    expect(securityHeadersOf(headers)).toEqual({
      "content-security-policy": EXPECTED_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin"
      // Strict-Transport-Security is production-only; X-XSS-Protection is
      // intentionally absent — both omissions are part of the assertion.
    });
  });

  it("adds the production-gated HSTS without re-adding X-XSS-Protection", async () => {
    const { status, headers } = await fetchSecurityHeaders("production");

    expect(status).toBe(200);
    expect(securityHeadersOf(headers)).toEqual({
      "content-security-policy": EXPECTED_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "strict-transport-security": "max-age=31536000; includeSubDomains"
    });
    expect(headers["x-xss-protection"]).toBeUndefined();
  });
});

const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/**
 * A store holding one live session, and the cookie that names it. The session
 * was last renewed a day ago, so the next request that reads it slides it.
 */
const seededStore = (mode: "production" | "development") => {
  const store = new MemoryStore();
  store.rows.set("seeded-session-id", {
    user: { id: "u1", username: "alice", email: "alice@example.com" },
    cookie: {
      originalMaxAge: WEEK_MS,
      _expires: new Date(Date.now() + WEEK_MS - DAY_MS),
      httpOnly: true,
      path: "/",
      secure: mode === "production",
      sameSite: "strict",
    },
  } as unknown as RuntimeSessionType);
  const secret = process.env.SECRET?.trim() ? process.env.SECRET : DEVELOPMENT_FALLBACK;
  const cookie = `connect.sid=${encodeURIComponent(signSessionCookie("seeded-session-id", secret))}`;
  return { store, cookie };
};

/**
 * A request carrying a live session's cookie. In production the app trusts
 * loopback proxies and only sends a Secure cookie over a secure request, so
 * the request arrives as the TLS-terminating proxy would forward it unless
 * `forwardedProto` says otherwise.
 */
const fetchSetCookies = async (
  mode: "production" | "development",
  forwardedProto: string | null = mode === "production" ? "https" : null
): Promise<{ setCookies: string[]; store: MemoryStore }> => {
  useMode(mode);
  const { store, cookie } = seededStore(mode);
  const headers: Record<string, string> = { Cookie: cookie };
  if (forwardedProto) headers["X-Forwarded-Proto"] = forwardedProto;
  const res = await call(store, "/api/users/login", { headers });
  await res.text();
  expect(res.status).toBe(200);
  return { setCookies: res.headers.getSetCookie(), store };
};

const expiresIn = (setCookie: string) => {
  const expires = /Expires=([^;]+)/.exec(setCookie)?.[1];
  expect(expires).toBeDefined();
  return new Date(expires!).getTime() - Date.now();
};

describe("createHttpApp session cookie", () => {
  afterEach(restoreEnv);

  it("marks the session cookie Secure in production", async () => {
    const { setCookies } = await fetchSetCookies("production");
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatch(/\bSecure\b/);
  });

  it("withholds the Secure cookie from a request that did not arrive over HTTPS", async () => {
    const { setCookies, store } = await fetchSetCookies("production", null);
    expect(setCookies).toHaveLength(0);
    // The session itself is still renewed in the store.
    expect(store.rows.get("seeded-session-id")!.cookie._expires!.getTime()).toBeGreaterThan(
      Date.now() + WEEK_MS - 60_000
    );
  });

  it("leaves the session cookie non-Secure in development", async () => {
    const { setCookies } = await fetchSetCookies("development");
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).not.toMatch(/\bSecure\b/);
  });

  it("carries the signed id, Path, HttpOnly, SameSite=Strict and a 7-day Expires", async () => {
    for (const mode of ["production", "development"] as const) {
      const { setCookies } = await fetchSetCookies(mode);
      expect(setCookies).toHaveLength(1);
      expect(setCookies[0]).toMatch(
        /^connect\.sid=s%3Aseeded-session-id\.[A-Za-z0-9%]+; Path=\/; Expires=[^;]+; HttpOnly(; Secure)?; SameSite=Strict$/
      );
      expect(Math.abs(expiresIn(setCookies[0]!) - WEEK_MS)).toBeLessThan(60_000);
    }
  });

  it("re-issues the cookie once per renewal interval, not on every request", async () => {
    useMode("development");
    const { store, cookie } = seededStore("development");
    const setCookies: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(store, "/api/users/login", { headers: { Cookie: cookie } });
      await res.text();
      setCookies.push(res.headers.getSetCookie().length);
      if (i === 0) expect(res.headers.getSetCookie()[0]!.split(";")[0]).toBe(cookie);
    }
    expect(setCookies).toEqual([1, 0, 0]);
    expect(store.calls).toEqual([
      "get seeded-session-id",
      "touch seeded-session-id",
      "get seeded-session-id",
      "get seeded-session-id",
    ]);
  });

  it("leaves the session store alone for the ping, static files, the SPA fallback and a 404", async () => {
    useMode("development");
    const { store, cookie } = seededStore("development");
    const paths = ["/api/ping", "/", "/index.html", "/nope.png", "/assets/missing.js"];
    for (const path of paths) {
      const get = await call(store, path, { headers: { Cookie: cookie } });
      await get.arrayBuffer();
      expect([path, get.headers.getSetCookie()]).toEqual([path, []]);
    }
    const post = await call(store, "/nope", { method: "POST", headers: { Cookie: cookie } });
    await post.arrayBuffer();
    expect(post.status).toBe(404);
    expect(store.calls).toEqual([]);
  });

  it("reads the session on an /api route next to the ping", async () => {
    useMode("development");
    const { store, cookie } = seededStore("development");
    const res = await call(store, "/api/pingx", { headers: { Cookie: cookie } });
    await res.text();
    expect(store.calls[0]).toBe("get seeded-session-id");
  });

  it("sets no cookie for a session that was never touched", async () => {
    useMode("development");
    const res = await call(new MemoryStore(), "/api/ping");
    await res.text();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("ignores a cookie whose signature does not verify", async () => {
    useMode("development");
    const { store, cookie } = seededStore("development");
    const res = await call(store, "/api/users/login", { headers: { Cookie: `${cookie.slice(0, -4)}AAAA` } });
    expect(((await res.json()) as { body: { user?: unknown } }).body.user).toBeUndefined();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

const fetchAutoconfig = async (env: {
  emailDomain: string;
  appHostname?: string;
}): Promise<{ status: number; contentType: string | null; body: string }> => {
  process.env.NODE_ENV = "development";
  process.env.EMAIL_DOMAIN = env.emailDomain;
  if (env.appHostname !== undefined) process.env.APP_HOSTNAME = env.appHostname;
  else delete process.env.APP_HOSTNAME;

  const res = await call(new MemoryStore(), "/.well-known/autoconfig/mail/config-v1.1.xml");
  const body = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), body };
};

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("createHttpApp mail autoconfig", () => {
  afterEach(restoreEnv);

  it("serves the autoconfig document as XML with the APP_HOSTNAME server hostname", async () => {
    const { status, contentType, body } = await fetchAutoconfig({
      emailDomain: "example.com",
      appHostname: "mail.host.example"
    });

    expect(status).toBe(200);
    expect(contentType).toBe("application/xml; charset=utf-8");
    // Both the IMAP and SMTP server entries point at the connectable
    // hostname, while the domain and provider id stay the MX domain.
    expect(countOccurrences(body, "<hostname>mail.host.example</hostname>")).toBe(2);
    expect(body).toContain("<domain>example.com</domain>");
    expect(body).toContain('<emailProvider id="example.com">');
  });

  it("falls back to EMAIL_DOMAIN for the server hostname when APP_HOSTNAME is unset", async () => {
    const { status, contentType, body } = await fetchAutoconfig({
      emailDomain: "example.com"
    });

    expect(status).toBe(200);
    expect(contentType).toBe("application/xml; charset=utf-8");
    expect(countOccurrences(body, "<hostname>example.com</hostname>")).toBe(2);
    expect(body).toContain("<domain>example.com</domain>");
    expect(body).toContain('<emailProvider id="example.com">');
  });
});

describe("createHttpApp boot ordering", () => {
  afterEach(restoreEnv);

  it("resolves the session secret before serving anything: production without SECRET throws", async () => {
    // initializeHttp builds the app via createHttpApp and only then starts
    // the server, so a throw here means the boot-refusal guard fires before
    // the server can listen — the executable form of "secret resolution runs
    // before listen". Bracket notation keeps the env restore out of the secret
    // scanner's literal-assignment heuristic (same pattern as
    // session-secret.test.ts's withEnv).
    const outerSecret = process.env["SECRET"];
    process.env.NODE_ENV = "production";
    delete process.env["SECRET"];
    try {
      expect(() => createHttpApp(new MemoryStore())).toThrow(/SECRET/);
    } finally {
      if (outerSecret !== undefined) process.env["SECRET"] = outerSecret;
      else delete process.env["SECRET"];
    }
  });
});
