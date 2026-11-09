import { describe, it, expect } from "bun:test";
import {
  ALLOWLIST_PATTERN_MAX_BYTES,
  exceedsAllowlistPatternBytes,
  isValidAllowlistPattern
} from "./pattern";
import { ALLOWLIST_PATTERN_MAX_BYTES as SERVER_MAX_BYTES } from "server/lib/postgres/models/spam_allowlist";

describe("isValidAllowlistPattern", () => {
  it("accepts an exact email address", () => {
    expect(isValidAllowlistPattern("friend@example.com")).toBe(true);
  });

  it("accepts a domain wildcard", () => {
    expect(isValidAllowlistPattern("*@example.com")).toBe(true);
  });

  it("accepts a multi-label domain", () => {
    expect(isValidAllowlistPattern("alerts@mail.example.co.uk")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidAllowlistPattern("  friend@example.com  ")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(isValidAllowlistPattern("")).toBe(false);
    expect(isValidAllowlistPattern("   ")).toBe(false);
  });

  it("rejects a bare local part with no domain", () => {
    expect(isValidAllowlistPattern("friend")).toBe(false);
  });

  it("rejects a domain with no TLD", () => {
    expect(isValidAllowlistPattern("friend@example")).toBe(false);
    expect(isValidAllowlistPattern("*@example")).toBe(false);
  });

  it("rejects an empty local part", () => {
    expect(isValidAllowlistPattern("@example.com")).toBe(false);
  });

  it("rejects input containing whitespace inside the address", () => {
    expect(isValidAllowlistPattern("a b@example.com")).toBe(false);
  });

  it("rejects a double-@ address", () => {
    expect(isValidAllowlistPattern("a@b@example.com")).toBe(false);
  });
});

describe("allowlist pattern byte ceiling", () => {
  const underCap = (bytes: number) => `${"a".repeat(bytes - "@example.com".length)}@example.com`;

  it("mirrors the server ceiling — the client refuses exactly what the server would", () => {
    expect(ALLOWLIST_PATTERN_MAX_BYTES).toBe(SERVER_MAX_BYTES);
  });

  it("accepts a pattern exactly at the ceiling", () => {
    const pattern = underCap(ALLOWLIST_PATTERN_MAX_BYTES);
    expect(new TextEncoder().encode(pattern).length).toBe(ALLOWLIST_PATTERN_MAX_BYTES);
    expect(exceedsAllowlistPatternBytes(pattern)).toBe(false);
    expect(isValidAllowlistPattern(pattern)).toBe(true);
  });

  it("rejects a pattern one byte over the ceiling", () => {
    const pattern = `a${underCap(ALLOWLIST_PATTERN_MAX_BYTES)}`;
    expect(exceedsAllowlistPatternBytes(pattern)).toBe(true);
    expect(isValidAllowlistPattern(pattern)).toBe(false);
  });

  it("measures UTF-8 bytes, not characters", () => {
    // Under the cap by `String.length`, over it by the bytes the server stores.
    const pattern = `${"\u00e9".repeat(200)}@example.com`;
    expect(pattern.length).toBeLessThan(ALLOWLIST_PATTERN_MAX_BYTES);
    expect(exceedsAllowlistPatternBytes(pattern)).toBe(true);
    expect(isValidAllowlistPattern(pattern)).toBe(false);
  });

  it("rejects the multi-megabyte pattern the shape check alone accepts", () => {
    const pattern = `${"a".repeat(5_000_000)}@example.com`;
    expect(isValidAllowlistPattern(pattern)).toBe(false);
  });

  it("still rejects an over-long pattern after trimming", () => {
    const pattern = `  ${"a".repeat(5_000)}@example.com  `;
    expect(isValidAllowlistPattern(pattern)).toBe(false);
  });
});
