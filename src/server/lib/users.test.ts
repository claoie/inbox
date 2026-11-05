import {
  describe,
  expect,
  it,
  afterEach,
  beforeEach,
  beforeAll,
  afterAll,
  mock,
  spyOn,
} from "bun:test";
import { restoreLeaves } from "test-helpers";
import crypto from "crypto";
import { User } from "common";
import { logger } from "./logger";

// Native mock.module pattern (mirrors budget's repositories/users.test.ts):
// mock the pool driver so the lazy pool in `postgres/client.ts` instantiates this
// FakePool, then run the REAL `users.ts` functions against it. `mockQuery`
// is the single seam every `usersTable` / `pgSearchUser` call funnels through
// (`pool.query`). `afterAll` re-mocks the driver back to the preload's real snapshot
// and `resetPool()` drops the cached FakePool, so the next test file in the
// same `bun test` process starts clean. The logger is spied on, not mocked
// (see below) — a module mock would leak past `afterAll`. No DI.
const mockQuery = mock(
  async (_sql: string, _values?: unknown[]) =>
    ({ rows: [] as unknown[], rowCount: 0 as number | null })
);

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  // client.ts registers `pool.on("error", ...)` at import time — the lazy
  // Proxy instantiates this FakePool on that first access, so `on` must exist.
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("server/lib/postgres/pool", pgMock);

// The logger is spied on, not module-mocked: `mock.module("./logger")` is
// process-global and its `afterAll` re-registration does NOT restore the
// real logger for later files in the same `bun test` process (verified:
// error-handler.test.ts's logging test saw 0 lines after this file ran).
// `spyOn` replaces only the two spied methods on the shared logger object
// and `mockRestore` in `afterAll` puts the originals back, so nothing leaks.
const mockLoggerError = spyOn(logger, "error").mockImplementation(() => {});
const mockLoggerInfo = spyOn(logger, "info").mockImplementation(() => {});

// Import the subjects AND resetPool only after the pool driver mock is
// registered, so `client.ts`'s `import { Pool } from "./pool"` resolves to FakePool.
const {
  getSignedUser,
  isValidEmail,
  createAuthenticationMail,
  getUser,
  getUsers,
  getActiveUsers,
  createToken,
  setUserInfo,
  startTimer,
  reclaimExpiredToken,
  encryptPassword,
  expiryTimer,
} = await import("./users");
const { resetPool } = await import("./postgres/client");
const {
  registerAuthenticatedSession,
  unregisterSession,
} = await import("./imap/session-registry");
const {
  registerSmtpServer,
  unregisterSmtpServer,
} = await import("./smtp-registry");

beforeAll(() => {
  // `mock.module` is process-global: a sibling test file that ran earlier in
  // the same `bun test` process may have restored the driver to the real module in
  // its `afterAll(restoreLeaves)` and/or instantiated the lazy pool against the
  // real Pool. Re-assert our driver mock and drop any cached pool right before this
  // file's tests, so every query below hits FakePool — not real Postgres (which
  // is ECONNREFUSED on CI). This is the contract the lazy pool documents.
  mock.module("server/lib/postgres/pool", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  mockLoggerError.mockRestore();
  mockLoggerInfo.mockRestore();
  resetPool();
});

beforeEach(() => {
  // Reset call history AND restore the default (no-rows) resolution, so a
  // call beyond the queued `mockResolvedValueOnce` values still resolves to an
  // empty result instead of `undefined`. resetPool() guarantees the next query
  // rebuilds against FakePool regardless of cross-file mock leakage.
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  resetPool();
});

// A full users-table row. UserModel's constructor validates EVERY column via
// its typeChecker, so a partial row would throw ModelValidationError before
// `toUser()` runs. Override only what a given test cares about.
const makeUserRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u-1",
  username: "alice",
  password: "hashed",
  password_version: 1,
  email: "alice@example.com",
  expiry: null,
  token: null,
  updated: null,
  is_deleted: false,
  imap_uid_validity: null,
  ...overrides,
});

const rows = (...r: Record<string, unknown>[]) => ({
  rows: r,
  rowCount: r.length,
});

describe("Token generation security", () => {
  it("uses cryptographically secure random bytes", () => {
    const token = crypto.randomBytes(32).toString("hex");
    expect(token.length).toBe(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = crypto.randomBytes(32).toString("hex");
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
    expect(tokens.size).toBe(100);
  });

  it("has sufficient entropy (256 bits)", () => {
    const bytes = crypto.randomBytes(32);
    expect(bytes.length).toBe(32);
  });
});

describe("getSignedUser", () => {
  it("returns undefined when user is undefined", () => {
    expect(getSignedUser(undefined)).toBeUndefined();
  });

  it("returns undefined when id is missing", () => {
    const user = new User({
      username: "alice",
      email: "alice@example.com",
      password: "hash",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns undefined when username is missing", () => {
    const user = new User({
      id: "u1",
      email: "alice@example.com",
      password: "hash",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns undefined when email is missing", () => {
    const user = new User({
      id: "u1",
      username: "alice",
      password: "hash",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns undefined when password is missing", () => {
    const user = new User({
      id: "u1",
      username: "alice",
      email: "alice@example.com",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns the user when all required fields are present", () => {
    const user = new User({
      id: "u1",
      username: "alice",
      email: "alice@example.com",
      password: "hash",
    });
    expect(getSignedUser(user)).toBe(user);
  });
});

describe("isValidEmail", () => {
  it("accepts a simple address", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("accepts plus addressing", () => {
    expect(isValidEmail("user+tag@example.com")).toBe(true);
  });

  it("accepts dots, underscores, hyphens, and percent in local part", () => {
    expect(isValidEmail("a.b_c-d%e@example.com")).toBe(true);
  });

  it("accepts subdomain in domain part", () => {
    expect(isValidEmail("user@mail.example.co.uk")).toBe(true);
  });

  it("accepts hyphenated domain labels", () => {
    expect(isValidEmail("user@my-host.example.com")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isValidEmail("USER@EXAMPLE.COM")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects address without @", () => {
    expect(isValidEmail("userexample.com")).toBe(false);
  });

  it("rejects address with multiple @", () => {
    expect(isValidEmail("user@@example.com")).toBe(false);
    expect(isValidEmail("a@b@example.com")).toBe(false);
  });

  it("rejects domain without a dot", () => {
    expect(isValidEmail("user@localhost")).toBe(false);
  });

  it("rejects empty local part", () => {
    expect(isValidEmail("@example.com")).toBe(false);
  });

  it("rejects empty domain part", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects local part with disallowed characters", () => {
    expect(isValidEmail("user name@example.com")).toBe(false);
    expect(isValidEmail("user!@example.com")).toBe(false);
  });

  it("rejects domain with disallowed characters", () => {
    expect(isValidEmail("user@exa_mple.com")).toBe(false);
    expect(isValidEmail("user@exa mple.com")).toBe(false);
  });
});

describe("createAuthenticationMail", () => {
  const originalHostname = process.env.APP_HOSTNAME;

  afterEach(() => {
    if (originalHostname !== undefined) {
      process.env.APP_HOSTNAME = originalHostname;
    } else {
      delete process.env.APP_HOSTNAME;
    }
  });

  it("returns expected envelope fields", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123");
    expect(mail.sender).toBe("admin");
    expect(mail.senderFullName).toBe("Administrator");
    expect(mail.to).toBe("alice@example.com");
    expect(mail.subject).toBe("Please set your password for Mail");
  });

  it("embeds email and token in confirmation link", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123");
    expect(mail.html).toContain("/set-info/alice@example.com?t=tok123");
  });

  it("appends username when provided", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123", "alice");
    expect(mail.html).toContain("/set-info/alice@example.com?t=tok123&u=alice");
  });

  it("omits username param when not provided", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123");
    expect(mail.html).not.toContain("&u=");
  });
});

describe("getUser", () => {
  it("issues no query and returns undefined when no filter field is set (pgSearchUser short-circuits empty filters)", async () => {
    const result = await getUser({});
    expect(result).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns undefined when no row matches", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    const result = await getUser({ email: "missing@example.com" });
    expect(result).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("maps a found pg row into a common User (user_id → id) with password preserved", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "alice",
          email: "alice@example.com",
          password: "hashed",
        })
      )
    );
    const result = await getUser({ id: "u-1" });
    expect(result).toBeInstanceOf(User);
    expect(result?.id).toBe("u-1");
    expect(result?.username).toBe("alice");
    expect(result?.email).toBe("alice@example.com");
    expect(result?.password).toBe("hashed");
  });

  it("maps password_version onto the user, defaulting null to 1", async () => {
    // Rows that predate the revocation fence's migration read back null;
    // the migration's DEFAULT 1 makes 1 the honest generation for them.
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password_version: null }))
    );
    expect((await getUser({ id: "u-1" }))?.passwordVersion).toBe(1);

    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password_version: 3 }))
    );
    expect((await getUser({ id: "u-1" }))?.passwordVersion).toBe(3);
  });

  it("forwards id/username/email into the SELECT parameter values", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    await getUser({
      id: "u-1",
      username: "alice",
      email: "alice@example.com",
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SELECT");
    expect(values).toEqual(
      expect.arrayContaining(["u-1", "alice", "alice@example.com"])
    );
  });

  it("coerces a null pg email to undefined on the returned User", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ user_id: "u-1", email: null, password: "hashed" }))
    );
    const result = await getUser({ id: "u-1" });
    expect(result?.email).toBeUndefined();
  });
});

describe("getUsers", () => {
  it("returns empty list when input is empty (no DB calls)", async () => {
    const result = await getUsers([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("collects only the users that resolve (drops not-found inputs)", async () => {
    mockQuery
      .mockResolvedValueOnce(rows(makeUserRow({ user_id: "u-1" })))
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(
        rows(makeUserRow({ user_id: "u-3", username: "carol" }))
      );

    const result = await getUsers([
      { id: "u-1" },
      { id: "u-missing" },
      { id: "u-3" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("u-1");
    expect(result[1].id).toBe("u-3");
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

describe("getActiveUsers", () => {
  it("returns SignedUsers for inputs that have all required fields", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "alice",
          email: "alice@example.com",
          password: "hashed",
        })
      )
    );
    const result = await getActiveUsers([{ id: "u-1" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("u-1");
    expect(result[0].email).toBe("alice@example.com");
    expect(result[0].username).toBe("alice");
  });

  it("drops users missing required signed fields (no email)", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ user_id: "u-1", email: null, password: "hashed" }))
    );
    const result = await getActiveUsers([{ id: "u-1" }]);
    expect(result).toEqual([]);
  });

  it("drops users that are not found at all", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    const result = await getActiveUsers([{ id: "u-missing" }]);
    expect(result).toEqual([]);
  });
});

describe("createToken", () => {
  it("issues UPDATE for an existing email, returns the existing user_id and username", async () => {
    mockQuery
      // getUser({ email }) → SELECT returns the existing user
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-existing",
            username: "alice",
            email: "alice@example.com",
            password: "hashed",
          })
        )
      )
      // usersTable.update(...) → UPDATE ... RETURNING user_id
      .mockResolvedValueOnce(rows({ user_id: "u-existing" }));

    const result = await createToken("alice@example.com");
    expect(result.id).toBe("u-existing");
    expect(result.username).toBe("alice");
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [sql, values] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("UPDATE");
    expect(values).toEqual(expect.arrayContaining([result.token, "u-existing"]));
  });

  it("issues INSERT for a new email, returns a UUID id and undefined username", async () => {
    // Both calls return no rows: SELECT finds nothing (→ new), INSERT's
    // return value is unused by createToken's new-account branch.
    const result = await createToken("new@example.com");
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(result.username).toBeUndefined();
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [sql, values] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("INSERT");
    expect(values).toEqual(
      expect.arrayContaining([result.id, "new@example.com", result.token])
    );
    // username defaults to `user_<first 8 of uuid>`
    expect(values.some((v) => typeof v === "string" && /^user_/.test(v))).toBe(
      true
    );
  });

  it("generated tokens are unique across calls", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await createToken(`u${i}@example.com`);
      tokens.add(result.token);
    }
    expect(tokens.size).toBe(5);
  });
});

describe("encryptPassword", () => {
  it("produces a bcrypt hash that verifies against the original password", async () => {
    const hash = await encryptPassword("hunter2");
    expect(typeof hash).toBe("string");
    expect(hash).not.toBe("hunter2");
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(await Bun.password.verify("hunter2", hash)).toBe(true);
    expect(await Bun.password.verify("wrong", hash)).toBe(false);
  });
});

describe("setUserInfo", () => {
  it("throws when email is missing", async () => {
    await expect(
      setUserInfo({ username: "alice", password: "p" })
    ).rejects.toThrow(/input is invalid/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when username is missing", async () => {
    await expect(
      setUserInfo({ email: "a@b.c", password: "p" })
    ).rejects.toThrow(/input is invalid/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when password is missing", async () => {
    await expect(
      setUserInfo({ email: "a@b.c", username: "alice" })
    ).rejects.toThrow(/input is invalid/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when user does not exist", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "p",
        token: "tok",
      })
    ).rejects.toThrow(/user doesn't exist/);
  });

  it("throws (and issues no UPDATE) when token does not match the stored token", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "alice",
          email: "a@b.c",
          password: "hash",
          token: "stored-token",
        })
      )
    );
    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "p",
        token: "wrong-token",
      })
    ).rejects.toThrow(/token doesn't match/);
    // Only the SELECT ran — no UPDATE.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a registered account's expired reset token and clears it", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const expiredRow = makeUserRow({
      user_id: "u-1",
      username: "alice",
      email: "a@b.c",
      password: "hash",
      token: "stale-token",
      expiry: past,
    });
    mockQuery
      .mockResolvedValueOnce(rows(expiredRow))
      .mockResolvedValueOnce(rows(expiredRow))
      .mockResolvedValueOnce(rows({ user_id: "u-1" }));

    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "attacker-choice",
        password: "attacker-password",
        token: "stale-token",
      })
    ).rejects.toThrow(/token is expired/);

    // The stale token is nulled, and no write carries a password hash.
    const updates = mockQuery.mock.calls.filter(([sql]) =>
      /^\s*UPDATE\s+users\s+SET/i.test(sql)
    );
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([null, null, "u-1"]);
    const hashed = mockQuery.mock.calls
      .flatMap(([, values]) => (values as unknown[]) ?? [])
      .find((v) => typeof v === "string" && /^\$2[aby]\$/.test(v));
    expect(hashed).toBeUndefined();
  });

  it("does not delete a registered account whose reset token expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const expiredRow = makeUserRow({
      user_id: "u-1",
      email: "a@b.c",
      password: "hash",
      token: "stale-token",
      expiry: past,
    });
    mockQuery
      .mockResolvedValueOnce(rows(expiredRow))
      .mockResolvedValueOnce(rows(expiredRow))
      .mockResolvedValueOnce(rows({ user_id: "u-1" }));

    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "attacker-choice",
        password: "attacker-password",
        token: "stale-token",
      })
    ).rejects.toThrow(/token is expired/);

    const deletes = mockQuery.mock.calls.filter(([sql]) =>
      /^\s*DELETE\s+FROM\s+users/i.test(sql)
    );
    expect(deletes).toHaveLength(0);
  });

  it("never reaches the expiry gate for an unclaimed sign-up", async () => {
    // `getUser` routes through `toUser`, which rejects a password-less row, so
    // a placeholder cannot get as far as the expiry check. Reclaiming those
    // rows is the timer's job.
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "user_abc12345",
          email: "a@b.c",
          password: null,
          token: "stale-token",
          expiry: new Date(Date.now() - 1000).toISOString(),
        })
      )
    );

    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "p",
        token: "stale-token",
      })
    ).rejects.toThrow(/no password set/);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("updates the row on matching token for a user whose username is already set", async () => {
    // existingUser.username is set → setUserInfo skips the collision check and
    // goes straight to the session eviction + UPDATE with the new password,
    // clearing token+expiry. The existing username wins over input.
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ user_id: "u-1", password_version: 2 }));

    await setUserInfo({
      email: "a@b.c",
      username: "ignored-because-already-set",
      password: "newpw",
      token: "tok",
    });

    expect(mockQuery).toHaveBeenCalledTimes(3);
    const [sql, values] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("UPDATE");
    // existing username wins; token + expiry cleared to null; password hashed.
    expect(values).toContain("alice");
    expect(values).toContain(null);
    expect(values).toContain("u-1");
    const hashed = values.find(
      (v) => typeof v === "string" && /^\$2[aby]\$/.test(v)
    );
    expect(hashed).toBeDefined();
    expect(values).not.toContain("newpw");
  });

  it("bumps password_version atomically in the same UPDATE that writes the new hash", async () => {
    // The revocation fence: the generation bump and the hash
    // write are one UPDATE, so no interleaving can land a new hash on the
    // old generation. The bump is computed by the database
    // (`COALESCE(password_version, 1) + 1`), not read-modify-written in
    // JS: two concurrent rotations must not both write N+1. A mutant that
    // binds a computed version fails the not-toContain(5) assertion.
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hashed",
            password_version: 4,
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ user_id: "u-1", password_version: 5 }));

    await setUserInfo({
      email: "a@b.c",
      username: "alice",
      password: "newpw",
      token: "tok",
    });

    const [sql, values] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("COALESCE(password_version, 1) + 1");
    expect(values).not.toContain(5);
  });

  it("starts the version at 2 for rows that predate the fence and signs the bumped version", async () => {
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hashed",
            password_version: null,
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ user_id: "u-1", password_version: 2 }));

    const signed = await setUserInfo({
      email: "a@b.c",
      username: "alice",
      password: "newpw",
      token: "tok",
    });

    const [sql, values] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("COALESCE(password_version, 1) + 1");
    expect(values).not.toContain(2);
    // The session this signs must carry the bumped generation the UPDATE
    // returned: updateSession stamps it onto the row, and a pre-bump stamp
    // would fail the fence on its first comparison after issuance.
    expect(signed.passwordVersion).toBe(2);
  });

  it("deletes the user's sessions before it writes the new password", async () => {
    // Ordering is the assertion, not just presence: a DELETE issued after the
    // UPDATE would leave a failed eviction on a row whose token is already
    // spent, so the caller could neither retry the reset nor trust it.
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows({ session_id: "s-1" }, { session_id: "s-2" }))
      .mockResolvedValueOnce(rows({ user_id: "u-1", password_version: 2 }));

    await setUserInfo({
      email: "a@b.c",
      username: "alice",
      password: "newpw",
      token: "tok",
    });

    const [deleteSql, deleteValues] = mockQuery.mock.calls[1] as [
      string,
      unknown[]
    ];
    expect(deleteSql).toContain("DELETE FROM sessions");
    expect(deleteSql).toContain("session_user_id");
    expect(deleteValues).toEqual(["u-1"]);

    const [updateSql] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(updateSql).toContain("UPDATE");
  });

  it("returns a signed user that carries no password", async () => {
    // `getSigned` refuses a user with no password, so the returned value is
    // only a SignedUser if the rotated hash reaches it — and the route hands
    // this object to both `req.session.user` and the response body, so the
    // hash must not survive the masking.
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ user_id: "u-1", password_version: 2 }));

    const signed = await setUserInfo({
      email: "a@b.c",
      username: "alice",
      password: "newpw",
      token: "tok",
    });

    expect(signed).toBeDefined();
    expect(signed.id).toBe("u-1");
    expect(signed.passwordVersion).toBe(2);
    expect(signed.username).toBe("alice");
    expect(signed.email).toBe("a@b.c");
    expect(JSON.stringify(signed)).not.toMatch(/\$2[aby]\$/);
    expect(JSON.stringify(signed)).not.toContain("newpw");
  });

  it("tears down the user's live IMAP and SMTP connections", async () => {
    // Both mail surfaces authenticate once per connection, so the HTTP-session
    // delete leaves them untouched. Without this the one control a user has
    // against someone else in the account misses the longest-lived grants.
    const imapClose = mock(() => {});
    const imapSession = {
      write: mock(() => true),
      close: imapClose,
      getAuthenticatedAs: () => "alice",
      getSessionId: () => "s-1",
    } as unknown as Parameters<typeof registerAuthenticatedSession>[0];
    const smtpClose = mock(() => {});
    const smtpConnection = {
      session: { user: "alice" },
      send: mock(() => {}),
      close: smtpClose,
    };
    const smtpServer = {
      connections: new Set([smtpConnection]),
    } as unknown as Parameters<typeof registerSmtpServer>[0];
    registerAuthenticatedSession(imapSession);
    registerSmtpServer(smtpServer);

    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ user_id: "u-1", password_version: 2 }));

    try {
      await setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "newpw",
        token: "tok",
      });

      expect(imapClose).toHaveBeenCalledTimes(1);
      expect(smtpClose).toHaveBeenCalledTimes(1);
    } finally {
      unregisterSession(imapSession);
      unregisterSmtpServer(smtpServer);
    }
  });

  it("leaves live connections alone when the password write fails", async () => {
    // The eviction runs after the UPDATE, so a rotation that never landed does
    // not disconnect clients still holding a credential that is still valid.
    const imapClose = mock(() => {});
    const imapSession = {
      write: mock(() => true),
      close: imapClose,
      getAuthenticatedAs: () => "alice",
      getSessionId: () => "s-1",
    } as unknown as Parameters<typeof registerAuthenticatedSession>[0];
    registerAuthenticatedSession(imapSession);

    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows())
      .mockRejectedValueOnce(new Error("constraint violation"));

    try {
      await expect(
        setUserInfo({
          email: "a@b.c",
          username: "alice",
          password: "newpw",
          token: "tok",
        })
      ).rejects.toThrow("constraint violation");

      expect(imapClose).not.toHaveBeenCalled();
    } finally {
      unregisterSession(imapSession);
    }
  });

  it("rejects without writing the password when the session delete fails", async () => {
    // The eviction is half of the rotation. A swallowed DELETE fault would let
    // the UPDATE land and answer success while every pre-reset session stayed
    // authenticated — the defect this eviction exists to close.
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockRejectedValueOnce(new Error("deadlock detected"));

    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "newpw",
        token: "tok",
      })
    ).rejects.toThrow("deadlock detected");

    // SELECT + the failed DELETE, and nothing after it: the row still holds the
    // old password and a spendable token.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const issued = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(issued.some((sql) => sql.includes("UPDATE"))).toBe(false);
  });
});

describe("startTimer", () => {
  beforeEach(() => {
    for (const k of Object.keys(expiryTimer)) {
      clearTimeout(expiryTimer[k]);
      delete expiryTimer[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(expiryTimer)) {
      clearTimeout(expiryTimer[k]);
      delete expiryTimer[k];
    }
  });

  it("registers a timer keyed by userId", () => {
    startTimer("u-1");
    expect(expiryTimer["u-1"]).toBeDefined();
  });

  it("replaces an existing timer for the same userId (no duplicate fires)", () => {
    startTimer("u-1");
    const firstTimer = expiryTimer["u-1"];
    startTimer("u-1");
    const secondTimer = expiryTimer["u-1"];
    expect(secondTimer).toBeDefined();
    expect(secondTimer).not.toBe(firstTimer);
  });

  it("logs a repository fault instead of rejecting unhandled", async () => {
    mockLoggerError.mockClear();
    const realSetTimeout = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    globalThis.setTimeout = ((callback: () => void) => {
      fire = callback;
      return realSetTimeout(() => {}, 0);
    }) as unknown as typeof globalThis.setTimeout;
    try {
      startTimer("u-1");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    mockQuery.mockRejectedValueOnce(new Error("connection terminated"));
    expect(fire).toBeDefined();
    expect(() => fire!()).not.toThrow();
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    expect(mockLoggerError).toHaveBeenCalled();
  });
});

const deleteStatements = () =>
  mockQuery.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => /^\s*DELETE\s+FROM\s+users/i.test(sql));

const updateStatements = () =>
  mockQuery.mock.calls.filter(([sql]) =>
    /^\s*UPDATE\s+users\s+SET/i.test(sql)
  );

describe("reclaimExpiredToken", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  it("does not delete a registered account whose reset token expired", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password: "hashed", token: "t", expiry: past }))
    );

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(0);
  });

  it("nulls token and expiry on a registered account whose reset token expired", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password: "hashed", token: "stale", expiry: past }))
    );

    await reclaimExpiredToken("u-1");

    const updates = updateStatements();
    expect(updates).toHaveLength(1);
    const [sql, values] = updates[0];
    expect(sql).toMatch(/token = \$\d+/);
    expect(sql).toMatch(/expiry = \$\d+/);
    expect(values).toEqual([null, null, "u-1"]);
  });

  it("leaves a registered account alone while its reset token is live", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password: "hashed", token: "live", expiry: future }))
    );

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(0);
    expect(updateStatements()).toHaveLength(0);
  });

  it("deletes an unclaimed sign-up whose window has passed", async () => {
    mockLoggerInfo.mockClear();
    mockQuery
      .mockResolvedValueOnce(
        rows(makeUserRow({ password: null, token: "t", expiry: past }))
      )
      .mockResolvedValueOnce(rows({ user_id: "u-1" }));

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(1);
    expect(mockLoggerInfo).toHaveBeenCalled();
  });

  it("does not report a reclaim when the DELETE itself fails", async () => {
    mockLoggerInfo.mockClear();
    mockLoggerError.mockClear();
    mockQuery
      .mockResolvedValueOnce(
        rows(makeUserRow({ password: null, token: "t", expiry: past }))
      )
      .mockRejectedValueOnce(new Error("canceling statement due to timeout"));

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("does not report a reclaim when the DELETE matches no row", async () => {
    mockLoggerInfo.mockClear();
    mockQuery
      .mockResolvedValueOnce(
        rows(makeUserRow({ password: null, token: "t", expiry: past }))
      )
      .mockResolvedValueOnce(rows());

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(1);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("leaves an unclaimed sign-up that is still inside its window", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password: null, token: "t", expiry: future }))
    );

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(0);
  });

  it("leaves a placeholder that carries no expiry", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password: null, token: null, expiry: null }))
    );

    await reclaimExpiredToken("u-1");

    expect(deleteStatements()).toHaveLength(0);
  });

  it("reads the row without routing through toUser", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ password: null, token: "t", expiry: past }))
    );

    await expect(reclaimExpiredToken("u-1")).resolves.toBeUndefined();
  });
});
