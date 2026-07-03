import { describe, expect, it } from "vitest";
import { computeMetrics, type DerivedContext } from "../../src/logic/derived";
import type { SampleSchema } from "../../src/types";

const SKEW_SCHEMA: SampleSchema = {
  metrics: [],
  derived: [
    { name: "skew_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } },
  ],
};
const EMPTY_SCHEMA: SampleSchema = { metrics: [], derived: [] };
const MS = Date.UTC(2026, 6, 1, 14, 3, 0) + 87;

const ctx = (createdAt: number, startedAt: number | null = null): DerivedContext => ({
  created_at: createdAt,
  run: { started_at: startedAt, ended_at: null },
});

describe("computeMetrics", () => {
  it("computes a derived metric for a bare (null-metrics) observation", () => {
    expect(computeMetrics(null, SKEW_SCHEMA, ctx(MS))).toEqual({ skew_ms: 87 });
  });

  it("merges stored metrics with derived metrics", () => {
    expect(computeMetrics('{"p95_ms":12.4}', SKEW_SCHEMA, ctx(MS))).toEqual({
      p95_ms: 12.4,
      skew_ms: 87,
    });
  });

  it("computes a relative-time metric from the widened run context (elapsed_ms)", () => {
    const schema: SampleSchema = {
      metrics: [],
      derived: [
        { name: "elapsed_ms", expr: { "-": [{ var: "created_at" }, { var: "run.started_at" }] } },
      ],
    };
    const started = Date.UTC(2026, 6, 1, 14, 0, 0);
    const created = started + 4200;
    expect(computeMetrics(null, schema, ctx(created, started))).toEqual({ elapsed_ms: 4200 });
  });

  it("returns null when there is nothing to emit", () => {
    expect(computeMetrics(null, EMPTY_SCHEMA, ctx(MS))).toBeNull();
  });

  it("treats invalid / non-object stored JSON as empty", () => {
    expect(computeMetrics("not json", SKEW_SCHEMA, ctx(MS))).toEqual({ skew_ms: 87 });
    expect(computeMetrics("[1,2]", EMPTY_SCHEMA, ctx(MS))).toBeNull();
    expect(computeMetrics("5", EMPTY_SCHEMA, ctx(MS))).toBeNull();
  });

  it("lets a derived value win a name collision with a stored value", () => {
    expect(computeMetrics('{"skew_ms":999}', SKEW_SCHEMA, ctx(MS))).toEqual({ skew_ms: 87 });
  });

  it("omits a derived field whose expression throws, without failing the read", () => {
    const schema: SampleSchema = {
      metrics: [],
      derived: [{ name: "x", expr: { no_such_op: [1] } }],
    };
    expect(computeMetrics('{"a":1}', schema, ctx(MS))).toEqual({ a: 1 });
  });

  it("omits a derived field that evaluates to a non-finite or non-numeric value", () => {
    const schema: SampleSchema = {
      metrics: [],
      derived: [
        { name: "inf", expr: { "/": [1, 0] } },
        { name: "str", expr: "hello" },
      ],
    };
    expect(computeMetrics('{"a":1}', schema, ctx(MS))).toEqual({ a: 1 });
  });
});
