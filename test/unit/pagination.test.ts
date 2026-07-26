import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { paginationMeta, parsePagination } from "../../src/query/pagination";

function expect400(fn: () => void) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (e) {
    expect((e as AppError).status).toBe(400);
  }
}

describe("parsePagination", () => {
  it("applies defaults when all params are absent", () => {
    expect(parsePagination(null, null, null)).toEqual({
      number: 1,
      size: 1000,
      includeTotal: false,
      offset: 0,
      limit: 1000,
    });
  });

  it("computes offset from page[number] and page[size]", () => {
    const p = parsePagination("3", "50", null);
    expect(p.offset).toBe(100);
    expect(p.limit).toBe(50);
  });

  it("accepts the max page size", () => {
    expect(parsePagination(null, "1000", null).size).toBe(1000);
  });

  it("accepts meta[total]=true and meta[total]=false", () => {
    expect(parsePagination(null, null, "true").includeTotal).toBe(true);
    expect(parsePagination(null, null, "false").includeTotal).toBe(false);
  });

  it.each([
    ["0", null, null, "page[number] below 1"],
    ["abc", null, null, "non-integer page[number]"],
    ["1.5", null, null, "fractional page[number]"],
    [null, "0", null, "page[size] below 1"],
    [null, "1001", null, "page[size] above max"],
    [null, "x", null, "non-integer page[size]"],
    [null, null, "yes", "invalid meta[total]"],
  ])("rejects %s/%s/%s (%s)", (n, s, t, _label) => {
    expect400(() => parsePagination(n, s, t));
  });
});

describe("paginationMeta", () => {
  const base = parsePagination("2", "10", null);

  it("omits totals when not requested", () => {
    expect(paginationMeta(base)).toEqual({ page: 2, size: 10 });
  });

  it("includes total and total_pages when requested", () => {
    const p = parsePagination("1", "10", "true");
    expect(paginationMeta(p, 101)).toEqual({
      page: 1,
      size: 10,
      total: 101,
      total_pages: 11,
    });
  });

  it("reports total_pages=0 for an empty result", () => {
    const p = parsePagination("1", "10", "true");
    expect(paginationMeta(p, 0)).toEqual({
      page: 1,
      size: 10,
      total: 0,
      total_pages: 0,
    });
  });

  it("omits totals when requested but total is undefined", () => {
    const p = parsePagination("1", "10", "true");
    expect(paginationMeta(p)).toEqual({ page: 1, size: 10 });
  });

  it("omits totals when a total is supplied but not requested", () => {
    expect(paginationMeta(base, 500)).toEqual({ page: 2, size: 10 });
  });
});
