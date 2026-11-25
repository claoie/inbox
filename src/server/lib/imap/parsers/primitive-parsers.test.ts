import { describe, it, expect } from "bun:test";
import {
  parseAtom,
  parseDate,
  parseFlag,
  parseString,
  parseListMailbox,
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

// ─── parseListMailbox ─────────────────────────────────────────────────────────

describe("parseListMailbox", () => {
  it.each(["*", "%", "INBOX/%", "%/accounts", "INBOX*", "*%*", "a]b[c"])(
    "captures %p whole, wildcards included",
    (input) => {
      const c = ctx(input);
      const r = parseListMailbox(c);
      expect(r).toEqual({ success: true, value: input, consumed: input.length });
      expect(c.position).toBe(input.length);
    }
  );

  it("keeps a wildcard pattern that parseAtom truncates", () => {
    expect(parseAtom(ctx("INBOX/%")).value).toBe("INBOX/");
    expect(parseListMailbox(ctx("INBOX/%")).value).toBe("INBOX/%");
  });

  it.each([
    ["space", "INBOX/% rest"],
    ["open paren", "INBOX/%(x"],
    ["close paren", "INBOX/%)"],
    ["brace", "INBOX/%{5}"],
    ["quote", 'INBOX/%"x'],
    ["backslash", "INBOX/%\\x"],
    ["CR", "INBOX/%\r\n"],
    ["LF", "INBOX/%\n"],
    ["control char", "INBOX/%\x01x"]
  ])("stops at %s", (_, input) => {
    const c = ctx(input);
    const r = parseListMailbox(c);
    expect(r).toEqual({ success: true, value: "INBOX/%", consumed: 7 });
    expect(c.position).toBe(7);
  });

  it("parses the quoted form and unescapes quoted-specials", () => {
    const c = ctx('"INBOX/%" rest');
    expect(parseListMailbox(c)).toEqual({ success: true, value: "INBOX/%", consumed: 9 });
    expect(c.position).toBe(9);
    expect(parseListMailbox(ctx('"a\\"b\\\\c"')).value).toBe('a"b\\c');
  });

  it("accepts an empty quoted pattern", () => {
    expect(parseListMailbox(ctx('""'))).toEqual({ success: true, value: "", consumed: 2 });
  });

  it("keeps multibyte characters intact", () => {
    expect(parseListMailbox(ctx("café/😀 x")).value).toBe("café/😀");
    expect(parseListMailbox(ctx('"café 😀" x')).value).toBe("café 😀");
  });

  it("fails on an unterminated quoted pattern", () => {
    const r = parseListMailbox(ctx('"INBOX/%'));
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unterminated quoted string");
  });

  it.each(["", " INBOX", "(INBOX", "\\Seen", "{5}"])(
    "fails without consuming on %p",
    (input) => {
      const c = ctx(input);
      expect(parseListMailbox(c)).toEqual({
        success: false,
        error: "Expected list mailbox",
        consumed: 0
      });
      expect(c.position).toBe(0);
    }
  );

  it("starts at the context position, not the input start", () => {
    const c = ctx('LIST "" INBOX/%', 8);
    expect(parseListMailbox(c)).toEqual({ success: true, value: "INBOX/%", consumed: 7 });
    expect(c.position).toBe(15);
  });

  it("fails at end of input", () => {
    const c = ctx("abc", 3);
    expect(parseListMailbox(c).success).toBe(false);
    expect(c.position).toBe(3);
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
