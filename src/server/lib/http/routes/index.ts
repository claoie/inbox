import { HttpError, type HttpRequest } from "../request";
import { json } from "../respond";
import { logger } from "../../logger";

export * from "./route";

import handleUsers from "./users";
import handleMails from "./mails";
import handlePush from "./push";
import handleHealth from "./health";
import handleClientError from "./client-error";
import handleAuth from "./auth";
import { getClientIp } from "server";
import { sendAlarm } from "../../alarm";
import { mailgunEventsLimiter } from "../rate-limit";
import { postMailgunEventsRoute } from "./mailgun-events";
import { dispatch, mountedPath } from "./route";

type SubRouter = (req: HttpRequest, path: string) => Promise<Response | undefined>;

const subRouters: [string, SubRouter][] = [
  ["/health", handleHealth],
  ["/client-error", handleClientError],
  ["/users", handleUsers],
  ["/mails", handleMails],
  ["/push", handlePush],
  ["/auth", handleAuth],
];

const logRequest = (req: HttpRequest, url: string) => {
  // Skip logging for the infra health check and the client liveness ping —
  // both are polled frequently (reverse proxy / every open tab's 30s offline
  // heartbeat) and would otherwise flood the request log.
  if (url === "/health" || url === "/ping") return;

  const date = new Date();
  const offset = date.getTimezoneOffset() / -60;
  const offsetString = (offset > 0 ? "+" : "") + offset + "H";
  logger.info(`<${req.method}> /api${url}`, {
    at: `${date.toLocaleString()}, ${offsetString}`,
    from: getClientIp(req),
  });
};

/** Whether an `/api` request, `path` relative to `/api`, is the client's liveness ping. */
export const isPingRequest = (method: string, path: string) =>
  (method === "GET" || method === "HEAD") && /^\/ping\/?$/i.test(path);

const route = async (req: HttpRequest, path: string): Promise<Response> => {
  const url = req.url.slice("/api".length);
  logRequest(req, url.startsWith("/") ? url : `/${url}`);

  // Cheap liveness probe for the client's offline heartbeat: just "is the HTTP
  // server reachable", with none of /health's DB query + SMTP/IMAP socket probes
  // (which would multiply into N port-scans per 30s at N users with open tabs).
  if (isPingRequest(req.method, path)) {
    return json({ status: "success" });
  }

  for (const [prefix, handle] of subRouters) {
    const rest = mountedPath(path, prefix);
    const response = rest === undefined ? undefined : await handle(req, rest);
    if (response) return response;
  }

  // Mailgun events webhook — public (HMAC-signed by Mailgun, verified in the
  // route handler), answered at exactly `/api/mailgun-events`. Rate-limited per
  // IP to keep an attacker from burning the alarm-cooldown bucket via replayed
  // captured signatures.
  if (mountedPath(path, "/mailgun-events") !== undefined) {
    const refused = mailgunEventsLimiter.check(req);
    if (refused) return refused;
    const response = await dispatch([postMailgunEventsRoute], req, path);
    if (response) return response;
  }

  // Unmatched /api/* requests get a JSON 404 rather than falling through to the
  // SPA index.html catch-all in http/index.ts. Without this, an authenticated
  // GET to e.g. /api/mails/unknown-route returns 200 + text/html, which silently
  // breaks any client that parses the body as JSON.
  return json({ status: "failed", message: "Not found" }, 404);
};

/**
 * Answers every `/api/*` request; `path` is relative to `/api`. A client error
 * ({@link HttpError}) propagates to the application's error handler, and any
 * other fault becomes a generic 500.
 */
const handleApi = async (req: HttpRequest, path: string): Promise<Response> => {
  try {
    return await route(req, path);
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    // Global 5xx error handler — catches unhandled errors thrown inside route handlers
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    console.error("Unhandled route error:", message);
    sendAlarm(
      "Unhandled Route Error",
      `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``,
    ).catch(() => undefined);
    return json({ status: "error", message: "Internal server error" }, 500);
  }
};

export default handleApi;

export * from "./users";
export * from "./mails";
export * from "./push";
export * from "./mailgun-events";
export * from "./auth";
