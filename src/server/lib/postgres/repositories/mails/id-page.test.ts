import { describe, it, expect } from "bun:test";
import { toIdPage } from "./http";

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    mail_id: `m${i}`,
    cursor_date: `2026-11-15 00:00:${String(59 - i).padStart(2, "0")}+00`,
  }));

describe("toIdPage", () => {
  it("returns the page and the last row's cursor when the extra row came back", () => {
    expect(toIdPage(rows(4), 3)).toEqual({
      ids: ["m0", "m1", "m2"],
      next: { date: "2026-11-15 00:00:57+00", id: "m2" },
    });
  });

  it("ends the list when exactly a page came back", () => {
    expect(toIdPage(rows(3), 3)).toEqual({ ids: ["m0", "m1", "m2"], next: null });
  });

  it("ends the list on a short or empty page", () => {
    expect(toIdPage(rows(1), 3)).toEqual({ ids: ["m0"], next: null });
    expect(toIdPage([], 3)).toEqual({ ids: [], next: null });
  });
});
