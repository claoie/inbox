import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ApiResponse } from "../route";
import { SignedUser } from "common";
import {
  ADMIN_RO_USERNAME,
  refuseReadOnly,
  remapReadOnlySession,
} from "../../../read-only";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetPushPublicKey = mock(() => "test-vapid-public-key");
const mockStoreSubscription = mock(async () => null as unknown);
const mockRefreshSubscription = mock(async () => null as unknown);
const mockDeleteSubscriptionForUser = mock(async () => false as unknown);

// Include base set of server exports so this mock doesn't break test files
// that run after this one (Bun's mock.module is global within a coverage run).
mock.module("server", () => ({
  push: {
    getPushPublicKey: mockGetPushPublicKey,
    storeSubscription: mockStoreSubscription,
    refreshSubscription: mockRefreshSubscription,
    deleteSubscriptionForUser: mockDeleteSubscriptionForUser,
    decrementBadgeCount: mock(async () => {}),
  },
  // Base exports needed by users/mails test files
  getUser: mock(async () => null),
  setUserInfo: mock(async () => null),
  isValidEmail: mock(() => true),
  createToken: mock(async () => ({ id: "u1", username: "u", token: "tok" })),
  getSignedUser: mock(() => null),
  createAuthenticationMail: mock(() => ({})),
  sendMail: mock(async () => {}),
  startTimer: mock(() => {}),
  version: "0.0.0",
  getMailHeaders: mock(async () => []),
  getAccounts: mock(async () => ({ received: [], sent: [] })),
  getMailBody: mock(async () => null),
  deleteMail: mock(async () => {}),
  markRead: mock(async () => {}),
  markSaved: mock(async () => {}),
  addressToUsername: mock((addr: string) => addr.split("@")[0]),
  searchMail: mock(async () => []),
  getDomain: mock(() => "example.com"),
  getAllowlistForUser: mock(async () => []),
  addAllowlistEntry: mock(async () => null),
  removeAllowlistEntry: mock(async () => false),
  markSpam: mock(async () => ({ found: false, changed: false })),
  getAttachment: mock(() => undefined),
  AUTH_ERROR_MESSAGE: "Authentication required",
  MailValidationError: class extends Error {},
  MailSendingError: class extends Error {},
  mailsTable: { queryOne: mock(async () => null) },
  SpamAllowlistModel: class {},
  logger: { error: mock(() => {}), info: mock(() => {}), warn: mock(() => {}) },
  ADMIN_RO_USERNAME,
  refuseReadOnly,
  remapReadOnlySession,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    session: { user: { id: "u1", username: "alice" } },
    params: {},
    body: {},
    ...overrides,
  }) as unknown as import("express").Request;

const makeRes = () => {
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  res.end = mock(() => res);
  return res as unknown as import("express").Response & { _code: number; _body: unknown };
};

const noopStream = mock(() => {}) as unknown as import("../route").Stream<unknown>;

// ── get-public-key ────────────────────────────────────────────────────────────

describe("getPublicKeyRoute", () => {
  beforeEach(() => mockGetPushPublicKey.mockClear());

  it("returns the VAPID public key", async () => {
    const { getPublicKeyRoute } = await import("./get-public-key");
    const result = await getPublicKeyRoute.callback(makeReq(), makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toBe("test-vapid-public-key");
    expect(mockGetPushPublicKey).toHaveBeenCalledTimes(1);
  });
});

// ── get-refresh ───────────────────────────────────────────────────────────────

describe("getRefreshRoute", () => {
  beforeEach(() => mockRefreshSubscription.mockClear());

  it("returns success when subscription is found", async () => {
    const { getRefreshRoute } = await import("./get-refresh");
    mockRefreshSubscription.mockResolvedValueOnce({ _id: "sub1" });
    const req = makeReq({ params: { id: "sub1" } });
    const result = await getRefreshRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns failed when subscription is not found", async () => {
    const { getRefreshRoute } = await import("./get-refresh");
    mockRefreshSubscription.mockResolvedValueOnce(null);
    const req = makeReq({ params: { id: "nonexistent" } });
    const result = await getRefreshRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/No subscription found/i);
  });
});

// ── post-subscribe ────────────────────────────────────────────────────────────

describe("postSubscribeRoute", () => {
  beforeEach(() => mockStoreSubscription.mockClear());

  it("returns success with subscription id when stored", async () => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const fakeSub = { endpoint: "https://fcm.example.com", keys: { p256dh: "abc", auth: "xyz" } };
    mockStoreSubscription.mockResolvedValueOnce({ _id: "sub42" });
    const req = makeReq({ body: { subscription: fakeSub } });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toBe("sub42");
    expect(mockStoreSubscription).toHaveBeenCalledWith("u1", fakeSub);
  });

  const expectNoStore = async (subscription: unknown, reason: RegExp) => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const req = makeReq({ body: { subscription } });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(reason);
    expect(mockStoreSubscription).not.toHaveBeenCalled();
  };

  it("rejects a non-https endpoint without writing", async () => {
    await expectNoStore(
      { endpoint: "http://fcm.example.com/s", keys: { p256dh: "abc", auth: "xyz" } },
      /https/,
    );
  });

  it("rejects a loopback endpoint without writing", async () => {
    await expectNoStore(
      { endpoint: "https://127.0.0.1:6379/s", keys: { p256dh: "abc", auth: "xyz" } },
      /not by IP/,
    );
  });

  it("rejects a link-local metadata endpoint without writing", async () => {
    await expectNoStore(
      { endpoint: "https://169.254.169.254/latest/meta-data/", keys: { p256dh: "abc", auth: "xyz" } },
      /not by IP/,
    );
  });

  it("rejects a malformed subscription without writing", async () => {
    await expectNoStore(undefined, /subscription must be an object/);
  });

  it("rejects missing keys without writing", async () => {
    await expectNoStore({ endpoint: "https://fcm.example.com/s" }, /keys must be an object/);
  });

  it("rejects a non-object body without writing", async () => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const req = makeReq({ body: "subscription=1" });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockStoreSubscription).not.toHaveBeenCalled();
  });

  it("returns failed when store returns null", async () => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const fakeSub = { endpoint: "https://fcm.example.com", keys: { p256dh: "abc", auth: "xyz" } };
    mockStoreSubscription.mockResolvedValueOnce(null);
    const req = makeReq({ body: { subscription: fakeSub } });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/Failed to store subscription/i);
  });
});

// ── delete-subscribe ──────────────────────────────────────────────────────────

describe("deleteSubscribeRoute", () => {
  beforeEach(() => mockDeleteSubscriptionForUser.mockClear());

  it("deletes the caller's own subscription (scoped by session user) and returns success", async () => {
    const { deleteSubscribeRoute } = await import("./delete-subscribe");
    mockDeleteSubscriptionForUser.mockResolvedValueOnce(true);
    const req = makeReq({ params: { id: "sub1" } });
    const result = await deleteSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    // Scoped to the session user id ("u1" from makeReq), not just the row id.
    expect(mockDeleteSubscriptionForUser).toHaveBeenCalledWith("sub1", "u1");
  });

  it("returns failed when no subscription matched the id for this user", async () => {
    const { deleteSubscribeRoute } = await import("./delete-subscribe");
    mockDeleteSubscriptionForUser.mockResolvedValueOnce(false);
    const req = makeReq({ params: { id: "nonexistent" } });
    const result = await deleteSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/No subscription found/i);
  });
});

// ── read-only guard sweep ─────────────────────────────────────────────────────

describe("read-only guard on push routes", () => {
  const readOnlyReq = (overrides: Record<string, unknown> = {}) =>
    ({
      session: {
        user: remapReadOnlySession(
          new SignedUser({
            id: "u1",
            username: "admin",
            email: "admin@localhost",
          }),
          ADMIN_RO_USERNAME
        ),
      },
      params: {},
      body: {},
      ...overrides,
    }) as unknown as import("express").Request;

  beforeEach(() => {
    mockStoreSubscription.mockClear();
    mockDeleteSubscriptionForUser.mockClear();
  });

  it("post-subscribe refuses a read-only session BEFORE storeSubscription", async () => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const req = readOnlyReq({
      body: {
        subscription: {
          endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
          keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
        },
      },
    });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect((result as ApiResponse<unknown>).message).toContain(ADMIN_RO_USERNAME);
    expect(mockStoreSubscription).not.toHaveBeenCalled();
  });

  it("delete-subscribe refuses a read-only session BEFORE deleteSubscriptionForUser", async () => {
    const { deleteSubscribeRoute } = await import("./delete-subscribe");
    const req = readOnlyReq({ params: { id: "sub1" } });
    const result = await deleteSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toContain("read-only");
    expect(mockDeleteSubscriptionForUser).not.toHaveBeenCalled();
  });
});
