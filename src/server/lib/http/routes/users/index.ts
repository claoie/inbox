import type { HttpRequest } from "../../request";
import { json } from "../../respond";
import { isLocalLoginAllowed } from "../../../sso";
import { dispatch, mountedPath } from "../route";
import { getLoginRoute } from "./get-login";
import { postLoginRoute } from "./post-login";
import { deleteLoginRoute } from "./delete-login";
import { postTokenRoute } from "./post-token";
import { postSetInfoRoute } from "./post-set-info";
import { loginLimiter, tokenLimiter, setInfoLimiter, type RateLimiter } from "../../rate-limit";

const routes = [
  getLoginRoute,
  postLoginRoute,
  deleteLoginRoute,
  postTokenRoute,
  postSetInfoRoute
];

// Password sign-in, sign-up and reset, which single sign-on turns off unless
// AUTH_LOCAL_LOGIN keeps them.
const localSignInRoutes = [postLoginRoute, postTokenRoute, postSetInfoRoute];

export const LOCAL_SIGN_IN_OFF_MESSAGE =
  "Password sign-in is turned off on this server. Sign in with SSO instead.";

// Rate limiters apply only to POST requests (not GET/DELETE).
const postLimiters: [string, RateLimiter][] = [
  [postLoginRoute.path, loginLimiter],
  [postTokenRoute.path, tokenLimiter],
  [postSetInfoRoute.path, setInfoLimiter],
];

/** `/api/users/*`, with `path` relative to that mount. */
const handleUsers = async (req: HttpRequest, path: string): Promise<Response | undefined> => {
  if (!isLocalLoginAllowed() && localSignInRoutes.some((route) => route.match(req.method, path))) {
    return json({ status: "failed", message: LOCAL_SIGN_IN_OFF_MESSAGE }, 403);
  }
  if (req.method === "POST") {
    for (const [prefix, limiter] of postLimiters) {
      const refused = mountedPath(path, prefix) !== undefined ? limiter.check(req) : undefined;
      if (refused) return refused;
    }
  }
  return dispatch(routes, req, path);
};

export default handleUsers;

export * from "./get-login";
export * from "./post-login";
export * from "./delete-login";
export * from "./post-token";
export * from "./post-set-info";
