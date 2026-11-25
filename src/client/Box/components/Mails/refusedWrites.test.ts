import { describe, it, expect } from "bun:test";
import { REFUSED_FALLBACK, refusalMessage } from "./refusedWrites";

describe("refusalMessage", () => {
  it("is null when every write landed", () => {
    expect(refusalMessage([{ status: "success" }, { status: "success" }])).toBeNull();
  });

  it("carries the first refusal's own message", () => {
    expect(
      refusalMessage([
        { status: "success" },
        { status: "failed", message: "not yours" },
        { status: "error", message: "offline" }
      ])
    ).toBe("not yours");
  });

  it("falls back when a refusal gives no reason", () => {
    expect(refusalMessage([{ status: "error" }])).toBe(REFUSED_FALLBACK);
  });
});
