import { logger } from "../../logger";
import { sendAlarm } from "../../alarm";
import { HttpError, type HttpRequest } from "../request";
import { json, sendFile } from "../respond";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}

export class StreamingStatus {
  counter = 0;
  limit = 1;

  constructor(limit?: number) {
    if (limit) this.limit = limit;
  }

  get = (): ApiResponse["status"] => {
    this.counter++;
    if (this.counter >= this.limit) return "success";
    return "streaming";
  };
}

export type GetResponse<T = unknown> = (
  req: HttpRequest
) => Promise<
  T extends Bun.BunFile ? Bun.BunFile | ApiResponse : ApiResponse<T> | Response | void
>;

const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compiles a route path such as `/body/:id`. Matching ignores case and a
 * trailing slash, and each `:name` captures one non-empty segment.
 */
const compilePath = (routePath: string) => {
  const keys: string[] = [];
  const source = routePath
    .split(/(:\w+)/)
    .map((part) => {
      if (!part.startsWith(":")) return escapeRegExp(part);
      keys.push(part.slice(1));
      return "([^/]+?)";
    })
    .join("");
  return { pattern: new RegExp(`^${source}\\/?$`, "i"), keys };
};

const decodeParam = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, `Failed to decode param '${value}'`);
  }
};

/**
 * The remainder of `path` below a router mounted at `prefix`, or undefined
 * when `path` is not under it. Matching ignores case.
 *
 * ```ts
 * mountedPath("/users/login", "/users"); // "/login"
 * mountedPath("/users", "/users"); // "/"
 * ```
 */
export const mountedPath = (path: string, prefix: string): string | undefined => {
  const head = path.slice(0, prefix.length);
  if (head.toLowerCase() !== prefix.toLowerCase()) return undefined;
  const rest = path.slice(prefix.length);
  if (rest !== "" && !rest.startsWith("/")) return undefined;
  return rest || "/";
};

export class Route<T> {
  method: Method;
  path: string;
  callback: GetResponse<T>;
  private readonly pattern: RegExp;
  private readonly keys: string[];

  constructor(method: Method, path: string, callback: GetResponse<T>) {
    this.method = method;
    this.path = path;
    this.callback = callback;
    ({ pattern: this.pattern, keys: this.keys } = compilePath(path));
  }

  /**
   * The route's decoded params when it answers `method` at `path` (relative to
   * its router), otherwise undefined. A GET route also answers HEAD.
   */
  match = (method: string, path: string): Record<string, string> | undefined => {
    const answers = method === this.method || (method === "HEAD" && this.method === "GET");
    const found = answers ? this.pattern.exec(path) : null;
    if (!found) return undefined;
    return Object.fromEntries(this.keys.map((key, i) => [key, decodeParam(found[i + 1]!)]));
  };

  handler = async (req: HttpRequest): Promise<Response> => {
    try {
      const result = await this.callback(req);
      if (result instanceof Response) return result;
      if (result instanceof Blob) {
        return sendFile(result as Bun.BunFile, { contentType: "application/octet-stream" });
      }
      if (result) return json(result);
      return new Response(null);
    } catch (error: unknown) {
      logger.error("Route handler error", { method: this.method, path: this.path }, error);
      sendAlarm(
        `Route Error: ${this.method} ${this.path}`,
        `**Error:** ${error instanceof Error ? error.message : String(error)}`
      ).catch(() => undefined);
      // The driver message stays server-side on every environment: a store
      // fault's text names table and column, and the deployment sets no
      // NODE_ENV, so gating the body on one would disclose it by default.
      return json({ status: "error", message: "Internal server error" }, 500);
    }
  };
}

/**
 * Runs the first of `routes` that answers the request at `path`, relative to
 * the router the routes belong to. Undefined when none does.
 */
export const dispatch = async (
  routes: Pick<Route<unknown>, "match" | "handler">[],
  req: HttpRequest,
  path: string
): Promise<Response | undefined> => {
  for (const route of routes) {
    const params = route.match(req.method, path);
    if (!params) continue;
    req.params = params;
    return route.handler(req);
  }
  return undefined;
};

export const AUTH_ERROR_MESSAGE = "Request user is not logged in.";

/**
 * A 401 for an unauthenticated request, undefined otherwise. Apply at the
 * router level so every route is protected by default — explicitly exclude
 * public paths instead of relying on each handler.
 */
export const authRequired = (req: HttpRequest): Response | undefined =>
  req.session.user
    ? undefined
    : json({ status: "failed", message: AUTH_ERROR_MESSAGE }, 401);
