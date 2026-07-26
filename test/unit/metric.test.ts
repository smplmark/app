// Metric validation (src/schema/metric): parseMetric normalizes a client-supplied metric — the
// unit/format/description facets and the name slug — parseStoredFormula tolerantly re-parses stored
// JSON, and metricSnapshot copies a library metric into a benchmark's measurement_schema entry.
// (Formula parsing/compilation itself is covered in metric_formula.test.ts.)
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors";
import { metricSnapshot, parseMetric, parseStoredFormula } from "../../src/schema/metric";
import type { MetricFormula, MetricRow } from "../../src/types";

function expect400(fn: () => void, match?: RegExp) {
  expect(fn).toThrow(BadRequestError);
  if (match) expect(fn).toThrow(match);
}

const attrs = (extra: Record<string, unknown> = {}) => ({ label: "P95 latency", type: "INTEGER", ...extra });

describe("parseMetric", () => {
  it("rejects a label/name that slugs to nothing", () => {
    expect400(() => parseMetric(attrs({ label: "!!!" })), /at least one letter or number/);
  });

  it("validates the unit facet", () => {
    expect(parseMetric(attrs({ unit: " ms " })).unit).toBe("ms");
    expect(parseMetric(attrs({ unit: "   " })).unit).toBeNull();
    expect(parseMetric(attrs()).unit).toBeNull();
    expect400(() => parseMetric(attrs({ unit: 42 })), /unit must be a string/);
    expect400(() => parseMetric(attrs({ unit: "u".repeat(25) })), /at most 24 characters/);
  });

  it("validates the format facet", () => {
    expect(parseMetric(attrs({ format: "#,##0.00" })).format).toBe("#,##0.00");
    expect(parseMetric(attrs({ format: "   " })).format).toBeNull();
    expect400(() => parseMetric(attrs({ format: 42 })), /format must be a string/);
    expect400(() => parseMetric(attrs({ format: "0".repeat(33) })), /at most 32 characters/);
    expect400(() => parseMetric(attrs({ format: "abc" })), /may use only the characters/);
    expect400(() => parseMetric(attrs({ format: "0.0.0" })), /at most one decimal point/);
  });

  it("validates the description", () => {
    expect(parseMetric(attrs({ description: " d " })).description).toBe("d");
    expect(parseMetric(attrs({ description: "   " })).description).toBeNull();
    expect400(() => parseMetric(attrs({ description: 42 })), /description must be a string/);
    expect400(() => parseMetric(attrs({ description: "d".repeat(501) })), /at most 500 characters/);
  });

  it("rejects a STEP operand whose step id is not a string", () => {
    const formula = {
      steps: [
        { kind: "OP", op: "ADD", a: { kind: "NUMBER", value: 1 }, b: { kind: "STEP", step: 42 } },
      ],
    };
    expect400(() => parseMetric(attrs({ type: "FORMULA", formula })), /must reference an earlier step/);
  });
});

describe("parseStoredFormula", () => {
  it("round-trips a stored object and maps everything else to null", () => {
    const formula: MetricFormula = {
      steps: [{ id: "A", kind: "OP", op: "ADD", a: { kind: "NUMBER", value: 1 }, b: { kind: "NUMBER", value: 2 } }],
      result: "A",
    };
    expect(parseStoredFormula(JSON.stringify(formula))).toEqual(formula);
    expect(parseStoredFormula(null)).toBeNull();
    expect(parseStoredFormula("")).toBeNull();
    expect(parseStoredFormula("[1,2]")).toBeNull();
    expect(parseStoredFormula("5")).toBeNull();
    expect(parseStoredFormula("null")).toBeNull();
    expect(parseStoredFormula("{garbage")).toBeNull();
  });
});

describe("metricSnapshot", () => {
  const row = (over: Partial<MetricRow>): MetricRow => ({
    id: "m1",
    account_id: "a1",
    name: "p95_ms",
    label: "P95",
    description: null,
    type: "INTEGER",
    unit: null,
    format: null,
    formula: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  });

  it("snapshots a stored metric with its cosmetic facets", () => {
    expect(metricSnapshot(row({ unit: "ms", format: "#,##0", description: "d" }))).toEqual({
      metric: { name: "p95_ms", type: "INTEGER", unit: "ms", format: "#,##0", description: "d" },
    });
    expect(metricSnapshot(row({ type: "DECIMAL" }))).toEqual({
      metric: { name: "p95_ms", type: "DECIMAL" },
    });
  });

  it("snapshots a FORMULA metric as a derived decl with compiled JSON Logic", () => {
    const formula: MetricFormula = {
      steps: [{ id: "A", kind: "OP", op: "MUL", a: { kind: "METRIC", name: "x" }, b: { kind: "NUMBER", value: 2 } }],
      result: "A",
    };
    expect(
      metricSnapshot(row({ type: "FORMULA", formula: JSON.stringify(formula), format: "0.0%", description: "share" })),
    ).toEqual({
      derived: { name: "p95_ms", expr: { "*": [{ var: "metrics.x" }, 2] }, format: "0.0%", description: "share" },
    });
    expect(metricSnapshot(row({ type: "FORMULA", formula: JSON.stringify(formula), unit: "ms" }))).toEqual({
      derived: { name: "p95_ms", expr: { "*": [{ var: "metrics.x" }, 2] }, unit: "ms" },
    });
  });

  it("snapshots a FORMULA metric with an unreadable stored formula as a null expr", () => {
    expect(metricSnapshot(row({ type: "FORMULA", formula: null }))).toEqual({
      derived: { name: "p95_ms", expr: null },
    });
  });
});
