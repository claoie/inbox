/**
 * Tests for mails route handlers:
 *   get-headers, get-accounts, get-body, delete, post-mark,
 *   get-search, get-domain, get-allowlist, post-allowlist,
 *   delete-allowlist, post-send, post-spam-mark, get-attachment
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ApiResponse } from "../route";
import {
  ADMIN_RO_USERNAME,
  refuseReadOnly,
  remapReadOnlySession,
} from "../../../read-only";
import { SignedUser } from "common";

// ── Shared mocks for "server" barrel ─────────────────────────────────────────

const mockGetMailHeaders = mock(async () => []);
const mockGetMailHeadersDelta = mock(async () => ({ as_of: "", headers: [], expunged_ids: [] }));
const mockGetAccounts = mock(async () => ({ received: [], sent: [] }));
const mockGetMailBody = mock(async () => null as unknown);
// Matches the real `deleteMail(): Promise<boolean>` — a stub resolving
// `undefined` could never surface the true/false distinction the route reads.
const mockDeleteMail = mock(async () => true);
const mockMarkRead = mock(async () => true);
const mockMarkSaved = mock(async () => true);
const mockDecrementBadgeCount = mock(async () => {});
const mockAddressToUsername = mock((addr: string) => addr.split("@")[0]);
const mockGetUser = mock(async () => null as unknown);

// New mocks for additional routes
const mockSearchMail = mock(async () => []);
const mockGetDomain = mock(() => "example.com");
const mockGetAllowlistForUser = mock(async () => []);
const mockAddAllowlistEntry = mock(async () => null as unknown);
const mockRemoveAllowlistEntry = mock(async () => false as unknown);
const mockSendMail = mock(async () => {});
const mockMarkSpam = mock(async () => ({ found: false, changed: false }) as unknown);
const mockGetAttachment = mock(() => undefined as unknown);
const mockMailsTableQueryOne = mock(async () => null as unknown);
const AUTH_ERROR_MESSAGE = "Authentication required";

class MockMailValidationError extends Error {}
class MockMailSendingError extends Error {}

mock.module("server", () => ({
  getMailHeaders: mockGetMailHeaders,
  getMailHeadersDelta: mockGetMailHeadersDelta,
  getAccounts: mockGetAccounts,
  getMailBody: mockGetMailBody,
  deleteMail: mockDeleteMail,
  markRead: mockMarkRead,
  markSaved: mockMarkSaved,
  push: {
    decrementBadgeCount: mockDecrementBadgeCount,
    // Other push.* methods are not exercised by mails routes; included so the
    // shared barrel mock is shape-compatible for any test file that lands
    // after this one in Bun's global mock.module hoist order.
    getPushPublicKey: mock(() => "vapid-public-key"),
    storeSubscription: mock(async () => null),
    refreshSubscription: mock(async () => null),
  },
  addressToUsername: mockAddressToUsername,
  getUser: mockGetUser,
  logger: { error: mock(() => {}), info: mock(() => {}), warn: mock(() => {}) },
  searchMail: mockSearchMail,
  getDomain: mockGetDomain,
  getAllowlistForUser: mockGetAllowlistForUser,
  addAllowlistEntry: mockAddAllowlistEntry,
  removeAllowlistEntry: mockRemoveAllowlistEntry,
  sendMail: mockSendMail,
  markSpam: mockMarkSpam,
  getAttachment: mockGetAttachment,
  AUTH_ERROR_MESSAGE,
  MailValidationError: MockMailValidationError,
  MailSendingError: MockMailSendingError,
  mailsTable: { queryOne: mockMailsTableQueryOne },
  SpamAllowlistModel: class {},
  // Users/token route exports
  setUserInfo: mock(async () => null),
  isValidEmail: mock(() => true),
  createToken: mock(async () => ({ id: "u1", username: "u", token: "tok" })),
  getSignedUser: mock(() => null),
  createAuthenticationMail: mock(() => ({})),
  startTimer: mock(() => {}),
  version: "0.0.0",
  // Read-only role attribution — real implementations so guards compare
  // against the real constant. Duplicating the literal here would leave
  // prod's guard comparing to a value this file could rename in isolation.
  ADMIN_RO_USERNAME,
  refuseReadOnly,
  remapReadOnlySession,
}));

// Mock logger used directly in post-mark / post-spam-mark
const mockLoggerError = mock(() => {});
const mockLoggerWarn = mock(() => {});
mock.module("../../../logger", () => ({
  logger: { debug: mock(() => {}), info: mock(() => {}), warn: mockLoggerWarn, error: mockLoggerError },
}));

// Mock deep imports used by post-spam-mark.ts (its trainWithEmail + getMailById
// reach into specific server submodules, not the "server" barrel).
const mockGetMailById = mock(async () => null as unknown);
mock.module("server/lib/postgres/repositories/mails", () => ({
  getMailById: mockGetMailById,
}));

const mockTrainWithEmail = mock(async () => undefined);
mock.module("server/lib/spam/classifier", () => ({
  trainWithEmail: mockTrainWithEmail,
}));

// ── Helper factories ──────────────────────────────────────────────────────────

const makeUser = (username = "alice", id = "u1") => ({ id, username });

const MAIL_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MISSING_ID = "9c8b7a65-4d3e-42f1-8a09-1b2c3d4e5f60";
const OTHER_ID = "5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170";

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    session: { user: makeUser() },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as import("express").Request;

const makeRes = () => {
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  res.send = mock((body: unknown) => { res._body = body; return res; });
  res.write = mock(() => true);
  res.end = mock(() => res);
  return res as unknown as import("express").Response & { _code: number; _body: unknown };
};

const stream = mock(() => {});
const noopStream = stream as unknown as import("../route").Stream<unknown>;

// ── get-headers route ─────────────────────────────────────────────────────────

describe("getHeadersRoute", () => {
  beforeEach(() => {
    mockGetMailHeaders.mockClear();
    mockGetMailHeadersDelta.mockClear();
    mockAddressToUsername.mockClear();
  });

  it("returns success with mail headers for valid user", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    const fakeMails = [{ id: "m1", subject: "Hello" }];
    mockGetMailHeaders.mockResolvedValueOnce(fakeMails as never);

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(fakeMails);
  });

  it("allows admin user to access any account", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockGetMailHeaders.mockResolvedValueOnce([] as never);
    mockAddressToUsername.mockReturnValueOnce("bob");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("admin") },
      params: { account: "bob@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns failed when user tries to access another user's account", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockAddressToUsername.mockReturnValueOnce("charlie");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "charlie@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("passes query options (sent/new/saved) to getMailHeaders", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockGetMailHeaders.mockResolvedValueOnce([]);
    mockAddressToUsername.mockReturnValueOnce("alice");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: { sent: "1", new: "1" },
    });
    const res = makeRes();

    await getHeadersRoute.callback(req, res, noopStream);

    const callArgs = mockGetMailHeaders.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ sent: true, new: true, saved: false });
  });

  it("passes the ?spam= flag to getMailHeaders (per-account spam folder)", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockGetMailHeaders.mockResolvedValueOnce([]);
    mockAddressToUsername.mockReturnValueOnce("alice");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: { spam: "1" },
    });
    const res = makeRes();

    await getHeadersRoute.callback(req, res, noopStream);

    const callArgs = mockGetMailHeaders.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ spam: true, sent: false });
  });

  it("without ?since= falls back to the full-list path (backwards-compat)", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockGetMailHeaders.mockResolvedValueOnce([{ id: "m1" }] as never);
    mockAddressToUsername.mockReturnValueOnce("alice");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockGetMailHeaders).toHaveBeenCalledTimes(1);
    expect(mockGetMailHeadersDelta).not.toHaveBeenCalled();
  });

  it("with a valid ?since= returns the delta shape via getMailHeadersDelta", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    const delta = { as_of: "2024-02-01T00:00:00.000Z", headers: [{ id: "m9" }], expunged_ids: ["x"] };
    mockGetMailHeadersDelta.mockResolvedValueOnce(delta as never);
    mockAddressToUsername.mockReturnValueOnce("alice");

    const since = "2024-01-01T00:00:00.000Z";
    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: { since },
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(delta);
    expect(mockGetMailHeaders).not.toHaveBeenCalled();
    const callArgs = mockGetMailHeadersDelta.mock.calls[0];
    expect(callArgs[3]).toBe(since);
  });

  it("rejects a malformed ?since= at the boundary instead of full-fetching or hitting SQL", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockAddressToUsername.mockReturnValueOnce("alice");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: { since: "not-a-date" },
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockGetMailHeadersDelta).not.toHaveBeenCalled();
    expect(mockGetMailHeaders).not.toHaveBeenCalled();
  });
});

// ── get-accounts route ────────────────────────────────────────────────────────

describe("getAccountsRoute", () => {
  beforeEach(() => mockGetAccounts.mockClear());

  it("returns received and sent accounts", async () => {
    const { getAccountsRoute } = await import("./get-accounts");

    const fakeAccounts = {
      received: [{ address: "alice@example.com" }],
      sent: [{ address: "bob@example.com" }],
    };
    mockGetAccounts.mockResolvedValueOnce(fakeAccounts as never);

    const req = makeReq({ session: { user: makeUser("alice") } });
    const res = makeRes();

    const result = await getAccountsRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject(fakeAccounts);
  });

  it("calls getAccounts with the session user", async () => {
    const { getAccountsRoute } = await import("./get-accounts");

    mockGetAccounts.mockResolvedValueOnce({ received: [], sent: [] } as never);
    const user = makeUser("bob");
    const req = makeReq({ session: { user } });
    const res = makeRes();

    await getAccountsRoute.callback(req, res, noopStream);

    expect(mockGetAccounts).toHaveBeenCalledWith(user);
  });
});

// ── get-body route ────────────────────────────────────────────────────────────

describe("getBodyRoute", () => {
  beforeEach(() => mockGetMailBody.mockClear());

  it("returns mail body when found", async () => {
    const { getBodyRoute } = await import("./get-body");

    const fakeMail = { id: "m1", html: "<p>Hello</p>" };
    mockGetMailBody.mockResolvedValueOnce(fakeMail);

    const req = makeReq({ params: { id: MAIL_ID } });
    const res = makeRes();

    const result = await getBodyRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(fakeMail);
  });

  it("returns failed when mail is not found", async () => {
    const { getBodyRoute } = await import("./get-body");

    mockGetMailBody.mockResolvedValueOnce(null);

    const req = makeReq({ params: { id: MISSING_ID } });
    const res = makeRes();

    const result = await getBodyRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBeTruthy();
  });
});

// ── delete mail route ─────────────────────────────────────────────────────────

describe("deleteMailRoute", () => {
  beforeEach(() => {
    mockGetMailBody.mockClear();
    mockDeleteMail.mockClear();
  });

  it("deletes mail and returns success when mail belongs to user", async () => {
    const { deleteMailRoute } = await import("./delete");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({ method: "DELETE", params: { id: MAIL_ID } });
    const res = makeRes();

    const result = await deleteMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockDeleteMail).toHaveBeenCalledWith("u1", MAIL_ID);
  });

  it("returns failed when mail not found (or belongs to another user)", async () => {
    const { deleteMailRoute } = await import("./delete");

    mockGetMailBody.mockResolvedValueOnce(null);

    const req = makeReq({ method: "DELETE", params: { id: OTHER_ID } });
    const res = makeRes();

    const result = await deleteMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockDeleteMail).not.toHaveBeenCalled();
  });
});

// ── post-mark route ───────────────────────────────────────────────────────────

describe("postMarkMailRoute", () => {
  beforeEach(() => {
    mockGetMailBody.mockClear();
    mockMarkRead.mockClear();
    mockMarkSaved.mockClear();
    mockDecrementBadgeCount.mockClear();
  });

  it("marks mail as read and returns success", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: MAIL_ID, read: true },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkRead).toHaveBeenCalledWith("u1", MAIL_ID);
  });

  it("marks mail as saved when save=true", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: MAIL_ID, save: true },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkSaved).toHaveBeenCalledWith("u1", MAIL_ID, true);
  });

  it("marks mail as unsaved when save=false", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: MAIL_ID, save: false },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkSaved).toHaveBeenCalledWith("u1", MAIL_ID, false);
  });

  it("returns failed when mail not found", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce(null);

    const req = makeReq({
      method: "POST",
      body: { mail_id: MISSING_ID, read: true },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("rejects a body with no mail_id before touching the repository (#790)", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    const req = makeReq({ method: "POST", body: { read: true } });

    const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    // An undefined mail_id is dropped from the SQL predicate at every layer
    // below, so the ownership lookup must not run at all — it would return an
    // arbitrary mail of the caller's and wave the request through.
    expect(mockGetMailBody).not.toHaveBeenCalled();
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockMarkSaved).not.toHaveBeenCalled();
  });

  it("rejects save=true / save=false with no mail_id (#790)", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    for (const save of [true, false]) {
      mockGetMailBody.mockClear();
      mockMarkSaved.mockClear();

      const req = makeReq({ method: "POST", body: { save } });
      const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

      expect((result as ApiResponse<unknown>).status).toBe("failed");
      expect(mockGetMailBody).not.toHaveBeenCalled();
      expect(mockMarkSaved).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-string or empty mail_id (#790)", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    for (const mail_id of [12345, { id: "m1" }, ["m1"], null, ""]) {
      mockGetMailBody.mockClear();

      const req = makeReq({ method: "POST", body: { mail_id, read: true } });
      const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

      expect((result as ApiResponse<unknown>).status).toBe("failed");
      expect(mockGetMailBody).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-object body (#790)", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    for (const body of [undefined, null, "mail_id=m1", 42, ["m1"]]) {
      mockGetMailBody.mockClear();

      const req = makeReq({ method: "POST", body });
      const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

      expect((result as ApiResponse<unknown>).status).toBe("failed");
      expect(mockGetMailBody).not.toHaveBeenCalled();
    }
  });

  it("reports failed when markRead could not write, and leaves the badge alone", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });
    mockMarkRead.mockResolvedValueOnce(false);

    const req = makeReq({ method: "POST", body: { mail_id: MAIL_ID, read: true } });
    const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
    // Decrementing for a mail that stayed unread would desync the badge.
    expect(mockDecrementBadgeCount).not.toHaveBeenCalled();
  });

  it("reports failed when markSaved could not write", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });
    mockMarkSaved.mockResolvedValueOnce(false);

    const req = makeReq({ method: "POST", body: { mail_id: MAIL_ID, save: true } });
    const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns success for a body with a valid mail_id and neither read nor save", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({ method: "POST", body: { mail_id: MAIL_ID } });
    const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockMarkSaved).not.toHaveBeenCalled();
  });

  it("does not call markRead when read is not explicitly true", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: MAIL_ID },
    });
    const res = makeRes();

    await postMarkMailRoute.callback(req, res, noopStream);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("fires push.decrementBadgeCount for the session user when read=true (#511)", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: MAIL_ID, read: true },
    });

    await postMarkMailRoute.callback(req, makeRes(), noopStream);

    expect(mockDecrementBadgeCount).toHaveBeenCalledTimes(1);
    expect(mockDecrementBadgeCount).toHaveBeenCalledWith([
      expect.objectContaining({ id: "u1" }),
    ]);
  });

  it("swallows push.decrementBadgeCount rejection — still marks read + succeeds (#511)", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockLoggerError.mockClear();
    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });
    mockDecrementBadgeCount.mockRejectedValueOnce(new Error("push transient"));

    const req = makeReq({
      method: "POST",
      body: { mail_id: MAIL_ID, read: true },
    });

    const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);

    // markRead still ran — the badge-decrement rejection is logged, not propagated.
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkRead).toHaveBeenCalledWith("u1", MAIL_ID);

    // Give the .catch(logger.error) microtask a chance to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockLoggerError).toHaveBeenCalledTimes(1);

    // Reset for the next iteration.
    mockDecrementBadgeCount.mockReset();
    mockDecrementBadgeCount.mockResolvedValue(undefined);
  });
});

// ── get-search route ──────────────────────────────────────────────────────────

describe("getSearchRoute", () => {
  beforeEach(() => mockSearchMail.mockClear());

  it("returns search results for a given value", async () => {
    const { getSearchRoute } = await import("./get-search");
    const fakeMails = [{ id: "m1", subject: "Test" }];
    mockSearchMail.mockResolvedValueOnce(fakeMails as never);

    const req = makeReq({ params: { value: "Test" }, query: {} });
    const result = await getSearchRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(fakeMails);
    expect(mockSearchMail).toHaveBeenCalledTimes(1);
  });

  it("passes field query param to searchMail", async () => {
    const { getSearchRoute } = await import("./get-search");
    mockSearchMail.mockResolvedValueOnce([]);

    const req = makeReq({ params: { value: "hello" }, query: { field: "subject" } });
    await getSearchRoute.callback(req, makeRes(), noopStream);

    expect(mockSearchMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "hello",
      "subject"
    );
  });

  it("handles percent characters without throwing URIError", async () => {
    const { getSearchRoute } = await import("./get-search");
    mockSearchMail.mockResolvedValueOnce([]);

    const req = makeReq({ params: { value: "100% off" }, query: {} });
    const result = await getSearchRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockSearchMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "100% off",
      undefined
    );
  });
});

// ── get-domain route ──────────────────────────────────────────────────────────

describe("getDomainRoute", () => {
  beforeEach(() => mockGetDomain.mockClear());

  it("returns the configured domain", async () => {
    const { getDomainRoute } = await import("./get-domain");
    const result = await getDomainRoute.callback(makeReq(), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toBe("example.com");
  });
});

// ── get-allowlist route ───────────────────────────────────────────────────────

describe("getSpamAllowlistRoute", () => {
  beforeEach(() => mockGetAllowlistForUser.mockClear());

  it("returns mapped allowlist entries", async () => {
    const { getSpamAllowlistRoute } = await import("./get-allowlist");
    const entries = [
      { allowlist_id: "a1", pattern: "*@spam.com", created_at: "2026-01-01" },
    ];
    mockGetAllowlistForUser.mockResolvedValueOnce(entries as never);

    const result = await getSpamAllowlistRoute.callback(makeReq(), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual([
      { id: "a1", pattern: "*@spam.com", createdAt: "2026-01-01" },
    ]);
  });

  it("returns empty array when no entries", async () => {
    const { getSpamAllowlistRoute } = await import("./get-allowlist");
    mockGetAllowlistForUser.mockResolvedValueOnce([]);

    const result = await getSpamAllowlistRoute.callback(makeReq(), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual([]);
  });
});

// ── post-allowlist route ──────────────────────────────────────────────────────

describe("postSpamAllowlistRoute", () => {
  beforeEach(() => mockAddAllowlistEntry.mockClear());

  it("rejects missing pattern", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    const req = makeReq({ body: {} });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/pattern is required/i);
  });

  it("rejects invalid pattern format", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    const req = makeReq({ body: { pattern: "notavalidemail" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/email address/i);
  });

  it("returns failed when entry already exists (null returned)", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    mockAddAllowlistEntry.mockResolvedValueOnce(null);
    const req = makeReq({ body: { pattern: "*@spam.com" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/already exists/i);
  });

  it("returns success with new entry on exact email pattern", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    mockAddAllowlistEntry.mockResolvedValueOnce({
      allowlist_id: "a2",
      pattern: "bad@spam.com",
      created_at: "2026-04-01",
    });
    const req = makeReq({ body: { pattern: "bad@spam.com" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject({ id: "a2", pattern: "bad@spam.com" });
  });

  it("returns success with domain wildcard pattern", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    mockAddAllowlistEntry.mockResolvedValueOnce({
      allowlist_id: "a3",
      pattern: "*@domain.com",
      created_at: "2026-04-01",
    });
    const req = makeReq({ body: { pattern: "*@domain.com" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject({ pattern: "*@domain.com" });
  });
});

// ── delete-allowlist route ────────────────────────────────────────────────────

describe("deleteSpamAllowlistRoute", () => {
  beforeEach(() => mockRemoveAllowlistEntry.mockClear());

  it("returns failed when entry not found", async () => {
    const { deleteSpamAllowlistRoute } = await import("./delete-allowlist");
    mockRemoveAllowlistEntry.mockResolvedValueOnce(false);
    const req = makeReq({ params: { pattern: "*@spam.com" } });
    const result = await deleteSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/not found/i);
  });

  it("returns success when entry removed", async () => {
    const { deleteSpamAllowlistRoute } = await import("./delete-allowlist");
    mockRemoveAllowlistEntry.mockResolvedValueOnce(true);
    const req = makeReq({ params: { pattern: "*@spam.com" } });
    const result = await deleteSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("handles patterns containing percent chars without throwing", async () => {
    const { deleteSpamAllowlistRoute } = await import("./delete-allowlist");
    mockRemoveAllowlistEntry.mockResolvedValueOnce(true);
    const req = makeReq({ params: { pattern: "100%match@spam.com" } });
    const result = await deleteSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });
});

// ── post-send route ───────────────────────────────────────────────────────────

describe("postSendMailRoute", () => {
  beforeEach(() => mockSendMail.mockClear());

  it("returns success when mail is sent", async () => {
    const { postSendMailRoute } = await import("./post-send");
    mockSendMail.mockResolvedValueOnce(undefined);
    const req = makeReq({
      body: { to: "test@example.com", subject: "Hi", text: "Hello" },
    });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns failed on MailValidationError", async () => {
    const { postSendMailRoute } = await import("./post-send");
    mockSendMail.mockRejectedValueOnce(new MockMailValidationError("bad mail"));
    const req = makeReq({ body: { to: "x@x.com", subject: "s", text: "t" } });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe("bad mail");
  });

  it("returns failed on MailSendingError", async () => {
    const { postSendMailRoute } = await import("./post-send");
    mockSendMail.mockRejectedValueOnce(new MockMailSendingError("send failed"));
    const req = makeReq({ body: { to: "x@x.com", subject: "s", text: "t" } });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe("send failed");
  });

  it("rethrows unknown errors", async () => {
    const { postSendMailRoute } = await import("./post-send");
    const unknownError = new Error("unexpected");
    mockSendMail.mockRejectedValueOnce(unknownError);
    const req = makeReq({ body: { to: "x@x.com", subject: "s", text: "t" } });
    await expect(postSendMailRoute.callback(req, makeRes(), noopStream)).rejects.toThrow("unexpected");
  });
});

// ── post-spam-mark route ──────────────────────────────────────────────────────

describe("postMarkSpamMailRoute", () => {
  beforeEach(() => {
    mockMarkSpam.mockClear();
    mockGetMailById.mockClear();
    mockTrainWithEmail.mockClear();
    mockLoggerWarn.mockClear();
  });

  it("rejects when is_spam is not boolean", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: "yes" } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/boolean/i);
    expect(mockMarkSpam).not.toHaveBeenCalled();
  });

  it("returns failed when mail not found or no permission (cross-user gate)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: false, changed: false });
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/not found/i);
    // markSpam was reached with the session user_id — the ownership gate is at
    // the repo layer; assert it was passed.
    expect(mockMarkSpam).toHaveBeenCalledWith("u1", MAIL_ID, true);
    expect(mockGetMailById).not.toHaveBeenCalled();
    expect(mockTrainWithEmail).not.toHaveBeenCalled();
  });

  it("returns success when spam marked + fires trainWithEmail (#511)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: true });
    mockGetMailById.mockResolvedValueOnce({
      subject: "Win cash now",
      text: "Click here",
      html: "<p>Click here</p>",
      from_address: [{ address: "spammer@evil.example" }],
    });
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    // Wait for the fire-and-forget training pipeline.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockGetMailById).toHaveBeenCalledWith("u1", MAIL_ID);
    expect(mockTrainWithEmail).toHaveBeenCalledTimes(1);
    expect(mockTrainWithEmail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        subject: "Win cash now",
        fromAddress: "spammer@evil.example",
      }),
      true,
    );
  });

  it("returns success when spam unmarked (is_spam false) + train with false (#511)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: true });
    mockGetMailById.mockResolvedValueOnce({
      subject: "Newsletter",
      text: "Updates",
      html: "<p>Updates</p>",
      from_address: [{ address: "news@legit.example" }],
    });
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: false } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockTrainWithEmail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ fromAddress: "news@legit.example" }),
      false,
    );
  });

  it("returns success but skips training when re-marking with the same value (#491)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: false });
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockGetMailById).not.toHaveBeenCalled();
    expect(mockTrainWithEmail).not.toHaveBeenCalled();
  });

  it("does not fire trainWithEmail when getMailById returns null (race) (#511)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: true });
    mockGetMailById.mockResolvedValueOnce(null);
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockGetMailById).toHaveBeenCalledTimes(1);
    expect(mockTrainWithEmail).not.toHaveBeenCalled();
  });

  it("swallows trainWithEmail rejection — response still success, logger.warn fired (#511)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: true });
    mockGetMailById.mockResolvedValueOnce({
      subject: "x",
      text: "y",
      html: "<p>y</p>",
      from_address: [{ address: "a@b.example" }],
    });
    mockTrainWithEmail.mockRejectedValueOnce(new Error("classifier offline"));
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it("handles non-array from_address shape safely (#511)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: true });
    // Some mail rows store from_address as null or an object, not always array.
    mockGetMailById.mockResolvedValueOnce({
      subject: "x",
      text: "y",
      html: "<p>y</p>",
      from_address: null,
    });
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockTrainWithEmail).toHaveBeenCalledTimes(1);
    expect(mockTrainWithEmail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ fromAddress: undefined }),
      true,
    );
  });

  it("handles empty from_address array safely (#511)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ found: true, changed: true });
    mockGetMailById.mockResolvedValueOnce({
      subject: "x",
      text: "y",
      html: "<p>y</p>",
      from_address: [],
    });
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockTrainWithEmail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ fromAddress: undefined }),
      true,
    );
  });
});

// ── get-attachment route ──────────────────────────────────────────────────────

describe("getAttachmentRoute", () => {
  beforeEach(() => {
    mockMailsTableQueryOne.mockClear();
    mockGetAttachment.mockClear();
  });

  it("returns failed with auth error when no session user", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    const req = makeReq({ session: { user: undefined } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe(AUTH_ERROR_MESSAGE);
  });

  it("returns failed when mail not found (IDOR protection)", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    mockMailsTableQueryOne.mockResolvedValueOnce(null);
    const req = makeReq({ params: { id: "att1" } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe("Not found");
  });

  it("returns failed when attachment file missing from disk", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    mockMailsTableQueryOne.mockResolvedValueOnce({ id: "m1" });
    mockGetAttachment.mockReturnValueOnce(undefined);
    const req = makeReq({ params: { id: "att1" } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns attachment buffer when found", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    const fakeBuffer = Buffer.from("file content");
    mockMailsTableQueryOne.mockResolvedValueOnce({ id: "m1" });
    mockGetAttachment.mockReturnValueOnce(fakeBuffer);
    const req = makeReq({ params: { id: "att1" } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect(result).toBe(fakeBuffer);
  });
});

describe("mail routes: a DB fault reaches the route boundary", () => {
  // A DB fault in the repository must propagate to `Route.handler` — swallowing
  // it and returning the same falsy value that means "no row matched" would
  // reach the user as "not found or you don't have permission", an authorization
  // verdict on a mail the user owns. The route boundary logs, alarms and answers
  // 500. These assert the callback rejects rather than resolving to a not-found
  // body.
  beforeEach(() => {
    mockMarkSpam.mockClear();
    mockMarkRead.mockClear();
    mockMarkSaved.mockClear();
    mockGetMailBody.mockClear();
    mockDeleteMail.mockClear();
  });

  it("post-spam-mark propagates instead of answering not-found", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockRejectedValueOnce(new Error("connection terminated"));
    const req = makeReq({ body: { mail_id: MAIL_ID, is_spam: true } });
    await expect(
      postMarkSpamMailRoute.callback(req, makeRes(), noopStream)
    ).rejects.toThrow("connection terminated");
  });

  it("post-mark read propagates instead of answering failed-to-mark", async () => {
    const { postMarkMailRoute } = await import("./post-mark");
    mockGetMailBody.mockResolvedValueOnce({ text: "t", html: "h" });
    mockMarkRead.mockRejectedValueOnce(new Error("connection terminated"));
    const req = makeReq({ body: { mail_id: MAIL_ID, read: true } });
    await expect(
      postMarkMailRoute.callback(req, makeRes(), noopStream)
    ).rejects.toThrow("connection terminated");
  });

  it("post-mark save propagates instead of answering failed-to-update", async () => {
    const { postMarkMailRoute } = await import("./post-mark");
    mockGetMailBody.mockResolvedValueOnce({ text: "t", html: "h" });
    mockMarkSaved.mockRejectedValueOnce(new Error("connection terminated"));
    const req = makeReq({ body: { mail_id: MAIL_ID, save: true } });
    await expect(
      postMarkMailRoute.callback(req, makeRes(), noopStream)
    ).rejects.toThrow("connection terminated");
  });

  it("get-body propagates instead of answering no-email-is-found", async () => {
    const { getBodyRoute } = await import("./get-body");
    mockGetMailBody.mockRejectedValueOnce(new Error("connection terminated"));
    const req = makeReq({ params: { id: MAIL_ID } });
    await expect(
      getBodyRoute.callback(req, makeRes(), noopStream)
    ).rejects.toThrow("connection terminated");
  });

  it("delete propagates instead of answering success for a delete that never landed", async () => {
    const { deleteMailRoute } = await import("./delete");
    mockGetMailBody.mockResolvedValueOnce({ text: "t", html: "h" });
    mockDeleteMail.mockRejectedValueOnce(new Error("connection terminated"));
    const req = makeReq({ params: { id: MAIL_ID } });
    await expect(
      deleteMailRoute.callback(req, makeRes(), noopStream)
    ).rejects.toThrow("connection terminated");
  });
});

describe("mail routes reject a malformed mail_id before it reaches Postgres (#747)", () => {
  // `mails.mail_id` is a uuid column, so Postgres answers a malformed value
  // with a 22P02 error rather than an empty result. Once the repository stopped
  // swallowing errors, an id of the wrong shape — a stale bookmark, an old
  // client's cached id — would have become a 500 plus an alarm page. These pin
  // that the shape check happens first and the repository is never called.
  const BAD_IDS = ["not-a-uuid", "", "123", "'; DROP TABLE mails; --"];

  beforeEach(() => {
    mockGetMailBody.mockClear();
    mockDeleteMail.mockClear();
    mockMarkSpam.mockClear();
    mockMarkRead.mockClear();
  });

  it.each(BAD_IDS)("get-body rejects %p without querying", async (id) => {
    const { getBodyRoute } = await import("./get-body");
    const result = await getBodyRoute.callback(makeReq({ params: { id } }), makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockGetMailBody).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)("delete rejects %p without querying", async (id) => {
    const { deleteMailRoute } = await import("./delete");
    const result = await deleteMailRoute.callback(
      makeReq({ params: { id } }),
      makeRes(),
      noopStream
    );
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockGetMailBody).not.toHaveBeenCalled();
    expect(mockDeleteMail).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)("post-mark rejects %p without querying", async (id) => {
    const { postMarkMailRoute } = await import("./post-mark");
    const result = await postMarkMailRoute.callback(
      makeReq({ body: { mail_id: id, read: true } }),
      makeRes(),
      noopStream
    );
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockGetMailBody).not.toHaveBeenCalled();
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)("post-spam-mark rejects %p without querying", async (id) => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    const result = await postMarkSpamMailRoute.callback(
      makeReq({ body: { mail_id: id, is_spam: true } }),
      makeRes(),
      noopStream
    );
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockMarkSpam).not.toHaveBeenCalled();
  });

  it("a well-formed uuid still reaches the repository", async () => {
    const { getBodyRoute } = await import("./get-body");
    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const result = await getBodyRoute.callback(makeReq({ params: { id } }), makeRes(), noopStream);
    expect(mockGetMailBody).toHaveBeenCalledWith("u1", id);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });
});

// ── read-only guard sweep ─────────────────────────────────────────────────────

describe("read-only guard on mutating mail + push routes", () => {
  const makeReadOnlyUser = () =>
    remapReadOnlySession(
      new SignedUser({ id: "u1", username: "admin", email: "admin@localhost" }),
      ADMIN_RO_USERNAME
    );

  const readOnlyReq = (overrides: Record<string, unknown> = {}) =>
    ({
      method: "POST",
      session: { user: makeReadOnlyUser() },
      params: {},
      query: {},
      body: {},
      ...overrides,
    }) as unknown as import("express").Request;

  beforeEach(() => {
    mockDeleteMail.mockClear();
    mockMarkRead.mockClear();
    mockMarkSaved.mockClear();
    mockSendMail.mockClear();
    mockMarkSpam.mockClear();
    mockAddAllowlistEntry.mockClear();
    mockRemoveAllowlistEntry.mockClear();
  });

  it("post-send refuses a read-only session BEFORE sendMail", async () => {
    // Guard MUST fire before sendMail — otherwise a read-only session
    // could burn one call against the outbound Mailgun quota per attempt.
    const { postSendMailRoute } = await import("./post-send");
    const req = readOnlyReq({
      body: { to: "b@c.com", subject: "hi", html: "" },
    });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect((result as ApiResponse<unknown>).message).toContain(ADMIN_RO_USERNAME);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("post-mark refuses a read-only session BEFORE markRead / markSaved", async () => {
    const { postMarkMailRoute } = await import("./post-mark");
    const req = readOnlyReq({
      body: { mail_id: MAIL_ID, read: true },
    });
    const result = await postMarkMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockMarkSaved).not.toHaveBeenCalled();
  });

  it("post-spam-mark refuses a read-only session BEFORE markSpam", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    const req = readOnlyReq({
      body: { mail_id: MAIL_ID, is_spam: true },
    });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect(mockMarkSpam).not.toHaveBeenCalled();
  });

  it("delete refuses a read-only session BEFORE deleteMail", async () => {
    const { deleteMailRoute } = await import("./delete");
    const req = readOnlyReq({
      method: "DELETE",
      params: { id: MAIL_ID },
    });
    const result = await deleteMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect(mockDeleteMail).not.toHaveBeenCalled();
  });

  it("post-allowlist refuses a read-only session BEFORE addAllowlistEntry", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    const req = readOnlyReq({
      body: { pattern: "user@example.com" },
    });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect(mockAddAllowlistEntry).not.toHaveBeenCalled();
  });

  it("delete-allowlist refuses a read-only session BEFORE removeAllowlistEntry", async () => {
    const { deleteSpamAllowlistRoute } = await import("./delete-allowlist");
    const req = readOnlyReq({
      method: "DELETE",
      params: { pattern: "user@example.com" },
    });
    const result = await deleteSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect(mockRemoveAllowlistEntry).not.toHaveBeenCalled();
  });

  it("post-send allows a non-read-only session (mutation-test the discriminator)", async () => {
    // Mutation-test the discriminator — replacing isReadOnly with any
    // value the code coerces to false must pass the guard. A wrong-sense
    // check (`!isReadOnly` instead of `isReadOnly`) would trip here.
    const { postSendMailRoute } = await import("./post-send");
    const req = ({
      method: "POST",
      session: {
        user: new SignedUser({
          id: "u1",
          username: "admin",
          email: "admin@localhost",
        }),
      },
      params: {},
      query: {},
      body: { to: "b@c.com", subject: "hi", html: "" },
    }) as unknown as import("express").Request;
    await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});
