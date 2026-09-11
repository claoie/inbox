import { describe, it, expect } from "bun:test";
import { SignedUser } from "common";
import {
  ADMIN_RO_USERNAME,
  refuseReadOnly,
  remapReadOnlySession,
} from "./read-only";

describe("ADMIN_RO_USERNAME", () => {
  it("names the reserved read-only credential", () => {
    // Pinning the literal — the source of truth every guard compares
    // against. A rename would flip every isReadOnly check to
    // `undefined === "admin-ro"` at the callers that duplicated it.
    expect(ADMIN_RO_USERNAME).toBe("admin-ro");
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

  it("does not mutate the caller's admin SignedUser", () => {
    // The remap constructs a new SignedUser — a caller that keeps the
    // original admin reference around (e.g. push logic) must not observe
    // isReadOnly=true on the effective user.
    remapReadOnlySession(admin, ADMIN_RO_USERNAME);
    expect(admin.isReadOnly).toBeUndefined();
    expect(admin.authenticatedAs).toBeUndefined();
  });
});
