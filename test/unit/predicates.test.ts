import { describe, expect, it } from "vitest";
import type { DateRange } from "../../src/query/daterange";
import { dateRangePredicate } from "../../src/query/predicates";

describe("dateRangePredicate", () => {
  it("emits inclusive bounds with >= and <=", () => {
    const range: DateRange = {
      start: 100,
      startInclusive: true,
      end: 200,
      endInclusive: true,
    };
    expect(dateRangePredicate("sample.created_at", range)).toEqual({
      sql: "sample.created_at >= ? AND sample.created_at <= ?",
      binds: [100, 200],
    });
  });

  it("emits exclusive bounds with > and <", () => {
    const range: DateRange = {
      start: 100,
      startInclusive: false,
      end: 200,
      endInclusive: false,
    };
    expect(dateRangePredicate("c", range)).toEqual({
      sql: "c > ? AND c < ?",
      binds: [100, 200],
    });
  });

  it("emits only the lower clause when the upper is open", () => {
    const range: DateRange = {
      start: 100,
      startInclusive: true,
      end: null,
      endInclusive: false,
    };
    expect(dateRangePredicate("c", range)).toEqual({
      sql: "c >= ?",
      binds: [100],
    });
  });

  it("emits only the upper clause when the lower is open", () => {
    const range: DateRange = {
      start: null,
      startInclusive: true,
      end: 200,
      endInclusive: false,
    };
    expect(dateRangePredicate("c", range)).toEqual({
      sql: "c < ?",
      binds: [200],
    });
  });

  it("emits nothing when both bounds are open", () => {
    const range: DateRange = {
      start: null,
      startInclusive: true,
      end: null,
      endInclusive: false,
    };
    expect(dateRangePredicate("c", range)).toEqual({ sql: "", binds: [] });
  });
});
