import { describe, it, expect } from "bun:test";
import { MAX_PAGE_SIZE, encodeListCursor, parseListPageParams } from "./list-page";

const CURSOR = {
  date: "2026-11-15 02:55:04.123456+00",
  id: "22222222-2222-2222-2222-222222222222",
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("parseListPageParams", () => {
  it("answers the whole list when no limit is given", () => {
    expect(parseListPageParams({})).toEqual({ paged: false });
  });

  it("reads a first page", () => {
    expect(parseListPageParams({ limit: "100" })).toEqual({ paged: true, limit: 100 });
  });

  it("round-trips a cursor it encoded", () => {
    expect(
      parseListPageParams({ limit: "100", cursor: encodeListCursor(CURSOR)! })
    ).toEqual({ paged: true, limit: 100, after: CURSOR });
  });

  it("accepts the text form of any session time zone", () => {
    for (const date of ["2026-11-15 02:55:04-07", "2026-11-15 02:55:04.5+05:30", "2026-03-08 03:00:00+00"]) {
      const cursor = encodeListCursor({ date, id: CURSOR.id })!;
      expect(parseListPageParams({ limit: "1", cursor })).toEqual({
        paged: true,
        limit: 1,
        after: { date, id: CURSOR.id },
      });
    }
  });

  it("encodes no cursor as null", () => {
    expect(encodeListCursor(null)).toBeNull();
  });

  it("accepts limits 1 and the maximum, and rejects 0, the maximum + 1 and non-integers", () => {
    expect(parseListPageParams({ limit: "1" })).toEqual({ paged: true, limit: 1 });
    expect(parseListPageParams({ limit: String(MAX_PAGE_SIZE) })).toEqual({
      paged: true,
      limit: MAX_PAGE_SIZE,
    });
    for (const limit of ["0", String(MAX_PAGE_SIZE + 1), "1.5", "-3", "ten", ""]) {
      expect(parseListPageParams({ limit })).toHaveProperty("error");
    }
  });

  it("rejects a cursor without a limit", () => {
    expect(parseListPageParams({ cursor: encodeListCursor(CURSOR)! })).toHaveProperty("error");
  });

  it("rejects a cursor that is not one of ours", () => {
    for (const cursor of [
      "not-base64-json",
      encode([CURSOR]),
      encode({ ...CURSOR, id: "1; DROP TABLE mails" }),
      encode({ ...CURSOR, date: "yesterday" }),
      encode({ ...CURSOR, date: "2026-11-15T02:55:04Z" }),
      encode({ id: CURSOR.id }),
    ]) {
      expect(parseListPageParams({ limit: "100", cursor })).toHaveProperty("error");
    }
  });
});
