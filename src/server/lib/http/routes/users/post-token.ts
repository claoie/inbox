import { MailDataToSend } from "common";
import {
  createAuthenticationMail,
  createToken,
  getSignedUser,
  getUser,
  isValidEmail,
  sendMail,
  startTimer,
  isReservedUsername,
  deliversToAdminMailbox
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

    // Refuse the boot-seeded accounts before createToken runs. This route is
    // unauthenticated, and createToken's existing-user branch writes
    // `{token, expiry}` onto the matched row AND schedules a hard-DELETE via
    // startTimer — so without the gate an outside caller mints a live reset
    // token for admin from nothing but the address.
    // Same-shape success response as a normal send so no probe signal.
    const existing = await getUser({ email });
    if (isReservedUsername(existing?.username)) {
      tokenLimiter.recordFailure(ip);
      return { status: "success" };
    }

    // Same for an address delivered into admin's own mailbox: the sent link
    // comes back through the receive webhook under admin's user_id, which the
    // read-only role reads by design.
    if (deliversToAdminMailbox(email)) {
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

    // No Sent record: the body carries a live signup token, and the sending
    // identity is admin — whose mailbox the read-only role reads by design.
    await sendMail(
      signedAdminUser,
      new MailDataToSend(authenticationEamil),
      undefined,
      { persistToSentMailbox: false }
    );

    startTimer(id);

    // Each successful magic-link send consumes one slot in the per-IP quota
    // (the limit exists to prevent mail-sending abuse). Server errors thrown
    // above don't reach this line, so transient 500s no longer burn the quota.
    tokenLimiter.recordFailure(ip);

    return { status: "success" };
  }
);
