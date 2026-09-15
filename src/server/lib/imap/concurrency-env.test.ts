import { describe, it, expect } from "bun:test";
import { parseConcurrencyValue } from "./concurrency-env";

describe("parseConcurrencyValue", () => {
  it("returns the default when raw is undefined", () => {
    expect(parseConcurrencyValue(undefined, "X", 5, "test")).toBe(5);
  });

  it("returns the default when raw is an empty string", () => {
    expect(parseConcurrencyValue("", "X", 5, "test")).toBe(5);
  });

  it("parses a valid positive integer", () => {
    expect(parseConcurrencyValue("3", "X", 5, "test")).toBe(3);
  });

  it("falls back to the default on a non-numeric value", () => {
    expect(parseConcurrencyValue("nope", "X", 5, "test")).toBe(5);
  });

  it("falls back to the default on zero", () => {
    expect(parseConcurrencyValue("0", "X", 5, "test")).toBe(5);
  });

  it("falls back to the default on a negative value", () => {
    expect(parseConcurrencyValue("-1", "X", 5, "test")).toBe(5);
  });

  it("truncates a fractional value via parseInt", () => {
    expect(parseConcurrencyValue("3.9", "X", 5, "test")).toBe(3);
  });
});
