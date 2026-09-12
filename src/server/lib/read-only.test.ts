import { describe, it, expect } from "bun:test";
import { SignedUser } from "common";
import {
  ADMIN_USERNAME,
  ADMIN_RO_USERNAME,
  deliversToAdminMailbox,
  isReservedUsername,
  refuseReadOnly,
  remapReadOnlySession,
} from "./read-only";
import { getDomain } from "./util";

describe("ADMIN_RO_USERNAME", () => {
  it("names the reserved read-only credential", () => {
    // Pinning the literal — the source of truth every guard compares
    // against. A rename would flip every isReadOnly check to
    // `undefined === "admin-ro"` at the callers that duplicated it.
    expect(ADMIN_RO_USERNAME).toBe("admin-ro");
  });
});

describe("deliversToAdminMailbox", () => {
  const domain = getDomain();

  it("matches the addresses whose mail is stored under admin's user_id", () => {
    // Both spellings route to admin on the receive path, so a magic link sent
    // to either is retrievable by a read-only session.
    expect(deliversToAdminMailbox(`victim@${domain}`)).toBe(true);
    expect(deliversToAdminMailbox(`victim@${ADMIN_USERNAME}.${domain}`)).toBe(true);
  });

  it("does not match another user's subdomain or an outside address", () => {
    // Mutation-test the discriminator: a predicate that answered true for
    // every address would refuse every signup on the server.
    expect(deliversToAdminMailbox(`bob@bob.${domain}`)).toBe(false);
    expect(deliversToAdminMailbox("victim@example.com")).toBe(false);
    expect(deliversToAdminMailbox(`victim@not-${domain}.example.com`)).toBe(false);
  });

  it("keys off the address domain, not its local part", () => {
    expect(deliversToAdminMailbox(`${ADMIN_USERNAME}@example.com`)).toBe(false);
  });
});

describe("isReservedUsername", () => {
  it("matches both boot-seeded accounts", () => {
    expect(isReservedUsername(ADMIN_USERNAME)).toBe(true);
    expect(isReservedUsername(ADMIN_RO_USERNAME)).toBe(true);
  });

  it("does not match ordinary usernames or a missing one", () => {
    // Mutation-test the discriminator: a set that swallowed every username
    // would lock every real signup out of the email reset flow.
    expect(isReservedUsername("alice")).toBe(false);
    expect(isReservedUsername("admin2")).toBe(false);
    expect(isReservedUsername("")).toBe(false);
    expect(isReservedUsername(undefined)).toBe(false);
  });
});

describe("refuseReadOnly", () => {
  const admin: SignedUser = new SignedUser({
    id: "admin-id",
    username: "admin",
    email: "admin@localhost",
  });

  it("returns { ok: true } for a non-read-only session", () => {
    // Mutation-test the discriminator: a non-read-only session must not
    // hit the refusal branch, whatever the caller passes as context.
    expect(refuseReadOnly(admin, "Sending mail")).toEqual({ ok: true });
  });

  it("returns { ok: true } when the session user is undefined", () => {
    // A missing session user is not the read-only user — no
    // false-positive refusal on unauthenticated code paths.
    expect(refuseReadOnly(undefined, "Sending mail")).toEqual({ ok: true });
  });

  it("returns { ok: false, message } naming the original credential", () => {
    const ro = remapReadOnlySession(admin, ADMIN_RO_USERNAME);
    const result = refuseReadOnly(ro, "Sending mail");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The refusal message must name the ORIGINAL credential
    // (`authenticatedAs`) — not the effective username — so audit lines
    // don't misattribute a read-only action to admin.
    expect(result.message).toContain(ADMIN_RO_USERNAME);
    expect(result.message).toContain("Sending mail");
    expect(result.message).not.toContain("admin@");
  });

  it("falls back to the reserved username when authenticatedAs is missing", () => {
    // Defensive: an isReadOnly flag set without an authenticatedAs
    // should not print `undefined` into the audit trail.
    const stripped = { isReadOnly: true } as Pick<
      SignedUser,
      "isReadOnly" | "authenticatedAs"
    >;
    const result = refuseReadOnly(stripped, "Sending mail");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain(ADMIN_RO_USERNAME);
    expect(result.message).not.toContain("undefined");
  });
});

describe("remapReadOnlySession", () => {
  const admin: SignedUser = new SignedUser({
    id: "admin-id",
    username: "admin",
    email: "admin@localhost",
  });

  it("returns a SignedUser with admin's effective identity", () => {
    // Every read path keys off `id` — the remapped session's id MUST be
    // admin's, otherwise the read-only role would read from its own
    // (empty) inbox and the whole design is defeated.
    const ro = remapReadOnlySession(admin, ADMIN_RO_USERNAME);
    expect(ro.id).toBe("admin-id");
    expect(ro.email).toBe("admin@localhost");
    expect(ro.username).toBe("admin");
  });

  it("stamps isReadOnly=true and authenticatedAs on the returned user", () => {
    const ro = remapReadOnlySession(admin, ADMIN_RO_USERNAME);
    expect(ro.isReadOnly).toBe(true);
    expect(ro.authenticatedAs).toBe(ADMIN_RO_USERNAME);
  });

  it("drops the effective identity's token and expiry", () => {
    // Both login routes return the session object to the client verbatim and
    // `mask()` retains token/expiry, so carrying them across the read-only
    // boundary would hand admin's live password-reset credential to a
    // read-only caller.
    const withReset = new SignedUser({
      id: "admin-id",
      username: "admin",
      email: "admin@localhost",
      token: "live-reset-token",
      expiry: "2999-01-01T00:00:00.000Z",
    });
    const ro = remapReadOnlySession(withReset, ADMIN_RO_USERNAME);
    expect(ro.token).toBeUndefined();
    expect(ro.expiry).toBeUndefined();
    expect(JSON.stringify(ro)).not.toContain("live-reset-token");
    // The effective identity itself is untouched — admin's own session must
    // still carry its reset state.
    expect(withReset.token).toBe("live-reset-token");
  });

  it("does not mutate the caller's admin SignedUser", () => {
    // The remap constructs a new SignedUser — a caller that keeps the
    // original admin reference around (e.g. push logic) must not observe
    // isReadOnly=true on the effective user.
    remapReadOnlySession(admin, ADMIN_RO_USERNAME);
    expect(admin.isReadOnly).toBeUndefined();
    expect(admin.authenticatedAs).toBeUndefined();
  });
});
