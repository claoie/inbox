/**
 * IMAP authentication: LOGIN and AUTHENTICATE PLAIN.
 *
 * This is the boundary where an unauthenticated socket either becomes a
 * session bound to a user or does not, so the assertions here are on the
 * exact wire line, not only on the returned value. The status word and the
 * `[AUTHENTICATIONFAILED]` response code (RFC 5530) are what clients branch
 * on: a refusal downgraded from `NO [AUTHENTICATIONFAILED]` to a bare `NO`
 * makes a mail client retry the same credentials forever instead of
 * prompting, and one promoted from `NO` to `OK` is an auth bypass.
 *
 * Two properties get stronger treatment than the response strings:
 *
 *  - **The bcrypt round is unconditional.** An implementation that skips the
 *    comparison when the user does not exist answers in a few microseconds
 *    instead of a few dozen milliseconds, which turns the auth endpoint into
 *    a username oracle. Asserting the refusal cannot see that difference —
 *    both implementations refuse — so the assertion is that `bcrypt.compare`
 *    ran, on a real hash, the same number of times as it does for a user that
 *    exists.
 *  - **A refusal past the threshold closes the socket.** The rate limiter
 *    only bounds brute force if the connection actually goes away, so these
 *    cases drive the real `closeSocket` and assert the socket ended.
 */

import { describe, it, expect, mock, spyOn, beforeEach, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { Socket } from "net";
import { SignedUser } from "common";
import { restoreLeaves } from "test-helpers";
import { ADMIN_RO_USERNAME, ADMIN_USERNAME } from "../read-only";
import { encryptPassword } from "../users";
import * as authRateLimit from "../auth-rate-limit";

const realBcrypt = (globalThis as Record<string, unknown>).__REAL_BCRYPT as {
  compare: (password: string, hash: string) => Promise<boolean>;
  hash: (password: string, rounds: number) => Promise<string>;
  default: Record<string, unknown>;
};

/**
 * Every `bcrypt.compare` the subject makes, as `[password, hash]`. The real
 * implementation still runs — a stub that returned a constant would make the
 * success cases pass without a working comparison.
 */
const compareCalls: [string, string][] = [];
const trackedCompare = (password: string, hash: string) => {
  compareCalls.push([password, hash]);
  return realBcrypt.compare(password, hash);
};

mock.module("bcryptjs", () => ({
  ...realBcrypt,
  compare: trackedCompare,
  default: { ...realBcrypt.default, compare: trackedCompare },
}));

const realServer = (globalThis as Record<string, unknown>).__REAL_SERVER as Record<
  string,
  unknown
>;

const mockGetUser = mock((_input: unknown): Promise<unknown> => Promise.resolve(null));
const mockLoggerInfo = mock(() => {});
const mockLogger = {
  debug: mock(() => {}),
  info: mockLoggerInfo,
  warn: mock(() => {}),
  error: mock(() => {}),
};

/**
 * Spread the real barrel rather than listing the exports the subject uses:
 * `mock.module` replaces the export graph-wide, so a hand-picked object
 * deletes every other `server` export for the rest of this file — including
 * the ones `Store` and `ImapSession` reach for on the success path.
 */
const serverMock = () => ({ ...realServer, getUser: mockGetUser, logger: mockLogger });
mock.module("server", serverMock);

/**
 * `spyOn` rather than `mock.module` for the rate limiter: the module owns
 * process-wide counter state that its own suite asserts on, and a global
 * module replacement would outlive this file. Real `recordAuthFailure` also
 * sleeps 500ms per call by design.
 */
const mockIsAuthRateLimited = spyOn(authRateLimit, "isAuthRateLimited").mockReturnValue(false);
const mockRecordAuthFailure = spyOn(authRateLimit, "recordAuthFailure").mockResolvedValue(false);
const mockResetAuthFailures = spyOn(authRateLimit, "resetAuthFailures").mockReturnValue(undefined);

const { handleAuthenticate, handleLogin } = await import("./auth");
const { ImapRequestHandler } = await import("./handler");

afterAll(() => {
  mockIsAuthRateLimited.mockRestore();
  mockRecordAuthFailure.mockRestore();
  mockResetAuthFailures.mockRestore();
  mock.module("server", () => realServer);
  restoreLeaves();
});

const REMOTE_IP = "203.0.113.7";
const CAPABILITIES = "IMAP4rev1 AUTH=PLAIN";

/** A complete bcrypt digest — 22 salt chars plus 31 of hash, base64-ish alphabet. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** The cost field of a bcrypt digest — `10` out of `$2b$10$…`. */
const costOf = (hash: string) => hash.split("$")[2];

interface FakeSocket extends EventEmitter {
  writes: string[];
  writable: boolean;
  destroyed: boolean;
  remoteAddress: string;
  remotePort: number;
  write: (data: string) => boolean;
  setTimeout: () => void;
  destroy: () => void;
  end: () => void;
}

function makeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
  socket.remoteAddress = REMOTE_IP;
  socket.remotePort = 45678;
  socket.write = (data: string) => {
    socket.writes.push(data);
    return true;
  };
  socket.setTimeout = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  // `closeSocket` arms a destroy timer and clears it on "close"; a socket with
  // an empty write queue — which is every socket built here — closes as soon
  // as `end` is called, so the fixture has to emit it or the teardown looks
  // like it never happened.
  socket.end = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
}

/** Harness matching what `ImapSession` hands the subject. */
function makeHarness() {
  const socket = makeSocket();
  const pendingSaslTags: string[] = [];
  return {
    socket,
    pendingSaslTags,
    args: [
      socket as unknown as Socket,
      (data: string) => socket.write(data),
      (tag: string) => pendingSaslTags.push(tag),
      () => CAPABILITIES,
    ] as const,
  };
}

const plainResponse = (username: string, password: string) =>
  Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64");

const signedUser = { id: "user-1", username: "admin", email: "admin@test.com" };

/** Cost 4 keeps the fixture hashes real bcrypt digests without the 10-round wait. */
const hashOf = (password: string) => realBcrypt.hash(password, 4);

beforeEach(() => {
  compareCalls.length = 0;
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(() => Promise.resolve(null));
  mockLoggerInfo.mockReset();
  mockIsAuthRateLimited.mockReset();
  mockIsAuthRateLimited.mockImplementation(() => false);
  mockRecordAuthFailure.mockReset();
  mockRecordAuthFailure.mockImplementation(() => Promise.resolve(false));
  mockResetAuthFailures.mockReset();
  mockResetAuthFailures.mockImplementation(() => undefined);
});

describe("handleAuthenticate", () => {
  it("refuses a mechanism other than PLAIN without consulting the user store", async () => {
    const { socket, args } = makeHarness();

    const result = await handleAuthenticate("A1", "LOGIN", "anything", ...args);

    expect(result).toBeNull();
    expect(socket.writes).toEqual(["A1 NO Only PLAIN authentication supported\r\n"]);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("issues an empty continuation and remembers the tag when no initial response is sent", async () => {
    const { socket, args, pendingSaslTags } = makeHarness();

    const result = await handleAuthenticate("A2", "PLAIN", undefined, ...args);

    expect(result).toBeNull();
    expect(socket.writes).toEqual(["+ \r\n"]);
    expect(pendingSaslTags).toEqual(["A2"]);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(compareCalls).toHaveLength(0);
  });

  it("closes the socket for an already rate-limited address before decoding the response", async () => {
    const { socket, args } = makeHarness();
    mockIsAuthRateLimited.mockImplementation(() => true);

    const result = await handleAuthenticate(
      "A3",
      "PLAIN",
      plainResponse("admin", "hunter2"),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "A3 NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n",
    ]);
    expect(socket.destroyed).toBe(true);
    expect(mockIsAuthRateLimited).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
  });

  const malformed: [string, string][] = [
    ["two parts", Buffer.from("admin\0hunter2", "utf8").toString("base64")],
    ["four parts", Buffer.from("\0admin\0hunter2\0extra", "utf8").toString("base64")],
    ["a single part", Buffer.from("admin", "utf8").toString("base64")],
  ];

  for (const [label, payload] of malformed) {
    it(`rejects a PLAIN response carrying ${label}`, async () => {
      const { socket, args } = makeHarness();

      const result = await handleAuthenticate("A4", "PLAIN", payload, ...args);

      expect(result).toBeNull();
      expect(socket.writes).toEqual(["A4 BAD Invalid PLAIN response format\r\n"]);
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(socket.destroyed).toBe(false);
    });
  }

  it("treats an empty initial response as absent rather than as malformed framing", async () => {
    const { socket, args, pendingSaslTags } = makeHarness();

    const result = await handleAuthenticate("A4b", "PLAIN", "", ...args);

    expect(result).toBeNull();
    expect(socket.writes).toEqual(["+ \r\n"]);
    expect(pendingSaslTags).toEqual(["A4b"]);
  });

  it("refuses an unknown user with AUTHENTICATIONFAILED and records the failure", async () => {
    const { socket, args } = makeHarness();

    const result = await handleAuthenticate(
      "A5",
      "PLAIN",
      plainResponse("nobody", "hunter2"),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "A5 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("refuses a wrong password for a user that does exist", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf("correct-horse"),
      getSigned: () => signedUser,
    }));

    const result = await handleAuthenticate(
      "A6",
      "PLAIN",
      plainResponse("admin", "wrong"),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "A6 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith(REMOTE_IP);
  });

  it("refuses an empty password even when the stored hash would match it", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf(""),
      getSigned: () => signedUser,
    }));

    const result = await handleAuthenticate("A7", "PLAIN", plainResponse("admin", ""), ...args);

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "A7 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
  });

  it("closes the socket on the failure that crosses the threshold", async () => {
    const { socket, args } = makeHarness();
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(true));

    const result = await handleAuthenticate(
      "A8",
      "PLAIN",
      plainResponse("nobody", "hunter2"),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "A8 NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n",
    ]);
    expect(socket.destroyed).toBe(true);
  });

  it("completes with a capability list and a store bound to the signed user", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf("correct-horse"),
      getSigned: () => signedUser,
    }));

    const result = await handleAuthenticate(
      "A9",
      "PLAIN",
      plainResponse("admin", "correct-horse"),
      ...args
    );

    expect(result).not.toBeNull();
    expect(result!.authenticated).toBe(true);
    expect(result!.isReadOnly).toBe(false);
    expect(result!.authenticatedAs).toBe("admin");
    expect(result!.store.getUser()).toBe(signedUser as never);
    expect(socket.writes).toEqual([
      `A9 OK [CAPABILITY ${CAPABILITIES}] AUTHENTICATE completed\r\n`,
    ]);
    expect(mockResetAuthFailures).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("logs the successful authentication at INFO with the account and remote peer", async () => {
    const { args } = makeHarness();
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf("correct-horse"),
      getSigned: () => signedUser,
    }));

    await handleAuthenticate("A10", "PLAIN", plainResponse("admin", "correct-horse"), ...args);

    expect(mockLoggerInfo).toHaveBeenCalledWith("IMAP AUTHENTICATE success", {
      component: "imap",
      tag: "A10",
      authenticatedAs: "admin",
      effectiveUsername: "admin",
      isReadOnly: false,
      remote: `${REMOTE_IP}:45678`,
      mechanism: "PLAIN",
    });
  });

  it("answers BAD rather than propagating when the user lookup throws", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(() => Promise.reject(new Error("connection terminated")));

    const result = await handleAuthenticate(
      "A11",
      "PLAIN",
      plainResponse("admin", "hunter2"),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual(["A11 BAD AUTHENTICATE failed\r\n"]);
    expect(socket.destroyed).toBe(false);
  });
});

describe("handleLogin", () => {
  const loginArgs = (harness: ReturnType<typeof makeHarness>) =>
    [harness.args[0], harness.args[1], harness.args[3]] as const;

  it("rejects a LOGIN missing its password argument", async () => {
    const harness = makeHarness();

    const result = await handleLogin("B1", ["admin"], ...loginArgs(harness));

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "B1 BAD LOGIN requires username and password\r\n",
    ]);
    expect(mockIsAuthRateLimited).not.toHaveBeenCalled();
  });

  it("closes the socket for an already rate-limited address before reading the credentials", async () => {
    const harness = makeHarness();
    mockIsAuthRateLimited.mockImplementation(() => true);

    const result = await handleLogin("B2", ["admin", "hunter2"], ...loginArgs(harness));

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "B2 NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n",
    ]);
    expect(harness.socket.destroyed).toBe(true);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
  });

  it("strips the surrounding quotes of a quoted-string username and password", async () => {
    const harness = makeHarness();
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf("correct-horse"),
      getSigned: () => signedUser,
    }));

    const result = await handleLogin(
      "B3",
      ['"admin"', '"correct-horse"'],
      ...loginArgs(harness)
    );

    expect(mockGetUser).toHaveBeenCalledWith({
      username: "admin",
      password: "correct-horse",
    });
    expect(result).not.toBeNull();
    expect(harness.socket.writes).toEqual([
      `B3 OK [CAPABILITY ${CAPABILITIES}] LOGIN completed\r\n`,
    ]);
  });

  it("leaves an unquoted atom untouched", async () => {
    const harness = makeHarness();

    await handleLogin("B4", ["admin", "hunter2"], ...loginArgs(harness));

    expect(mockGetUser).toHaveBeenCalledWith({ username: "admin", password: "hunter2" });
  });

  it("refuses an unknown user with AUTHENTICATIONFAILED and records the failure", async () => {
    const harness = makeHarness();

    const result = await handleLogin("B5", ["nobody", "hunter2"], ...loginArgs(harness));

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "B5 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
    expect(harness.socket.destroyed).toBe(false);
  });

  it("refuses an account with no signable identity instead of throwing", async () => {
    const harness = makeHarness();
    // `getSigned` returns undefined unless id, username, email and password
    // are all present, so a row can hold a matching password hash and still
    // have no identity to bind a session to.
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf("correct-horse"),
      getSigned: () => undefined,
    }));

    const result = await handleLogin("B6", ["admin", "correct-horse"], ...loginArgs(harness));

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "B6 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
  });

  it("closes the socket on the failure that crosses the threshold", async () => {
    const harness = makeHarness();
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(true));

    const result = await handleLogin("B7", ["nobody", "hunter2"], ...loginArgs(harness));

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "B7 NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n",
    ]);
    expect(harness.socket.destroyed).toBe(true);
  });

  it("propagates a throwing user lookup instead of answering BAD, unlike AUTHENTICATE", async () => {
    const harness = makeHarness();
    mockGetUser.mockImplementation(() => Promise.reject(new Error("connection terminated")));

    await expect(
      handleLogin("B9", ["admin", "hunter2"], ...loginArgs(harness))
    ).rejects.toThrow("connection terminated");
    expect(harness.socket.writes).toEqual([]);
  });

  it("completes with a capability list, a bound store, and a reset failure counter", async () => {
    const harness = makeHarness();
    mockGetUser.mockImplementation(async () => ({
      password: await hashOf("correct-horse"),
      getSigned: () => signedUser,
    }));

    const result = await handleLogin("B8", ["admin", "correct-horse"], ...loginArgs(harness));

    expect(result).not.toBeNull();
    expect(result!.authenticated).toBe(true);
    expect(result!.isReadOnly).toBe(false);
    expect(result!.authenticatedAs).toBe("admin");
    expect(result!.store.getUser()).toBe(signedUser as never);
    expect(harness.socket.writes).toEqual([
      `B8 OK [CAPABILITY ${CAPABILITIES}] LOGIN completed\r\n`,
    ]);
    expect(mockResetAuthFailures).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    expect(harness.socket.destroyed).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith("IMAP LOGIN success", {
      component: "imap",
      tag: "B8",
      authenticatedAs: "admin",
      effectiveUsername: "admin",
      isReadOnly: false,
      remote: `${REMOTE_IP}:45678`,
    });
  });
});

describe("username enumeration resistance", () => {
  const existingUser = async () => ({
    password: await hashOf("correct-horse"),
    getSigned: () => signedUser,
  });

  it("runs a bcrypt comparison against a real digest when AUTHENTICATE names no known user", async () => {
    const { args } = makeHarness();

    await handleAuthenticate("C1", "PLAIN", plainResponse("nobody", "hunter2"), ...args);

    expect(compareCalls).toHaveLength(1);
    const [password, hash] = compareCalls[0]!;
    expect(password).toBe("hunter2");
    expect(hash).toMatch(BCRYPT_HASH);
  });

  it("runs a bcrypt comparison against a real digest when LOGIN names no known user", async () => {
    const harness = makeHarness();

    await handleLogin("C2", ["nobody", "hunter2"], harness.args[0], harness.args[1], harness.args[3]);

    expect(compareCalls).toHaveLength(1);
    const [password, hash] = compareCalls[0]!;
    expect(password).toBe("hunter2");
    expect(hash).toMatch(BCRYPT_HASH);
  });

  it("spends the same number of bcrypt rounds on an unknown user as on a wrong password", async () => {
    const unknown = makeHarness();
    await handleAuthenticate("C3", "PLAIN", plainResponse("nobody", "hunter2"), ...unknown.args);
    const unknownUserRounds = compareCalls.length;

    compareCalls.length = 0;
    mockGetUser.mockImplementation(existingUser);
    const known = makeHarness();
    await handleAuthenticate("C4", "PLAIN", plainResponse("admin", "hunter2"), ...known.args);
    const wrongPasswordRounds = compareCalls.length;

    expect(unknownUserRounds).toBe(1);
    expect(wrongPasswordRounds).toBe(unknownUserRounds);
    expect(unknown.socket.writes).toEqual(known.socket.writes.map((w) => w.replace("C4", "C3")));
  });

  it("compares an unknown user against a digest of the cost the app hashes at", async () => {
    const { args } = makeHarness();

    await handleAuthenticate("C7", "PLAIN", plainResponse("nobody", "hunter2"), ...args);

    // Derived from the app's own hasher rather than written as a literal: a
    // dummy hash cheaper than what real accounts carry answers in a few
    // milliseconds against a few dozen, which is the oracle this path closes
    // — and its shape stays well-formed the whole way down.
    expect(costOf(compareCalls[0]![1])).toBe(costOf(await encryptPassword("x")));
  });

  it("does not reuse a real account's digest for the unknown-user comparison", async () => {
    mockGetUser.mockImplementation(existingUser);
    const known = makeHarness();
    await handleLogin("C5", ["admin", "hunter2"], known.args[0], known.args[1], known.args[3]);
    const realHash = compareCalls[0]![1];

    compareCalls.length = 0;
    mockGetUser.mockImplementation(() => Promise.resolve(null));
    const unknown = makeHarness();
    await handleLogin("C6", ["nobody", "hunter2"], unknown.args[0], unknown.args[1], unknown.args[3]);

    expect(compareCalls[0]![1]).not.toBe(realHash);
    expect(await realBcrypt.compare("hunter2", compareCalls[0]![1])).toBe(false);
  });
});

describe("read-only credential session resolution", () => {
  const RO_PASSWORD = "ro-secret";
  const roSigned = new SignedUser({
    id: "user-ro",
    username: ADMIN_RO_USERNAME,
    email: "admin-ro@test.com",
  });
  const adminSigned = new SignedUser({
    id: "user-admin",
    username: ADMIN_USERNAME,
    email: "admin@test.com",
    token: "reset-token",
    expiry: "2026-01-01",
  });

  /**
   * `resolveSessionUser` looks the effective account up by username alone, so
   * the store answers the second call without a password.
   */
  const withAdminRow = (adminRow: unknown) => async (input: unknown) => {
    const { username } = input as { username: string };
    if (username === ADMIN_RO_USERNAME) {
      return { password: await hashOf(RO_PASSWORD), getSigned: () => roSigned };
    }
    if (username === ADMIN_USERNAME) return adminRow;
    return null;
  };

  const adminRow = { password: "unused", getSigned: () => adminSigned };

  it("binds the store to the effective account while attributing the credential", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(adminRow));

    const result = await handleAuthenticate(
      "E1",
      "PLAIN",
      plainResponse(ADMIN_RO_USERNAME, RO_PASSWORD),
      ...args
    );

    expect(result).not.toBeNull();
    expect(result!.isReadOnly).toBe(true);
    expect(result!.authenticatedAs).toBe(ADMIN_RO_USERNAME);
    const sessionUser = result!.store.getUser();
    expect(sessionUser.id).toBe(adminSigned.id);
    expect(sessionUser.username).toBe(ADMIN_USERNAME);
    expect(sessionUser.isReadOnly).toBe(true);
    expect(sessionUser.authenticatedAs).toBe(ADMIN_RO_USERNAME);
    // The remap must not carry the effective account's password-reset
    // credential onto a session the read-only caller holds.
    expect(sessionUser.token).toBeUndefined();
    expect(sessionUser.expiry).toBeUndefined();
    expect(socket.writes).toEqual([
      `E1 OK [CAPABILITY ${CAPABILITIES}] AUTHENTICATE completed\r\n`,
    ]);
  });

  it("attributes the audit line to the credential, not the effective account", async () => {
    const { args } = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(adminRow));

    await handleAuthenticate("E2", "PLAIN", plainResponse(ADMIN_RO_USERNAME, RO_PASSWORD), ...args);

    expect(mockLoggerInfo).toHaveBeenCalledWith("IMAP AUTHENTICATE success", {
      component: "imap",
      tag: "E2",
      authenticatedAs: ADMIN_RO_USERNAME,
      effectiveUsername: ADMIN_USERNAME,
      isReadOnly: true,
      remote: `${REMOTE_IP}:45678`,
      mechanism: "PLAIN",
    });
  });

  it("refuses the read-only credential when the effective account does not exist", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(null));

    const result = await handleAuthenticate(
      "E3",
      "PLAIN",
      plainResponse(ADMIN_RO_USERNAME, RO_PASSWORD),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "E3 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("closes the socket when that refusal crosses the threshold", async () => {
    const { socket, args } = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(null));
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(true));

    const result = await handleAuthenticate(
      "E4",
      "PLAIN",
      plainResponse(ADMIN_RO_USERNAME, RO_PASSWORD),
      ...args
    );

    expect(result).toBeNull();
    expect(socket.writes).toEqual([
      "E4 NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n",
    ]);
    expect(socket.destroyed).toBe(true);
  });

  it("applies the same remap to LOGIN", async () => {
    const harness = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(adminRow));

    const result = await handleLogin(
      "E5",
      [ADMIN_RO_USERNAME, RO_PASSWORD],
      harness.args[0],
      harness.args[1],
      harness.args[3]
    );

    expect(result).not.toBeNull();
    expect(result!.isReadOnly).toBe(true);
    expect(result!.authenticatedAs).toBe(ADMIN_RO_USERNAME);
    expect(result!.store.getUser().id).toBe(adminSigned.id);
    expect(harness.socket.writes).toEqual([
      `E5 OK [CAPABILITY ${CAPABILITIES}] LOGIN completed\r\n`,
    ]);
  });

  it("closes the LOGIN socket when that refusal crosses the threshold", async () => {
    const harness = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(null));
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(true));

    const result = await handleLogin(
      "E7",
      [ADMIN_RO_USERNAME, RO_PASSWORD],
      harness.args[0],
      harness.args[1],
      harness.args[3]
    );

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "E7 NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n",
    ]);
    expect(harness.socket.destroyed).toBe(true);
  });

  it("refuses the read-only credential on LOGIN when the effective account does not exist", async () => {
    const harness = makeHarness();
    mockGetUser.mockImplementation(withAdminRow(null));

    const result = await handleLogin(
      "E6",
      [ADMIN_RO_USERNAME, RO_PASSWORD],
      harness.args[0],
      harness.args[1],
      harness.args[3]
    );

    expect(result).toBeNull();
    expect(harness.socket.writes).toEqual([
      "E6 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n",
    ]);
    expect(mockRecordAuthFailure).toHaveBeenCalledWith(REMOTE_IP);
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
    expect(harness.socket.destroyed).toBe(false);
  });
});

describe("SASL continuation line", () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("cancels the exchange on a bare asterisk without reaching the user store", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeSocket();
    handler.setSocket(socket as unknown as Socket);
    handler.setPendingSaslTag("D1");

    socket.emit("data", Buffer.from("*\r\n"));
    await settle();

    expect(socket.writes).toContain("D1 BAD Authentication cancelled\r\n");
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("forgets the tag after the cancel, so the next line is read as a command", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeSocket();
    handler.setSocket(socket as unknown as Socket);
    handler.setPendingSaslTag("D2");

    socket.emit("data", Buffer.from("*\r\n"));
    await settle();
    socket.writes.length = 0;
    socket.emit("data", Buffer.from("*\r\n"));
    await settle();

    expect(socket.writes.join("")).not.toContain("Authentication cancelled");
  });

  it("feeds a base64 continuation into the PLAIN exchange", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeSocket();
    handler.setSocket(socket as unknown as Socket);
    handler.setPendingSaslTag("D3");

    socket.emit("data", Buffer.from(`${plainResponse("nobody", "hunter2")}\r\n`));
    await settle();

    expect(mockGetUser).toHaveBeenCalledWith({ username: "nobody", password: "hunter2" });
    expect(socket.writes).toContain("D3 NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n");
  });
});
