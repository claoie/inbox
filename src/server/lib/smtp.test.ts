import { describe, expect, it, jest, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { PassThrough, Readable } from "stream";
import type { SmtpAuthRequest, SmtpSession } from "./smtp/types";
import * as smtpServerModule from "./smtp/server";
import type { SmtpServer } from "./smtp/server";
import * as mimeParser from "./mime/parser";
import * as authRateLimit from "./auth-rate-limit";
import { MAX_MESSAGE_BYTES } from "./message-size";
import { restoreLeaves } from "test-helpers";
import { logger } from "./logger";
import { resetAlarmState } from "./alarm";

// Mock dependencies before importing project code (Bun requirement)
const mockGetUser = mock(() => Promise.resolve(null));
// Resolves the number of mailboxes written, as `saveMailHandler` does. A stub
// that resolved nothing would make every incoming fixture read as a mailbox
// that stored, which is the one thing the transaction now branches on.
const mockSaveMailHandler = mock((): Promise<number> => Promise.resolve(1));
const mockSendMail = mock(() => Promise.resolve());

const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

// Import the real constant so the barrel-mock value stays in lock-step with
// the source of truth — duplicating the literal would let prod's smtp.ts
// compare against a new value while this mock still yielded the old one, and
// the guard would go silently inert in this file while tests stayed green.
import { ADMIN_RO_USERNAME } from "./read-only";

// Only mock what smtp.ts actually imports from "server": getUser, saveMailHandler, sendMail, logger.
// Do NOT add getDomain/getUserDomain/etc here — Bun's mock.module is global and persists across
// test files in the same run. Unused mocks leak into subsequent files (e.g. mails/util.test.ts),
// replacing the real implementations with mock stubs.
mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSaveMailHandler,
  sendMail: mockSendMail,
  logger: mockLogger,
  // Required, not optional — onMailFrom checks against this constant, and
  // omitting it here would leave the comparison against `undefined` and the
  // guard inert in this file while still passing every test.
  ADMIN_RO_USERNAME,
}));

// spyOn rather than mock.module: the parser has its own test files, and a
// process-global module mock would hand them this stub. Restored in afterAll.
const mockParseMessage = spyOn(mimeParser, "parseMessage").mockImplementation(() =>
  Promise.resolve({
    messageId: "<test@example.com>",
    from: { text: "sender@example.com", value: [{ address: "sender@example.com", name: "Sender" }] },
    to: { text: "recipient@test.com", value: [{ address: "recipient@test.com", name: "Recipient" }] },
    subject: "Test Subject",
    html: "<p>Test HTML</p>",
    text: "Test text",
    date: new Date("2026-02-27T10:00:00Z"),
    attachments: []
  })
);

const realVerify = Bun.password.verify.bind(Bun.password);

// Every `Bun.password.verify` onAuth makes, as `[password, hash]`. The real
// implementation still runs underneath — a stub answering a constant would let
// the success cases pass without a working comparison. Restored for the next
// test file in this file's afterAll.
const compareCalls: [string, string][] = [];
const verifySpy = spyOn(Bun.password, "verify").mockImplementation(async (password, hash) => {
  const text =
    typeof password === "string" ? password : new TextDecoder().decode(password as Uint8Array);
  compareCalls.push([text, hash]);
  return realVerify(password, hash);
});

/** A complete bcrypt digest — 22 salt chars plus 31 of hash, base64-ish alphabet. */
const BCRYPT_DIGEST = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// Stub auth-rate-limit so we can drive the rate-limit branch in onAuth without
// needing 10 real failed attempts (each takes 500ms in production code). We use
// spyOn (restored in afterAll) rather than mock.module: mock.module is process-
// global in Bun and would replace the real implementation in auth-rate-limit.test.ts
// when that file runs after this one, making its threshold assertions see the
// always-false stub. spyOn mutates the live module binding and is reverted cleanly.
const mockIsAuthRateLimited = spyOn(authRateLimit, "isAuthRateLimited").mockReturnValue(false);
const mockRecordAuthFailure = spyOn(authRateLimit, "recordAuthFailure").mockResolvedValue(false);
const mockResetAuthFailures = spyOn(authRateLimit, "resetAuthFailures").mockReturnValue(undefined);
const mockIsRecipientProbeRateLimited = spyOn(
  authRateLimit,
  "isRecipientProbeRateLimited"
).mockReturnValue(false);
const mockRecordRecipientProbe = spyOn(
  authRateLimit,
  "recordRecipientProbe"
).mockResolvedValue(false);

// Note: we deliberately do NOT mock "./alarm" globally — `mock.module` is
// process-wide in Bun, and a global mock leaks into alarm.test.ts. Instead
// we let the real `sendAlarm` run and assert on its no-op behavior when
// `DISCORD_ALARM_WEBHOOK` is unset (the early return in alarm.ts:15).

// Import the actual SMTP handlers after mocks are set up
import {
  onAuth,
  onData,
  onMailFrom,
  onRcptTo,
  resolveOutgoingSender,
  splitEnvelopeRecipients,
  DATA_IDLE_TIMEOUT_MS,
  INCOMING_ATTACHMENT_FOLDER
} from "./smtp";
import {
  withSmtpDataBudget,
  smtpDataBudgetCapacity,
  smtpDataBudgetInFlight,
  smtpDataBudgetWaitCeilingMs,
  _resetSmtpDataBudget
} from "./smtp-data-budget";

// Revert the auth-rate-limit spies after this file so the real implementation is
// restored for any test file that runs later (e.g. auth-rate-limit.test.ts).
afterAll(() => {
  verifySpy.mockRestore();
  mockParseMessage.mockRestore();
  mockCreateSmtpServer.mockRestore();
  mockIsAuthRateLimited.mockRestore();
  mockRecordAuthFailure.mockRestore();
  mockResetAuthFailures.mockRestore();
  mockIsRecipientProbeRateLimited.mockRestore();
  mockRecordRecipientProbe.mockRestore();
  // Restore the "server" barrel — the `mock.module("server", ...)` at the
  // top of this file replaces the export graph-wide, so `getUser` leaks
  // into any file that imports it (even `users.test.ts`'s direct import
  // from "./users", per Bun's fourth-variant hoisting behavior in
  // `reference_bun_mock_module_global_hoisting.md`). Under Linux CI file
  // orders where smtp.test.ts runs before users.test.ts, the leaked
  // `mockGetUser` returns smtp.test.ts's last `mockResolvedValue(...)`
  // (usually `{ password, getSigned: () => ({username}) }`), and
  // users.test.ts's `getUser({})` reads THAT — 16 users tests fail.
  // Preload captures the real server barrel onto `__REAL_SERVER`; this
  // afterAll re-mocks it back before the next file runs.
  const realServer = (globalThis as Record<string, unknown>).__REAL_SERVER;
  if (realServer) mock.module("server", () => realServer);
  restoreLeaves();
});

describe("onAuth handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockGetUser.mockReset();
    mockIsAuthRateLimited.mockReset();
    mockIsAuthRateLimited.mockImplementation(() => false);
    mockRecordAuthFailure.mockReset();
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(false));
    mockResetAuthFailures.mockReset();
    mockResetAuthFailures.mockImplementation(() => undefined);
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns existing session user without re-authenticating", async () => {
    const session = { user: "existing-user" } as SmtpSession;
    const auth = { username: "new-user", password: "password" } as SmtpAuthRequest;

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBe("existing-user");
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects auth when user does not exist", async () => {
    const session = {} as SmtpSession;
    const auth = { username: "nonexistent", password: "password" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue(null);

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
  });

  // Same contract as `onRcptTo`: `sasl.js` discards the promise this handler
  // returns, so a rejection that escapes leaves the session unanswered. An
  // outage is not a credential verdict, so it answers transiently and does not
  // charge the failure budget.
  it("answers a transient refusal when the credential lookup rejects", async () => {
    const session = {} as SmtpSession;
    const auth = { username: "testuser", password: "password" } as SmtpAuthRequest;
    mockGetUser.mockRejectedValue(new Error("timeout exceeded when trying to connect"));

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onAuth!(auth, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(451);
    expect(err!.message).toBe("4.3.0 Error: temporary lookup failure");
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
  });

  it("rejects auth when password is empty", async () => {
    const hashedPw = await Bun.password.hash("correct", { algorithm: "bcrypt", cost: 10 });
    const session = {} as SmtpSession;
    const auth = { username: "testuser", password: "" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
  });

  it("rejects auth when password is wrong", async () => {
    const hashedPw = await Bun.password.hash("correctpassword", { algorithm: "bcrypt", cost: 10 });
    const session = {} as SmtpSession;
    const auth = { username: "testuser", password: "wrongpassword" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
  });

  it("authenticates successfully with correct credentials", async () => {
    const hashedPw = await Bun.password.hash("correctpassword", { algorithm: "bcrypt", cost: 10 });
    const session = {} as SmtpSession;
    const auth = { username: "testuser", password: "correctpassword" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBe("testuser");
    expect(mockResetAuthFailures).toHaveBeenCalledTimes(1);
  });

  it("stamps the credential's password_version onto the session at AUTH", async () => {
    // The revocation fence: the per-command gates compare this
    // stamp against the row's current version.
    const hashedPw = await Bun.password.hash("correctpassword", { algorithm: "bcrypt", cost: 10 });
    const session = {} as SmtpSession;
    const auth = { username: "testuser", password: "correctpassword" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      passwordVersion: 3,
      getSigned: () => ({ username: "testuser" })
    });

    await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(
      (session as SmtpSession & { passwordVersion?: number })
        .passwordVersion
    ).toBe(3);
  });

  it("stamps version 1 when the credential row predates the fence", async () => {
    const hashedPw = await Bun.password.hash("correctpassword", { algorithm: "bcrypt", cost: 10 });
    const session = {} as SmtpSession;
    const auth = { username: "testuser", password: "correctpassword" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(
      (session as SmtpSession & { passwordVersion?: number })
        .passwordVersion
    ).toBe(1);
  });

  it("rejects auth when IP is rate-limited", async () => {
    mockIsAuthRateLimited.mockImplementation(() => true);
    const session = { remoteAddress: "5.6.7.8" } as SmtpSession;
    const auth = { username: "testuser", password: "anything" } as SmtpAuthRequest;

    const err = await new Promise<Error | null>((resolve) => {
      onAuth!(auth, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("Too many failed authentication attempts");
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
  });

  it("falls back to 'unknown' IP when remoteAddress is missing", async () => {
    const session = {} as SmtpSession;
    const auth = { username: "nope", password: "x" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue(null);

    await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(mockIsAuthRateLimited).toHaveBeenCalledWith("unknown", "nope");
    expect(mockRecordAuthFailure).toHaveBeenCalledWith("unknown", "nope");
  });

  it("records failure and rejects when getSigned returns falsy", async () => {
    const session = { remoteAddress: "9.9.9.9" } as SmtpSession;
    const auth = { username: "testuser", password: "anything" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: "irrelevant",
      getSigned: () => null
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
    expect(mockRecordAuthFailure).toHaveBeenCalledWith("9.9.9.9", "testuser");
  });

  it("records failure on wrong-password path", async () => {
    const hashedPw = await Bun.password.hash("right", { algorithm: "bcrypt", cost: 10 });
    const session = { remoteAddress: "1.1.1.1" } as SmtpSession;
    const auth = { username: "testuser", password: "wrong" } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(mockRecordAuthFailure).toHaveBeenCalledWith("1.1.1.1", "testuser");
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
  });

  it("authenticates the read-only credential (mutation-refusal is at MAIL FROM)", async () => {
    // SMTP has only mutating gates, but authenticating admin-ro is
    // permitted so the session shape stays symmetric with HTTP/IMAP —
    // the refusal lives at MAIL FROM (below).
    const hashedPw = await Bun.password.hash("readonlypass", { algorithm: "bcrypt", cost: 10 });
    const session = { remoteAddress: "10.0.0.1" } as SmtpSession;
    const auth = {
      username: ADMIN_RO_USERNAME,
      password: "readonlypass",
    } as SmtpAuthRequest;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: ADMIN_RO_USERNAME }),
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    // Session.user carries the original credential so downstream gates
    // (onMailFrom) can distinguish it. Audit line names the original
    // credential.
    expect(result.user).toBe(ADMIN_RO_USERNAME);
    expect(mockResetAuthFailures).toHaveBeenCalledTimes(1);
    const readOnlyLog = mockLogger.info.mock.calls.find(
      (call) => (call[0] as string) === "SMTP AUTH success (read-only)"
    );
    expect(readOnlyLog).toBeDefined();
    expect((readOnlyLog?.[1] as Record<string, unknown>).authenticatedAs).toBe(
      ADMIN_RO_USERNAME
    );
  });
});

describe("onAuth username enumeration resistance", () => {
  const hashOf = (password: string) => Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });

  const existingUser = async () => ({
    password: await hashOf("correct-horse"),
    getSigned: () => ({ username: "testuser" }),
  });

  const drive = (username: string, password: string) =>
    new Promise<{ user?: string }>((resolve) => {
      const auth = { username, password } as SmtpAuthRequest;
      onAuth!(auth, { remoteAddress: "203.0.113.7" } as SmtpSession, (_err, data) =>
        resolve(data || {})
      );
    });

  beforeEach(() => {
    compareCalls.length = 0;
    mockGetUser.mockReset();
    mockGetUser.mockImplementation(() => Promise.resolve(null));
    mockIsAuthRateLimited.mockReset();
    mockIsAuthRateLimited.mockImplementation(() => false);
    mockRecordAuthFailure.mockReset();
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(false));
    mockResetAuthFailures.mockReset();
    mockResetAuthFailures.mockImplementation(() => undefined);
  });

  it("runs a bcrypt comparison against a real digest when AUTH names no known user", async () => {
    const result = await drive("nobody", "hunter2");

    expect(result.user).toBeUndefined();
    expect(compareCalls).toHaveLength(1);
    const [password, hash] = compareCalls[0]!;
    expect(password).toBe("hunter2");
    expect(hash).toMatch(BCRYPT_DIGEST);
  });

  it("spends the same number of bcrypt rounds on an unknown user as on a wrong password", async () => {
    // The refusal is identical either way, so the round count is the only
    // observable that separates an equalised implementation from one that
    // answers an unknown username in microseconds.
    await drive("nobody", "hunter2");
    const unknownUserRounds = compareCalls.length;

    compareCalls.length = 0;
    mockGetUser.mockImplementation(existingUser);
    await drive("testuser", "hunter2");

    expect(unknownUserRounds).toBe(1);
    expect(compareCalls).toHaveLength(unknownUserRounds);
  });

  it("does not reuse a real account's digest for the unknown-user comparison", async () => {
    mockGetUser.mockImplementation(existingUser);
    await drive("testuser", "hunter2");
    const realDigest = compareCalls[0]![1];

    compareCalls.length = 0;
    mockGetUser.mockImplementation(() => Promise.resolve(null));
    await drive("nobody", "hunter2");

    expect(compareCalls[0]![1]).not.toBe(realDigest);
    expect(await realVerify("hunter2", compareCalls[0]![1])).toBe(false);
  });

  it("runs the comparison when the stored digest is empty", async () => {
    mockGetUser.mockImplementation(() =>
      Promise.resolve({ password: "", getSigned: () => ({ username: "testuser" }) })
    );

    const result = await drive("testuser", "hunter2");

    expect(result.user).toBeUndefined();
    expect(compareCalls).toHaveLength(1);
    expect(compareCalls[0]![1]).toMatch(BCRYPT_DIGEST);
  });
});

describe("onMailFrom handler", () => {
  it("refuses MAIL FROM with 550 for the read-only session", async () => {
    // SMTP submission is a mutating action (writes a sent row, hands the
    // message to Mailgun). The read-only session's single mutating gate is
    // MAIL FROM; refuse there rather than intercepting at every command.
    const session = {
      user: ADMIN_RO_USERNAME,
      remoteAddress: "10.0.0.1",
    } as unknown as SmtpSession;
    const address = { address: "sender@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("READ-ONLY user cannot send");
    expect(
      (err as Error & { responseCode?: number }).responseCode
    ).toBe(550);
  });

  it("passes MAIL FROM for a non-read-only session", async () => {
    // Mutation-test the guard's discriminator: replacing the read-only
    // username with any other username must not trip it. `every(p)` on a
    // list of one user would hide a `!==` typo; asserting the pass path
    // with a distinct username is the discriminator.
    const session = {
      user: "alice",
      remoteAddress: "10.0.0.2",
    } as unknown as SmtpSession;
    const address = { address: "alice@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeNull();
  });

  it("refuses MAIL FROM with 421 when the credential rotated after AUTH", async () => {
    // The revocation fence: the connection was stamped with
    // generation 1 at AUTH; the row is now on 2. `mockResolvedValueOnce`
    // keeps the implementation from leaking into later describes.
    mockGetUser.mockResolvedValueOnce({ passwordVersion: 2 });
    const session = {
      user: "alice",
      passwordVersion: 1,
      remoteAddress: "10.0.0.3",
    } as unknown as SmtpSession;
    const address = { address: "alice@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(
      "4.4.2 Credential changed, please re-authenticate"
    );
    expect(
      (err as Error & { responseCode?: number }).responseCode
    ).toBe(421);
  });

  it("passes MAIL FROM when the stamped version is current", async () => {
    mockGetUser.mockResolvedValueOnce({ passwordVersion: 2 });
    const session = {
      user: "alice",
      passwordVersion: 2,
      remoteAddress: "10.0.0.4",
    } as unknown as SmtpSession;
    const address = { address: "alice@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeNull();
  });

  it("answers transiently when the version lookup fails", async () => {
    // A grant that cannot be proven current is not exercised.
    mockGetUser.mockRejectedValueOnce(
      new Error("timeout exceeded when trying to connect")
    );
    const session = {
      user: "alice",
      passwordVersion: 1,
      remoteAddress: "10.0.0.5",
    } as unknown as SmtpSession;
    const address = { address: "alice@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(
      (err as Error & { responseCode?: number }).responseCode
    ).toBe(451);
  });
});

describe("onRcptTo handler", () => {
  const originalEnv = process.env;

  const rcpt = (address: string) =>
    new Promise<Error | null | undefined>((resolve) => {
      const session = { remoteAddress: "1.2.3.4" } as unknown as SmtpSession;
      onRcptTo!({ address } as never, session, (e) => resolve(e));
    });

  beforeEach(() => {
    mockGetUser.mockReset();
    mockLogger.warn.mockReset();
    mockRecordRecipientProbe.mockClear();
    mockIsRecipientProbeRateLimited.mockClear();
    mockIsRecipientProbeRateLimited.mockReturnValue(false);
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("passes a foreign recipient without looking a user up", async () => {
    const err = await rcpt("someone@other.com");

    expect(err).toBeUndefined();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("passes a domain that merely ends in the served one without looking a user up", async () => {
    mockGetUser.mockResolvedValue({ id: "u1" });

    expect(await rcpt("user@nottest.com")).toBeUndefined();
    expect(await rcpt("user@test.com.attacker.net")).toBeUndefined();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("resolves the served apex to admin and passes it", async () => {
    mockGetUser.mockResolvedValue({ id: "u1" });

    const err = await rcpt("anything@test.com");

    expect(err).toBeUndefined();
    expect(mockGetUser).toHaveBeenCalledWith({ username: "admin" });
  });

  it("resolves a user subdomain to its own account and passes it", async () => {
    mockGetUser.mockResolvedValue({ id: "u1" });

    const err = await rcpt("anything@bob.test.com");

    expect(err).toBeUndefined();
    expect(mockGetUser).toHaveBeenCalledWith({ username: "bob" });
  });

  // The served zone answers a wildcard, so any label under it is this host's to
  // answer for while only the ones with an account behind them have a mailbox.
  it("refuses a label under the served domain that owns no account", async () => {
    mockGetUser.mockResolvedValue(undefined);

    const err = await rcpt("x@nosuchuser.test.com");

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(err!.message).toBe("5.1.1 Error: no such mailbox here");
    expect(mockGetUser).toHaveBeenCalledWith({ username: "nosuchuser" });
  });

  it("refuses a nested label no account owns", async () => {
    mockGetUser.mockResolvedValue(undefined);

    const err = await rcpt("x@evil.bob.test.com");

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(mockGetUser).toHaveBeenCalledWith({ username: "evil.bob" });
  });

  it("passes every recipient when EMAIL_DOMAIN is not set", async () => {
    delete process.env.EMAIL_DOMAIN;

    const err = await rcpt("x@nosuchuser.test.com");

    expect(err).toBeUndefined();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  // The server hands the command-loop continuation to `cb` and discards the
  // promise, so a rejection that escapes wedges the session rather than the
  // command — the connection then holds one of `maxClients` until the socket
  // times out. The pool this lookup draws on is shared with HTTP and IMAP and
  // rejects on saturation, so this needs no attacker to reach.
  it("answers a transient refusal when the mailbox lookup rejects", async () => {
    mockGetUser.mockRejectedValue(new Error("timeout exceeded when trying to connect"));

    const err = await rcpt("x@bob.test.com");

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(451);
    expect(err!.message).toBe("4.3.0 Error: temporary lookup failure");
  });

  it("charges a refused recipient to the per-IP probe budget", async () => {
    mockGetUser.mockResolvedValue(undefined);

    await rcpt("x@nosuchuser.test.com");

    expect(mockRecordRecipientProbe).toHaveBeenCalledWith("1.2.3.4");
  });

  it("does not charge a recipient that resolves to a mailbox", async () => {
    mockGetUser.mockResolvedValue({ id: "u1" });

    await rcpt("x@bob.test.com");

    expect(mockRecordRecipientProbe).not.toHaveBeenCalled();
  });

  // Past the budget the answer carries no information and costs no pool slot:
  // the same transient refusal for every local recipient, with no lookup behind
  // it. A check that ran after the query would have already paid for it.
  it("refuses without a lookup once the probe budget is spent", async () => {
    mockIsRecipientProbeRateLimited.mockReturnValueOnce(true);
    mockGetUser.mockResolvedValue({ id: "u1" });

    const err = await rcpt("x@bob.test.com");

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(451);
    expect(err!.message).toBe(
      "4.7.0 Error: too many unknown recipients, try again later"
    );
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRecordRecipientProbe).not.toHaveBeenCalled();
  });

  it("does not consult the budget for a foreign recipient", async () => {
    const err = await rcpt("someone@other.com");

    expect(err).toBeUndefined();
    expect(mockIsRecipientProbeRateLimited).not.toHaveBeenCalled();
  });
});

describe("onData handler", () => {
  const originalEnv = process.env;

  // A real stream, not a { pipe, on } stub: onData now counts the octets it
  // forwards, so a fixture that never delivers any cannot exercise the cap.
  const makeStream = () => {
    const stream = new PassThrough();
    stream.end();
    return stream as unknown as Readable;
  };

  beforeEach(() => {
    mockSaveMailHandler.mockReset();
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(1));
    mockSendMail.mockReset();
    mockParseMessage.mockReset();
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<test@example.com>",
        from: { text: "sender@example.com", value: [{ address: "sender@example.com" }] },
        to: { text: "recipient@test.com", value: [{ address: "recipient@test.com" }] },
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
        text: "Test text",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns error when EMAIL_DOMAIN is not set", async () => {
    delete process.env.EMAIL_DOMAIN;
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "sender@test.com" },
        rcptTo: [{ address: "recipient@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null>((resolve) => {
      onData(stream, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("Email service not configured");
  });

  it("routes incoming email to saveMailHandler", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("routes outgoing email to sendMail", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("refuses an outgoing message when the credential rotated after AUTH", async () => {
    // The revocation fence: the send gate re-checks the
    // stamp, closing the window between RCPT TO and DATA.
    const stream = makeStream();
    const session = {
      user: "admin",
      passwordVersion: 1,
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      passwordVersion: 2,
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(
      "4.4.2 Credential changed, please re-authenticate"
    );
    expect(
      (err as Error & { responseCode?: number }).responseCode
    ).toBe(421);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("propagates parser failure on incoming path", async () => {
    mockParseMessage.mockImplementation(() =>
      Promise.reject(new Error("malformed mail"))
    );
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("malformed mail");
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  // A local envelope sender on an unauthenticated session is a freely chosen
  // string, so the pair (local sender, foreign recipient, no auth) is a relay
  // attempt. 550 is permanent; the 450 the submission branch produced invited a
  // retry for a class this host will never accept.
  it("refuses an unauthenticated relay attempt permanently", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "spoofer@test.com" },
        rcptTo: [{ address: "victim@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("Error: relay access denied");
    expect((err as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // The delivery half of the same gate: an inbound message for a local mailbox
  // is delivered whatever its envelope sender claims. Selecting the submission
  // branch on the sender alone refused it instead — a forwarder, a bounce or a
  // spoof addressed to a real user never reached the mailbox.
  it("delivers inbound mail whose envelope sender claims a user subdomain", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "spoof@bob.test.com" },
        rcptTo: [{ address: "alice@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("delivers inbound mail whose envelope sender claims the served apex", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "spoof@test.com" },
        rcptTo: [{ address: "alice@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // The transaction is answered rather than accepted when nothing was written,
  // and transiently, because the authoritative refusal is `onRcptTo`'s.
  it("refuses a transaction that stored into no mailbox", async () => {
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(0));
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "ghost@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(451);
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });

  it("answers a zero-stored transaction once when the source fails afterwards", async () => {
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(0));
    const source = new PassThrough();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "ghost@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const calls: (Error | null | undefined)[] = [];
    onData(source as unknown as Readable, session, (err) =>
      calls.push(err)
    );
    source.end("x");
    await new Promise((resolve) => setTimeout(resolve, 40));
    source.emit("error", new Error("connection reset"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.length).toBe(1);
    expect((calls[0] as Error & { responseCode?: number }).responseCode).toBe(451);
  });

  it("accepts a transaction that stored into at least one mailbox", async () => {
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(1));
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "alice@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });

  it("rejects outgoing path when getUser returns null", async () => {
    const stream = makeStream();
    const session = {
      user: "ghost",
      envelope: {
        mailFrom: { address: "ghost@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue(null);

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("User not authenticated");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("propagates parser failure on outgoing path", async () => {
    mockParseMessage.mockImplementation(() =>
      Promise.reject(new Error("outgoing parse failure"))
    );
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("outgoing parse failure");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("wraps non-Error rejection in Error on outgoing path", async () => {
    mockParseMessage.mockImplementation(() => Promise.reject("plain string"));
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("plain string");
  });

  it("defaults sender to 'admin' when mailFrom address has no local part", async () => {
    // To reach onDataOutgoing, mailFrom must be a non-boolean with an address
    // that endsWith @EMAIL_DOMAIN. An address of "@test.com" satisfies that and
    // also exercises the `"" || "admin"` fallback inside the handler.
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    // Parser body returns from.text undefined → senderFullName falls back to sender ("admin")
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<o@example.com>",
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendMail.mock.calls[0];
    // sendMail(signedUser, mailData) — mailData is the 2nd arg
    const mailData = callArgs[1] as { sender: string; senderFullName: string };
    expect(mailData.sender).toBe("admin");
    expect(mailData.senderFullName).toBe("admin");
  });

  it("sends as the same-domain recipient named in the submission", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }, { address: "sales@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<dyn@example.com>",
        from: {
          text: "Admin <admin@test.com>",
          value: [{ address: "admin@test.com", name: "Admin" }]
        },
        to: {
          text: "recipient@other.com",
          value: [{ address: "recipient@other.com", name: "" }]
        },
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailData = mockSendMail.mock.calls[0][1] as {
      sender: string;
      to: string;
    };
    expect(mailData.sender).toBe("sales");
    expect(mailData.to).toBe("recipient@other.com");
    expect((mailData as { bcc?: string }).bcc).toBeUndefined();
    expect((mailData as { senderFullName: string }).senderFullName).toBe("Admin");
  });

  it("leaves a To recipient of the user's domain addressed", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "bob@test.com" }, { address: "friend@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<addressed@example.com>",
        from: {
          text: "Admin <admin@test.com>",
          value: [{ address: "admin@test.com", name: "Admin" }]
        },
        to: {
          text: "bob@test.com, friend@other.com",
          value: [{ address: "bob@test.com" }, { address: "friend@other.com" }]
        },
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    const mailData = mockSendMail.mock.calls[0][1] as {
      sender: string;
      to: string;
    };
    expect(mailData.sender).toBe("admin");
    expect(mailData.to).toBe("bob@test.com,friend@other.com");
  });

  it("reads To recipients out of an RFC 5322 address group", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "bob@test.com" }, { address: "friend@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<group@example.com>",
        from: {
          text: "Admin <admin@test.com>",
          value: [{ address: "admin@test.com", name: "Admin" }]
        },
        to: {
          text: "Team: bob@test.com, friend@other.com;",
          value: [
            {
              name: "Team",
              group: [
                { address: "bob@test.com", name: "" },
                { address: "friend@other.com", name: "" }
              ]
            }
          ]
        },
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    const mailData = mockSendMail.mock.calls[0][1] as {
      sender: string;
      to: string;
    };
    expect(mailData.sender).toBe("admin");
    expect(mailData.to).toBe("bob@test.com,friend@other.com");
  });

  it("maps attachments through the parsed attachment array", async () => {
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<att@example.com>",
        from: { text: "external@other.com", value: [{ address: "external@other.com" }] },
        to: { text: "user@test.com", value: [{ address: "user@test.com" }] },
        subject: "Has attachment",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: [
          {
            filename: "receipt.pdf",
            contentType: "application/pdf",
            path: "/tmp/attachment-0",
            size: 3
          },
          {
            // missing filename → falls back to "attachment"
            contentType: "image/png",
            path: "/tmp/attachment-1",
            size: 3
          }
        ]
      })
    );
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    const mailArg = mockSaveMailHandler.mock.calls[0]![1] as {
      attachments: Array<{ filename: string; contentType: string; size: number }>;
    };
    expect(mailArg.attachments).toHaveLength(2);
    expect(mailArg.attachments[0]!.filename).toBe("receipt.pdf");
    expect(mailArg.attachments[1]!.filename).toBe("attachment");
  });

  const outgoingSession = (rcptTo: string[]) =>
    ({
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: rcptTo.map((address) => ({ address }))
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  const parseAs = (headers: {
    to?: { address?: string; group?: { address: string }[] }[];
    cc?: { address?: string; group?: { address: string }[] }[];
  }) => {
    mockParseMessage.mockImplementation(() =>
      Promise.resolve({
        messageId: "<test@example.com>",
        from: { text: "admin@test.com", value: [{ address: "admin@test.com" }] },
        to: headers.to && { text: "", value: headers.to },
        cc: headers.cc && { text: "", value: headers.cc },
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
        text: "Test text",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );
  };

  const driveOutgoing = async (session: SmtpSession) => {
    mockGetUser.mockResolvedValue({ getSigned: () => ({ username: "admin" }) });
    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(makeStream(), session, (e) => resolve(e));
    });
    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    return mockSendMail.mock.calls[0][1];
  };

  it("keeps an envelope recipient the To: header omits out of the To field", async () => {
    parseAs({ to: [{ address: "visible@other.com" }] });
    const mailData = await driveOutgoing(
      outgoingSession(["visible@other.com", "hidden@other.com"])
    );

    expect(mailData.to).toBe("visible@other.com");
    expect(mailData.bcc).toBe("hidden@other.com");
    expect(mailData.cc).toBeUndefined();
  });

  it("routes a Cc: header recipient to cc, not to to or bcc", async () => {
    parseAs({
      to: [{ address: "visible@other.com" }],
      cc: [{ address: "copied@other.com" }]
    });
    const mailData = await driveOutgoing(
      outgoingSession(["visible@other.com", "copied@other.com", "hidden@other.com"])
    );

    expect(mailData.to).toBe("visible@other.com");
    expect(mailData.cc).toBe("copied@other.com");
    expect(mailData.bcc).toBe("hidden@other.com");
  });

  it("sends a header-less submission entirely as bcc", async () => {
    parseAs({});
    const mailData = await driveOutgoing(
      outgoingSession(["one@other.com", "two@other.com"])
    );

    expect(mailData.to).toBe("");
    expect(mailData.bcc).toBe("one@other.com,two@other.com");
  });

  it("reads addresses out of an RFC 5322 group in the To: header", async () => {
    // `To: Team: a@x, b@x;` — the parser nests the members under value[0].group
    // and leaves value[0].address undefined.
    parseAs({
      to: [{ group: [{ address: "a@other.com" }, { address: "b@other.com" }] }]
    });
    const mailData = await driveOutgoing(
      outgoingSession(["a@other.com", "b@other.com", "hidden@other.com"])
    );

    expect(mailData.to).toBe("a@other.com,b@other.com");
    expect(mailData.bcc).toBe("hidden@other.com");
  });

  it("refuses to relay when neither incoming nor outgoing matches", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "external@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const calls: (Error | null | undefined)[] = [];
    onData(stream, session, (err) => calls.push(err));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.length).toBe(1);
    expect((calls[0] as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // Locality is a label boundary, not a string suffix: a user's mail lives
  // under `<user>.<domain>`, so both predicates have to accept that form and
  // still refuse a domain that merely ends in the served one.
  it("saves incoming mail addressed to a user subdomain", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "anything@bob.test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });

  it("relays an authenticated submission sent from a user subdomain", async () => {
    const stream = makeStream();
    const session = {
      user: "bob",
      envelope: {
        mailFrom: { address: "bob@bob.test.com" },
        rcptTo: [{ address: "someone@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "bob" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("refuses a domain that merely ends in the served one", async () => {
    const codes: (number | undefined)[] = [];
    for (const address of ["user@nottest.com", "user@test.com.attacker.net"]) {
      const session = {
        envelope: {
          mailFrom: { address },
          rcptTo: [{ address }]
        },
        remoteAddress: "1.2.3.4"
      } as unknown as SmtpSession;

      const err = await new Promise<Error | null | undefined>((resolve) => {
        onData(makeStream(), session, (e) => resolve(e));
      });
      codes.push((err as Error & { responseCode?: number }).responseCode);
    }

    expect(codes).toEqual([550, 550]);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // A refusal that lands while a handler's own await is in flight: the reply
  // has gone out, so the await's continuation must not answer again.
  const deferred = () => {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  };

  const answersOnceWhenRefusedMidAwait = async (
    session: SmtpSession,
    awaited: { promise: Promise<void> }
  ) => {
    const source = new PassThrough();
    const calls: (Error | null | undefined)[] = [];
    onData(source as unknown as Readable, session, (err) =>
      calls.push(err)
    );
    source.write("x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    source.emit("error", new Error("connection reset"));
    await awaited.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return calls;
  };

  it("answers once when the source fails during saveMailHandler", async () => {
    const saving = deferred();
    mockSaveMailHandler.mockImplementation(() => saving.promise.then(() => 1));
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const pending = answersOnceWhenRefusedMidAwait(session, saving);
    await new Promise((resolve) => setTimeout(resolve, 40));
    saving.settle();
    const calls = await pending;

    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
    expect((calls[0] as Error).message).toBe("connection reset");
  });

  it("answers once when the source fails during sendMail", async () => {
    const sending = deferred();
    mockSendMail.mockImplementation(() => sending.promise);
    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession;

    const pending = answersOnceWhenRefusedMidAwait(session, sending);
    await new Promise((resolve) => setTimeout(resolve, 40));
    sending.settle();
    const calls = await pending;

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
    expect((calls[0] as Error).message).toBe("connection reset");
  });
});

describe("onData message ceiling", () => {
  const originalEnv = process.env;

  // Counts what the parser is actually handed, so the assertions can tell a
  // handler that stops feeding it at the ceiling from one that parses the
  // whole message and rejects afterwards — the second spends exactly the
  // memory the ceiling exists to bound, and answers 552 all the same.
  let parserBytes = 0;
  let parserStream: Readable | undefined;

  const parseAndCount = () =>
    mockParseMessage.mockImplementation(
      (stream) =>
        new Promise((resolve) => {
          parserStream = stream as Readable;
          stream.on("data", (chunk: Buffer) => {
            parserBytes += chunk.length;
          });
          stream.on("end", () =>
            resolve({
              messageId: "<big@example.com>",
              from: { value: [{ address: "sender@example.com" }] },
              to: { value: [{ address: "recipient@test.com" }] },
              subject: "Big",
              html: "<p>Big</p>",
              text: "Big",
              attachments: []
            })
          );
        })
    );

  // Writes `totalBytes` honouring backpressure, so the fixture cannot outrun
  // the handler and buffer the whole payload in the source stream instead.
  const feed = (stream: PassThrough, totalBytes: number) => {
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    let written = 0;
    const pump = () => {
      while (written < totalBytes) {
        const size = Math.min(chunk.length, totalBytes - written);
        written += size;
        if (!stream.write(chunk.subarray(0, size))) {
          stream.once("drain", pump);
          return;
        }
      }
      stream.end();
    };
    pump();
  };

  const drive = (
    session: SmtpSession,
    totalBytes: number
  ): Promise<Error | null | undefined> => {
    const stream = new PassThrough();
    return new Promise((resolve) => {
      onData(stream as unknown as Readable, session, resolve);
      feed(stream, totalBytes);
    });
  };

  const incomingSession = () =>
    ({
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  const outgoingSession = () =>
    ({
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  beforeEach(() => {
    parserBytes = 0;
    parserStream = undefined;
    mockSaveMailHandler.mockReset();
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(1));
    mockSendMail.mockReset();
    mockParseMessage.mockReset();
    mockGetUser.mockReset();
    mockLogger.warn.mockReset();
    parseAndCount();
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("refuses an incoming message past the ceiling with 552 and never saves it", async () => {
    const err = await drive(incomingSession(), MAX_MESSAGE_BYTES + 1024 * 1024);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(552);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("stops feeding the parser at the ceiling rather than after the whole message", async () => {
    await drive(incomingSession(), MAX_MESSAGE_BYTES + 1024 * 1024);

    expect(parserBytes).toBeGreaterThan(0);
    expect(parserBytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("logs the refusal against the sending address", async () => {
    await drive(incomingSession(), MAX_MESSAGE_BYTES + 1024 * 1024);

    const refusals = mockLogger.warn.mock.calls.filter((call) =>
      String(call[0]).includes("over the maximum size")
    );
    expect(refusals.length).toBe(1);
    expect(refusals[0]![1]).toMatchObject({
      remoteAddress: "1.2.3.4",
      maxBytes: MAX_MESSAGE_BYTES
    });
  });

  it("refuses an outgoing submission past the ceiling and never relays it", async () => {
    mockGetUser.mockImplementation(() =>
      Promise.resolve({
        username: "admin",
        getSigned: () => ({ id: "user-1", username: "admin" })
      })
    );

    const err = await drive(outgoingSession(), MAX_MESSAGE_BYTES + 1024 * 1024);

    expect((err as Error & { responseCode?: number }).responseCode).toBe(552);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(parserBytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("delivers a message under the ceiling whole", async () => {
    const size = 2 * 1024 * 1024;
    const err = await drive(incomingSession(), size);

    expect(err).toBeUndefined();
    expect(parserBytes).toBe(size);
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });

  it("answers a failed DATA stream once and never saves it", async () => {
    const stream = new PassThrough();
    const calls: (Error | null | undefined)[] = [];

    onData(stream as unknown as Readable, incomingSession(), (err) =>
      calls.push(err)
    );
    stream.write(Buffer.alloc(1024, 0x61));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.destroy(new Error("socket reset"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("socket reset");
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  // The outgoing branch reaches the parser only after a user lookup, so a
  // stream that fails during the lookup has no parser listening yet. Answering
  // through `cb` rather than through the stream is what keeps that from
  // becoming an unhandled 'error' event.
  it("answers a DATA stream that fails before the parser is attached", async () => {
    let releaseLookup: (() => void) | undefined;
    mockGetUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseLookup = () =>
            resolve({
              username: "admin",
              getSigned: () => ({ id: "user-1", username: "admin" })
            });
        })
    );

    const stream = new PassThrough();
    const calls: (Error | null | undefined)[] = [];
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      onData(stream as unknown as Readable, outgoingSession(), (err) =>
        calls.push(err)
      );
      stream.write(Buffer.alloc(1024, 0x61));
      await new Promise((resolve) => setTimeout(resolve, 20));
      stream.destroy(new Error("socket reset"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseLookup?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    expect(uncaught).toEqual([]);
    expect(mockParseMessage).not.toHaveBeenCalled();
    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("socket reset");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("answers a refused transaction exactly once", async () => {
    const stream = new PassThrough();
    const calls: (Error | null | undefined)[] = [];

    onData(stream as unknown as Readable, incomingSession(), (err) =>
      calls.push(err)
    );
    feed(stream, MAX_MESSAGE_BYTES + 1024 * 1024);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls.length).toBe(1);
  });

  it("releases the parser's stream when the ceiling refuses", async () => {
    await drive(incomingSession(), MAX_MESSAGE_BYTES + 1024 * 1024);

    expect(parserStream).toBeDefined();
    expect(parserStream!.destroyed).toBe(true);
  });

  // A destroyed stream is not a settled parser: a parser that settles on `end`
  // or `error` and on neither `close` nor a bare `destroy()` would, after a
  // refusal that cuts silently, hold the attachment file it was writing open
  // for the life of the connection.
  it("settles the parser's promise when the ceiling refuses", async () => {
    let parserSettled = false;
    mockParseMessage.mockImplementation(
      (stream) =>
        new Promise((resolve, reject) => {
          stream.on("data", () => {});
          stream.on("end", () => {
            parserSettled = true;
            resolve({ attachments: [] });
          });
          stream.on("error", (err: Error) => {
            parserSettled = true;
            reject(err);
          });
        })
    );

    await drive(incomingSession(), MAX_MESSAGE_BYTES + 1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(parserSettled).toBe(true);
  });

  const relaySession = () =>
    ({
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "external@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  // Local envelope sender, foreign recipient, no auth: a relay attempt, which
  // is refused before the octets are read rather than at the submission branch.
  const unauthenticatedSession = () =>
    ({
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  const driveAndDrain = async (
    session: SmtpSession,
    totalBytes: number,
    waitMs = 300
  ) => {
    const stream = new PassThrough();
    const calls: (Error | null | undefined)[] = [];

    onData(stream as unknown as Readable, session, (err) =>
      calls.push(err)
    );
    feed(stream, totalBytes);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    return { calls, ended: stream.readableEnded };
  };

  // Each payload below crosses the ceiling on purpose. Reading the transaction
  // out after an early refusal puts the rest of DATA back under the ceiling
  // watcher, which answers through the same callback — so the same fixture
  // measures both that the source ends and that it is answered only once.
  const PAST_CEILING = MAX_MESSAGE_BYTES + 1024 * 1024;

  it("reads out a relayed transaction it refuses", async () => {
    const { calls, ended } = await driveAndDrain(relaySession(), 1024 * 1024);

    expect(calls.length).toBe(1);
    expect((calls[0] as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(ended).toBe(true);
    expect(mockParseMessage).not.toHaveBeenCalled();
  });

  it("reads out an unauthenticated relay attempt it refuses", async () => {
    mockGetUser.mockImplementation(() => Promise.resolve(undefined));

    const { calls, ended } = await driveAndDrain(
      unauthenticatedSession(),
      1024 * 1024
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("Error: relay access denied");
    expect(ended).toBe(true);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("reads out a transaction refused before EMAIL_DOMAIN is known", async () => {
    delete process.env.EMAIL_DOMAIN;

    const { calls, ended } = await driveAndDrain(incomingSession(), PAST_CEILING);

    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("Email service not configured");
    expect(ended).toBe(true);
    expect(mockParseMessage).not.toHaveBeenCalled();
  });

  it("answers an unauthenticated relay attempt once when DATA runs past the ceiling", async () => {
    mockGetUser.mockImplementation(() => Promise.resolve(undefined));

    const { calls, ended } = await driveAndDrain(
      unauthenticatedSession(),
      PAST_CEILING
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("Error: relay access denied");
    expect(ended).toBe(true);
  });

  it("answers a parser failure once and reads the rest of DATA out", async () => {
    mockParseMessage.mockImplementation(() =>
      Promise.reject(new Error("parse boom"))
    );

    const { calls, ended } = await driveAndDrain(incomingSession(), PAST_CEILING);

    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("parse boom");
    expect(ended).toBe(true);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("answers an outgoing lookup failure once and reads the rest of DATA out", async () => {
    mockGetUser.mockImplementation(() => Promise.reject(new Error("db down")));

    const { calls, ended } = await driveAndDrain(outgoingSession(), PAST_CEILING);

    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toBe("db down");
    expect(ended).toBe(true);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

/**
 * Attachments are decoded into a per-transaction directory, and nothing may
 * be left there once the transaction is answered — whichever way it ends.
 */
describe("onData transaction files", () => {
  const originalEnv = process.env;
  let directories: string[];

  // Stands in for the parser: writes one attachment file into the directory it
  // is handed, as the real one does, then settles as `outcome` says.
  const parseWritingAFile = (outcome: "resolve" | "reject" | "hang" = "resolve") =>
    mockParseMessage.mockImplementation(async (stream, options) => {
      directories.push(options.attachmentDir);
      fs.mkdirSync(options.attachmentDir, { recursive: true });
      const filePath = path.join(options.attachmentDir, "0");
      fs.writeFileSync(filePath, "attachment bytes");
      if (outcome === "hang") return new Promise(() => {});
      for await (const _chunk of stream as Readable) {
        // read the message out
      }
      if (outcome === "reject") throw new Error("malformed mail");
      return {
        subject: "with attachment",
        attachments: [{ path: filePath, filename: "a.bin", contentType: "application/octet-stream", size: 16 }]
      };
    });

  const incomingSession = () =>
    ({
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  const deliver = (session: SmtpSession, body: string | Buffer = "Subject: x\r\n\r\nbody\r\n") => {
    const stream = new PassThrough();
    const answered = new Promise<Error | null | undefined>((resolve) => onData(stream, session, resolve));
    stream.end(body);
    return answered;
  };

  /** The directory is removed after the answer, so give the removal a moment. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

  beforeEach(() => {
    directories = [];
    _resetSmtpDataBudget();
    mockSaveMailHandler.mockReset();
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(1));
    mockSendMail.mockReset();
    mockGetUser.mockReset();
    mockParseMessage.mockReset();
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
    directories.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it("works under the incoming attachment folder, one directory per transaction", async () => {
    parseWritingAFile();
    await deliver(incomingSession());
    await deliver(incomingSession());
    expect(directories).toHaveLength(2);
    expect(new Set(directories).size).toBe(2);
    directories.forEach((dir) => expect(path.dirname(dir)).toBe(INCOMING_ATTACHMENT_FOLDER));
  });

  it("hands the save the attachment's file and removes it once stored", async () => {
    parseWritingAFile();
    let seenWhileSaving: boolean | undefined;
    mockSaveMailHandler.mockImplementation((...args: unknown[]) => {
      const mail = args[1] as { attachments: { path: string; filename: string }[] };
      seenWhileSaving = fs.existsSync(mail.attachments[0].path);
      return Promise.resolve(1);
    });
    const err = await deliver(incomingSession());
    await settled();
    expect(err).toBeUndefined();
    expect(seenWhileSaving).toBe(true);
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it("removes the files when the parser fails", async () => {
    parseWritingAFile("reject");
    const err = await deliver(incomingSession());
    await settled();
    expect(err!.message).toBe("malformed mail");
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it("removes the files when nothing was stored", async () => {
    parseWritingAFile();
    mockSaveMailHandler.mockImplementation(() => Promise.resolve(0));
    const err = await deliver(incomingSession());
    await settled();
    expect((err as Error & { responseCode?: number }).responseCode).toBe(451);
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it("removes the files when the message runs past the ceiling", async () => {
    parseWritingAFile();
    const err = await deliver(incomingSession(), Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61));
    await settled();
    expect((err as Error & { responseCode?: number }).responseCode).toBe(552);
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it("answers at once and removes the files when the connection drops mid-DATA", async () => {
    parseWritingAFile();
    const stream = new PassThrough();
    const answered = new Promise<Error | null | undefined>((resolve) =>
      onData(stream, incomingSession(), resolve)
    );
    stream.write("Subject: x\r\n\r\npartial");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.destroy();
    const err = await answered;
    await settled();
    expect((err as Error & { responseCode?: number }).responseCode).toBe(421);
    expect(smtpDataBudgetInFlight()).toBe(0);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it("removes the files of an outgoing submission", async () => {
    parseWritingAFile();
    mockGetUser.mockResolvedValue({ getSigned: () => ({ username: "admin" }) });
    const err = await deliver({
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SmtpSession);
    await settled();
    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(directories[0])).toBe(false);
  });
});

describe("splitEnvelopeRecipients", () => {
  it("assigns each envelope recipient by the header that names it", () => {
    const split = splitEnvelopeRecipients(
      ["a@x.com", "b@x.com", "c@x.com"],
      ["a@x.com"],
      ["b@x.com"]
    );
    expect(split).toEqual({ to: ["a@x.com"], cc: ["b@x.com"], bcc: ["c@x.com"] });
  });

  it("matches a header address to an envelope address case-insensitively", () => {
    const split = splitEnvelopeRecipients(["Alice@X.com"], ["alice@x.com"], []);
    expect(split).toEqual({ to: ["Alice@X.com"], cc: [], bcc: [] });
  });

  it("ignores a header address that the envelope never named", () => {
    const split = splitEnvelopeRecipients(
      ["real@x.com"],
      ["real@x.com", "forged@x.com"],
      []
    );
    expect(split).toEqual({ to: ["real@x.com"], cc: [], bcc: [] });
  });

  it("assigns an address named by both headers to To, not Cc", () => {
    const split = splitEnvelopeRecipients(
      ["dup@x.com"],
      ["dup@x.com"],
      ["dup@x.com"]
    );
    expect(split).toEqual({ to: ["dup@x.com"], cc: [], bcc: [] });
  });

  it("returns three empty lists for an empty envelope", () => {
    expect(splitEnvelopeRecipients([], ["a@x.com"], ["b@x.com"])).toEqual({
      to: [],
      cc: [],
      bcc: []
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// registerListeners is not exported, but its behavior is reachable by
// driving initializeSmtp with a stubbed server factory. Each
// `createSmtpServer(...)` returns a controllable EventEmitter-like stub, then
// the tests replay the error/close events they care about.
// ───────────────────────────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

interface FakeServer {
  on: (event: string, listener: Listener) => void;
  listen: (port: number, callback: () => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  listeners: Map<string, Listener[]>;
  // The real SmtpServer tracks its live connections here; the eviction sweep
  // reads it, so the stub carries one too.
  connections: Set<unknown>;
  options: Record<string, unknown>;
}

const createdServers: FakeServer[] = [];

const makeFakeServer = (): FakeServer => {
  const listeners = new Map<string, Listener[]>();
  const server: FakeServer = {
    listeners,
    connections: new Set<unknown>(),
    options: {},
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    },
    listen(_port, callback) {
      // Fire callback synchronously so initializeSmtp's promise resolves.
      callback();
    },
    emit(event, ...args) {
      (listeners.get(event) || []).forEach((fn) => fn(...args));
    }
  };
  return server;
};

const createdOptions: Record<string, unknown>[] = [];

const mockCreateSmtpServer = spyOn(smtpServerModule, "createSmtpServer").mockImplementation(
  (opts) => {
    const fake = makeFakeServer();
    fake.options = opts as unknown as Record<string, unknown>;
    createdServers.push(fake);
    createdOptions.push(fake.options);
    return fake as unknown as SmtpServer;
  }
);

// Lazy import, so initializeSmtp is first called with the factory stubbed.
const loadInitializeSmtp = async () => {
  const mod = await import("./smtp");
  return mod.initializeSmtp;
};

describe("registerListeners error handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    createdServers.length = 0;
    mockLogger.error.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    process.env = { ...originalEnv };
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    // Keep DISCORD_ALARM_WEBHOOK unset so real `sendAlarm` is a no-op (alarm.ts:15).
    delete process.env.DISCORD_ALARM_WEBHOOK;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const bootSingleServer = async () => {
    const initializeSmtp = await loadInitializeSmtp();
    // Without SSL configured, initializeSmtp only spins up one server on SMTP_PORT.
    await initializeSmtp();
    expect(createdServers.length).toBeGreaterThan(0);
    return createdServers[0]!;
  };

  it("suppresses the alarm for TLS handshake function names, but still logs a warning", async () => {
    const server = await bootSingleServer();
    server.emit("error", new Error("tls_early_post_process_client_hello: unsupported protocol"));
    server.emit("error", new Error("extract_keyshares: bad key share"));
    server.emit("error", new Error("tls_choose_sigalg: no suitable signature algorithm"));
    server.emit("error", new Error("Socket closed before TLS handshake"));
    server.emit("error", new Error("read ECONNRESET"));
    server.emit("error", new Error("TLS handshake timeout"));
    server.emit("error", new Error("write ECONNRESET"));
    server.emit("error", new Error("write EPIPE"));
    server.emit(
      "error",
      new Error(
        "C0BC3644C57F0000:error:0A00006E:SSL routines:tls_parse_ctos_maxfragmentlen:bad extension:../deps/openssl/openssl/ssl/statem/extensions_srvr.c:184:\n"
      )
    );
    server.emit("error", new Error("SSL routines:tls_collect_extensions:bad extension"));

    expect(mockLogger.error).not.toHaveBeenCalled();
    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes("SMTP Server")).length).toBe(10);
  });

  const bunErrno = (code: string, description: string, syscall: string) =>
    Object.assign(new Error(`${code}: ${description}, ${syscall}`), { code, syscall });

  it("suppresses the alarm for peer-drop errno codes in Bun's message format", async () => {
    const server = await bootSingleServer();
    server.emit("error", bunErrno("ETIMEDOUT", "connection timed out", "read"));
    server.emit("error", bunErrno("ECONNRESET", "connection reset by peer", "read"));
    server.emit("error", bunErrno("EPIPE", "broken pipe", "write"));
    server.emit("error", bunErrno("ECONNRESET", "connection reset by peer", "write"));
    server.emit("error", bunErrno("EPROTO", "protocol error", "write"));

    expect(mockLogger.error).not.toHaveBeenCalled();
    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes("SMTP Server")).length).toBe(5);
  });

  it("still alarms on errno codes outside the peer-drop syscalls", async () => {
    const server = await bootSingleServer();
    server.emit("error", bunErrno("EMFILE", "too many open files", "accept"));
    server.emit("error", bunErrno("EPROTO", "protocol error", "read"));

    expect(mockLogger.error).toHaveBeenCalledTimes(2);
  });

  const bootWithTls = async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "smtp-tls-error-test-"));
    writeFileSync(join(dir, "cert.pem"), "DUMMY CERT");
    writeFileSync(join(dir, "key.pem"), "DUMMY KEY");
    process.env.SSL_CERTIFICATE = join(dir, "cert.pem");
    process.env.SSL_CERTIFICATE_KEY = join(dir, "key.pem");
    try {
      const initializeSmtp = await loadInitializeSmtp();
      await initializeSmtp();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return {
      implicitTls: createdServers.find((s) => s.options.secure === true)!,
      startTls: createdServers.find((s) => s.options.secure === false)!
    };
  };

  const resetError = (message: string, meta?: { stage: string }) =>
    Object.assign(new Error(message), { code: "ECONNRESET", ...(meta && { meta: { protocol: "smtp", ...meta } }) });

  const smtpServerLines = (fn: typeof mockLogger.warn) =>
    fn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("SMTP Server"));

  it("suppresses any implicit-TLS handshake error, whatever its wording", async () => {
    const { implicitTls } = await bootWithTls();
    implicitTls.emit("error", resetError("socket hang up", { stage: "connect" }));
    implicitTls.emit("error", resetError("some future runtime wording", { stage: "connect" }));

    expect(smtpServerLines(mockLogger.error)).toEqual([]);
    expect(smtpServerLines(mockLogger.warn).length).toBe(2);
  });

  it("still pages for the same error when it was not raised by the implicit-TLS handshake", async () => {
    const { implicitTls, startTls } = await bootWithTls();
    implicitTls.emit("error", resetError("socket hang up"));
    implicitTls.emit("error", resetError("socket hang up", { stage: "data" }));
    startTls.emit("error", resetError("socket hang up", { stage: "connect" }));

    expect(smtpServerLines(mockLogger.error).length).toBe(3);
    expect(smtpServerLines(mockLogger.warn)).toEqual([]);
  });

  const boringSslError = (reason: string) =>
    Object.assign(new Error(`error:100000b8:SSL routines:OPENSSL_internal:${reason}`), {
      library: "SSL routines",
      reason,
      code: `ERR_SSL_${reason}`,
      meta: { protocol: "smtp", stage: "connect", tlsProtocol: "TLSv1.2" }
    });

  it("suppresses BoringSSL TLS-layer errors on the STARTTLS servers", async () => {
    const { startTls } = await bootWithTls();
    startTls.emit("error", boringSslError("NO_SHARED_CIPHER"));
    startTls.emit("error", boringSslError("UNSUPPORTED_PROTOCOL"));
    startTls.emit("error", Object.assign(new Error("OPENSSL_internal:WRONG_VERSION_NUMBER"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }));

    expect(smtpServerLines(mockLogger.error)).toEqual([]);
    expect(smtpServerLines(mockLogger.warn).length).toBe(3);
  });

  it("still pages for a socket error tagged by the STARTTLS upgrade handler", async () => {
    const { startTls } = await bootWithTls();
    startTls.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        meta: { protocol: "smtp", stage: "connect", tlsProtocol: null }
      })
    );
    startTls.emit("error", Object.assign(new Error("SSL is not a library"), { library: "SSL", code: "ERR_SSLX" }));

    expect(smtpServerLines(mockLogger.error).length).toBe(2);
    expect(smtpServerLines(mockLogger.warn)).toEqual([]);
  });

  it("pages when the peer rejects our certificate on either runtime", async () => {
    const { startTls } = await bootWithTls();
    startTls.emit("error", boringSslError("SSLV3_ALERT_BAD_CERTIFICATE"));
    startTls.emit("error", boringSslError("TLSV1_ALERT_UNKNOWN_CA"));
    startTls.emit(
      "error",
      Object.assign(new Error("error:14094412:SSL routines:ssl3_read_bytes:sslv3 alert bad certificate"), {
        library: "SSL routines",
        reason: "sslv3 alert bad certificate",
        code: "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE"
      })
    );
    startTls.emit(
      "error",
      Object.assign(new Error("error:0A000412:SSL routines::ssl/tls alert bad certificate"), {
        library: "SSL routines",
        reason: "ssl/tls alert bad certificate",
        code: "ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE"
      })
    );
    startTls.emit("error", boringSslError("NO_SHARED_CIPHER"));

    expect(smtpServerLines(mockLogger.error).length).toBe(4);
    expect(smtpServerLines(mockLogger.warn).length).toBe(1);
  });

  describe("peer address", () => {
    const pagedDetails = (emit: () => void) => {
      process.env.DISCORD_ALARM_WEBHOOK = "https://alarm.invalid/webhook";
      resetAlarmState();
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
      try {
        emit();
        return fetchSpy.mock.calls.map(
          ([, init]) => JSON.parse(String(init?.body)).embeds[0].description as string
        );
      } finally {
        fetchSpy.mockRestore();
      }
    };

    const certRejection = (peer: object) =>
      Object.assign(boringSslError("SSLV3_ALERT_BAD_CERTIFICATE"), peer);

    it("names the peer of a certificate rejected during the implicit-TLS handshake", async () => {
      const { implicitTls } = await bootWithTls();
      const meta = { protocol: "smtp", stage: "connect", remoteAddress: "203.0.113.7" };
      const details = pagedDetails(() => implicitTls.emit("error", certRejection({ meta })));

      expect(details.length).toBe(1);
      expect(details[0]).toContain("**Remote:** 203.0.113.7\n");
      expect(mockLogger.error.mock.calls[0]![1]).toEqual({ remoteAddress: "203.0.113.7" });
    });

    it("names the peer of an error raised inside a session", async () => {
      const server = await bootSingleServer();
      const failure = Object.assign(new Error("unexpected internal failure"), {
        remoteAddress: "203.0.113.8"
      });
      const details = pagedDetails(() => server.emit("error", failure));

      expect(details[0]).toContain("**Remote:** 203.0.113.8\n");
      expect(mockLogger.error.mock.calls[0]![1]).toEqual({ remoteAddress: "203.0.113.8" });
    });

    it("leaves the line out when the error has no peer", async () => {
      const server = await bootSingleServer();
      const details = pagedDetails(() => server.emit("error", new Error("listen EADDRINUSE")));

      expect(details.length).toBe(1);
      expect(details[0]).not.toContain("Remote");
    });

    it("keeps the peer out of suppressed warnings", async () => {
      const { implicitTls } = await bootWithTls();
      const meta = { protocol: "smtp", stage: "connect", remoteAddress: "203.0.113.9" };
      const details = pagedDetails(() =>
        implicitTls.emit("error", Object.assign(boringSslError("NO_SHARED_CIPHER"), { meta, remoteAddress: "203.0.113.9" }))
      );

      expect(details).toEqual([]);
      expect(mockLogger.warn.mock.calls.at(-1)![1]).toEqual({});
    });
  });

  it("logs error on non-suppressible failures", async () => {
    const server = await bootSingleServer();
    server.emit("error", new Error("unexpected internal failure"));

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const errArgs = mockLogger.error.mock.calls[0]!;
    expect(String(errArgs[0])).toContain("SMTP Server");
  });

  it("logs an info line on server close", async () => {
    const server = await bootSingleServer();
    mockLogger.info.mockReset();
    server.emit("close");
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(String(mockLogger.info.mock.calls[0]![0])).toContain("closed");
  });
});

describe("initializeSmtp configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    createdServers.length = 0;
    createdOptions.length = 0;
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
    process.env = { ...originalEnv };
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    delete process.env.SMTP_PORT;
    delete process.env.SMTPS_PORT;
    delete process.env.SMTP_SUBMISSION_PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("removes every transaction directory a previous process left, before listening", async () => {
    const leftover = path.join(INCOMING_ATTACHMENT_FOLDER, "crashed-seconds-ago");
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "1"), "partial attachment");
    let leftoverWhenListening: boolean | undefined;
    const createServer = mockCreateSmtpServer.getMockImplementation()!;
    mockCreateSmtpServer.mockImplementationOnce((opts) => {
      leftoverWhenListening = fs.existsSync(leftover);
      return createServer(opts);
    });

    const initializeSmtp = await loadInitializeSmtp();
    await initializeSmtp();

    expect(leftoverWhenListening).toBe(false);
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it("starts one plaintext server when SSL is not configured", async () => {
    const initializeSmtp = await loadInitializeSmtp();
    const servers = await initializeSmtp();

    expect(servers.length).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalled();
    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes("not configured"))).toBe(true);
  });

  it("warns and falls back to plaintext when SSL files are unreadable", async () => {
    process.env.SSL_CERTIFICATE = "/nonexistent/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/nonexistent/key.pem";
    const initializeSmtp = await loadInitializeSmtp();
    const servers = await initializeSmtp();

    expect(servers.length).toBe(1);
    // Configured-but-unusable TLS logs at ERROR (and alarms), not WARN: the
    // process keeps serving cleartext, so nothing else pages for it.
    const errors = mockLogger.error.mock.calls.map((c) => String(c[0]));
    expect(errors.some((m) => m.includes("SSL certificate files not readable"))).toBe(true);
  });

  it("starts three servers (SMTP + SMTPS + submission) when SSL files exist", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = mkdtempSync(join(tmpdir(), "smtp-ssl-test-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, "DUMMY CERT");
    writeFileSync(keyPath, "DUMMY KEY");
    process.env.SSL_CERTIFICATE = certPath;
    process.env.SSL_CERTIFICATE_KEY = keyPath;

    try {
      const initializeSmtp = await loadInitializeSmtp();
      const servers = await initializeSmtp();

      // One plaintext (25) + SMTPS (465) + submission (587) = 3
      expect(servers.length).toBe(3);
      // The "SSL certificate files not found" warning should NOT fire here.
      const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((m) => m.includes("SSL certificate files not found"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses custom SMTP_PORT / SMTPS_PORT / SMTP_SUBMISSION_PORT env values", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = mkdtempSync(join(tmpdir(), "smtp-port-test-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, "DUMMY CERT");
    writeFileSync(keyPath, "DUMMY KEY");
    process.env.SSL_CERTIFICATE = certPath;
    process.env.SSL_CERTIFICATE_KEY = keyPath;
    process.env.SMTP_PORT = "2525";
    process.env.SMTPS_PORT = "4465";
    process.env.SMTP_SUBMISSION_PORT = "5587";

    try {
      const initializeSmtp = await loadInitializeSmtp();
      const servers = await initializeSmtp();
      expect(servers.length).toBe(3);
      // Confirm logger.info recorded each port in its "listening on port N" message.
      const infos = mockLogger.info.mock.calls.map((c) => String(c[0]));
      expect(infos.some((m) => m.includes("2525"))).toBe(true);
      expect(infos.some((m) => m.includes("4465"))).toBe(true);
      expect(infos.some((m) => m.includes("5587"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A recipient check the listener was never handed refuses nothing, and no test
  // that calls the handler directly can see that. Driving the registered one is
  // what ties the two together.
  it("registers a recipient check that refuses a mailbox it does not hold", async () => {
    process.env.EMAIL_DOMAIN = "test.com";
    mockGetUser.mockReset();
    mockGetUser.mockImplementation(() => Promise.resolve(undefined));

    const initializeSmtp = await loadInitializeSmtp();
    await initializeSmtp();

    expect(createdOptions.length).toBe(1);
    const registered = createdOptions[0]!.onRcptTo as NonNullable<
      typeof onRcptTo
    >;
    const err = await new Promise<Error | null | undefined>((resolve) => {
      registered(
        { address: "x@nosuchuser.test.com" } as never,
        { remoteAddress: "1.2.3.4" } as unknown as SmtpSession,
        (e) => resolve(e)
      );
    });

    expect((err as Error & { responseCode?: number }).responseCode).toBe(550);
  });

  // `size` is what makes the listener advertise `SIZE` in EHLO and refuse a
  // `MAIL FROM` that declares more — the half a sending MTA acts on, which no
  // test that drives DATA can see.
  it("declares the message ceiling on every listener it starts", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = mkdtempSync(join(tmpdir(), "smtp-size-test-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, "DUMMY CERT");
    writeFileSync(keyPath, "DUMMY KEY");
    process.env.SSL_CERTIFICATE = certPath;
    process.env.SSL_CERTIFICATE_KEY = keyPath;

    try {
      const initializeSmtp = await loadInitializeSmtp();
      await initializeSmtp();

      expect(createdOptions.length).toBe(3);
      expect(createdOptions.map((options) => options.size)).toEqual([
        MAX_MESSAGE_BYTES,
        MAX_MESSAGE_BYTES,
        MAX_MESSAGE_BYTES
      ]);
      expect(createdOptions.map((options) => options.hideSize)).toEqual([
        undefined,
        undefined,
        undefined
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOutgoingSender", () => {
  const resolve = (
    from: { header?: string; envelope?: string },
    recipients: string[],
    addressedTo: string[] = []
  ) => resolveOutgoingSender("admin", "test.com", from, recipients, addressedTo);

  it("promotes the first same-domain recipient to sender and drops it", () => {
    expect(
      resolve({ header: "admin@test.com", envelope: "admin@test.com" }, [
        "outside@other.com",
        "sales@test.com",
        "later@other.com"
      ])
    ).toEqual({
      sender: "sales",
      recipients: ["outside@other.com", "later@other.com"]
    });
  });

  it("selects only the first same-domain recipient and keeps the rest", () => {
    expect(
      resolve({ envelope: "admin@test.com" }, [
        "sales@test.com",
        "support@test.com"
      ])
    ).toEqual({ sender: "sales", recipients: ["support@test.com"] });
  });

  it("keeps a From that already names another account of the domain", () => {
    expect(
      resolve({ header: "sales@test.com", envelope: "admin@test.com" }, [
        "outside@other.com",
        "support@test.com"
      ])
    ).toEqual({
      sender: "sales",
      recipients: ["outside@other.com", "support@test.com"]
    });
  });

  it("treats the login account among the recipients as a real recipient", () => {
    expect(
      resolve({ envelope: "admin@test.com" }, [
        "outside@other.com",
        "admin@test.com"
      ])
    ).toEqual({
      sender: "admin",
      recipients: ["outside@other.com", "admin@test.com"]
    });
  });

  it("matches the domain case-insensitively and normalizes the account", () => {
    expect(
      resolve({ envelope: "Admin@TEST.com" }, [
        "Sales@Test.com",
        "outside@other.com"
      ])
    ).toEqual({ sender: "sales", recipients: ["outside@other.com"] });
  });

  it("ignores a From header outside the user domain and falls back to the envelope", () => {
    expect(
      resolve({ header: "spoofed@evil.com", envelope: "admin@test.com" }, [
        "outside@other.com"
      ])
    ).toEqual({ sender: "admin", recipients: ["outside@other.com"] });
  });

  it("never lets a From header outside the user domain supply the sender", () => {
    expect(resolve({ header: "ceo@irs.gov" }, ["victim@other.com"])).toEqual({
      sender: "admin",
      recipients: ["victim@other.com"]
    });
    expect(
      resolve({ header: "ceo@irs.gov", envelope: "@test.com" }, [
        "victim@other.com"
      ])
    ).toEqual({ sender: "admin", recipients: ["victim@other.com"] });
  });

  it("lowercases a sender taken from the envelope", () => {
    expect(
      resolve({ envelope: "Bob@Test.com" }, ["outside@other.com"])
    ).toEqual({ sender: "bob", recipients: ["outside@other.com"] });
  });

  it("leaves a To recipient of the user's domain addressed, not promoted", () => {
    expect(
      resolve(
        { envelope: "admin@test.com" },
        ["bob@test.com", "friend@other.com"],
        ["bob@test.com", "friend@other.com"]
      )
    ).toEqual({
      sender: "admin",
      recipients: ["bob@test.com", "friend@other.com"]
    });
  });

  it("promotes a Cc account while a To account of the same domain stays addressed", () => {
    expect(
      resolve(
        { envelope: "admin@test.com" },
        ["bob@test.com", "sales@test.com"],
        ["bob@test.com"]
      )
    ).toEqual({ sender: "sales", recipients: ["bob@test.com"] });
  });

  it("keeps a lone same-domain recipient rather than emptying the recipient list", () => {
    expect(resolve({ envelope: "admin@test.com" }, ["sales@test.com"])).toEqual({
      sender: "admin",
      recipients: ["sales@test.com"]
    });
  });

  it("does not read a local part out of a two-at address", () => {
    expect(
      resolve({ header: "sales@evil.com@test.com", envelope: "admin@test.com" }, [
        "outside@other.com"
      ])
    ).toEqual({ sender: "admin", recipients: ["outside@other.com"] });
  });

  it("falls back to the username when no address carries a local part", () => {
    expect(resolve({ envelope: "@test.com" }, ["outside@other.com"])).toEqual({
      sender: "admin",
      recipients: ["outside@other.com"]
    });
  });

  it("scopes selection to the caller's own domain, not the bare mail domain", () => {
    expect(
      resolveOutgoingSender(
        "alice",
        "alice.test.com",
        { envelope: "alice@alice.test.com" },
        ["outside@other.com", "team@alice.test.com", "admin@test.com"],
        []
      )
    ).toEqual({
      sender: "team",
      recipients: ["outside@other.com", "admin@test.com"]
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Credential eviction: a rotated password has to reach connections that
// authenticated before it, because SMTP authenticates once per connection and
// never re-derives the grant from the stored hash.
// ───────────────────────────────────────────────────────────────────────────

interface StubConnection {
  session: { user?: string };
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

const makeConnection = (user?: string): StubConnection => ({
  session: { user },
  send: mock(() => {}),
  close: mock(() => {})
});

describe("evictSmtpConnections", () => {
  const originalEnv = process.env;
  let evictSmtpConnections: (username: string) => number;
  let server: FakeServer;

  beforeEach(async () => {
    createdServers.length = 0;
    process.env = { ...originalEnv };
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    const initializeSmtp = await loadInitializeSmtp();
    await initializeSmtp();
    server = createdServers[0]!;
    evictSmtpConnections = (await import("./smtp-registry")).evictSmtpConnections;
  });

  afterEach(() => {
    // "close" is what drops the server from the registry, so emitting it keeps
    // this file's fakes out of later suites' sweeps.
    createdServers.forEach((created) => created.emit("close"));
    process.env = originalEnv;
  });

  it("closes only the connections authenticated as the rotated username", () => {
    const alice = makeConnection("alice");
    const otherAlice = makeConnection("alice");
    const bob = makeConnection("bob");
    const anonymous = makeConnection(undefined);
    [alice, otherAlice, bob, anonymous].forEach((c) => server.connections.add(c));

    expect(evictSmtpConnections("alice")).toBe(2);

    [alice, otherAlice].forEach((c) => {
      expect(c.send).toHaveBeenCalledTimes(1);
      expect(c.send.mock.calls[0]![0]).toBe(421);
      expect(c.close).toHaveBeenCalledTimes(1);
    });
    expect(bob.close).not.toHaveBeenCalled();
    expect(anonymous.close).not.toHaveBeenCalled();
  });

  it("keeps sweeping after a connection refuses teardown", () => {
    const refuses = makeConnection("alice");
    refuses.close = mock(() => {
      throw new Error("socket already gone");
    });
    const healthy = makeConnection("alice");
    [refuses, healthy].forEach((c) => server.connections.add(c));

    expect(evictSmtpConnections("alice")).toBe(1);
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });

  it("reports nothing evicted when no connection matches", () => {
    server.connections.add(makeConnection("bob"));
    expect(evictSmtpConnections("alice")).toBe(0);
  });

  it("stops reaching a server that has closed", () => {
    const alice = makeConnection("alice");
    server.connections.add(alice);

    server.emit("close");

    expect(evictSmtpConnections("alice")).toBe(0);
    expect(alice.close).not.toHaveBeenCalled();
  });
});


/**
 * Proves the DATA budget is wired into `onData` itself, not merely correct in
 * isolation (`smtp-data-budget.test.ts` covers the semaphore in a vacuum).
 * Every assertion here drives SEVERAL transactions at once, because a test
 * that drives one cannot distinguish a bounded listener from an unbounded one
 * — the defect is only visible in the aggregate.
 */
describe("onData DATA budget wiring", () => {
  const CAP = smtpDataBudgetCapacity();
  const originalEnv = process.env;

  // A real stream, not a { pipe, on } stub: `onData` now runs every
  // transaction through `boundMessageSize`, which attaches real
  // `data`/`end`/`error` listeners the stub doesn't have.
  const makeStream = () => {
    const stream = new PassThrough();
    stream.end();
    return stream as unknown as Readable;
  };

  const incomingSession = () =>
    ({
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SmtpSession;

  const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  const nextTick = () => new Promise<void>((r) => setImmediate(r));

  beforeEach(() => {
    _resetSmtpDataBudget();
    mockSaveMailHandler.mockReset();
    mockSaveMailHandler.mockImplementation(() => Promise.resolve());
    mockParseMessage.mockReset();
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetSmtpDataBudget();
  });

  it("holds concurrent transactions to the capacity and still accepts them all", async () => {
    const gates: Array<ReturnType<typeof defer>> = [];
    let parsing = 0;
    let peakParsing = 0;
    mockParseMessage.mockImplementation(() => {
      parsing++;
      peakParsing = Math.max(peakParsing, parsing);
      const gate = defer();
      gates.push(gate);
      return gate.promise.then(() => {
        parsing--;
        return { attachments: [] };
      });
    });

    const total = CAP + 3;
    const settled = Array.from(
      { length: total },
      () =>
        new Promise<Error | null | undefined>((resolve) => {
          onData(makeStream(), incomingSession(), resolve);
        })
    );
    await nextTick();

    // The bound: `maxClients` would have let all `total` parse at once.
    expect(peakParsing).toBe(CAP);

    // Drain the queue — each release admits the next waiter, so the gate list
    // grows as we go and has to be walked rather than snapshotted.
    for (let drained = 0; drained < total; drained++) {
      gates[drained].resolve();
      await nextTick();
    }

    const errors = await Promise.all(settled);
    expect(errors.filter(Boolean)).toEqual([]);
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(total);
    expect(peakParsing).toBe(CAP);
    expect(smtpDataBudgetInFlight()).toBe(0);
  });

  it("refuses with 421 and drains the stream when no slot frees up in time", async () => {
    const holders = Array.from({ length: CAP }, () => defer());
    const held = holders.map((gate) => withSmtpDataBudget(() => gate.promise));
    await nextTick();

    const stream = makeStream();
    const resumeSpy = spyOn(stream, "resume");
    jest.useFakeTimers();
    let err: Error | null | undefined;
    try {
      const refused = new Promise<Error | null | undefined>((resolve) => {
        onData(stream, incomingSession(), resolve);
      });
      jest.advanceTimersByTime(smtpDataBudgetWaitCeilingMs() + 1);
      err = await refused;
    } finally {
      jest.useRealTimers();
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(421);
    // Without the drain the server waits for an `end` the stream cannot
    // emit, and the peer reads nothing until its own socket timeout.
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();

    holders.forEach((gate) => gate.resolve());
    await Promise.all(held);
  });

  it("frees the slot when a transaction fails, so the next one is admitted", async () => {
    mockParseMessage.mockImplementationOnce(() => Promise.reject(new Error("bad message")));
    mockParseMessage.mockImplementation(() => Promise.resolve({ attachments: [] }));

    const first = await new Promise<Error | null | undefined>((resolve) => {
      onData(makeStream(), incomingSession(), resolve);
    });
    expect(first).toBeInstanceOf(Error);
    expect(smtpDataBudgetInFlight()).toBe(0);

    const second = await new Promise<Error | null | undefined>((resolve) => {
      onData(makeStream(), incomingSession(), resolve);
    });
    expect(second).toBeFalsy();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });

  // A sender that goes silent mid-DATA without closing its socket leaves a
  // stream that fires none of `data`/`end`/`error`/`close`, so that is the
  // faithful repro, not a bug in the fixture.
  it("releases the slot when the connection is abandoned mid-DATA with no end/error ever firing", async () => {
    // Stands in for a parser call stuck reading a stream that will
    // never end — the only path to settlement left is the idle watchdog.
    mockParseMessage.mockImplementation(() => new Promise(() => {}));
    const abandonedStream = new PassThrough() as unknown as Readable;

    jest.useFakeTimers();
    let err: Error | null | undefined;
    try {
      const abandoned = new Promise<Error | null | undefined>((resolve) => {
        onData(abandonedStream, incomingSession(), resolve);
      });
      // The budget's slot-acquire and the executor's own Promise wrapper each
      // cost a microtask tick before `boundMessageSize` runs and arms the
      // real `setTimeout` — flush those before advancing the fake clock, or
      // there is no timer yet to advance.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      jest.advanceTimersByTime(DATA_IDLE_TIMEOUT_MS + 1);
      err = await abandoned;
    } finally {
      jest.useRealTimers();
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(421);
    expect(smtpDataBudgetInFlight()).toBe(0);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();

    // The slot is free again — without the watchdog this hangs forever. Under
    // real timers this arms a real 65s watchdog on the fresh transaction; the
    // mocked parser resolves independently of the stream, so without
    // waiting for the stream's own `end` here too, that real timer can
    // outlive this test and fire a stray warning during a later one.
    mockParseMessage.mockImplementation(() => Promise.resolve({ attachments: [] }));
    const secondStream = makeStream();
    const secondStreamEnded = new Promise<void>((resolve) => secondStream.once("end", resolve));
    const second = await new Promise<Error | null | undefined>((resolve) => {
      onData(secondStream, incomingSession(), resolve);
    });
    await secondStreamEnded;
    expect(second).toBeFalsy();
  });

  it("releases the slot at once for a connection that dropped while queued for it", async () => {
    mockParseMessage.mockImplementation(() => new Promise(() => {}));
    const holders = Array.from({ length: CAP }, () => defer());
    const held = holders.map((gate) => withSmtpDataBudget(() => gate.promise));
    await nextTick();

    const dropped = new PassThrough();
    dropped.write("Subject: half a message\r\n");
    const settled = new Promise<Error | null | undefined>((resolve) => {
      onData(dropped as unknown as Readable, incomingSession(), resolve);
    });
    await nextTick();
    dropped.destroy();
    await nextTick();

    holders[0].resolve();
    const err = await Promise.race([settled, Bun.sleep(1000).then(() => "still holding")]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(421);
    expect(smtpDataBudgetInFlight()).toBe(CAP - 1);

    holders.forEach((gate) => gate.resolve());
    await Promise.all(held);
  });

  it("re-arms the idle watchdog on every chunk, so a slow-but-live sender past the ceiling still completes", async () => {
    // Gated, not immediately-resolved: an unconditional mock would settle
    // `onDataIncoming`'s lane the instant `boundMessageSize` returns, before
    // a single chunk is written, making every chunk/clock-advance below
    // exercise a transaction that already finished — vacuously green whether
    // or not the watchdog actually re-arms.
    const gate = defer();
    mockParseMessage.mockImplementation(() => gate.promise.then(() => ({ attachments: [] })));
    const stream = new PassThrough() as unknown as Readable;
    // Waited for explicitly below so this test's own watchdog timer is
    // guaranteed cleared before it ends — otherwise a real leftover timer
    // can outlive this test and fire a stray warning during a later one.
    const streamEnded = new Promise<void>((resolve) => stream.once("end", resolve));

    jest.useFakeTimers();
    let err: Error | null | undefined;
    try {
      const result = new Promise<Error | null | undefined>((resolve) => {
        onData(stream, incomingSession(), resolve);
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Three chunks, each gap just under the ceiling but summing to nearly
      // triple it — survivable only if every chunk re-arms the watchdog
      // rather than one arm-on-start timer counting down regardless. The
      // parser is still gated here, so `result` can only have settled early
      // via the watchdog firing — the assertion below would catch it.
      for (let i = 0; i < 3; i++) {
        stream.write(Buffer.from(`chunk-${i}`));
        await Promise.resolve();
        jest.advanceTimersByTime(DATA_IDLE_TIMEOUT_MS - 1000);
      }

      stream.end();
      gate.resolve();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await streamEnded;

      err = await result;
    } finally {
      jest.useRealTimers();
    }

    expect(err).toBeFalsy();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });

  it("clears the idle watchdog on a normal completion, so a late tick never fires a spurious abandonment", async () => {
    mockParseMessage.mockImplementation(() => Promise.resolve({ attachments: [] }));
    // Bun's `spyOn`/`mock.module` tracking on a shared singleton is
    // process-global and can attribute an earlier test's call to this one's
    // spy — swapping the plain object property directly sidesteps that.
    const originalWarn = logger.warn;
    const warnCalls: unknown[][] = [];
    logger.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    const stream = makeStream();
    // `boundMessageSize`'s own `end` listener (which clears the watchdog) is
    // a sibling on this same event, not something the mocked parser's
    // resolution depends on — wait for it explicitly, or the clock advance
    // below races it instead of following it.
    const streamEnded = new Promise<void>((resolve) => stream.once("end", resolve));

    jest.useFakeTimers();
    try {
      const err = await new Promise<Error | null | undefined>((resolve) => {
        onData(stream, incomingSession(), resolve);
      });
      expect(err).toBeFalsy();
      await streamEnded;

      // Nothing should still be armed — advancing well past the ceiling must
      // not touch the budget or log an abandonment for a message already
      // delivered.
      jest.advanceTimersByTime(DATA_IDLE_TIMEOUT_MS * 2);
      expect(smtpDataBudgetInFlight()).toBe(0);
      expect(warnCalls).not.toContainEqual([
        "SMTP: DATA transaction abandoned mid-transfer, releasing its budget slot",
        expect.anything()
      ]);
    } finally {
      jest.useRealTimers();
      logger.warn = originalWarn;
    }
  });

  it("clears the idle watchdog on every other refusal too, not just a clean end", async () => {
    // `onDataIncoming` calls the parser unconditionally as soon as
    // `boundMessageSize` returns, independent of whether the byte ceiling
    // goes on to refuse the same message — needs an implementation or the
    // unmocked call throws before the ceiling ever gets a chance to run.
    mockParseMessage.mockImplementation(() => new Promise(() => {}));
    const originalWarn = logger.warn;
    const warnCalls: unknown[][] = [];
    logger.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    const stream = new PassThrough() as unknown as Readable;

    jest.useFakeTimers();
    try {
      const result = new Promise<Error | null | undefined>((resolve) => {
        onData(stream, incomingSession(), resolve);
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Oversized in one chunk — refuses via `drain()`, the same path an
      // abandoned-timeout refusal takes, before any `end` ever fires.
      stream.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1));
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const err = await result;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { responseCode?: number }).responseCode).toBe(552);
      warnCalls.length = 0;

      // The ceiling refusal already logged its own warning above — cleared
      // so only a stray abandonment warning from here on would show up.
      jest.advanceTimersByTime(DATA_IDLE_TIMEOUT_MS * 2);
      expect(smtpDataBudgetInFlight()).toBe(0);
      expect(warnCalls).not.toContainEqual([
        "SMTP: DATA transaction abandoned mid-transfer, releasing its budget slot",
        expect.anything()
      ]);
    } finally {
      jest.useRealTimers();
      logger.warn = originalWarn;
    }
  });
});
