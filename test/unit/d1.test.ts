import { describe, expect, it } from "vitest";
import { isUniqueViolation, jsonOrNull } from "../../src/data/d1";

describe("isUniqueViolation", () => {
  it("detects a UNIQUE constraint error", () => {
    expect(
      isUniqueViolation(new Error("D1_ERROR: UNIQUE constraint failed: benchmark.key")),
    ).toBe(true);
  });
  it("is false for other errors and non-errors", () => {
    expect(isUniqueViolation(new Error("NOT NULL constraint failed"))).toBe(false);
    expect(isUniqueViolation("some string")).toBe(false);
  });
});

describe("jsonOrNull", () => {
  it("serializes a value and passes null/undefined through as null", () => {
    expect(jsonOrNull({ a: 1 })).toBe('{"a":1}');
    expect(jsonOrNull(null)).toBeNull();
    expect(jsonOrNull(undefined)).toBeNull();
  });
});
