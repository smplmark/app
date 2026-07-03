import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { parseDateRange } from "../../src/query/daterange";

const U = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s);

describe("parseDateRange", () => {
  it("parses an inclusive-lower/exclusive-upper range", () => {
    const r = parseDateRange("[2026-06-01T00:00:00Z,2026-07-01T00:00:00Z)");
    expect(r).toEqual({
      start: U(2026, 6, 1),
      startInclusive: true,
      end: U(2026, 7, 1),
      endInclusive: false,
    });
  });

  it("parses an exclusive-lower/inclusive-upper range", () => {
    const r = parseDateRange("(2026-06-01T00:00:00Z,2026-07-01T00:00:00Z]");
    expect(r.startInclusive).toBe(false);
    expect(r.endInclusive).toBe(true);
  });

  it("parses an open lower bound (*)", () => {
    const r = parseDateRange("[*,2026-07-01T00:00:00Z)");
    expect(r.start).toBeNull();
    expect(r.end).toBe(U(2026, 7, 1));
  });

  it("parses an open upper bound (*)", () => {
    const r = parseDateRange("[2026-06-01T00:00:00Z,*)");
    expect(r.start).toBe(U(2026, 6, 1));
    expect(r.end).toBeNull();
  });

  it("parses both-open", () => {
    const r = parseDateRange("[*,*)");
    expect(r.start).toBeNull();
    expect(r.end).toBeNull();
  });

  it("treats a naive (no-timezone) datetime as UTC", () => {
    const r = parseDateRange("[2026-01-01T00:00:00,*)");
    expect(r.start).toBe(U(2026, 1, 1));
  });

  it("accepts a space-separated datetime", () => {
    const r = parseDateRange("[2026-01-01 12:00:00,*)");
    expect(r.start).toBe(U(2026, 1, 1, 12));
  });

  it("accepts a date-only token as UTC midnight", () => {
    const r = parseDateRange("[2026-01-01,*)");
    expect(r.start).toBe(U(2026, 1, 1));
  });

  it("honours an explicit timezone offset", () => {
    const r = parseDateRange("[2026-01-01T02:00:00+02:00,*)");
    expect(r.start).toBe(U(2026, 1, 1, 0));
  });

  it("trims whitespace around tokens", () => {
    const r = parseDateRange("[ 2026-01-01T00:00:00Z , * )");
    expect(r.start).toBe(U(2026, 1, 1));
    expect(r.end).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["2026-01-01,*)", "no leading bracket"],
    ["[*,*", "no trailing bracket"],
    ["[a,b,c)", "three tokens"],
    ["[2026-01-01T00:00:00Z)", "one token"],
    ["[not-a-date,*)", "non-ISO token"],
    ["[2026-13-45T99:99:99Z,*)", "ISO-shaped but unparseable"],
  ])("rejects %s (%s) with a 400", (value, _label) => {
    expect(() => parseDateRange(value)).toThrow(AppError);
    try {
      parseDateRange(value);
    } catch (e) {
      expect((e as AppError).status).toBe(400);
    }
  });
});
