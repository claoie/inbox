import bcrypt from "bcryptjs";
import { MaskedUser } from "common";
import {
  getUser,
  logger,
  ADMIN_USERNAME,
  ADMIN_RO_USERNAME,
  remapReadOnlySession,
} from "server";
import { Route } from "../route";
import { getClientIp, loginLimiter } from "../../rate-limit";

export type LoginPostResponse = MaskedUser;

// Valid bcrypt hash used as a constant-time dummy to prevent timing-based
// username enumeration. bcrypt.compare still runs its full cost-10 work
// when the user is not found, so response time is indistinguishable.
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    // Validate body shape before processing.
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "failed", message: "Invalid request body." };
    }

    const { email, username, password } = body as Record<string, unknown>;

    if (typeof password !== "string" || !password) {
      return { status: "failed", message: "Invalid credentials." };
    }
    if (email !== undefined && typeof email !== "string") {
      return { status: "failed", message: "Invalid credentials." };
    }
    if (username !== undefined && typeof username !== "string") {
      return { status: "failed", message: "Invalid credentials." };
    }

    const inputUser = { email: email as string | undefined, username: username as string | undefined };
    const user = await getUser(inputUser);
    const signedUser = user?.getSigned();

    // Always run bcrypt.compare regardless of whether the user exists.
    // This prevents timing attacks that could reveal valid usernames.
    const pwMatches = user
      ? await bcrypt.compare(password, user.password as string)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    const ip = getClientIp(req);

    if (!pwMatches || !signedUser) {
      loginLimiter.recordFailure(ip);
      return { status: "failed", message: "Invalid credentials." };
    }

    // Session-scoped read-only remap. The caller authenticated with the
    // reserved read-only credential, so the session identity is the
    // effective (admin) user for every read path — mutating gates read
    // `isReadOnly` and refuse. If the effective user is missing (the
    // read-only account was seeded before admin's row exists), fall back
    // to bad-credentials rather than issuing an unremapped session.
    let sessionUser = signedUser;
    if (signedUser.username === ADMIN_RO_USERNAME) {
      const admin = await getUser({ username: ADMIN_USERNAME });
      const signedAdmin = admin?.getSigned();
      if (!signedAdmin) {
        loginLimiter.recordFailure(ip);
        return { status: "failed", message: "Invalid credentials." };
      }
      sessionUser = remapReadOnlySession(signedAdmin, ADMIN_RO_USERNAME);
      logger.info("HTTP LOGIN success (read-only)", {
        component: "http",
        authenticatedAs: ADMIN_RO_USERNAME,
        effectiveUserId: signedAdmin.id,
        ip,
      });
    }

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    req.session.user = sessionUser;

    loginLimiter.reset(ip);
    return { status: "success", body: sessionUser };
  }
);
