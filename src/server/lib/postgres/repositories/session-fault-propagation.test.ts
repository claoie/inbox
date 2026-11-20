/**
 * A DB fault on the session store's read, write or purge path must reach the
 * caller instead of being reported as a successful, empty, or idempotent
 * outcome. The session store's contract treats a resolved `set` as an
 * affirmative claim that the write landed and a `get` resolving null as an
 * affirmative claim that no such session exists, so a swallowed fault here
 * answers a successful login whose row was never written, or logs a live user
 * out at random.
 *
 * The stub is installed through the pool Proxy's set trap rather than
 * `mock.module("server/lib/postgres/pool", ...)` — same seam as `session-destroy-propagation.test.ts`.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { SignedUser } from "common";
import { pool, resetPool } from "../client";
import {
  PostgresSessionStore,
  purgeSessions,
} from "./sessions";

type Mode = "ok" | "empty" | "throw";

let writeMode: Mode = "ok";
let readMode: Mode = "ok";
let purgeMode: Mode = "ok";
let touchMode: Mode = "ok";
const updateCalls: { sql: string; values: unknown[] }[] = [];
// The user row's password_version the fence reads; "missing" simulates a
// deleted account row, "throw" a lookup fault.
let userVersionMode: number | "missing" | "throw" = 1;
let stampedVersion = 1;
// Whether the stored row was issued by the retired read-only admin login.
let readOnlyRow = false;
const insertValues: unknown[][] = [];

const issuedSql: string[] = [];

const liveUserRow = (password_version: number) => ({
  user_id: USER.id,
  username: USER.username,
  password: "hashed",
  password_version,
  email: USER.email,
  expiry: null,
  token: null,
  updated: new Date().toISOString(),
  is_deleted: false,
  imap_uid_validity: null,
  auth_sub: null,
});

const SESSION_ID = "fault-propagation-session-id";
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;

const USER = new SignedUser({
  id: "11111111-2222-3333-4444-555555555555",
  username: "alice",
  email: "alice@example.com",
});

const liveSessionRow = () => ({
  session_id: SESSION_ID,
  session_user_id: USER.id,
  session_username: USER.username,
  session_email: USER.email,
  session_is_read_only: readOnlyRow ? true : null,
  session_authenticated_as: readOnlyRow ? "admin-ro" : null,
  session_password_version: stampedVersion,
  auth_sid: null,
  auth_refresh_token: null,
  auth_recheck_at: null,
  cookie_original_max_age: WEEK_MS,
  cookie_max_age: WEEK_MS,
  cookie_signed: null,
  cookie_expires: new Date(Date.now() + WEEK_MS).toISOString(),
  cookie_http_only: true,
  cookie_path: "/",
  cookie_domain: null,
  cookie_secure: "false",
  cookie_same_site: '"strict"',
  updated: new Date().toISOString(),
});

const mockQuery = mock(async (sql: string, values: unknown[] = []) => {
  issuedSql.push(sql);
  if (sql.startsWith("INSERT INTO sessions")) {
    insertValues.push(values);
    if (writeMode === "throw") throw new Error("could not serialize session write");
    const rows = writeMode === "empty" ? [] : [liveSessionRow()];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("UPDATE sessions")) {
    updateCalls.push({ sql, values });
    if (touchMode === "throw") throw new Error("could not slide session expiry");
    const rows = touchMode === "empty" ? [] : [{ session_id: SESSION_ID }];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT") && sql.includes("FROM sessions")) {
    if (readMode === "throw") throw new Error("connection terminated unexpectedly");
    const rows = readMode === "empty" ? [] : [liveSessionRow()];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT") && sql.includes("FROM users")) {
    if (userVersionMode === "throw") throw new Error("connection terminated unexpectedly");
    const rows = userVersionMode === "missing" ? [] : [liveUserRow(userVersionMode)];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("DELETE FROM sessions") && sql.includes("cookie_expires")) {
    if (purgeMode === "throw") throw new Error("permission denied for table sessions");
    return { rows: [{ session_id: SESSION_ID }], rowCount: 1 };
  }
  return { rows: [] as unknown[], rowCount: 0 as number | null };
});

const installQueryStub = () => {
  (pool as unknown as { query: typeof mockQuery }).query = mockQuery;
};

resetPool();
installQueryStub();
const store = new PostgresSessionStore();

afterAll(() => {
  resetPool();
});

beforeEach(() => {
  writeMode = "ok";
  readMode = "ok";
  purgeMode = "ok";
  touchMode = "ok";
  updateCalls.length = 0;
  userVersionMode = 1;
  stampedVersion = 1;
  readOnlyRow = false;
  issuedSql.length = 0;
  insertValues.length = 0;
  installQueryStub();
});

const runtimeSession = () =>
  ({
    user: USER,
    cookie: {
      originalMaxAge: WEEK_MS,
      maxAge: WEEK_MS,
      signed: false,
      _expires: new Date(Date.now() + WEEK_MS),
      httpOnly: true,
      path: "/",
      domain: undefined,
      secure: false,
      sameSite: "strict" as const,
    },
  }) as never;

/** Resolves with the error `set` rejected with, or null when it resolved. */
const setResult = (session_id: string) =>
  store.set(session_id, runtimeSession()).then(
    () => null,
    (err: unknown) => err
  );

/** Resolves with the outcome so an error is distinguishable from the
 * affirmative "no such session" answer. */
const getResult = (session_id: string) =>
  store.get(session_id).then(
    (session) => ({ err: null as unknown, session: session ?? null }),
    (err: unknown) => ({ err, session: null })
  );

describe("PostgresSessionStore.set", () => {
  it("rejects when the session write raises", async () => {
    writeMode = "throw";

    const err = await setResult(SESSION_ID);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("could not serialize session write");
  });

  it("resolves when the write lands", async () => {
    const err = await setResult(SESSION_ID);

    expect(err).toBeNull();
  });
});

describe("PostgresSessionStore.touch", () => {
  it("rejects when the expiry write raises", async () => {
    touchMode = "throw";

    const err = await store.touch(SESSION_ID, new Date()).then(
      () => null,
      (error: unknown) => error
    );

    expect((err as Error).message).toContain("could not slide session expiry");
  });

  it("updates only the expiry of the named row and never inserts one", async () => {
    touchMode = "empty";
    const expires = new Date(Date.now() + WEEK_MS);

    await store.touch(SESSION_ID, expires);

    expect(issuedSql.filter((sql) => sql.startsWith("INSERT"))).toEqual([]);
    expect(updateCalls).toHaveLength(1);
    const { sql, values } = updateCalls[0]!;
    const assignments = sql.slice(sql.indexOf(" SET ") + 5, sql.indexOf(" WHERE "));
    expect(assignments.split(", ").map((a) => a.split(" = ")[0]).sort()).toEqual(["cookie_expires", "updated"]);
    expect(values).toEqual([expires.toISOString(), SESSION_ID]);
  });
});

describe("PostgresSessionStore.get", () => {
  it("rejects when the session read raises", async () => {
    readMode = "throw";

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("connection terminated unexpectedly");
    // The rejection must not also carry the affirmative "no such session"
    // answer, which is how the swallow spelled a fault.
    expect(session).toBeFalsy();
  });

  it("resolves null when the row is genuinely absent", async () => {
    readMode = "empty";

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect(session).toBeNull();
  });

  it("resolves the stored session when the row is present", async () => {
    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect((session as { user: SignedUser }).user.id).toBe(USER.id);
  });
});

describe("PostgresSessionStore.get — a session the retired read-only login issued", () => {
  it("is refused and destroyed rather than served as the account it names", async () => {
    // Such a row carries admin's user id. Served, it would hand the
    // read-only login admin's whole account, writes included.
    readOnlyRow = true;

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect(session).toBeNull();
    expect(
      issuedSql.some((sql) => sql.startsWith("DELETE FROM sessions WHERE session_id = $1"))
    ).toBe(true);
  });

  it("is never written by this version", async () => {
    const { session } = await getResult(SESSION_ID);
    await store.set(SESSION_ID, session!);
    const columns = issuedSql.find((sql) => sql.startsWith("INSERT INTO sessions"))!;
    const names = columns.slice(columns.indexOf("(") + 1, columns.indexOf(")")).split(",").map((c) => c.trim());
    const values = insertValues[insertValues.length - 1];
    expect(values[names.indexOf("session_is_read_only")]).toBeNull();
  });
});

describe("PostgresSessionStore.get credential-version fence", () => {
  it("rejects a session stamped behind the user's current password_version and destroys the row", async () => {
    // The revocation fence: the row was minted on generation 1
    // and the credential has since rotated to 2 — a resurrected row, or a
    // session from a login that straddled the rotation.
    userVersionMode = 2;

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect(session).toBeNull();
    // The rejected row is destroyed so it cannot be resurrected again.
    expect(
      issuedSql.some((sql) =>
        sql.startsWith("DELETE FROM sessions WHERE session_id = $1")
      )
    ).toBe(true);
  });

  it("keeps a session stamped at the current version", async () => {
    userVersionMode = 1;

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect((session as { user: SignedUser }).user.id).toBe(USER.id);
  });

  it("rejects a session whose user row is gone and destroys the row", async () => {
    // A deleted account, or a soft-deleted one, which the user read leaves
    // out: the session must not outlive it.
    userVersionMode = "missing";

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect(session).toBeNull();
    expect(
      issuedSql.some((sql) =>
        sql.startsWith("DELETE FROM sessions WHERE session_id = $1")
      )
    ).toBe(true);
  });

  it("reads the user row without soft-deleted accounts", async () => {
    await getResult(SESSION_ID);

    const userRead = issuedSql.find((sql) => sql.includes("FROM users"));
    expect(userRead).toContain("(is_deleted IS NULL OR is_deleted = FALSE)");
  });

  it("a session read back and saved again keeps the version it was stamped with", async () => {
    // Every request re-saves its session.
    userVersionMode = 2;
    stampedVersion = 2;

    const { err, session } = await getResult(SESSION_ID);
    expect(err).toBeNull();
    expect((session as { user: SignedUser }).user.passwordVersion).toBe(2);

    await store.set(SESSION_ID, session as never);
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toContain(2);
    expect(insertValues[0]).not.toContain(1);
  });

  it("rejects when the version lookup raises", async () => {
    // A grant that cannot be proven current is not exercised — but the
    // failure must surface as an error, not as a silent logout.
    userVersionMode = "throw";

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      "connection terminated unexpectedly"
    );
    expect(session).toBeFalsy();
  });
});

describe("purgeSessions", () => {
  it("rejects when the sweep raises", async () => {
    purgeMode = "throw";

    await expect(purgeSessions()).rejects.toThrow("permission denied for table sessions");
  });

  it("resolves the deleted count when the sweep lands", async () => {
    await expect(purgeSessions()).resolves.toBe(1);
  });
});
