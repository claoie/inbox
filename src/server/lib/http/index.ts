import path from "path";

import { getDomain, isProduction, PostgresSessionStore } from "server";
import { resolveProxyTrust } from "./app";
import { resolveSessionSecret } from "./session-secret";
import handleApi, { isPingRequest, isRawBodyPath } from "./routes";
import { mountedPath } from "./routes/route";
import { errorHandler, reportMiddlewareError, serverErrorHandler } from "./error-handler";
import { startCleanupScheduler } from "./rate-limit";
import { HttpSession, type SessionStore } from "./session";
import {
  isSecureRequest,
  parseQuery,
  readJsonBody,
  requestTarget,
  resolveClientIp,
  type HttpRequest,
} from "./request";
import { conditional, send, text } from "./respond";
import { serveIndex, serveStatic } from "./static";
import { MAX_REQUEST_BODY_SIZE } from "./upload";
import { logger } from "../logger";
import { enforceSsoSession } from "../sso/session";

/**
 * Security response headers, applied to every response. This is the single
 * place they are defined, so any new header belongs here.
 */
const securityHeaders = (production: boolean): [string, string][] => {
  const headers: [string, string][] = [
    // Restrict resource origins. 'unsafe-inline' for styles is required by React.
    // 'blob:' in img-src allows inline email images loaded as object URLs.
    // 'https:' in img-src allows external images in email bodies (the sanitizer
    // adds referrerpolicy="no-referrer" + loading="lazy" to mitigate tracking).
    // Plain http: is intentionally omitted to avoid mixed-content on prod.
    [
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "connect-src 'self'",
        // sandbox attribute on email iframes restricts their content;
        // frame-src 'self' allows those sandboxed iframes to be embedded.
        "frame-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    ],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ];
  if (production) {
    headers.push(["Strict-Transport-Security", "max-age=31536000; includeSubDomains"]);
  }
  return headers;
};

const AUTOCONFIG_PATH = /^\/\.well-known\/autoconfig\/mail\/config-v1\.1\.xml\/?$/i;

// IMAP/SMTP auto-discovery for email clients (Thunderbird, Apple Mail, Outlook, etc.)
// https://wiki.mozilla.org/Thunderbird:Autoconfiguration:ConfigFileFormat
const autoconfig = (): Response => {
  const emailDomain = getDomain();
  // APP_HOSTNAME is the actual server hostname clients connect to for IMAP/SMTP.
  // EMAIL_DOMAIN is the MX-record domain used for routing — not always the same as
  // the server's hostname (e.g. MX record may use non-TLS delivery paths).
  const serverHostname = process.env.APP_HOSTNAME || emailDomain;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${emailDomain}">
    <domain>${emailDomain}</domain>
    <displayName>${emailDomain} Mail</displayName>
    <displayShortName>${emailDomain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${serverHostname}</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${serverHostname}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
  return send(xml, { contentType: "application/xml; charset=utf-8" });
};

/** Handles one request; `peerAddress` is the remote address of its connection. */
export type HttpApp = (request: Request, peerAddress: string) => Promise<Response>;

/**
 * Assembles the whole request pipeline: JSON body, the session (read only for
 * `/api` requests other than the liveness ping), the `/api` routes,
 * mail-client autoconfig, the built client with its single-page fallback, and
 * {@link errorHandler} for anything that escapes.
 *
 * The store is a parameter so the pipeline can be driven end to end against
 * an in-memory one: a store fault is raised before any route runs, and the
 * only thing that can observe where such a fault lands is the assembled
 * pipeline itself.
 *
 * @example
 * const app = createHttpApp(new PostgresSessionStore());
 * const response = await app(new Request("http://localhost/api/ping"), "127.0.0.1");
 */
export const createHttpApp = (store: SessionStore): HttpApp => {
  const sessionSecret = resolveSessionSecret();
  const production = isProduction();
  const trust = resolveProxyTrust();
  const headers = securityHeaders(production);
  const clientPath = path.resolve(__dirname, "../../../../build/client");

  const route = async (req: HttpRequest): Promise<Response> => {
    const apiPath = mountedPath(req.path, "/api");
    if (apiPath !== undefined) return handleApi(req, apiPath);

    if (req.method !== "GET" && req.method !== "HEAD") return text("Not Found", 404);
    if (AUTOCONFIG_PATH.test(req.path)) return autoconfig();
    const ranged = req.headers.has("range");
    const file =
      (await serveStatic(clientPath, req.path, ranged)) ?? (await serveIndex(clientPath, ranged));
    return file ?? text("Not Found", 404);
  };

  return async (request, peerAddress) => {
    const url = requestTarget(request);
    const { method } = request;
    const ip = resolveClientIp(peerAddress, request.headers.get("x-forwarded-for"), trust);
    const secure = isSecureRequest(peerAddress, request.headers.get("x-forwarded-proto"), trust);

    let session: HttpSession | undefined;
    let response: Response;
    try {
      const body = isRawBodyPath(url.pathname) ? {} : await readJsonBody(request);
      const apiPath = mountedPath(url.pathname, "/api");
      const usesSession = apiPath !== undefined && !isPingRequest(method, apiPath);
      session = await HttpSession.load(usesSession ? request.headers.get("cookie") : null, store, {
        secret: sessionSecret,
        secure: production,
      });
      await enforceSsoSession(session);
      response = await route({
        method,
        path: url.pathname,
        url: url.pathname + url.search,
        headers: request.headers,
        query: parseQuery(new URLSearchParams(url.search)),
        params: {},
        body,
        ip,
        secure,
        session,
        raw: request,
      });
    } catch (error) {
      response = errorHandler(error, { method, path: url.pathname, sessionId: session?.sessionId });
    }

    if (session) {
      const failed = { method, path: url.pathname, sessionId: session.sessionId };
      const cookie = await session.commit(secure, (error) => reportMiddlewareError(error, failed));
      if (cookie) response.headers.append("Set-Cookie", cookie);
    }
    for (const [name, value] of headers) response.headers.set(name, value);
    return conditional(request, response);
  };
};

// Bun counts time spent waiting on a handler as idle, so a shorter bound would
// reset any request whose handler is still working (a mail send through
// Mailgun, the health check's TLS probes). 255 seconds is Bun's maximum.
const IDLE_TIMEOUT_SECONDS = 255;

export const initializeHttp = async () => {
  const app = createHttpApp(new PostgresSessionStore());

  const domain = getDomain();
  const port = Number(process.env.PORT || 3004);

  const httpServer = Bun.serve({
    port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    fetch: (request, server) => app(request, server.requestIP(request)?.address ?? ""),
    error: serverErrorHandler,
  });
  logger.info(`${domain} mail server is listening`);

  // Start cleanup scheduler for rate limit data
  startCleanupScheduler();

  return httpServer;
};

export * from "./routes";
export * from "./rate-limit";
export * from "./issue-session";
