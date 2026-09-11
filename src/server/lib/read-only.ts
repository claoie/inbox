import { SignedUser } from "common";

/**
 * Reserved username for the read-only administrative role. A row with this
 * username is upserted at boot when `ADMIN_RO_PASSWORD` is set. Authenticating
 * with these credentials produces a session whose effective identity is the
 * admin account (so every read path returns admin's data) while every mutating
 * surface refuses the write. The original username is preserved on the session
 * as `authenticatedAs`, so a compromised read-only credential is distinct in
 * audit logs from a compromised admin credential.
 */
export const ADMIN_RO_USERNAME = "admin-ro";

/**
 * Discriminated result returned by {@link refuseReadOnly}. A caller propagates
 * `!result.ok` into whatever refusal shape its surface uses (an API failed
 * response, an IMAP `NO` line, an SMTP 550) rather than each surface
 * open-coding the check.
 */
export type ReadOnlyGuardResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Returns `{ ok: false }` when the session was authenticated with a read-only
 * credential, otherwise `{ ok: true }`. The message names the effective
 * identity the caller is asking to mutate on, and the original credential
 * ("admin-ro") — so the refusal is legible both to the caller and to log
 * triage without leaking the effective identity's true username.
 */
export const refuseReadOnly = (
  sessionUser: Pick<SignedUser, "isReadOnly" | "authenticatedAs"> | undefined,
  context: string
): ReadOnlyGuardResult => {
  if (!sessionUser?.isReadOnly) return { ok: true };
  const attributedTo = sessionUser.authenticatedAs || ADMIN_RO_USERNAME;
  return {
    ok: false,
    message: `${context} not permitted for read-only user (${attributedTo}).`,
  };
};

/**
 * Constructs a SignedUser whose identity is the effective (data-owning) user
 * but whose session_id-scoped attribution names the read-only credential the
 * caller authenticated with. Read paths that key off `id` see the effective
 * user; mutating gates read `isReadOnly` and refuse.
 */
export const remapReadOnlySession = (
  effective: SignedUser,
  authenticatedAs: string
): SignedUser => {
  const remapped = new SignedUser(effective);
  remapped.isReadOnly = true;
  remapped.authenticatedAs = authenticatedAs;
  return remapped;
};
