/**
 * Tests for user route handlers: post-login, delete-login, get-login,
 * post-set-info, post-token
 */
import { describe, it, expect, mock, beforeEach, afterAll, spyOn } from "bun:test";
import { restoreLeaves } from "test-helpers";
import * as rateLimit from "../../rate-limit";

// Real read-only helpers — used by post-login/post-set-info/post-token to
// name the reserved username and to construct the remapped session. Mocking
// their values would let the routes compare against `undefined` and the
// guard would be silently inert while tests stayed green.
import {
  ADMIN_USERNAME,
  ADMIN_RO_USERNAME,
  isReservedUsername,
  remapReadOnlySession,
  refuseReadOnly,
} from "../../../read-only";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetUser = mock(async () => null as unknown);
const mockSetUserInfo = mock(async () => null as unknown);
const mockIsValidEmail = mock((_email: string) => true);
const mockCreateToken = mock(async () => ({ id: "u1", username: "alice", token: "tok123" }));
const mockGetSignedUser = mock((_user: unknown) => null as unknown);
const mockCreateAuthenticationMail = mock(() => ({ to: "test@example.com", subject: "auth" }));
const mockSendMail = mock(async () => {});
const mockStartTimer = mock((_id: string) => {});
const mockDeliversToAdminMailbox = mock((_email: string) => false);
const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};
const TEST_VERSION = "1.2.3";

mock.module("server", () => ({
  getUser: mockGetUser,
  setUserInfo: mockSetUserInfo,
  isValidEmail: mockIsValidEmail,
  createToken: mockCreateToken,
  getSignedUser: mockGetSignedUser,
  createAuthenticationMail: mockCreateAuthenticationMail,
  sendMail: mockSendMail,
  startTimer: mockStartTimer,
  logger: mockLogger,
  version: TEST_VERSION,
  // Read-only helpers reach the routes through the barrel; hand the real
  // implementations back so the routes compare against the real constant.
  ADMIN_USERNAME,
  ADMIN_RO_USERNAME,
  isReservedUsername,
  // Stubbed rather than real, unlike its neighbours: the real predicate
  // reaches `addressToUsername` through `./util`, which any earlier file's
  // `mock.module("server", ...)` replaces graph-wide — so a real one here
  // would answer with that file's stub values. What this file tests is the
  // route's wiring in both directions; the predicate's own truth table is
  // covered against the real implementation in read-only.test.ts.
  deliversToAdminMailbox: mockDeliversToAdminMailbox,
  remapReadOnlySession,
  refuseReadOnly,
}));

mock.module("../../../logger", () => ({
  logger: { debug: mock(() => {}), info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
}));

// bcrypt is a real module but we mock it to keep tests fast + deterministic
const mockBcryptCompare = mock(async () => false);
mock.module("bcryptjs", () => ({
  default: { compare: mockBcryptCompare },
  compare: mockBcryptCompare,
}));

afterAll(() => {
  restoreLeaves();
  const realServer = (globalThis as Record<string, unknown>).__REAL_SERVER;
  if (realServer) mock.module("server", () => realServer);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeUser = (username = "alice", id = "u1") => ({
  id,
  username,
  password: "$2b$10$hashedpassword",
  getSigned: () => ({ id, username }),
});

const makeReq = (overrides: Record<string, unknown> = {}) => {
  const sessionData: Record<string, unknown> = { user: null };
  return {
    method: "POST",
    session: {
      ...sessionData,
      regenerate: mock((cb: (err: Error | null) => void) => cb(null)),
      destroy: mock((cb: (err: Error | null) => void) => cb(null)),
    },
    body: {},
    params: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
    ...overrides,
  } as unknown as import("express").Request;
};

const makeRes = () => {
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  res.end = mock(() => res);
  return res as unknown as import("express").Response & { _code: number; _body: unknown };
};

const noopStream = mock(() => {}) as unknown as import("../route").Stream<unknown>;

// ── post-login tests ──────────────────────────────────────────────────────────

describe("postLoginRoute", () => {
  beforeEach(() => {
    mockGetUser.mockClear();
    mockBcryptCompare.mockClear();
  });

  it("returns success and session user on valid credentials", async () => {
    const { postLoginRoute } = await import("./post-login");

    const user = makeUser("alice");
    mockGetUser.mockResolvedValueOnce(user);
    mockBcryptCompare.mockResolvedValueOnce(true);

    const req = makeReq({ body: { username: "alice", password: "secret" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject({ id: "u1", username: "alice" });
    expect((req as unknown as { session: import("express-session").Session & { user: unknown; destroy: ReturnType<typeof mock> } }).session.user).toMatchObject({ id: "u1", username: "alice" });
  });

  it("returns failed when password doesn't match", async () => {
    const { postLoginRoute } = await import("./post-login");

    const user = makeUser("alice");
    mockGetUser.mockResolvedValueOnce(user);
    mockBcryptCompare.mockResolvedValueOnce(false);

    const req = makeReq({ body: { username: "alice", password: "wrong" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("Invalid credentials");
  });

  it("remaps admin-ro credentials to admin's identity with isReadOnly attribution", async () => {
    // Authenticating with the reserved read-only credential must produce a
    // session whose effective identity is admin (so read paths return
    // admin's data) while `isReadOnly` is set and `authenticatedAs` names
    // the original credential — a compromised admin-ro credential must not
    // read as admin in audit logs.
    const { postLoginRoute } = await import("./post-login");

    const roUser = {
      id: "readonly-id",
      username: ADMIN_RO_USERNAME,
      password: "$2b$10$hashedreadonly",
      email: `${ADMIN_RO_USERNAME}@localhost`,
      getSigned: () => ({
        id: "readonly-id",
        username: ADMIN_RO_USERNAME,
        email: `${ADMIN_RO_USERNAME}@localhost`,
      }),
    };
    const adminUser = {
      id: "admin-id",
      username: "admin",
      password: "$2b$10$hashedadmin",
      email: "admin@localhost",
      getSigned: () => ({
        id: "admin-id",
        username: "admin",
        email: "admin@localhost",
      }),
    };
    // First call: authenticate admin-ro credential. Second: look up admin
    // for the session-scope remap.
    mockGetUser.mockResolvedValueOnce(roUser);
    mockGetUser.mockResolvedValueOnce(adminUser);
    mockBcryptCompare.mockResolvedValueOnce(true);

    const req = makeReq({
      body: { username: ADMIN_RO_USERNAME, password: "correct" },
    });
    const result = await postLoginRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    const body = (result as ApiResponse<Record<string, unknown>>).body!;
    // Effective identity is admin — read paths key off this id.
    expect(body.id).toBe("admin-id");
    expect(body.username).toBe("admin");
    // Read-only attribution is set on the session; audit lines read the
    // original credential from `authenticatedAs`.
    expect(body.isReadOnly).toBe(true);
    expect(body.authenticatedAs).toBe(ADMIN_RO_USERNAME);
    const session = (req as unknown as {
      session: import("express-session").Session & { user: Record<string, unknown> };
    }).session;
    expect(session.user.id).toBe("admin-id");
    expect(session.user.isReadOnly).toBe(true);
    expect(session.user.authenticatedAs).toBe(ADMIN_RO_USERNAME);
  });

  it("refuses admin-ro login when the admin row is missing (no unremapped session)", async () => {
    // If the read-only account exists but admin does not, refusing the
    // session outright is safer than issuing an unremapped session whose
    // reads would return admin-ro's own (empty) inbox. Same-shape response
    // as bad credentials.
    const { postLoginRoute } = await import("./post-login");

    const roUser = {
      id: "readonly-id",
      username: ADMIN_RO_USERNAME,
      password: "$2b$10$hashedreadonly",
      email: `${ADMIN_RO_USERNAME}@localhost`,
      getSigned: () => ({
        id: "readonly-id",
        username: ADMIN_RO_USERNAME,
        email: `${ADMIN_RO_USERNAME}@localhost`,
      }),
    };
    mockGetUser.mockResolvedValueOnce(roUser);
    mockGetUser.mockResolvedValueOnce(null); // admin lookup misses
    mockBcryptCompare.mockResolvedValueOnce(true);
    const recordFailureSpy = spyOn(rateLimit.loginLimiter, "recordFailure");

    const req = makeReq({
      body: { username: ADMIN_RO_USERNAME, password: "correct" },
    });
    const result = await postLoginRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain(
      "Invalid credentials"
    );
    // Session must NOT be issued when the effective identity is missing.
    expect(
      (req as unknown as {
        session: import("express-session").Session & { user: unknown };
      }).session.user
    ).toBeNull();
    expect(recordFailureSpy).toHaveBeenCalledWith("127.0.0.1");
    recordFailureSpy.mockRestore();
  });

  it("returns failed when user doesn't exist (runs dummy hash to prevent timing attacks)", async () => {
    const { postLoginRoute } = await import("./post-login");

    mockGetUser.mockResolvedValueOnce(null);
    // dummy compare is called but always returns false
    mockBcryptCompare.mockResolvedValueOnce(false);

    const req = makeReq({ body: { username: "nobody", password: "anypassword" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
    // bcrypt.compare should still have been called (dummy hash)
    expect(mockBcryptCompare).toHaveBeenCalled();
  });

  it("returns failed when body is missing", async () => {
    const { postLoginRoute } = await import("./post-login");

    const req = makeReq({ body: null });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns failed when body is an array", async () => {
    const { postLoginRoute } = await import("./post-login");

    const req = makeReq({ body: [] });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns failed when password is missing", async () => {
    const { postLoginRoute } = await import("./post-login");

    const req = makeReq({ body: { username: "alice" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns failed when email field is not a string", async () => {
    const { postLoginRoute } = await import("./post-login");

    const req = makeReq({ body: { email: 123, password: "secret" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns failed when username field is not a string", async () => {
    const { postLoginRoute } = await import("./post-login");

    const req = makeReq({ body: { username: {}, password: "secret" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("accepts login with email field instead of username", async () => {
    const { postLoginRoute } = await import("./post-login");

    const user = makeUser("alice");
    mockGetUser.mockResolvedValueOnce(user);
    mockBcryptCompare.mockResolvedValueOnce(true);

    const req = makeReq({ body: { email: "alice@example.com", password: "correct" } });
    const res = makeRes();

    const result = await postLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
  });
});

// ── delete-login tests ────────────────────────────────────────────────────────

describe("deleteLoginRoute", () => {
  it("destroys session and returns success", async () => {
    const { deleteLoginRoute } = await import("./delete-login");

    const req = makeReq({ method: "DELETE" });
    const res = makeRes();

    const result = await deleteLoginRoute.callback(req, res, noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((req as unknown as { session: import("express-session").Session & { user: unknown; destroy: ReturnType<typeof mock> } }).session.destroy).toHaveBeenCalled();
  });

  it("rejects and never answers success when session.destroy calls back with an error", async () => {
    const { deleteLoginRoute } = await import("./delete-login");

    const req = makeReq({ method: "DELETE" });
    (req as unknown as { session: import("express-session").Session & { user: unknown; destroy: ReturnType<typeof mock> } }).session.destroy = mock((cb: (err: Error) => void) => cb(new Error("session store error")));
    const res = makeRes();

    await expect(deleteLoginRoute.callback(req, res, noopStream)).rejects.toThrow(
      "session store error"
    );
  });

  it("waits for the destroy callback before answering", async () => {
    const { deleteLoginRoute } = await import("./delete-login");

    const req = makeReq({ method: "DELETE" });
    let settleDestroy: (() => void) | undefined;
    (req as unknown as { session: { destroy: ReturnType<typeof mock> } }).session.destroy = mock(
      (cb: (err: Error | null) => void) => {
        settleDestroy = () => cb(null);
      }
    );
    const res = makeRes();

    let answered = false;
    const pending = deleteLoginRoute.callback(req, res, noopStream).then((result) => {
      answered = true;
      return result;
    });
    await Promise.resolve();
    expect(answered).toBe(false);

    settleDestroy?.();
    const result = await pending;
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });
});

// ── get-login tests ───────────────────────────────────────────────────────────

describe("getLoginRoute", () => {
  it("returns user and app version when session has user", async () => {
    const { getLoginRoute } = await import("./get-login");
    const req = makeReq({ session: { user: { id: "u1", username: "alice" } } });
    const result = await getLoginRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body.user).toMatchObject({ id: "u1", username: "alice" });
    expect((result as ApiResponse<unknown>).body.app.version).toBe(TEST_VERSION);
  });

  it("returns null user and app version when not logged in", async () => {
    const { getLoginRoute } = await import("./get-login");
    const req = makeReq({ session: {} });
    const result = await getLoginRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body.user).toBeUndefined();
    expect((result as ApiResponse<unknown>).body.app.version).toBe(TEST_VERSION);
    expect((result as ApiResponse<unknown>).message).toMatch(/Not logged in/i);
  });
});

// ── post-set-info tests ───────────────────────────────────────────────────────

describe("postSetInfoRoute", () => {
  beforeEach(() => mockSetUserInfo.mockClear());

  it("returns failed when body is missing", async () => {
    const { postSetInfoRoute } = await import("./post-set-info");
    const req = makeReq({ body: null });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns failed when email is missing", async () => {
    const { postSetInfoRoute } = await import("./post-set-info");
    const req = makeReq({ body: { username: "alice", password: "pass" } });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/email is required/i);
  });

  it("returns failed when username is missing", async () => {
    const { postSetInfoRoute } = await import("./post-set-info");
    const req = makeReq({ body: { email: "a@b.com", password: "pass" } });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/username is required/i);
  });

  it("returns failed when password is missing", async () => {
    const { postSetInfoRoute } = await import("./post-set-info");
    const req = makeReq({ body: { email: "a@b.com", username: "alice" } });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/password is required/i);
  });

  it("returns failed when token is not a string", async () => {
    const { postSetInfoRoute } = await import("./post-set-info");
    const req = makeReq({ body: { email: "a@b.com", username: "alice", password: "pass", token: 123 } });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/token must be a string/i);
  });

  it("sets session user and returns success with valid data", async () => {
    const { postSetInfoRoute } = await import("./post-set-info");
    const maskedUser = { id: "u1", username: "alice", email: "a@b.com" };
    // First getUser call is the read-only pre-gate (no existing row).
    mockGetUser.mockResolvedValueOnce(null);
    mockSetUserInfo.mockResolvedValueOnce(maskedUser as Awaited<ReturnType<typeof mockSetUserInfo>>);
    const req = makeReq({ body: { email: "a@b.com", username: "alice", password: "pass" } });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(maskedUser);
    expect((req as unknown as { session: import("express-session").Session & { user: unknown; destroy: ReturnType<typeof mock> } }).session.user).toEqual(maskedUser);
  });

  it("refuses the read-only identity BEFORE setUserInfo (no DB mutation)", async () => {
    // setUserInfo unconditionally re-hashes the password on the existing
    // row, so a post-call check would leave admin-ro's row already mutated.
    // The gate is a pre-lookup on email; a match on the reserved username
    // refuses same-shape as bad credentials.
    const { postSetInfoRoute } = await import("./post-set-info");
    mockSetUserInfo.mockClear();
    mockGetUser.mockResolvedValueOnce({
      id: "readonly-id",
      username: ADMIN_RO_USERNAME,
      email: `${ADMIN_RO_USERNAME}@localhost`,
    });
    const req = makeReq({
      body: {
        email: `${ADMIN_RO_USERNAME}@localhost`,
        username: ADMIN_RO_USERNAME,
        password: "any",
      },
    });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain(
      "Invalid credentials"
    );
    // Load-bearing: proves the gate fires BEFORE the DB-mutating call.
    expect(mockSetUserInfo).not.toHaveBeenCalled();
  });

  it("refuses the admin address BEFORE setUserInfo", async () => {
    // admin's password is upserted from ADMIN_PASSWORD on every boot, so it
    // has no use for the email reset flow. Left open, a caller holding a
    // reset token for admin — mintable from this route's unauthenticated
    // sibling, and readable by any read-only session — takes over the
    // account outright.
    const { postSetInfoRoute } = await import("./post-set-info");
    mockSetUserInfo.mockClear();
    mockGetUser.mockResolvedValueOnce({
      id: "admin-id",
      username: ADMIN_USERNAME,
      email: `${ADMIN_USERNAME}@localhost`,
    });
    const req = makeReq({
      body: {
        email: `${ADMIN_USERNAME}@localhost`,
        username: ADMIN_USERNAME,
        password: "attacker-chosen",
        token: "stolen-token",
      },
    });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockSetUserInfo).not.toHaveBeenCalled();
  });

  it("lets an ordinary address through to setUserInfo", async () => {
    // Mutation-test the gate: a check that refused every username would pass
    // both refusal cases above while breaking every real signup.
    const { postSetInfoRoute } = await import("./post-set-info");
    mockSetUserInfo.mockClear();
    const maskedUser = { id: "u1", username: "alice", email: "a@b.com" };
    mockGetUser.mockResolvedValueOnce({
      id: "u1",
      username: "alice",
      email: "a@b.com",
    });
    mockSetUserInfo.mockResolvedValueOnce(
      maskedUser as Awaited<ReturnType<typeof mockSetUserInfo>>
    );
    const req = makeReq({
      body: { email: "a@b.com", username: "alice", password: "pass" },
    });
    const result = await postSetInfoRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockSetUserInfo).toHaveBeenCalledTimes(1);
  });
});

// ── post-token tests ──────────────────────────────────────────────────────────

describe("postTokenRoute", () => {
  beforeEach(() => {
    mockIsValidEmail.mockClear();
    mockCreateToken.mockClear();
    mockGetUser.mockClear();
    mockSendMail.mockClear();
    mockStartTimer.mockClear();
    mockDeliversToAdminMailbox.mockClear();
  });

  it("returns failed when email is invalid", async () => {
    const { postTokenRoute } = await import("./post-token");
    mockIsValidEmail.mockReturnValueOnce(false);
    const req = makeReq({ body: { email: "notanemail" } });
    const result = await postTokenRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/invalid/i);
  });

  it("sends auth email and returns success for valid email", async () => {
    const { postTokenRoute } = await import("./post-token");
    const adminUser = { id: "admin1", username: "admin" };
    // First getUser call is the read-only pre-gate (no existing row for
    // a brand-new signup).
    mockGetUser.mockResolvedValueOnce(null);
    // Second call is the admin lookup for the outgoing auth mail's `from`.
    mockGetUser.mockResolvedValueOnce(adminUser);
    mockGetSignedUser.mockReturnValueOnce({ id: "admin1", username: "admin" });
    const req = makeReq({ body: { email: "user@example.com" } });
    const result = await postTokenRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockStartTimer).toHaveBeenCalledWith("u1");
  });

  it("refuses the admin-ro address BEFORE createToken (no DB mutation, no timer)", async () => {
    // /token is unauthenticated. Without the gate, an outside caller with
    // just admin-ro's email address triggers createToken (mutates
    // admin-ro's token+expiry) AND startTimer (schedules hard-DELETE).
    // Same-shape as a normal signup send so no probe signal.
    const { postTokenRoute } = await import("./post-token");
    mockCreateToken.mockClear();
    mockStartTimer.mockClear();
    mockSendMail.mockClear();
    mockGetUser.mockResolvedValueOnce({
      id: "readonly-id",
      username: ADMIN_RO_USERNAME,
      email: `${ADMIN_RO_USERNAME}@localhost`,
    });
    const recordFailureSpy = spyOn(rateLimit.tokenLimiter, "recordFailure");
    const req = makeReq({
      body: { email: `${ADMIN_RO_USERNAME}@localhost` },
    });
    const result = await postTokenRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    // Load-bearing — proves the gate fires before every mutation path.
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockStartTimer).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(recordFailureSpy).toHaveBeenCalledWith("127.0.0.1");
    recordFailureSpy.mockRestore();
  });

  it("refuses an address delivered into admin's mailbox BEFORE createToken", async () => {
    // Such an address routes to admin on the receive path, so the magic link
    // would come back stored under admin's user_id — where a read-only session
    // reads it and can then claim the account the token belongs to.
    const { postTokenRoute } = await import("./post-token");
    mockCreateToken.mockClear();
    mockStartTimer.mockClear();
    mockSendMail.mockClear();
    // No existing row: the address does not have to belong to a user, since
    // createToken's other branch mints one for any valid address.
    mockGetUser.mockResolvedValueOnce(null);
    mockDeliversToAdminMailbox.mockReturnValueOnce(true);
    const req = makeReq({ body: { email: "victim@served-domain.test" } });
    const result = await postTokenRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockDeliversToAdminMailbox).toHaveBeenCalledWith(
      "victim@served-domain.test"
    );
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockStartTimer).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("sends the magic link with no Sent record under the sending identity", async () => {
    // The body carries a live token and the sender is admin, whose mailbox
    // the read-only role reads — so the Sent copy must never be written.
    const { postTokenRoute } = await import("./post-token");
    mockGetUser.mockResolvedValueOnce(null);
    mockGetUser.mockResolvedValueOnce({ id: "admin1", username: "admin" });
    mockGetSignedUser.mockReturnValueOnce({ id: "admin1", username: "admin" });
    const req = makeReq({ body: { email: "user@example.com" } });
    await postTokenRoute.callback(req, makeRes(), noopStream);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][3]).toEqual({ persistToSentMailbox: false });
  });

  it("refuses the admin address BEFORE createToken (no reset token minted)", async () => {
    // The tokens this route writes are readable by any read-only session,
    // which reads admin's mail by design — so minting one for admin is a
    // full write-credential handout to an unauthenticated caller.
    const { postTokenRoute } = await import("./post-token");
    mockCreateToken.mockClear();
    mockStartTimer.mockClear();
    mockSendMail.mockClear();
    mockGetUser.mockResolvedValueOnce({
      id: "admin-id",
      username: ADMIN_USERNAME,
      email: `${ADMIN_USERNAME}@localhost`,
    });
    const req = makeReq({ body: { email: `${ADMIN_USERNAME}@localhost` } });
    const result = await postTokenRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockStartTimer).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe("postTokenRoute body shape", () => {
  beforeEach(() => {
    mockIsValidEmail.mockReset();
    // The suite-wide stub answers `true` for every input, which cannot
    // distinguish a guarded route from an unguarded one. The real
    // `isValidEmail` opens with `email.split("@")`, so mirror that first
    // statement: a non-string argument must blow up here, exactly as it does
    // in production, or these cases pass against a route that never guards.
    mockIsValidEmail.mockImplementation(
      ((email: unknown) => (email as string).split("@").length === 2) as never
    );
    mockCreateToken.mockClear();
    mockGetUser.mockClear();
    mockSendMail.mockClear();
    mockStartTimer.mockClear();
  });

  it("rejects a non-string email instead of throwing on email.split", async () => {
    const { postTokenRoute } = await import("./post-token");

    for (const email of [undefined, null, 123, {}, ["a@b.com"], true]) {
      const req = makeReq({ body: { email } });
      const result = await postTokenRoute.callback(req, makeRes(), noopStream);

      expect((result as ApiResponse<unknown>).status).toBe("failed");
      expect((result as ApiResponse<unknown>).message).toMatch(/invalid/i);
    }

    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockStartTimer).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a plain object", async () => {
    const { postTokenRoute } = await import("./post-token");

    for (const body of [undefined, null, "user@example.com", 7, [{ email: "a@b.com" }]]) {
      const req = makeReq({ body });
      const result = await postTokenRoute.callback(req, makeRes(), noopStream);

      expect((result as ApiResponse<unknown>).status).toBe("failed");
      expect((result as ApiResponse<unknown>).message).toMatch(/invalid/i);
    }

    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("rejects a bodyless request, which express parses as {}", async () => {
    const { postTokenRoute } = await import("./post-token");

    const result = await postTokenRoute.callback(makeReq({ body: {} }), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("still sends the magic link for a well-formed email", async () => {
    const { postTokenRoute } = await import("./post-token");
    // First getUser call is the reserved-account pre-gate — a brand-new
    // signup has no existing row. Second is the admin lookup for the
    // outgoing mail's `from`.
    mockGetUser.mockResolvedValueOnce(null);
    mockGetUser.mockResolvedValueOnce({ id: "admin1", username: "admin" });
    mockGetSignedUser.mockReturnValueOnce({ id: "admin1", username: "admin" });

    const req = makeReq({ body: { email: "user@example.com" } });
    const result = await postTokenRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  // Both rejection branches must consume quota. A bad address already did, and
  // a caller who can be refused without paying for it is the cheaper attack.
  it.each([
    ["a non-object body", "198.51.100.30", "notanobject"],
    ["a non-string email", "198.51.100.31", { email: 123 }]
  ])("counts %s against the IP quota", async (_label, ip, body) => {
    const { postTokenRoute } = await import("./post-token");
    const rateLimit = await import("../../rate-limit");
    rateLimit.tokenLimiter.reset(ip as string);

    const req = makeReq({ body, headers: { "x-real-ip": ip } });

    for (let i = 0; i < 3; i++) {
      const result = await postTokenRoute.callback(req, makeRes(), noopStream);
      expect((result as ApiResponse<unknown>).status).toBe("failed");
    }

    const res = makeRes();
    const next = mock(() => {});
    rateLimit.tokenLimiter.middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe("postLoginRoute + loginLimiter integration (#504)", () => {
  beforeEach(() => {
    mockGetUser.mockClear();
    mockBcryptCompare.mockClear();
  });

  it("records a failure on bad credentials but not on success", async () => {
    const { postLoginRoute } = await import("./post-login");
    const rateLimit = await import("../../rate-limit");
    // Fresh limiter for this IP — reset first.
    rateLimit.loginLimiter.reset("198.51.100.10");

    const req = (body: Record<string, unknown>) =>
      makeReq({ body, headers: { "x-real-ip": "198.51.100.10" } });

    // Five consecutive bad-password attempts should all reach the handler
    // (middleware lets them through; recordFailure bumps the counter).
    mockGetUser.mockResolvedValue(makeUser("alice"));
    mockBcryptCompare.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      const r = await postLoginRoute.callback(req({ username: "alice", password: "wrong" }), makeRes(), noopStream);
      expect((r as ApiResponse<unknown>).status).toBe("failed");
    }

    // Now the middleware should block.
    const blockRes = makeRes();
    const next = mock(() => {});
    rateLimit.loginLimiter.middleware(
      req({ username: "alice", password: "wrong" }),
      blockRes,
      next
    );
    expect((blockRes as unknown as { _code: number })._code).toBe(429);
    expect(next).not.toHaveBeenCalled();

    // A successful login (different IP, fresh counter) resets the counter and
    // does NOT consume a slot.
    rateLimit.loginLimiter.reset("198.51.100.11");
    const successReq = makeReq({
      body: { username: "alice", password: "right" },
      headers: { "x-real-ip": "198.51.100.11" }
    });
    mockGetUser.mockResolvedValueOnce(makeUser("alice"));
    mockBcryptCompare.mockResolvedValueOnce(true);
    const ok = await postLoginRoute.callback(successReq, makeRes(), noopStream);
    expect((ok as ApiResponse<unknown>).status).toBe("success");

    // Now run 10 more successful logins from the same IP — none should
    // burn a slot (the bug was that successes counted).
    for (let i = 0; i < 10; i++) {
      mockGetUser.mockResolvedValueOnce(makeUser("alice"));
      mockBcryptCompare.mockResolvedValueOnce(true);
      const r = await postLoginRoute.callback(successReq, makeRes(), noopStream);
      expect((r as ApiResponse<unknown>).status).toBe("success");
    }

    // The 11th success-path middleware check still passes.
    const finalRes = makeRes();
    const finalNext = mock(() => {});
    rateLimit.loginLimiter.middleware(successReq, finalRes, finalNext);
    expect(finalNext).toHaveBeenCalledTimes(1);
    expect(finalRes.status).not.toHaveBeenCalled();
  });
});

describe("postTokenRoute + tokenLimiter integration (#504)", () => {
  beforeEach(() => {
    mockIsValidEmail.mockReset();
    mockIsValidEmail.mockReturnValue(true);
    mockCreateToken.mockClear();
    mockGetUser.mockClear();
    mockSendMail.mockClear();
    mockStartTimer.mockClear();
  });

  it("does not count thrown server errors against the IP quota", async () => {
    const { postTokenRoute } = await import("./post-token");
    const rateLimit = await import("../../rate-limit");
    rateLimit.tokenLimiter.reset("198.51.100.20");

    const req = makeReq({
      body: { email: "user@example.com" },
      headers: { "x-real-ip": "198.51.100.20" }
    });

    // sendMail rejects → callback throws → recordFailure should NOT run.
    // Answer by lookup key, not call order: the route asks twice per request
    // (reserved-account pre-gate by email, then admin by username) and this
    // case drives five requests through.
    mockGetUser.mockImplementation((async (query: { username?: string }) =>
      query.username === "admin"
        ? { id: "admin1", username: "admin" }
        : null) as never);
    mockGetSignedUser.mockReturnValue({ id: "admin1", username: "admin" });
    mockSendMail.mockRejectedValue(new Error("smtp transient"));

    for (let i = 0; i < 5; i++) {
      await expect(
        postTokenRoute.callback(req, makeRes(), noopStream)
      ).rejects.toThrow();
    }

    // Middleware should still let requests through — server errors did not
    // burn quota.
    const res = makeRes();
    const next = mock(() => {});
    rateLimit.tokenLimiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
