import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { likePattern, parseSearchQuery } from "../../src/query/search";

function expect400(fn: () => unknown) {
  try {
    fn();
    throw new Error("expected a 400");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(400);
  }
}

describe("parseSearchQuery", () => {
  it("splits bare words, lowercases, and keeps quoted phrases contiguous", () => {
    expect(parseSearchQuery("fast GPU rendering")).toEqual(["fast", "gpu", "rendering"]);
    expect(parseSearchQuery('cycles "Blender 4.2" gpu')).toEqual(["cycles", "blender 4.2", "gpu"]);
    expect(parseSearchQuery('"exact phrase only"')).toEqual(["exact phrase only"]);
  });

  it("handles empty, whitespace, empty quotes, and unbalanced quotes without crashing", () => {
    expect(parseSearchQuery("")).toEqual([]);
    expect(parseSearchQuery("   ")).toEqual([]);
    expect(parseSearchQuery('""')).toEqual([]);
    expect(parseSearchQuery('gpu "unclosed phrase')).toEqual(["gpu", '"unclosed', "phrase"]);
  });

  it("400s on oversized input instead of scanning it", () => {
    expect400(() => parseSearchQuery("x".repeat(101)));
    expect400(() => parseSearchQuery(Array.from({ length: 9 }, (_, i) => `t${i}`).join(" ")));
  });
});

describe("likePattern", () => {
  it("wraps in % and escapes LIKE metacharacters", () => {
    expect(likePattern("gpu")).toBe("%gpu%");
    expect(likePattern("100%_done\\x")).toBe("%100\\%\\_done\\\\x%");
  });
});
