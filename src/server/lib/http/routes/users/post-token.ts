import { MailDataToSend } from "common";
import {
  createAuthenticationMail,
  createToken,
  getSignedUser,
  getUser,
  isValidEmail,
  sendMail,
  startTimer,
  ADMIN_RO_USERNAME
} from "server";
import { Route } from "../route";
import { getClientIp, tokenLimiter } from "../../rate-limit";

export type TokenPostResponse = undefined;

export const postTokenRoute = new Route<TokenPostResponse>(
  "POST",
  "/token",
  async (req) => {
    const ip = getClientIp(req);
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      tokenLimiter.recordFailure(ip);
      return { status: "failed", message: "Invalid request body." };
    }

    const { email } = body as Record<string, unknown>;

    // `isValidEmail` opens with `email.split("@")`, so every non-string value
    // throws there instead of failing the address check. An absent JSON body
    // reaches it as `undefined`, which is why the guard covers the shape as
    // well as the type.
    if (typeof email !== "string" || !isValidEmail(email)) {
      tokenLimiter.recordFailure(ip);
      return {
        status: "failed",
        message: "Signup failed because email is invalid."
      };
    }

    // Refuse the reserved read-only identity before createToken runs.
    // createToken's existing-user branch issues
    // `usersTable.update(readonly.id, {token, expiry})` AND schedules a
    // hard-DELETE via startTimer, both of which would silently mutate the
    // read-only row for an unauthenticated caller who guessed the address.
    // Same-shape success response as a normal send so no probe signal.
    const existing = await getUser({ email });
    if (existing?.username === ADMIN_RO_USERNAME) {
      tokenLimiter.recordFailure(ip);
      return { status: "success" };
    }

    const [adminUser, createdUser] = await Promise.all([
      getUser({ username: "admin" }),
      createToken(email)
    ]);

    const signedAdminUser = getSignedUser(adminUser);

    if (!signedAdminUser) throw new Error("Admin user does not exist.");
    const { id, username, token } = createdUser;

    const authenticationEamil = createAuthenticationMail(
      email,
      token,
      username
    );

    await sendMail(signedAdminUser, new MailDataToSend(authenticationEamil));

    startTimer(id);

    // Each successful magic-link send consumes one slot in the per-IP quota
    // (the limit exists to prevent mail-sending abuse). Server errors thrown
    // above don't reach this line, so transient 500s no longer burn the quota.
    tokenLimiter.recordFailure(ip);

    return { status: "success" };
  }
);
