/**
 * A failed `DELETE FROM sessions` must reach the session store's caller.
 * These tests drive the real `PostgresSessionStore` against a stubbed
 * `pool.query`, so a swallowed delete error fails here rather than surfacing
 * as a logout that answers success while the session row survives.
 *
 * The stub is installed through the pool Proxy's set trap instead of
 * `mock.module("pg", ...)` — the pg module registry is process-global and
 * which `Pool` binding is live depends on test-file order, which differs
 * between platforms.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { pool, resetPool } from "../client";
import { PostgresSessionStore } from "./sessions";

type DeleteMode = "ok" | "nomatch" | "throw";
let deleteMode: DeleteMode = "ok";

const SESSION_ID = "test-session-id";
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;

const liveSessionRow = () => ({
  session_id: SESSION_ID,
  session_user_id: "u1",
  session_username: "alice",
  session_email: "alice@example.com",
  session_is_read_only: null,
  session_authenticated_as: null,
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

const issuedSql: string[] = [];
const isSessionDelete = (sql: string) =>
  sql.startsWith("DELETE FROM sessions WHERE session_id = $1");

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  issuedSql.push(sql);
  if (isSessionDelete(sql)) {
    if (deleteMode === "throw") {
      throw new Error("permission denied for table sessions");
    }
    const rows = deleteMode === "ok" ? [{ session_id: SESSION_ID }] : [];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT") && sql.includes("FROM sessions")) {
    return { rows: [liveSessionRow()], rowCount: 1 };
  }
  return { rows: [] as unknown[], rowCount: 0 as number | null };
});

const installQueryStub = () => {
  // The pool export is a Proxy whose set trap forwards to the live instance,
  // so this shadows `query` on whatever Pool the current module state built.
  (pool as unknown as { query: typeof mockQuery }).query = mockQuery;
};

resetPool();
installQueryStub();
const store = new PostgresSessionStore();

afterAll(() => {
  resetPool();
});

beforeEach(() => {
  deleteMode = "ok";
  issuedSql.length = 0;
  installQueryStub();
});

const destroyResult = (session_id: string) =>
  new Promise<unknown>((resolve) => {
    store.destroy(session_id, (err) => resolve(err ?? null));
  });

const getSession = (session_id: string) =>
  new Promise<{ user: { id: string } } | null>((resolve, reject) => {
    store.get(session_id, (err, session) => {
      if (err) reject(err);
      else resolve((session as { user: { id: string } }) ?? null);
    });
  });

describe("PostgresSessionStore.destroy", () => {
  it("calls back with the error when the session DELETE raises, and the session stays live", async () => {
    deleteMode = "throw";

    const err = await destroyResult(SESSION_ID);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("permission denied");

    // The row survived the failed DELETE: the store must still answer with
    // the live session, not silently assume it is gone.
    const session = await getSession(SESSION_ID);
    expect(session).not.toBeNull();
    expect(session?.user.id).toBe("u1");
  });

  it("calls back null when the row is deleted", async () => {
    const err = await destroyResult(SESSION_ID);
    expect(err).toBeNull();
  });

  it("stays idempotent when no row matches (already-destroyed session)", async () => {
    deleteMode = "nomatch";
    const err = await destroyResult(SESSION_ID);
    expect(err).toBeNull();
  });

  it("still issues the DELETE without a callback and does not reject", async () => {
    deleteMode = "throw";
    await store.destroy(SESSION_ID);
    expect(issuedSql.filter(isSessionDelete).length).toBe(1);
  });
});
