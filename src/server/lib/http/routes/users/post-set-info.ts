import { MaskedUser } from "common";
import {
  getUser,
  setUserInfo,
  isReservedUsername,
  type SetUserInfoRejection
} from "server";
import type { HttpRequest } from "../../request";
import { Route, type ApiResponse } from "../route";
import { issueAuthenticatedSession } from "../../issue-session";
import { getClientIp, setInfoLimiter } from "../../rate-limit";

export type SetInfoPostResponse = MaskedUser;

const INVALID_LINK = "This link is invalid or has already been used. Request a new one.";

// `unknown-user` and `token-mismatch` share one message so the answer does not
// reveal whether an address has an account.
const rejectionMessages: Record<SetUserInfoRejection, string> = {
  "invalid-input": "email, username and password are required.",
  "unknown-user": INVALID_LINK,
  "token-mismatch": INVALID_LINK,
  "token-expired": "This link has expired. Request a new one.",
  "username-taken": "That username is already taken."
};

const setInfo = async (req: HttpRequest, ip: string): Promise<ApiResponse<SetInfoPostResponse>> => {
  const refuse = (message: string): ApiResponse<SetInfoPostResponse> => {
    setInfoLimiter.recordFailure(ip);
    return { status: "failed", message };
  };

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse("Invalid request body.");
  }

  const { email, username, password, token } = body as Record<string, unknown>;

  if (typeof email !== "string" || !email) {
    return refuse("email is required and must be a string.");
  }
  if (typeof username !== "string" || !username) {
    return refuse("username is required and must be a string.");
  }
  if (typeof password !== "string" || !password) {
    return refuse("password is required and must be a string.");
  }
  if (token !== undefined && typeof token !== "string") {
    return refuse("token must be a string.");
  }

  // Refuse the boot-seeded accounts BEFORE calling setUserInfo. setUserInfo
  // unconditionally runs `usersTable.update(id, {password, ...})` for
  // pre-existing users, so a post-call check would leave the row already
  // mutated (bcrypt hash of an attacker-chosen password) even when session
  // issuance gets refused.
  const existing = await getUser({ email });
  if (isReservedUsername(existing?.username)) {
    return refuse("Invalid credentials.");
  }

  const result = await setUserInfo({ email, username, password, token: token as string | undefined });
  if (result.status === "rejected") return refuse(rejectionMessages[result.reason]);

  await issueAuthenticatedSession(req, result.user);
  return { status: "success", body: result.user };
};

export const postSetInfoRoute = new Route<SetInfoPostResponse>(
  "POST",
  "/set-info",
  async (req) => {
    const ip = getClientIp(req);
    try {
      return await setInfo(req, ip);
    } catch (error) {
      // A fault an anonymous caller can trigger would otherwise loop 500s and alarms unthrottled.
      setInfoLimiter.recordFailure(ip);
      throw error;
    }
  }
);
