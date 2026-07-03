import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import {
  assertFrozenCompatible,
  parseSampleSchema,
  validateSampleSchema,
} from "../../src/schema/sample_schema";
import type { SampleSchema } from "../../src/types";

function expectStatus(fn: () => void, status: number) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (e) {
    expect((e as AppError).status).toBe(status);
  }
}
const expect400 = (fn: () => void) => expectStatus(fn, 400);
const expect409 = (fn: () => void) => expectStatus(fn, 409);

describe("validateSampleSchema", () => {
  it("normalizes a full valid schema", () => {
    const out = validateSampleSchema({
      metrics: [{ name: "p95_ms", type: "number", unit: "ms" }],
      derived: [
        { name: "skew_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } },
      ],
    });
    expect(out).toEqual({
      metrics: [{ name: "p95_ms", type: "number", unit: "ms" }],
      derived: [
        { name: "skew_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } },
      ],
    });
  });

  it("defaults missing metrics/derived to empty arrays", () => {
    expect(validateSampleSchema({})).toEqual({ metrics: [], derived: [] });
  });

  it("keeps a metric without a unit and a derived without a unit", () => {
    const out = validateSampleSchema({
      metrics: [{ name: "n", type: "number" }],
      derived: [{ name: "d", expr: { var: "created_at" } }],
    });
    expect(out.metrics[0].unit).toBeUndefined();
    expect(out.derived[0].unit).toBeUndefined();
  });

  it("carries per-metric descriptions through", () => {
    const out = validateSampleSchema({
      metrics: [{ name: "n", type: "number", description: "a stored value" }],
      derived: [{ name: "d", expr: {}, description: "a derived value" }],
    });
    expect(out.metrics[0].description).toBe("a stored value");
    expect(out.derived[0].description).toBe("a derived value");
  });

  it.each([
    [null, "null value"],
    [["a"], "array value"],
    ["str", "string value"],
    [{ metrics: {} }, "metrics not an array"],
    [{ derived: 5 }, "derived not an array"],
    [{ metrics: [1] }, "metric not an object"],
    [{ metrics: [{ type: "number" }] }, "metric missing name"],
    [{ metrics: [{ name: "", type: "number" }] }, "metric empty name"],
    [{ metrics: [{ name: "x" }] }, "metric missing type"],
    [{ metrics: [{ name: "x", type: "number", unit: 5 }] }, "metric bad unit"],
    [{ metrics: [{ name: "x", type: "number", description: 5 }] }, "metric bad description"],
    [{ derived: [1] }, "derived not an object"],
    [{ derived: [{ name: "x" }] }, "derived missing expr"],
    [{ derived: [{ expr: {} }] }, "derived missing name"],
    [{ derived: [{ name: "x", expr: {}, unit: 5 }] }, "derived bad unit"],
    [{ derived: [{ name: "x", expr: {}, description: 5 }] }, "derived bad description"],
    [
      { metrics: [{ name: "dup", type: "number" }, { name: "dup", type: "number" }] },
      "duplicate within metrics",
    ],
    [
      {
        metrics: [{ name: "dup", type: "number" }],
        derived: [{ name: "dup", expr: {} }],
      },
      "duplicate across metrics and derived",
    ],
  ])("rejects %o (%s)", (value, _label) => {
    expect400(() => validateSampleSchema(value));
  });
});

describe("parseSampleSchema", () => {
  it("round-trips a stored schema", () => {
    const json = JSON.stringify({ metrics: [], derived: [{ name: "d", expr: {} }] });
    expect(parseSampleSchema(json)).toEqual({
      metrics: [],
      derived: [{ name: "d", expr: {} }],
    });
  });

  it("defaults null / missing keys to empty arrays", () => {
    expect(parseSampleSchema("null")).toEqual({ metrics: [], derived: [] });
    expect(parseSampleSchema("{}")).toEqual({ metrics: [], derived: [] });
  });

  it("round-trips a chart block", () => {
    const json = JSON.stringify({
      metrics: [{ name: "skew_ms", type: "number" }],
      derived: [],
      chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
    });
    expect(parseSampleSchema(json).chart).toEqual({ x: "created_at", y: "skew_ms", x_kind: "TIME" });
  });
});

describe("chart validation", () => {
  const withMetric = (chart: unknown) => ({
    metrics: [{ name: "skew_ms", type: "number" }],
    derived: [],
    chart,
  });

  it("accepts a time-series chart and a scalar (x=null) chart", () => {
    expect(validateSampleSchema(withMetric({ x: "created_at", y: "skew_ms", x_kind: "TIME" })).chart)
      .toEqual({ x: "created_at", y: "skew_ms", x_kind: "TIME" });
    expect(validateSampleSchema(withMetric({ x: null, y: "skew_ms" })).chart)
      .toEqual({ x: null, y: "skew_ms" });
  });

  it("infers no chart when omitted or explicitly null", () => {
    expect(validateSampleSchema({ metrics: [], derived: [] }).chart).toBeUndefined();
    expect(validateSampleSchema({ metrics: [], derived: [], chart: null }).chart).toBeUndefined();
  });

  it.each([
    [withMetric({ y: "skew_ms", x: "nope" }), "unknown x metric"],
    [withMetric({ y: "nope" }), "unknown y metric"],
    [withMetric({ x: "created_at" }), "missing y"],
    [withMetric({ x: "created_at", y: "skew_ms", x_kind: "PIE" }), "bad x_kind"],
  ])("rejects %o (%s)", (value, _label) => {
    expect400(() => validateSampleSchema(value));
  });
});

describe("assertFrozenCompatible", () => {
  const published: SampleSchema = {
    metrics: [{ name: "skew_ms", type: "number", unit: "ms", description: "old" }],
    derived: [{ name: "d", expr: { minute_offset_ms: [{ var: "created_at" }] }, unit: "ms" }],
    chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
  };

  it("allows cosmetic-only changes (unit/description)", () => {
    const edited: SampleSchema = {
      metrics: [{ name: "skew_ms", type: "number", unit: "milliseconds", description: "new" }],
      derived: [{ name: "d", expr: { minute_offset_ms: [{ var: "created_at" }] }, unit: "ms" }],
      chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
    };
    expect(() => assertFrozenCompatible(published, edited)).not.toThrow();
  });

  it("rejects a changed derived expression", () => {
    const edited: SampleSchema = {
      ...published,
      derived: [{ name: "d", expr: { "+": [1, 1] }, unit: "ms" }],
    };
    expect409(() => assertFrozenCompatible(published, edited));
  });

  it("rejects an added metric and a changed chart mapping", () => {
    expect409(() =>
      assertFrozenCompatible(published, {
        ...published,
        metrics: [...published.metrics, { name: "extra", type: "number" }],
      }),
    );
    expect409(() =>
      assertFrozenCompatible(published, { ...published, chart: { x: null, y: "skew_ms" } }),
    );
  });
});
