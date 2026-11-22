
import { describe, it, expect } from "bun:test";
import { parseCommand } from "./index";
import { parseBodyFetch, parseBodySection } from "./fetch-parsers";
import type { FetchDataItem, ParseContext } from "../types";

function parseFetch(args: string) {
  const result = parseCommand(`A001 FETCH ${args}`);
  if (!result.success || result.value?.request.type !== "FETCH") {
    throw new Error(`FETCH parse failed: ${result.error}`);
  }
  return result.value.request.data as { sequenceSet: unknown; dataItems: FetchDataItem[] };
}

// ---------------------------------------------------------------------------
// Simple data items
// ---------------------------------------------------------------------------

describe("fetch-parsers > simple data items", () => {
  const simpleItems = [
    "ENVELOPE",
    "FLAGS",
    "INTERNALDATE",
    "RFC822",
    "RFC822.HEADER",
    "RFC822.SIZE",
    "RFC822.TEXT",
    "UID",
    "BODYSTRUCTURE",
  ];

  for (const item of simpleItems) {
    it(`should parse ${item} as single item`, () => {
      const data = parseFetch(`1 ${item}`);
      expect(data.dataItems).toHaveLength(1);
      expect(data.dataItems[0].type).toBe(item);
    });
  }
});

// ---------------------------------------------------------------------------
// Sequence sets
// ---------------------------------------------------------------------------

describe("fetch-parsers > sequence sets", () => {
  it("should parse single message number", () => {
    const data = parseFetch("1 FLAGS");
    expect(data.dataItems[0].type).toBe("FLAGS");
  });

  it("should parse range sequence", () => {
    const data = parseFetch("1:10 FLAGS");
    expect(data.dataItems[0].type).toBe("FLAGS");
  });

  it("should parse wildcard sequence", () => {
    const data = parseFetch("1:* FLAGS");
    expect(data.dataItems[0].type).toBe("FLAGS");
  });
});

// ---------------------------------------------------------------------------
// Parenthesized list of data items
// ---------------------------------------------------------------------------

describe("fetch-parsers > parenthesized lists", () => {
  it("should parse (FLAGS) as a list with one item", () => {
    const data = parseFetch("1 (FLAGS)");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("FLAGS");
  });

  it("should parse (FLAGS UID) as a list with two items", () => {
    const data = parseFetch("1 (FLAGS UID)");
    expect(data.dataItems).toHaveLength(2);
    expect(data.dataItems[0].type).toBe("FLAGS");
    expect(data.dataItems[1].type).toBe("UID");
  });

  it("should parse (FLAGS UID ENVELOPE) as a list with three items", () => {
    const data = parseFetch("1 (FLAGS UID ENVELOPE)");
    expect(data.dataItems).toHaveLength(3);
    expect(data.dataItems.map((i) => i.type)).toEqual(["FLAGS", "UID", "ENVELOPE"]);
  });

  it("should parse (RFC822.SIZE INTERNALDATE) correctly", () => {
    const data = parseFetch("1 (RFC822.SIZE INTERNALDATE)");
    expect(data.dataItems).toHaveLength(2);
    expect(data.dataItems[0].type).toBe("RFC822.SIZE");
    expect(data.dataItems[1].type).toBe("INTERNALDATE");
  });
});

// ---------------------------------------------------------------------------
// BODY data items
// ---------------------------------------------------------------------------

describe("fetch-parsers > BODY data items", () => {
  it("should parse bare BODY as the non-extensible BODYSTRUCTURE, not content (#666)", () => {
    // RFC 3501 §6.4.5: `BODY` (no section, no .PEEK) is the non-extensible form
    // of BODYSTRUCTURE — a structure line, NOT BODY[] content. It must not parse
    // to a content BODY item (which would stream the whole message and set \Seen).
    const data = parseFetch("1 BODY");
    expect(data.dataItems).toHaveLength(1);
    const item = data.dataItems[0];
    expect(item.type).toBe("BODYSTRUCTURE");
    if (item.type !== "BODYSTRUCTURE") throw new Error("expected BODYSTRUCTURE");
    expect(item.extensible).toBe(false);
  });

  it("should parse BODY[] as full body fetch", () => {
    const data = parseFetch("1 BODY[]");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("BODY");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("FULL");
  });

  it("should parse BODY.PEEK[] as peek body fetch", () => {
    const data = parseFetch("1 BODY.PEEK[]");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("BODY");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.peek).toBe(true);
  });

  it("should parse BODY[HEADER]", () => {
    const data = parseFetch("1 BODY[HEADER]");
    expect(data.dataItems).toHaveLength(1);
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("HEADER");
  });

  it("should parse BODY[TEXT]", () => {
    const data = parseFetch("1 BODY[TEXT]");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("TEXT");
  });

  it("should parse BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)]", () => {
    const data = parseFetch("1 BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)]");
    expect(data.dataItems).toHaveLength(1);
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("HEADER_FIELDS");
    if (bodyItem.section?.type !== "HEADER_FIELDS") throw new Error("expected HEADER_FIELDS section");
    expect(bodyItem.section.fields).toContain("FROM");
    expect(bodyItem.section.fields).toContain("TO");
    expect(bodyItem.section.fields).toContain("SUBJECT");
    expect(bodyItem.section.fields).toContain("DATE");
  });

  it("should parse BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)]", () => {
    const data = parseFetch("1 BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)]");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.peek).toBe(true);
    expect(bodyItem.section?.type).toBe("HEADER_FIELDS");
  });

  it("should parse BODY[1] for first MIME part", () => {
    const data = parseFetch("1 BODY[1]");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("MIME_PART");
  });

  it("should parse BODY[] with partial range <0.2048>", () => {
    const data = parseFetch("1 BODY[]<0.2048>");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.partial).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Common FETCH combinations (iOS Mail / Thunderbird patterns)
// ---------------------------------------------------------------------------

describe("fetch-parsers > real-world FETCH patterns", () => {
  it("should parse (UID FLAGS ENVELOPE BODYSTRUCTURE) — typical list view", () => {
    const data = parseFetch("1:* (UID FLAGS ENVELOPE BODYSTRUCTURE)");
    const types = data.dataItems.map((i) => i.type);
    expect(types).toContain("UID");
    expect(types).toContain("FLAGS");
    expect(types).toContain("ENVELOPE");
    expect(types).toContain("BODYSTRUCTURE");
    // The BODYSTRUCTURE token is the extensible form (carries the extension data).
    const structure = data.dataItems.find((i) => i.type === "BODYSTRUCTURE");
    if (structure?.type !== "BODYSTRUCTURE") throw new Error("expected BODYSTRUCTURE");
    expect(structure.extensible).toBe(true);
  });

  it("should parse (UID BODY.PEEK[]) — full message fetch", () => {
    const data = parseFetch("1 (UID BODY.PEEK[])");
    const types = data.dataItems.map((i) => i.type);
    expect(types).toContain("UID");
    expect(types).toContain("BODY");
  });

  it("should parse (UID RFC822.SIZE INTERNALDATE FLAGS) — metadata fetch", () => {
    const data = parseFetch("1:* (UID RFC822.SIZE INTERNALDATE FLAGS)");
    const types = data.dataItems.map((i) => i.type);
    expect(types).toContain("UID");
    expect(types).toContain("RFC822.SIZE");
    expect(types).toContain("INTERNALDATE");
    expect(types).toContain("FLAGS");
  });
});

describe("fetch-parsers > macros", () => {
  it("should expand FAST to (FLAGS INTERNALDATE RFC822.SIZE)", () => {
    const data = parseFetch("2 FAST");
    expect(data.dataItems.map((i) => i.type)).toEqual([
      "FLAGS",
      "INTERNALDATE",
      "RFC822.SIZE",
    ]);
  });

  it("should expand ALL to (FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)", () => {
    const data = parseFetch("2 ALL");
    expect(data.dataItems.map((i) => i.type)).toEqual([
      "FLAGS",
      "INTERNALDATE",
      "RFC822.SIZE",
      "ENVELOPE",
    ]);
  });

  it("should expand FULL to (FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE)", () => {
    const data = parseFetch("2 FULL");
    // Per RFC 3501 §6.4.5, FULL's BODY is the non-extensible BODYSTRUCTURE (a
    // compact structure line), NOT BODY[] (full content). Expanding to a
    // content BODY would make `FETCH 1:* FULL` stream every message's body.
    expect(data.dataItems.map((i) => i.type)).toEqual([
      "FLAGS",
      "INTERNALDATE",
      "RFC822.SIZE",
      "ENVELOPE",
      "BODYSTRUCTURE",
    ]);
    // Guard against a regression back to the full-content BODY[] shape.
    expect(data.dataItems.some((i) => i.type === "BODY")).toBe(false);
    // FULL's structure item is the non-extensible form (labelled `BODY`).
    const structure = data.dataItems.find((i) => i.type === "BODYSTRUCTURE");
    if (structure?.type !== "BODYSTRUCTURE") throw new Error("expected BODYSTRUCTURE");
    expect(structure.extensible).toBe(false);
  });

  it("should be case-insensitive (fast / all / full)", () => {
    expect(parseFetch("2 fast").dataItems).toHaveLength(3);
    expect(parseFetch("2 all").dataItems).toHaveLength(4);
    expect(parseFetch("2 full").dataItems).toHaveLength(5);
  });

  it("should expand macros under UID FETCH too", () => {
    const result = parseCommand("A001 UID FETCH 2 FAST");
    // UID FETCH wraps the inner FETCH request under a UID envelope.
    if (
      !result.success ||
      result.value?.request.type !== "UID" ||
      (result.value.request.data as { request: { type: string } }).request
        .type !== "FETCH"
    ) {
      throw new Error(`UID FETCH parse failed: ${result.error}`);
    }
    const inner = (
      result.value.request.data as { request: { data: { dataItems: FetchDataItem[] } } }
    ).request.data;
    expect(inner.dataItems.map((i) => i.type)).toEqual([
      "FLAGS",
      "INTERNALDATE",
      "RFC822.SIZE",
    ]);
  });

  it("should not treat a non-macro single item as a macro (regression)", () => {
    // FLAGS/RFC822.SIZE/BODY[] must still parse as their single selves.
    expect(parseFetch("1 FLAGS").dataItems.map((i) => i.type)).toEqual([
      "FLAGS",
    ]);
    expect(parseFetch("1 RFC822.SIZE").dataItems.map((i) => i.type)).toEqual([
      "RFC822.SIZE",
    ]);
    expect(parseFetch("1 BODY[]").dataItems.map((i) => i.type)).toEqual([
      "BODY",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseBodySection (direct)
// ---------------------------------------------------------------------------

describe("fetch-parsers > parseBodySection", () => {
  const cases: [string, unknown][] = [
    ["", { type: "FULL" }],
    ["HEADER", { type: "HEADER" }],
    ["header", { type: "HEADER" }],
    ["TEXT", { type: "TEXT" }],
    ["Text", { type: "TEXT" }],
    ["1", { type: "MIME_PART", partNumber: "1" }],
    ["1.2.3", { type: "MIME_PART", partNumber: "1.2.3" }],
    ["1.HEADER", { type: "MIME_PART", partNumber: "1", subSection: "HEADER" }],
    ["2.3.TEXT", { type: "MIME_PART", partNumber: "2.3", subSection: "TEXT" }],
    ["1.mime", { type: "MIME_PART", partNumber: "1", subSection: "MIME" }],
    [
      "HEADER.FIELDS (FROM TO)",
      { type: "HEADER_FIELDS", not: false, fields: ["FROM", "TO"] },
    ],
    [
      "header.fields (From x-Mailer)",
      { type: "HEADER_FIELDS", not: false, fields: ["FROM", "X-MAILER"] },
    ],
    [
      "HEADER.FIELDS.NOT (BCC)",
      { type: "HEADER_FIELDS", not: true, fields: ["BCC"] },
    ],
    [
      "HEADER.FIELDS.NOT (Received   DKIM-Signature)",
      { type: "HEADER_FIELDS", not: true, fields: ["RECEIVED", "DKIM-SIGNATURE"] },
    ],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      const result = parseBodySection(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual(expected as never);
    });
  }

  const invalid = ["FOO", "MIME", "1.", ".1", "1..2", "1.FOO", "HEADER.FIELDS", "a1"];

  for (const input of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const result = parseBodySection(input);
      expect(result.success).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.error).toBe(`Invalid body section: ${input}`);
    });
  }
});

// ---------------------------------------------------------------------------
// parseBodyFetch (direct)
// ---------------------------------------------------------------------------

describe("fetch-parsers > parseBodyFetch", () => {
  const context: ParseContext = { input: "", position: 0, length: 0 };

  const cases: [string, unknown][] = [
    ["BODY", { type: "BODYSTRUCTURE", extensible: false }],
    ["BODY.PEEK", { type: "BODY", peek: true, section: { type: "FULL" } }],
    ["BODY[]", { type: "BODY", peek: false, section: { type: "FULL" } }],
    ["BODY.PEEK[]", { type: "BODY", peek: true, section: { type: "FULL" } }],
    ["BODY[TEXT]", { type: "BODY", peek: false, section: { type: "TEXT" } }],
    [
      "BODY.PEEK[1.2.MIME]",
      {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "1.2", subSection: "MIME" },
      },
    ],
    [
      "BODY.PEEK[HEADER.FIELDS (DATE FROM)]",
      {
        type: "BODY",
        peek: true,
        section: { type: "HEADER_FIELDS", not: false, fields: ["DATE", "FROM"] },
      },
    ],
    [
      "BODY[]<0.1024>",
      {
        type: "BODY",
        peek: false,
        section: { type: "FULL" },
        partial: { start: 0, length: 1024 },
      },
    ],
    [
      "BODY.PEEK[2]<500.12345>",
      {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "2" },
        partial: { start: 500, length: 12345 },
      },
    ],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${input}`, () => {
      const result = parseBodyFetch(input, context);
      expect(result.success).toBe(true);
      expect(result.value).toEqual(expected as never);
    });
  }

  it("leaves partial undefined when no range follows the section", () => {
    const result = parseBodyFetch("BODY[HEADER]", context);
    expect(result.value).toEqual({ type: "BODY", peek: false, section: { type: "HEADER" } });
    if (result.value?.type !== "BODY") throw new Error("expected BODY");
    expect(result.value.partial).toBeUndefined();
  });

  it("rejects an unknown section atom inside well-formed brackets", () => {
    const result = parseBodyFetch("BODY[FOO]", context);
    expect(result.success).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.error).toBe("Invalid body section");
  });

  const malformed = ["BODY[", "BODY[1", "BODY.PEEK[TEXT", "BODY]", "BODYX[]", "BODY.PEEKX[]", "RFC822", ""];

  for (const input of malformed) {
    it(`rejects malformed expression ${JSON.stringify(input)}`, () => {
      const result = parseBodyFetch(input, context);
      expect(result.success).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.error).toBe(`Invalid body expression: ${input}`);
    });
  }
});
