/**
 * Allowlist pattern validation — mirrors the server-side checks in
 * `src/server/lib/http/routes/mails/post-allowlist.ts` so the client rejects
 * malformed input before it ever hits the network.
 *
 * Valid shapes:
 *   - exact email:     `user@example.com`
 *   - domain wildcard: `*@example.com`
 */
const EXACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_WILDCARD = /^\*@[^\s@]+\.[^\s@]+$/;

/**
 * Mirrors `ALLOWLIST_PATTERN_MAX_BYTES`. The server measures UTF-8 bytes, so
 * `TextEncoder` is what agrees with it — `String.length` counts UTF-16 code
 * units and would pass a multi-byte pattern the server then refuses.
 */
export const ALLOWLIST_PATTERN_MAX_BYTES = 320;

export const exceedsAllowlistPatternBytes = (pattern: string): boolean =>
  new TextEncoder().encode(pattern).length > ALLOWLIST_PATTERN_MAX_BYTES;

export const isValidAllowlistPattern = (pattern: string): boolean => {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (exceedsAllowlistPatternBytes(trimmed)) return false;
  return EXACT_EMAIL.test(trimmed) || DOMAIN_WILDCARD.test(trimmed);
};
