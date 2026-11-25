import { describe, it, expect } from "bun:test";
import {
  parseAtom,
  parseDate,
  parseModifierGroup,
  parseFlag,
  parseString,
  parseQuotedString,
  parseSequenceSet,
  parseNumber,
  skipWhitespace,
  peek,
  consume,
} from "./primitive-parsers";
import { ParseContext } from "../types";

function ctx(input: string, position = 0): ParseContext {
  return { input, position, length: input.length };
}

// ─── parseAtom ────────────────────────────────────────────────────────────────

describe("parseAtom", () => {
  it("parses a simple atom", () => {
    const c = ctx("INBOX");
    const r = parseAtom(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("INBOX");
    expect(c.position).toBe(5);
  });

  it("stops at space", () => {
    const c = ctx("INBOX rest");
    const r = parseAtom(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("INBOX");
    expect(c.position).toBe(5);
  });

  it("stops at parenthesis", () => {
    const c = ctx("FLAGS)");
    const r = parseAtom(c);
    expect(r.value).toBe("FLAGS");
  });

  it("fails on empty input", () => {
    const c = ctx("");
    const r = parseAtom(c);
    expect(r.success).toBe(false);
  });

  it("fails when first char is a special", () => {
    const c = ctx("(atom");
    const r = parseAtom(c);
    expect(r.success).toBe(false);
  });

  it("stops at double-quote", () => {
    const c = ctx('atom"rest');
    const r = parseAtom(c);
    expect(r.value).toBe("atom");
  });

  it("stops at backslash", () => {
    const c = ctx("atom\\flag");
    const r = parseAtom(c);
    expect(r.value).toBe("atom");
  });

  it("stops at asterisk", () => {
    const c = ctx("atom*rest");
    const r = parseAtom(c);
    expect(r.value).toBe("atom");
  });

  it("stops at percent", () => {
    const c = ctx("atom%rest");
    const r = parseAtom(c);
    expect(r.value).toBe("atom");
  });

  it("stops at control character", () => {
    const c = ctx("atom\x01rest");
    const r = parseAtom(c);
    expect(r.value).toBe("atom");
  });
});

// ─── parseNumber ──────────────────────────────────────────────────────────────

describe("parseNumber", () => {
  it("parses a single digit", () => {
    const c = ctx("5");
    const r = parseNumber(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe(5);
  });

  it("parses a multi-digit number", () => {
    const c = ctx("12345");
    const r = parseNumber(c);
    expect(r.value).toBe(12345);
    expect(r.consumed).toBe(5);
  });

  it("stops at non-digit", () => {
    const c = ctx("42abc");
    const r = parseNumber(c);
    expect(r.value).toBe(42);
    expect(c.position).toBe(2);
  });

  it("fails on non-digit input", () => {
    const c = ctx("abc");
    const r = parseNumber(c);
    expect(r.success).toBe(false);
  });

  it("fails on empty input", () => {
    const c = ctx("");
    const r = parseNumber(c);
    expect(r.success).toBe(false);
  });
});

// ─── parseFlag ────────────────────────────────────────────────────────────────

describe("parseFlag", () => {
  it("parses a backslash flag", () => {
    const c = ctx("\\Seen");
    const r = parseFlag(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("\\Seen");
  });

  it("parses a flag without backslash", () => {
    const c = ctx("Answered");
    const r = parseFlag(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("Answered");
  });

  it("stops at space", () => {
    const c = ctx("\\Seen \\Flagged");
    const r = parseFlag(c);
    expect(r.value).toBe("\\Seen");
    expect(c.position).toBe(5);
  });

  it("fails on empty input", () => {
    const c = ctx("");
    const r = parseFlag(c);
    expect(r.success).toBe(false);
  });

  it("fails when only a backslash at end of input", () => {
    // backslash consumes position but then no more chars → consumed > start
    const c = ctx("\\");
    const r = parseFlag(c);
    // A lone backslash still moved position past it
    expect(r.success).toBe(true);
    expect(r.value).toBe("\\");
  });
});

// ─── parseQuotedString ────────────────────────────────────────────────────────

describe("parseQuotedString", () => {
  it("parses a simple quoted string", () => {
    const c = ctx('"hello"');
    const r = parseQuotedString(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("hello");
  });

  it("parses an empty quoted string", () => {
    const c = ctx('""');
    const r = parseQuotedString(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("");
  });

  it("handles escaped characters", () => {
    const c = ctx('"hello\\"world"');
    const r = parseQuotedString(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe('hello"world');
  });

  it("handles escaped backslash", () => {
    const c = ctx('"hello\\\\world"');
    const r = parseQuotedString(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("hello\\world");
  });

  it("fails on unterminated string", () => {
    const c = ctx('"hello');
    const r = parseQuotedString(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Unterminated");
  });

  it("fails if not starting with quote", () => {
    const c = ctx("hello");
    const r = parseQuotedString(c);
    expect(r.success).toBe(false);
  });
});

// ─── parseString ──────────────────────────────────────────────────────────────

describe("parseString", () => {
  it("delegates to parseQuotedString when input starts with quote", () => {
    const c = ctx('"test"');
    const r = parseString(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("test");
  });

  it("falls back to parseAtom for unquoted input", () => {
    const c = ctx("INBOX");
    const r = parseString(c);
    expect(r.success).toBe(true);
    expect(r.value).toBe("INBOX");
  });
});

// ─── parseSequenceSet ─────────────────────────────────────────────────────────

describe("parseSequenceSet", () => {
  it("parses a single number", () => {
    const c = ctx("5");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(true);
    expect(r.value!.ranges).toHaveLength(1);
    expect(r.value!.ranges[0]).toEqual({ start: 5 });
  });

  it("parses a range", () => {
    const c = ctx("1:5");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(true);
    expect(r.value!.ranges[0]).toEqual({ start: 1, end: 5 });
  });

  it("parses wildcard range 1:*", () => {
    const c = ctx("1:*");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(true);
    expect(r.value!.ranges[0].end).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("parses standalone *", () => {
    const c = ctx("*");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(true);
    expect(r.value!.ranges[0].start).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("parses comma-separated sequence set", () => {
    const c = ctx("1,3,5");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(true);
    expect(r.value!.ranges).toHaveLength(3);
  });

  it("parses mixed ranges and singles", () => {
    const c = ctx("1:3,5,7:9");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(true);
    expect(r.value!.ranges).toHaveLength(3);
    expect(r.value!.ranges[0]).toEqual({ start: 1, end: 3 });
    expect(r.value!.ranges[1]).toEqual({ start: 5 });
    expect(r.value!.ranges[2]).toEqual({ start: 7, end: 9 });
  });

  it("fails on empty input", () => {
    const c = ctx("");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(false);
  });

  it("fails on non-numeric non-star input", () => {
    const c = ctx("abc");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(false);
  });

  it("fails on invalid range end", () => {
    const c = ctx("1:abc");
    const r = parseSequenceSet(c);
    expect(r.success).toBe(false);
  });
});

// ─── skipWhitespace ───────────────────────────────────────────────────────────

describe("skipWhitespace", () => {
  it("skips spaces", () => {
    const c = ctx("   abc");
    skipWhitespace(c);
    expect(c.position).toBe(3);
  });

  it("does nothing when no leading spaces", () => {
    const c = ctx("abc");
    skipWhitespace(c);
    expect(c.position).toBe(0);
  });

  it("does not skip tabs or newlines", () => {
    const c = ctx("\tabc");
    skipWhitespace(c);
    expect(c.position).toBe(0);
  });
});

// ─── peek ─────────────────────────────────────────────────────────────────────

describe("peek", () => {
  it("returns current character without advancing", () => {
    const c = ctx("abc");
    expect(peek(c)).toBe("a");
    expect(c.position).toBe(0);
  });

  it("returns empty string at end of input", () => {
    const c = ctx("a", 1);
    expect(peek(c)).toBe("");
  });
});

// ─── consume ──────────────────────────────────────────────────────────────────

describe("consume", () => {
  it("consumes matching string and returns true", () => {
    const c = ctx("FLAGS");
    expect(consume(c, "FLAGS")).toBe(true);
    expect(c.position).toBe(5);
  });

  it("returns false and does not advance for non-match", () => {
    const c = ctx("FLAGS");
    expect(consume(c, "BODY")).toBe(false);
    expect(c.position).toBe(0);
  });

  it("consumes partial match from current position", () => {
    const c = ctx("ABCDEF", 2);
    expect(consume(c, "CD")).toBe(true);
    expect(c.position).toBe(4);
  });
});

// ─── parseDate ────────────────────────────────────────────────────────────────

describe("parseDate", () => {
  it("parses a valid date atom", () => {
    const c = ctx("01-Jan-2024");
    const r = parseDate(c);
    expect(r.success).toBe(true);
    expect(r.value).toBeInstanceOf(Date);
    expect(isNaN(r.value!.getTime())).toBe(false);
  });

  it("fails on invalid date", () => {
    const c = ctx("not-a-date");
    const r = parseDate(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Invalid date");
  });

  it("fails on empty input", () => {
    const c = ctx("");
    const r = parseDate(c);
    expect(r.success).toBe(false);
  });
});

// ─── parseModifierGroup ───────────────────────────────────────────────────────

describe("parseModifierGroup", () => {
  it("returns undefined without consuming when no group follows", () => {
    const c = ctx(" FLAGS", 0);
    const r = parseModifierGroup(c, "STORE", "UNCHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBeUndefined();
    expect(c.position).toBe(1);
  });

  it("returns undefined at end of input", () => {
    const c = ctx("");
    const r = parseModifierGroup(c, "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBeUndefined();
    expect(c.position).toBe(0);
  });

  it("parses a FETCH CHANGEDSINCE modseq", () => {
    const c = ctx(" (CHANGEDSINCE 12345)");
    const r = parseModifierGroup(c, "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBe(12345);
    expect(c.position).toBe(21);
  });

  it("parses a STORE UNCHANGEDSINCE modseq and stops before the item name", () => {
    const c = ctx("(UNCHANGEDSINCE 7) +FLAGS");
    const r = parseModifierGroup(c, "STORE", "UNCHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBe(7);
    expect(c.input.slice(c.position)).toBe(" +FLAGS");
  });

  it("matches the modifier name case-insensitively", () => {
    const c = ctx("(changedSince 9)");
    const r = parseModifierGroup(c, "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBe(9);
  });

  it("tolerates padding whitespace inside the group", () => {
    const c = ctx("(  CHANGEDSINCE   42  )");
    const r = parseModifierGroup(c, "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBe(42);
    expect(c.position).toBe(c.length);
  });

  it("accepts an empty group as no modifier", () => {
    const c = ctx("()");
    const r = parseModifierGroup(c, "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBeUndefined();
    expect(c.position).toBe(2);
  });

  it("keeps the last value when the modifier repeats", () => {
    const c = ctx("(CHANGEDSINCE 1 CHANGEDSINCE 2)");
    const r = parseModifierGroup(c, "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(true);
    expect(r.value).toBe(2);
  });

  it("rejects a modifier that belongs to the other command", () => {
    const r = parseModifierGroup(ctx("(UNCHANGEDSINCE 5)"), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unknown FETCH modifier: UNCHANGEDSINCE");
  });

  it("rejects an unknown modifier, naming it as sent", () => {
    const r = parseModifierGroup(ctx("(vanished 5)"), "STORE", "UNCHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unknown STORE modifier: vanished");
  });

  it("rejects a modifier name glued to its value", () => {
    const r = parseModifierGroup(ctx("(CHANGEDSINCE5)"), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unknown FETCH modifier: CHANGEDSINCE5");
  });

  it("rejects a non-atom where a modifier name is expected", () => {
    const r = parseModifierGroup(ctx('("CHANGEDSINCE" 5)'), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Invalid FETCH modifier");
  });

  it("rejects a non-numeric modseq", () => {
    const r = parseModifierGroup(ctx("(CHANGEDSINCE abc)"), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("CHANGEDSINCE requires a mod-sequence value");
  });

  it("rejects a negative modseq", () => {
    const r = parseModifierGroup(ctx("(UNCHANGEDSINCE -1)"), "STORE", "UNCHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("UNCHANGEDSINCE requires a mod-sequence value");
  });

  it("rejects a modifier with no modseq", () => {
    const r = parseModifierGroup(ctx("(CHANGEDSINCE)"), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("CHANGEDSINCE requires a mod-sequence value");
  });

  it("rejects a group missing its closing paren", () => {
    const r = parseModifierGroup(ctx("(CHANGEDSINCE 5"), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unterminated FETCH modifier group");
  });

  it("rejects a bare opening paren", () => {
    const r = parseModifierGroup(ctx("("), "STORE", "UNCHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unterminated STORE modifier group");
  });

  it("rejects a trailing token after the modseq", () => {
    const r = parseModifierGroup(ctx("(CHANGEDSINCE 5 6)"), "FETCH", "CHANGEDSINCE");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unknown FETCH modifier: 6");
  });
});
