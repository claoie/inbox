import { logger } from "../logger";
import type { HttpRequest } from "./request";
import { json } from "./respond";

/**
 * Identity that every rate-limit bucket is keyed on.
 *
 * Reads `req.ip` only. It is resolved against the trusted-proxy list, so a
 * forwarded address is honoured only when the connection itself arrives from
 * an address configured as a proxy. Reading the forwarding headers here
 * instead would let any caller name its own bucket and rotate out of it.
 */
export const getClientIp = (req: HttpRequest): string => req.ip || "unknown";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface AttemptRecord {
  count: number;
  resetAt: number;
}

// Tracks all per-limiter attempt Maps so the scheduler can clean them all.
const allAttemptMaps: Map<string, AttemptRecord>[] = [];

export interface RateLimiter {
  /** A 429 when the request's IP or attempted identity is over the limit, else undefined. */
  check: (req: HttpRequest) => Response | undefined;
  /**
   * Record a failure against the IP's aggregate bucket, and — when an
   * account is given — against that account's own bucket under the IP.
   */
  recordFailure: (ip: string, account?: string) => void;
  /**
   * Forgive failures. With an account, only that account's own bucket is
   * cleared and the per-IP aggregate keeps accumulating; without one, the
   * whole IP bucket (aggregate plus every account bucket under it) is
   * cleared, preserving the pre-account-granularity contract.
   */
  reset: (ip: string, account?: string) => void;
}

/**
 * The attempted login identity a request is bucketed under: the username when
 * present, otherwise the email, normalized so trivial case/whitespace rotation
 * of the identity does not buy a fresh bucket. Returns undefined when the body
 * names no identity; the per-IP aggregate still applies in that case.
 */
export const loginIdentityOf = (req: HttpRequest): string | undefined => {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const raw =
    typeof body.username === "string" && body.username !== ""
      ? body.username
      : typeof body.email === "string" && body.email !== ""
        ? body.email
        : undefined;
  return raw === undefined ? undefined : raw.trim().toLowerCase();
};

/**
 * Create a rate limiter with a read-only check + explicit record/reset hooks.
 *
 * The check only reads the limit; route handlers decide which outcomes
 * count by calling `recordFailure(ip, account)` on real failures or
 * `reset(ip, account)` on success. Mirrors the `auth-rate-limit.ts` shape used
 * by IMAP/SMTP so that successful logins don't pin the counter and transient
 * 500s don't burn the per-IP quota.
 *
 * When `options.identityOf` is given (as for the login limiter), failures are
 * tracked at two granularities: a per-IP aggregate bucket that every failure
 * from the IP feeds, plus one bucket per attempted identity under that IP.
 * The check refuses when either trips, and a success clears only the
 * authenticating account's own bucket — the aggregate keeps accumulating, so
 * one account's success can no longer forgive another account's failures from
 * the same IP.
 *
 * Each call to createLimiter gets its own isolated attempt Maps so that
 * separate limiters (e.g. loginLimiter and tokenLimiter) do not share
 * counters.
 *
 * @param maxAttempts Maximum attempts allowed within the window
 * @param message Error message to return when limit is exceeded
 * @param options.identityOf Extracts the attempted identity from a request so
 *   the check can read that account's bucket in addition to the IP's
 */
export const createLimiter = (
  maxAttempts: number,
  message: string,
  options?: { identityOf?: (req: HttpRequest) => string | undefined }
): RateLimiter => {
  const attempts = new Map<string, AttemptRecord>();
  const accountAttempts = new Map<string, AttemptRecord>();
  allAttemptMaps.push(attempts, accountAttempts);

  const identityOf = options?.identityOf;

  // `\u0000` separates the components; getClientIp never yields one, so a
  // crafted account string cannot collide with a different (ip, account) pair.
  const accountKey = (ip: string, account: string) => `${ip}\u0000${account}`;

  const bump = (map: Map<string, AttemptRecord>, key: string): void => {
    const now = Date.now();
    const record = map.get(key);
    if (record && now < record.resetAt) {
      record.count++;
    } else {
      map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    }
  };

  const isLimited = (map: Map<string, AttemptRecord>, key: string): boolean => {
    const record = map.get(key);
    return (
      !!record && Date.now() < record.resetAt && record.count >= maxAttempts
    );
  };

  return {
    check: (req: HttpRequest) => {
      const ip = getClientIp(req);
      const account = identityOf?.(req);
      if (
        isLimited(attempts, ip) ||
        (account !== undefined &&
          isLimited(accountAttempts, accountKey(ip, account)))
      ) {
        return json({ status: "failed", message }, 429);
      }
      return undefined;
    },
    recordFailure: (ip: string, account?: string) => {
      bump(attempts, ip);
      if (account !== undefined) {
        bump(accountAttempts, accountKey(ip, account));
      }
    },
    reset: (ip: string, account?: string) => {
      if (account === undefined) {
        // Whole-bucket reset: forgive the IP and every account bucket under
        // it, matching the pre-account-granularity contract.
        attempts.delete(ip);
        const prefix = `${ip}\u0000`;
        for (const key of accountAttempts.keys()) {
          if (key.startsWith(prefix)) {
            accountAttempts.delete(key);
          }
        }
        return;
      }
      // Scoped reset: forgive only this account's own failures. The per-IP
      // aggregate is deliberately left to keep accumulating across accounts.
      accountAttempts.delete(accountKey(ip, account));
    }
  };
};

/**
 * Clean up expired attempt records across all limiter Maps.
 * Called periodically to prevent memory buildup.
 */
export const cleanupExpiredAttempts = (): number => {
  const now = Date.now();
  let cleaned = 0;

  for (const attempts of allAttemptMaps) {
    for (const [ip, record] of attempts) {
      if (now >= record.resetAt) {
        attempts.delete(ip);
        cleaned++;
      }
    }
  }

  return cleaned;
};

// Schedule periodic cleanup
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export const startCleanupScheduler = () => {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const cleaned = cleanupExpiredAttempts();
    if (cleaned > 0) {
      logger.info(`[Rate Limit] Cleaned up ${cleaned} expired attempt records`);
    }
  }, CLEANUP_INTERVAL_MS);

  // Run initial cleanup
  cleanupExpiredAttempts();
};

export const stopCleanupScheduler = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
};

// Pre-configured limiters, shared by a router and the handler that records
// against them.
export const loginLimiter = createLimiter(
  5,
  "Too many login attempts, try again later",
  { identityOf: loginIdentityOf }
);

export const tokenLimiter = createLimiter(
  3,
  "Too many token requests, try again later"
);

export const setInfoLimiter = createLimiter(
  5,
  "Too many attempts, try again later"
);

export const mailgunEventsLimiter = createLimiter(
  60,
  "Too many Mailgun webhook requests, try again later"
);
