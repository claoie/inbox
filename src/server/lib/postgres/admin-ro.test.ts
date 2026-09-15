/**
 * Boot-time reconciliation of the read-only admin account against
 * `ADMIN_RO_PASSWORD` — seeding when it is set, revoking when it is not.
 */
import { describe, it, expect, mock, spyOn, beforeEach, afterAll } from "bun:test";
import * as realRepositories from "./repositories";
import { ADMIN_RO_USERNAME } from "../read-only";
import { logger } from "../logger";

type WrittenUser = {
  user_id?: string;
  username: string;
  password?: string;
  email?: string;
};

const written: WrittenUser[] = [];
let existingRow: unknown = null;

const mockSearchUser = mock(async () => existingRow);
const mockDeleteSessionsAuthenticatedAs = mock(async (_authenticatedAs: string) => 2);
const mockWriteUser = mock(async (user: WrittenUser) => {
  written.push(user);
  return { _id: user.user_id ?? "generated-id" };
});

// Snapshot before mocking: `realRepositories` is the live namespace object and
// Bun mutates it in place when the mock installs, so restoring from it hands
// back the stubs and leaves the barrel mocked for every later file.
const REAL_REPOSITORIES = { ...realRepositories };

mock.module("./repositories", () => ({
  ...REAL_REPOSITORIES,
  searchUser: mockSearchUser,
  writeUser: mockWriteUser,
  deleteSessionsAuthenticatedAs: mockDeleteSessionsAuthenticatedAs,
}));

// `mock.module` is process-global with no unmock API — hand the real module
// back so the next file in the same run does not inherit these stubs.
afterAll(() => {
  mock.module("./repositories", () => REAL_REPOSITORIES);
});

const SEEDED_ROW = {
  user_id: "ro-user-id",
  username: ADMIN_RO_USERNAME,
  email: `${ADMIN_RO_USERNAME}@mydomain`,
};

const originalPassword = process.env.ADMIN_RO_PASSWORD;

const runInitialize = async () => {
  const { initializeAdminReadOnlyUser } = await import("./initialize");
  await initializeAdminReadOnlyUser();
};

describe("initializeAdminReadOnlyUser", () => {
  beforeEach(() => {
    written.length = 0;
    existingRow = null;
    mockWriteUser.mockClear();
    mockSearchUser.mockClear();
    mockDeleteSessionsAuthenticatedAs.mockClear();
  });

  afterAll(() => {
    if (originalPassword === undefined) delete process.env.ADMIN_RO_PASSWORD;
    else process.env.ADMIN_RO_PASSWORD = originalPassword;
  });

  it("seeds the account with the configured password when the variable is set", () => {
    process.env.ADMIN_RO_PASSWORD = "ro-secret";
    existingRow = SEEDED_ROW;
    return runInitialize().then(() => {
      expect(written).toHaveLength(1);
      expect(written[0].user_id).toBe(SEEDED_ROW.user_id);
      expect(written[0].username).toBe(ADMIN_RO_USERNAME);
      // Mutation-test the branch: a revoke that also swallowed the seed would
      // leave the operator with no way to turn the role on.
      expect(written[0].password).toBe("ro-secret");
    });
  });

  it("writes nothing when the variable is unset and no account was ever seeded", async () => {
    delete process.env.ADMIN_RO_PASSWORD;
    existingRow = null;
    await runInitialize();
    expect(mockWriteUser).not.toHaveBeenCalled();
  });

  it("revokes a previously seeded account when the variable is unset", async () => {
    delete process.env.ADMIN_RO_PASSWORD;
    existingRow = SEEDED_ROW;
    const infoSpy = spyOn(logger, "info");

    await runInitialize();

    expect(written).toHaveLength(1);
    // The row survives so a later re-enable keeps the same identity; what is
    // destroyed is the credential.
    expect(written[0].user_id).toBe(SEEDED_ROW.user_id);
    expect(written[0].email).toBe(SEEDED_ROW.email);
    expect(written[0].password).not.toBe("ro-secret");
    expect(written[0].password).toMatch(/^[0-9a-f]{64}$/);
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("deletes the sessions the revoked credential already issued", async () => {
    delete process.env.ADMIN_RO_PASSWORD;
    existingRow = SEEDED_ROW;

    await runInitialize();

    // Refusing new logins is not a revocation on its own: the cookie outlives
    // the password it was minted from and `rolling` renews its window.
    expect(mockDeleteSessionsAuthenticatedAs).toHaveBeenCalledTimes(1);
    expect(mockDeleteSessionsAuthenticatedAs.mock.calls[0][0]).toBe(
      ADMIN_RO_USERNAME
    );
  });

  it("leaves sessions alone when the variable is set", async () => {
    process.env.ADMIN_RO_PASSWORD = "ro-secret";
    existingRow = SEEDED_ROW;

    await runInitialize();

    expect(mockDeleteSessionsAuthenticatedAs).not.toHaveBeenCalled();
  });

  it("revokes with a password that exists nowhere, not a fixed sentinel", async () => {
    delete process.env.ADMIN_RO_PASSWORD;
    existingRow = SEEDED_ROW;

    await runInitialize();
    await runInitialize();

    // A constant here would be a credential published in the source tree.
    expect(written).toHaveLength(2);
    expect(written[0].password).not.toBe(written[1].password);
  });
});
