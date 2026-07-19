import { describe, expect, it } from "vitest";
import type { AggMeasurementRow } from "../../src/data/measurements";
import { computeStats, percentile, summarizeMeasurements } from "../../src/logic/stats";

describe("percentile (R-7 linear interpolation)", () => {
  it("interpolates between adjacent values", () => {
    const s = [1, 2, 3, 4];
    expect(percentile(s, 0.5)).toBeCloseTo(2.5);
    expect(percentile(s, 0.75)).toBeCloseTo(3.25);
    expect(percentile(s, 0.9)).toBeCloseTo(3.7);
    expect(percentile(s, 0.95)).toBeCloseTo(3.85);
    expect(percentile(s, 0.99)).toBeCloseTo(3.97);
  });

  it("matches known quantiles of 1..10", () => {
    const s = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(percentile(s, 0.5)).toBeCloseTo(5.5);
    expect(percentile(s, 0.75)).toBeCloseTo(7.75);
    expect(percentile(s, 0.9)).toBeCloseTo(9.1);
    expect(percentile(s, 0.95)).toBeCloseTo(9.55);
    expect(percentile(s, 0.99)).toBeCloseTo(9.91);
  });

  it("returns the exact element when the rank is integral", () => {
    const s = [1, 2, 3, 4, 5];
    expect(percentile(s, 0.5)).toBe(3); // rank 2.0
    expect(percentile(s, 0.25)).toBe(2); // rank 1.0
    expect(percentile(s, 0)).toBe(1);
    expect(percentile(s, 1)).toBe(5);
  });

  it("returns the single value for a one-element set", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });
});

describe("computeStats", () => {
  it("computes the ten statistics over an unsorted set", () => {
    const stats = computeStats([30, 10, 20]);
    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({ count: 3, sum: 60, min: 10, max: 30, avg: 20, median: 20 });
    expect(stats!.p75).toBeCloseTo(25);
  });

  it("skips non-finite values; count reflects only finite ones", () => {
    const stats = computeStats([1, Number.NaN, Number.POSITIVE_INFINITY, 2, 3]);
    expect(stats).toMatchObject({ count: 3, min: 1, max: 3, sum: 6, avg: 2, median: 2 });
  });

  it("handles a single value (all statistics equal it)", () => {
    expect(computeStats([7])).toEqual({
      count: 1, sum: 7, min: 7, max: 7, avg: 7, median: 7, p75: 7, p90: 7, p95: 7, p99: 7,
    });
  });

  it("handles an all-equal set", () => {
    expect(computeStats([5, 5, 5])).toMatchObject({ count: 3, min: 5, max: 5, avg: 5, median: 5, p99: 5, sum: 15 });
  });

  it("returns null when there is nothing finite to summarize", () => {
    expect(computeStats([])).toBeNull();
    expect(computeStats([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });
});

describe("summarizeMeasurements", () => {
  // A schema with one stored metric (latency_ms) and one derived metric (skew_ms = created_at mod 60000).
  const SCHEMA = JSON.stringify({
    metrics: [{ name: "latency_ms", type: "DECIMAL" }],
    derived: [{ name: "skew_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } }],
  });
  const TOP = Date.UTC(2026, 6, 1, 10, 0, 0); // top-of-minute → skew is the +offset

  const row = (subject_key: string, offset: number, latency: number): AggMeasurementRow => ({
    subject_key,
    created_at: TOP + offset,
    metrics: JSON.stringify({ latency_ms: latency }),
    measurement_schema: SCHEMA,
    run_started_at: null,
    run_ended_at: null,
  });

  it("groups by subject and summarizes stored + derived metrics", () => {
    const rows = [
      row("sub-a", 100, 10),
      row("sub-a", 200, 20),
      row("sub-a", 300, 30),
      row("sub-b", 50, 5),
    ];
    const out = summarizeMeasurements(rows, false);
    expect(out.measurements).toBe(4);
    expect(out.truncated).toBe(false);
    expect(out.subjects.map((s) => s.subject)).toEqual(["sub-a", "sub-b"]); // first-seen order

    const a = out.subjects[0].metrics;
    expect(a.latency_ms).toMatchObject({ count: 3, min: 10, max: 30, avg: 20, median: 20, sum: 60 });
    expect(a.latency_ms.p75).toBeCloseTo(25);
    expect(a.skew_ms).toMatchObject({ count: 3, min: 100, max: 300, avg: 200, median: 200 });

    const b = out.subjects[1].metrics;
    expect(b.latency_ms).toMatchObject({ count: 1, avg: 5, min: 5, max: 5 });
    expect(b.skew_ms).toMatchObject({ count: 1, avg: 50 });
  });

  it("passes truncated through and counts every scanned row", () => {
    const out = summarizeMeasurements([row("sub-a", 100, 10)], true);
    expect(out.truncated).toBe(true);
    expect(out.measurements).toBe(1);
  });

  it("skips merged values that are non-numeric or non-finite", () => {
    const schema = JSON.stringify({ metrics: [{ name: "latency_ms", type: "DECIMAL" }], derived: [] });
    // "note" is a string (typeof !== number); "big" (1e999) parses to Infinity (a number, not finite).
    const rows: AggMeasurementRow[] = [{
      subject_key: "s",
      created_at: TOP,
      metrics: '{"latency_ms":10,"note":"x","big":1e999}',
      measurement_schema: schema,
      run_started_at: null,
      run_ended_at: null,
    }];
    const out = summarizeMeasurements(rows, false);
    expect(Object.keys(out.subjects[0].metrics)).toEqual(["latency_ms"]);
    expect(out.subjects[0].metrics.latency_ms).toMatchObject({ count: 1, avg: 10 });
  });

  it("counts a row with nothing to summarize but emits no subject entry for it", () => {
    const empty: AggMeasurementRow = {
      subject_key: "sub-empty",
      created_at: TOP,
      metrics: null,
      measurement_schema: JSON.stringify({ metrics: [], derived: [] }),
      run_started_at: null,
      run_ended_at: null,
    };
    const out = summarizeMeasurements([empty], false);
    expect(out.measurements).toBe(1);
    expect(out.subjects).toEqual([]);
  });
});
