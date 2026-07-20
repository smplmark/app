import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import {
  diffMeasurementSchema,
  parseMeasurementSchema,
  validateMeasurementSchema,
} from "../../src/schema/measurement_schema";
import type { MeasurementSchema } from "../../src/types";

function expectStatus(fn: () => void, status: number) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (e) {
    expect((e as AppError).status).toBe(status);
  }
}
const expect400 = (fn: () => void) => expectStatus(fn, 400);

describe("validateMeasurementSchema", () => {
  it("normalizes a full valid schema", () => {
    const out = validateMeasurementSchema({
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
    expect(validateMeasurementSchema({})).toEqual({ metrics: [], derived: [] });
  });

  it("keeps a metric without a unit and a derived without a unit", () => {
    const out = validateMeasurementSchema({
      metrics: [{ name: "n", type: "number" }],
      derived: [{ name: "d", expr: { var: "created_at" } }],
    });
    expect(out.metrics[0].unit).toBeUndefined();
    expect(out.derived[0].unit).toBeUndefined();
  });

  it("carries per-metric descriptions through", () => {
    const out = validateMeasurementSchema({
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
    expect400(() => validateMeasurementSchema(value));
  });
});

describe("parseMeasurementSchema", () => {
  it("round-trips a stored schema", () => {
    const json = JSON.stringify({ metrics: [], derived: [{ name: "d", expr: {} }] });
    expect(parseMeasurementSchema(json)).toEqual({
      metrics: [],
      derived: [{ name: "d", expr: {} }],
    });
  });

  it("defaults null / missing keys to empty arrays", () => {
    expect(parseMeasurementSchema("null")).toEqual({ metrics: [], derived: [] });
    expect(parseMeasurementSchema("{}")).toEqual({ metrics: [], derived: [] });
  });

  it("round-trips a chart block", () => {
    const json = JSON.stringify({
      metrics: [{ name: "skew_ms", type: "number" }],
      derived: [],
      chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
    });
    expect(parseMeasurementSchema(json).chart).toEqual({ x: "created_at", y: "skew_ms", x_kind: "TIME" });
  });
});

describe("chart validation", () => {
  const withMetric = (chart: unknown) => ({
    metrics: [{ name: "skew_ms", type: "number" }],
    derived: [],
    chart,
  });

  it("accepts a time-series chart and a scalar (x=null) chart", () => {
    expect(validateMeasurementSchema(withMetric({ x: "created_at", y: "skew_ms", x_kind: "TIME" })).chart)
      .toEqual({ x: "created_at", y: "skew_ms", x_kind: "TIME" });
    expect(validateMeasurementSchema(withMetric({ x: null, y: "skew_ms" })).chart)
      .toEqual({ x: null, y: "skew_ms" });
  });

  it("infers no chart when omitted or explicitly null", () => {
    expect(validateMeasurementSchema({ metrics: [], derived: [] }).chart).toBeUndefined();
    expect(validateMeasurementSchema({ metrics: [], derived: [], chart: null }).chart).toBeUndefined();
  });

  it.each([
    [withMetric({ y: "skew_ms", x: "nope" }), "unknown x metric"],
    [withMetric({ y: "nope" }), "unknown y metric"],
    [withMetric({ x: "created_at" }), "missing y"],
    [withMetric({ x: "created_at", y: "skew_ms", x_kind: "PIE" }), "bad x_kind"],
  ])("rejects %o (%s)", (value, _label) => {
    expect400(() => validateMeasurementSchema(value));
  });
});

describe("diffMeasurementSchema", () => {
  const published: MeasurementSchema = {
    metrics: [{ name: "skew_ms", type: "number", unit: "ms", description: "old" }],
    derived: [{ name: "d", expr: { minute_offset_ms: [{ var: "created_at" }] }, unit: "ms" }],
    chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
  };
  // The same schema without its chart (built without the key — absent compares as null).
  const chartless: MeasurementSchema = {
    metrics: published.metrics,
    derived: published.derived,
  };

  it("reports identical schemas as unchanged", () => {
    expect(diffMeasurementSchema(published, { ...published })).toEqual({
      changed: false,
      semantic_core: false,
    });
  });

  it("ignores key-order-only differences (canonical compare)", () => {
    const reordered: MeasurementSchema = {
      metrics: [{ type: "number", description: "old", unit: "ms", name: "skew_ms" }],
      derived: [{ expr: { minute_offset_ms: [{ var: "created_at" }] }, unit: "ms", name: "d" }],
      chart: { y: "skew_ms", x_kind: "TIME", x: "created_at" },
    };
    expect(diffMeasurementSchema(published, reordered)).toEqual({
      changed: false,
      semantic_core: false,
    });
  });

  it("flags cosmetic unit/format/description edits as changed, but not semantic-core", () => {
    const edited: MeasurementSchema = {
      metrics: [
        { name: "skew_ms", type: "number", unit: "milliseconds", format: "#,##0", description: "new" },
      ],
      derived: [{ name: "d", expr: { minute_offset_ms: [{ var: "created_at" }] }, unit: "ms" }],
      chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
    };
    expect(diffMeasurementSchema(published, edited)).toEqual({
      changed: true,
      semantic_core: false,
    });
  });

  it("treats reordered metrics as a change, but not a semantic-core one (name-sorted set compare)", () => {
    const pair: MeasurementSchema = {
      metrics: [{ name: "a_ms", type: "number" }, { name: "b_ms", type: "number" }],
      derived: [],
    };
    const swapped: MeasurementSchema = {
      metrics: [{ name: "b_ms", type: "number" }, { name: "a_ms", type: "number" }],
      derived: [],
    };
    expect(diffMeasurementSchema(pair, swapped)).toEqual({
      changed: true,
      semantic_core: false,
    });
  });

  it("ignores a changed derived expression — the formula lives on the library metric, not the schema", () => {
    const before: MeasurementSchema = { metrics: [], derived: [{ name: "d", unit: "ms", expr: { "+": [1, 1] } }] };
    const after: MeasurementSchema = {
      metrics: [],
      derived: [{ name: "d", unit: "ms", expr: { "%": [{ var: "created_at" }, 3_600_000] } }],
    };
    expect(diffMeasurementSchema(before, after)).toEqual({
      changed: false,
      semantic_core: false,
    });
  });

  it("flags an added metric as semantic-core", () => {
    const grown: MeasurementSchema = {
      ...published,
      metrics: [...published.metrics, { name: "extra", type: "number" }],
    };
    expect(diffMeasurementSchema(published, grown)).toEqual({
      changed: true,
      semantic_core: true,
    });
  });

  it("flags a removed derived as semantic-core", () => {
    const shrunk: MeasurementSchema = { ...published, derived: [] };
    expect(diffMeasurementSchema(published, shrunk)).toEqual({
      changed: true,
      semantic_core: true,
    });
  });

  it("flags chart changes as semantic-core: added, changed, and removed", () => {
    // Added where none existed.
    expect(diffMeasurementSchema(chartless, published)).toEqual({
      changed: true,
      semantic_core: true,
    });
    // Changed mapping.
    expect(
      diffMeasurementSchema(published, { ...published, chart: { x: null, y: "skew_ms" } }),
    ).toEqual({ changed: true, semantic_core: true });
    // Removed (an absent chart compares as null).
    expect(diffMeasurementSchema(published, chartless)).toEqual({
      changed: true,
      semantic_core: true,
    });
  });
});
