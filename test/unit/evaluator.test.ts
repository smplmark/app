import { describe, expect, it } from "vitest";
import { applyRule, minuteOffsetMs } from "../../src/logic/evaluator";

const SKEW = { minute_offset_ms: [{ var: "created_at" }] };

describe("minuteOffsetMs", () => {
  it("is 0 at the top of a minute", () => {
    expect(minuteOffsetMs(Date.UTC(2026, 6, 1, 14, 3, 0))).toBe(0);
  });

  it("returns milliseconds past the previous minute", () => {
    expect(minuteOffsetMs(Date.UTC(2026, 6, 1, 14, 3, 0) + 87)).toBe(87);
    expect(minuteOffsetMs(Date.UTC(2026, 6, 1, 14, 3, 59) + 500)).toBe(59_500);
  });
});

describe("applyRule", () => {
  it("resolves a plain var", () => {
    expect(applyRule({ var: "created_at" }, { created_at: 42 })).toBe(42);
  });

  it("evaluates the minute_offset_ms custom op over created_at (number)", () => {
    const ms = Date.UTC(2026, 6, 1, 14, 3, 0) + 87;
    expect(applyRule(SKEW, { created_at: ms })).toBe(87);
  });

  it("coerces a non-number operand to a number", () => {
    // The var resolves to a string here, exercising the Number(ms) branch of the op.
    expect(applyRule({ minute_offset_ms: [{ var: "s" }] }, { s: "60000" })).toBe(
      0,
    );
  });
});
