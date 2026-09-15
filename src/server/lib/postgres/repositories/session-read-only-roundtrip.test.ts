/**
 * A read-only session's attribution must survive the session store's round
 * trip. `remapReadOnlySession` sets `isReadOnly` / `authenticatedAs` on the
 * login request's session object, but every later request rebuilds the user
 * from the stored row — so a field the store does not persist is gone from
 * request 2 onward, and `refuseReadOnly` (which short-circuits on exactly that
 * field) permits every mutating surface while the effective identity is admin.
 *
 * These tests drive the real `PostgresSessionStore` end to end: `set` writes
 * through a stubbed `pool.query` that captures the persisted columns, and `get`
 * reads that captured row back. The assertion has to be on the rehydrated
 * object — a session built in-process never leaves the request that made it.
 *
 * The stub is installed through the pool Proxy's set trap rather than
 * `mock.module("pg", ...)` — same seam as `session-destroy-propagation.test.ts`.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { SignedUser } from "common";
import { pool, resetPool } from "../client";
import { sessionColumns } from "../models";
import { PostgresSessionStore } from "./sessions";
import { refuseReadOnly, remapReadOnlySession, ADMIN_RO_USERNAME } from "../../read-only";

const SESSION_ID = "read-only-session-id";
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;

const ADMIN = new SignedUser({
  id: "11111111-2222-3333-4444-555555555555",
  username: "admin",
  email: "admin@example.com",
});

/** Columns and values the last INSERT carried, zipped back into a row. */
let persistedRow: Record<string, unknown> | null = null;

const mockQuery = mock(async (sql: string, values: unknown[] = []) => {
  if (sql.startsWith("INSERT INTO sessions")) {
    const [, columnList, placeholderList] =
      sql.match(/^INSERT INTO sessions \(([^)]+)\) VALUES \(([^)]+)\)/) ?? [];
    if (!columnList) throw new Error(`Unexpected upsert SQL: ${sql}`);
    const columns = columnList.split(",").map((column) => column.trim());
    const placeholders = placeholderList.split(",").map((p) => p.trim());

    // Every schema column reads back present: an absent one is NULL in the
    // row, which is what `ALTER TABLE ADD COLUMN` leaves and what the model's
    // type checker demands.
    const row: Record<string, unknown> = Object.fromEntries(
      sessionColumns.map((column) => [column, null])
    );
    row.updated = new Date().toISOString();
    columns.forEach((column, index) => {
      // `updated` is stamped as a SQL literal and consumes no bound parameter.
      const placeholder = placeholders[index];
      if (!placeholder?.startsWith("$")) return;
      row[column] = values[Number(placeholder.slice(1)) - 1] ?? null;
    });

    persistedRow = row;
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("SELECT") && sql.includes("FROM sessions")) {
    const rows = persistedRow ? [persistedRow] : [];
    return { rows, rowCount: rows.length };
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
  persistedRow = null;
  installQueryStub();
});

const runtimeCookie = () => ({
  originalMaxAge: WEEK_MS,
  maxAge: WEEK_MS,
  signed: false,
  _expires: new Date(Date.now() + WEEK_MS),
  httpOnly: true,
  path: "/",
  domain: undefined,
  secure: false,
  sameSite: "strict" as const,
});

const roundTrip = async (user: SignedUser): Promise<SignedUser> => {
  await new Promise<void>((resolve, reject) => {
    store.set(
      SESSION_ID,
      { user, cookie: runtimeCookie() } as never,
      (err) => (err ? reject(err) : resolve())
    );
  });
  return new Promise<SignedUser>((resolve, reject) => {
    store.get(SESSION_ID, (err, session) => {
      if (err) return reject(err);
      if (!session) return reject(new Error("session did not round trip"));
      resolve((session as unknown as { user: SignedUser }).user);
    });
  });
};

describe("read-only attribution across the session store round trip", () => {
  it("rehydrates isReadOnly and authenticatedAs on the next request", async () => {
    const remapped = remapReadOnlySession(ADMIN, ADMIN_RO_USERNAME);

    const rehydrated = await roundTrip(remapped);

    expect(rehydrated.id).toBe(ADMIN.id);
    expect(rehydrated.username).toBe("admin");
    expect(rehydrated.isReadOnly).toBe(true);
    expect(rehydrated.authenticatedAs).toBe(ADMIN_RO_USERNAME);
  });

  it("refuses a mutating surface on the rehydrated session", async () => {
    const rehydrated = await roundTrip(remapReadOnlySession(ADMIN, ADMIN_RO_USERNAME));

    const verdict = refuseReadOnly(rehydrated, "Sending mail");

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.message).toBe(
      `Sending mail not permitted for read-only user (${ADMIN_RO_USERNAME}).`
    );
  });

  it("persists the attribution as its own columns", async () => {
    await roundTrip(remapReadOnlySession(ADMIN, ADMIN_RO_USERNAME));

    expect(persistedRow?.session_is_read_only).toBe(true);
    expect(persistedRow?.session_authenticated_as).toBe(ADMIN_RO_USERNAME);
  });

  it("leaves an ordinary session permitted after the round trip", async () => {
    const rehydrated = await roundTrip(ADMIN);

    expect(rehydrated.isReadOnly).toBeUndefined();
    expect(rehydrated.authenticatedAs).toBeUndefined();
    expect(refuseReadOnly(rehydrated, "Sending mail").ok).toBe(true);
  });

  it("reads a row written before the columns existed as an ordinary session", async () => {
    await roundTrip(ADMIN);
    // An `ALTER TABLE ADD COLUMN` stamps existing rows NULL; that row was
    // never a read-only session, so it must not rehydrate as one.
    persistedRow = { ...persistedRow, session_is_read_only: null, session_authenticated_as: null };

    const rehydrated = await new Promise<SignedUser>((resolve, reject) => {
      store.get(SESSION_ID, (err, session) => {
        if (err) return reject(err);
        resolve((session as unknown as { user: SignedUser }).user);
      });
    });

    expect(rehydrated.isReadOnly).toBeUndefined();
    expect(refuseReadOnly(rehydrated, "Sending mail").ok).toBe(true);
  });
});
