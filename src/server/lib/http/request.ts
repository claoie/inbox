import net from "net";
import type { HttpSession } from "./session";
import type { UploadedFile } from "./upload";

/** The request every route handler and middleware receives. */
export interface HttpRequest {
  method: string;
  /** Full pathname, still percent-encoded. */
  path: string;
  /** Pathname plus query string, as the request line carried it. */
  url: string;
  headers: Headers;
  query: Record<string, string | string[]>;
  /** Decoded `:name` segments of the matched route. */
  params: Record<string, string>;
  /** Parsed JSON, multipart fields, or `{}` when the request carried neither. */
  body: unknown;
  /** Multipart file parts by field name; one part per name stays unwrapped. */
  files?: Record<string, UploadedFile | UploadedFile[]>;
  /** Client address; see {@link resolveClientIp}. */
  ip: string;
  /** Whether the client reached us over HTTPS. */
  secure: boolean;
  session: HttpSession;
  /** The underlying request; its body is still unread unless it was JSON. */
  raw: Request;
}

/** A failure the client caused, answered with `status` instead of a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Decides whether a peer is a proxy whose forwarding headers are believed.
 * Production trusts loopback and private (RFC 1918 / ULA) addresses only.
 */
export type ProxyTrust = (address: string) => boolean;

const trustedProxyRanges = (() => {
  const list = new net.BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("::1", 128, "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  return list;
})();

/** Loopback and private addresses, including their IPv4-mapped IPv6 forms. */
export const trustLoopbackAndPrivate: ProxyTrust = (address) => {
  const family = net.isIP(address);
  if (family === 0) return false;
  return trustedProxyRanges.check(address, family === 4 ? "ipv4" : "ipv6");
};

export const trustNoProxy: ProxyTrust = () => false;

/** `X-Forwarded-For` entries, nearest hop first. Only spaces are trimmed. */
const forwardedHops = (header: string | null): string[] =>
  header
    ? header
        .split(",")
        .map((entry) => entry.replace(/^ +| +$/g, ""))
        .filter((entry) => entry !== "")
        .reverse()
    : [];

/**
 * The client address a request is attributed to, walking `X-Forwarded-For`
 * from the socket outward and stopping at the first hop that is not a trusted
 * proxy. A peer that is not itself trusted is the answer whatever headers it
 * sends, so a caller that reaches the port directly cannot name its own
 * address.
 */
export const resolveClientIp = (
  peerAddress: string,
  forwardedFor: string | null,
  trust: ProxyTrust
): string => {
  const hops = [peerAddress, ...forwardedHops(forwardedFor)];
  for (let i = 0; i < hops.length - 1; i++) {
    if (!trust(hops[i]!)) return hops[i]!;
  }
  return hops[hops.length - 1]!;
};

/** HTTPS when a trusted proxy says so in `X-Forwarded-Proto`. */
export const isSecureRequest = (
  peerAddress: string,
  forwardedProto: string | null,
  trust: ProxyTrust
): boolean => {
  if (!forwardedProto || !trust(peerAddress)) return false;
  return forwardedProto.split(",")[0]!.trim() === "https";
};

/**
 * The path and query string a request asked for, exactly as sent: the path is
 * not normalized, and the Host header plays no part.
 */
export const requestTarget = (request: Request): { pathname: string; search: string } => {
  const { url } = request;
  const authority = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i.exec(url);
  const target = authority ? url.slice(authority[0].length) : url;
  const queryAt = target.indexOf("?");
  return {
    pathname: (queryAt === -1 ? target : target.slice(0, queryAt)) || "/",
    search: queryAt === -1 ? "" : target.slice(queryAt),
  };
};

/** Repeated keys collect into an array, as `?a=1&a=2` → `{ a: ["1", "2"] }`. */
export const parseQuery = (search: URLSearchParams): Record<string, string | string[]> => {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of search) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
};

/**
 * Largest JSON body accepted, in bytes. Every JSON caller sends a few KB;
 * mail and attachments travel as multipart. The body is read before routing
 * and auth, so this ceiling is what any unauthenticated peer can make the
 * process hold per request.
 */
export const JSON_BODY_LIMIT = 1024 * 1024;

const mediaTypeOf = (contentType: string | null) =>
  (contentType ?? "").split(";")[0]!.trim().toLowerCase();

const charsetOf = (contentType: string) => {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match ? match[1]!.toLowerCase() : "utf-8";
};

type BodyStream = NonNullable<Request["body"]>;

const decodedBody = (body: BodyStream, headers: Headers): BodyStream => {
  const encoding = (headers.get("content-encoding") ?? "identity").toLowerCase();
  if (encoding === "identity") return body;
  if (encoding === "gzip" || encoding === "deflate") {
    return body.pipeThrough(new DecompressionStream(encoding));
  }
  throw new HttpError(415, `unsupported content encoding "${encoding}"`);
};

/** Reads a stream to text, refusing it once it passes `limit` bytes. */
const readLimited = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    received += next.value.byteLength;
    if (received > limit) {
      reader.cancel().catch(() => undefined);
      throw new HttpError(413, "request entity too large");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
};

/** Whether the request carries a body; a declared length of zero means it does not. */
export const hasBody = (request: Request): boolean =>
  request.body !== null && request.headers.get("content-length") !== "0";

/**
 * The body of any request as text, whatever its content type. Throws
 * {@link HttpError} with 413 past `limit` bytes, 415 for an unknown content
 * encoding and 400 for a body that cannot be read.
 */
export const readTextBody = async (request: Request, limit: number): Promise<string> => {
  if (!hasBody(request)) return "";
  if (Number(request.headers.get("content-length")) > limit) {
    throw new HttpError(413, "request entity too large");
  }
  try {
    return await readLimited(decodedBody(request.body!, request.headers), limit);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid request body");
  }
};

/**
 * The body of an `application/json` request, parsed; `{}` for any other
 * request. Only an object or array is accepted at the top level.
 *
 * Throws {@link HttpError} with 400 for malformed JSON, 413 over {@link JSON_BODY_LIMIT} and
 * 415 for a non-UTF charset or an unknown content encoding.
 */
export const readJsonBody = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get("content-type");
  if (mediaTypeOf(contentType) !== "application/json" || !hasBody(request)) {
    return {};
  }
  if (!charsetOf(contentType!).startsWith("utf-")) {
    throw new HttpError(415, "unsupported charset");
  }
  const declared = Number(request.headers.get("content-length"));
  if (declared > JSON_BODY_LIMIT) throw new HttpError(413, "request entity too large");

  let text: string;
  try {
    text = await readLimited(decodedBody(request.body!, request.headers), JSON_BODY_LIMIT);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid request body");
  }
  text = text.replace(/^\uFEFF/, "");
  if (text === "") return {};

  const first = /^[\x20\x09\x0a\x0d]*(.)/.exec(text)?.[1];
  if (first !== "{" && first !== "[") throw new HttpError(400, "invalid JSON body");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
};
