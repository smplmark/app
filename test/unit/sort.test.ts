import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { orderByClause, parseSort } from "../../src/query/sort";

const ALLOWED = ["name", "created_at"] as const;

describe("parseSort", () => {
  it("falls back to the default when raw is null or empty", () => {
    expect(parseSort(null, "-created_at", ALLOWED)).toEqual({ field: "created_at", desc: true });
    expect(parseSort("", "name", ALLOWED)).toEqual({ field: "name", desc: false });
  });

  it("parses ascending and descending", () => {
    expect(parseSort("name", "name", ALLOWED)).toEqual({ field: "name", desc: false });
    expect(parseSort("-created_at", "name", ALLOWED)).toEqual({ field: "created_at", desc: true });
  });

  it("rejects a field outside the allowed set with a 400", () => {
    try {
      parseSort("evil", "name", ALLOWED);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(400);
    }
  });
});

describe("orderByClause", () => {
  it("maps the field to a column, applies direction, and appends the tiebreaker", () => {
    const col = (f: string) => (f === "created_at" ? "t.created_at" : f);
    expect(orderByClause({ field: "created_at", desc: true }, col, "t.id")).toBe(
      "ORDER BY t.created_at DESC, t.id",
    );
    expect(orderByClause({ field: "name", desc: false }, col, "t.id")).toBe(
      "ORDER BY name ASC, t.id",
    );
  });
});
