import { describe, it, expect } from "bun:test";
import type { RuntimeSessionType, SignedUser } from "common";

import {
  HttpSession,
  SESSION_RENEW_INTERVAL_MS,
  readCookie,
  signSessionCookie,
  unsignSessionCookie,
  type SessionStore,
} from "./session";

/**
 * A `Set-Cookie` value in the express-session scheme — signed by
 * `cookie-signature` and serialized by `cookie` — for session id
 * `CGvM0kigAKJr5ZXzwHgefCOSrOHdv7hS` under {@link GOLDEN_SECRET}.
 */
const GOLDEN_COOKIE =
  "connect.sid=s%3ACGvM0kigAKJr5ZXzwHgefCOSrOHdv7hS.vUwqSDhDpSNRBbBAYeZgDSpOZqKfiIBGts4Rjs8HwqM";
const GOLDEN_SECRET = "<test-only-signing-key>";
const GOLDEN_ID = "CGvM0kigAKJr5ZXzwHgefCOSrOHdv7hS";

const WEEK_MS = 7 * 24 * 3600 * 1000;
const OPTIONS = { secret: "unit-test-secret", secure: false };
const ALICE = { id: "u1", username: "alice", email: "alice@example.com" } as SignedUser;

class MemoryStore implements SessionStore {
  readonly rows = new Map<string, RuntimeSessionType>();
  readonly writes: string[] = [];
  readonly touches: string[] = [];
  get = async (id: string) => this.rows.get(id) ?? null;
  set = async (id: string, session: RuntimeSessionType) => {
    this.writes.push(id);
    this.rows.set(id, session);
  };
  touch = async (id: string, expires: Date) => {
    this.touches.push(id);
    const row = this.rows.get(id);
    if (row) row.cookie._expires = expires;
  };
  destroy = async (id: string) => {
    this.rows.delete(id);
  };
}

const cookieFor = (id: string, secret = OPTIONS.secret) =>
  `connect.sid=${encodeURIComponent(signSessionCookie(id, secret))}`;

const storedSession = (expiresIn = 1000): RuntimeSessionType =>
  ({
    user: ALICE,
    cookie: {
      originalMaxAge: WEEK_MS,
      _expires: new Date(Date.now() + expiresIn),
      httpOnly: true,
      path: "/",
      secure: false,
      sameSite: "strict",
    },
  }) as unknown as RuntimeSessionType;

const noFault = (error: unknown) => {
  throw error;
};

describe("session cookie signature", () => {
  it("verifies a cookie signed with the express-session scheme", () => {
    const value = readCookie(GOLDEN_COOKIE, "connect.sid")!;
    expect(unsignSessionCookie(value, GOLDEN_SECRET)).toBe(GOLDEN_ID);
  });

  it("signs an id in the express-session scheme", () => {
    expect(cookieFor(GOLDEN_ID, GOLDEN_SECRET)).toBe(GOLDEN_COOKIE);
  });

  it("refuses a tampered, unsigned or foreign-key cookie", () => {
    const value = readCookie(GOLDEN_COOKIE, "connect.sid")!;
    expect(unsignSessionCookie(`${value.slice(0, -1)}A`, GOLDEN_SECRET)).toBeUndefined();
    expect(unsignSessionCookie(GOLDEN_ID, GOLDEN_SECRET)).toBeUndefined();
    expect(unsignSessionCookie(value, "another-secret")).toBeUndefined();
  });

  it("reads the first cookie of the name, unquoted and decoded", () => {
    expect(readCookie('a=1; connect.sid="s%3Ax.y"; connect.sid=second', "connect.sid")).toBe("s:x.y");
    expect(readCookie("connect.sid=%E0%A4", "connect.sid")).toBe("%E0%A4");
    expect(readCookie(null, "connect.sid")).toBeUndefined();
  });
});

describe("HttpSession", () => {
  it("neither stores nor sets a cookie for a session nothing touched", async () => {
    const store = new MemoryStore();
    const session = await HttpSession.load(null, store, OPTIONS);

    expect(await session.commit(false, noFault)).toBeUndefined();
    expect(store.writes).toEqual([]);
  });

  it("stores and sets a cookie once a user is attached", async () => {
    const store = new MemoryStore();
    const session = await HttpSession.load(null, store, OPTIONS);
    session.user = ALICE;

    const setCookie = await session.commit(false, noFault);

    expect(setCookie).toStartWith(cookieFor(session.sessionId));
    expect(store.rows.get(session.sessionId)!.user).toEqual(ALICE);
  });

  it("slides a lagging session's expiry alone and re-issues its cookie", async () => {
    const store = new MemoryStore();
    store.rows.set("live", storedSession());
    const session = await HttpSession.load(cookieFor("live"), store, OPTIONS);

    const setCookie = await session.commit(false, noFault);

    expect(session.user).toEqual(ALICE);
    expect(setCookie).toStartWith(`${cookieFor("live")}; Path=/; Expires=`);
    expect([store.touches, store.writes]).toEqual([["live"], []]);
    const expires = store.rows.get("live")!.cookie._expires!.getTime();
    expect(Math.abs(expires - (Date.now() + WEEK_MS))).toBeLessThan(5_000);
  });

  it("writes nothing and sets no cookie for a session renewed within the interval", async () => {
    const store = new MemoryStore();
    const recentlyRenewed = WEEK_MS - SESSION_RENEW_INTERVAL_MS + 60_000;
    store.rows.set("live", storedSession(recentlyRenewed));
    const session = await HttpSession.load(cookieFor("live"), store, OPTIONS);

    expect(await session.commit(false, noFault)).toBeUndefined();
    expect(session.user).toEqual(ALICE);
    expect([store.touches, store.writes]).toEqual([[], []]);
  });

  it("slides a session whose expiry lags just past the interval", async () => {
    const store = new MemoryStore();
    const lagging = WEEK_MS - SESSION_RENEW_INTERVAL_MS - 60_000;
    store.rows.set("live", storedSession(lagging));
    const session = await HttpSession.load(cookieFor("live"), store, OPTIONS);

    expect(await session.commit(false, noFault)).toStartWith(cookieFor("live"));
    expect(store.touches).toEqual(["live"]);
  });

  it("rewrites the whole row when the identity changes on a recently renewed session", async () => {
    const store = new MemoryStore();
    store.rows.set("live", storedSession(WEEK_MS));
    const session = await HttpSession.load(cookieFor("live"), store, OPTIONS);
    session.user = { ...ALICE, username: "alice2" } as SignedUser;

    expect(await session.commit(false, noFault)).toStartWith(cookieFor("live"));
    expect([store.touches, store.writes]).toEqual([[], ["live"]]);
    expect(store.rows.get("live")!.user.username).toBe("alice2");
  });

  it("reports a failed expiry slide and still returns the cookie", async () => {
    const store = new MemoryStore();
    store.rows.set("live", storedSession());
    store.touch = async () => {
      throw new Error("could not slide session expiry");
    };
    const session = await HttpSession.load(cookieFor("live"), store, OPTIONS);
    const faults: unknown[] = [];

    expect(await session.commit(false, (error) => faults.push(error))).toStartWith(cookieFor("live"));
    expect((faults[0] as Error).message).toBe("could not slide session expiry");
  });

  it("starts anonymous under a new id when the cookie names no stored session", async () => {
    const store = new MemoryStore();
    const session = await HttpSession.load(cookieFor("gone"), store, OPTIONS);

    expect(session.user).toBeUndefined();
    expect(session.sessionId).not.toBe("gone");
    expect(await session.commit(false, noFault)).toBeUndefined();
  });

  it("deletes the old row and issues a new id on regenerate", async () => {
    const store = new MemoryStore();
    store.rows.set("planted", storedSession());
    const session = await HttpSession.load(cookieFor("planted"), store, OPTIONS);

    await session.regenerate();
    expect(session.user).toBeUndefined();
    session.user = ALICE;
    const setCookie = await session.commit(false, noFault);

    expect(store.rows.has("planted")).toBe(false);
    expect(session.sessionId).not.toBe("planted");
    expect(setCookie).toStartWith(cookieFor(session.sessionId));
  });

  it("sets no cookie and writes no row after destroy", async () => {
    const store = new MemoryStore();
    store.rows.set("live", storedSession());
    const session = await HttpSession.load(cookieFor("live"), store, OPTIONS);

    await session.destroy();

    expect(await session.commit(false, noFault)).toBeUndefined();
    expect(store.rows.has("live")).toBe(false);
  });

  it("withholds a Secure cookie from a plain-HTTP request but still renews the row", async () => {
    const store = new MemoryStore();
    const session = await HttpSession.load(null, store, { ...OPTIONS, secure: true });
    session.user = ALICE;

    expect(await session.commit(false, noFault)).toBeUndefined();
    expect(store.rows.has(session.sessionId)).toBe(true);
    expect(await session.commit(true, noFault)).toMatch(/; HttpOnly; Secure; SameSite=Strict$/);
  });

  it("reports a failed write and still returns the cookie", async () => {
    const store = new MemoryStore();
    store.set = async () => {
      throw new Error("could not serialize session write");
    };
    const session = await HttpSession.load(null, store, OPTIONS);
    session.user = ALICE;
    const faults: unknown[] = [];

    const setCookie = await session.commit(false, (error) => faults.push(error));

    expect(setCookie).toStartWith(cookieFor(session.sessionId));
    expect((faults[0] as Error).message).toBe("could not serialize session write");
  });

  it("rejects when the store read fails", async () => {
    const store = new MemoryStore();
    store.get = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    await expect(HttpSession.load(cookieFor("live"), store, OPTIONS)).rejects.toThrow(
      "connection terminated unexpectedly"
    );
  });
});
