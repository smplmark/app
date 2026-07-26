import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta } from "../../ingestion/lib/sources/clickbench.mjs";

// A miniature fixture archive shaped exactly like the parsed data.generated.js array (short
// result matrices for readability — the adapter sums whatever triples are present).
const entries: unknown[] = [
  {
    system: "ClickHouse",
    date: "2026-06-24",
    machine: "c6a.4xlarge",
    cluster_size: 1,
    proprietary: "no",
    hardware: "cpu",
    tuned: "no",
    tags: ["C++", "column-oriented"],
    load_time: 294,
    data_size: 15267535124,
    concurrent_qps: 0.745,
    concurrent_error_ratio: 0.89,
    source: "clickhouse/results/20260624/c6a.4xlarge.json",
    // cold = 0.01 + 1 (third triple's cold run failed); hot = 0.002 + 0.5 + 2.
    result: [
      [0.01, 0.002, 0.003],
      [1, 0.5, 0.6],
      [null, 2, null],
    ],
  },
  {
    // Emoji in the system name, string cluster_size, sparse fields, a comment.
    system: "MotherDuck ☁️",
    date: "2026-05-01",
    machine: "serverless-tier",
    cluster_size: "serverless",
    tags: [],
    load_time: 0,
    data_size: 123,
    concurrent_qps: null,
    comment: "Managed service.",
    source: "motherduck/results/20260501/serverless-tier.json",
    // cold = 1.6; hot = 0.3 + 0.1 + 0.7 = 1.1.
    result: [
      [0.5, 0.4, 0.3],
      [0.2, 0.1, 0.2],
      [0.9, null, 0.7],
    ],
  },
  // Two rows whose slugs collide ("Fast DB" vs "Fast-DB") — uniqueSlug must keep them apart.
  {
    system: "Fast DB",
    date: "2026-04-01",
    machine: "m1",
    cluster_size: 1,
    source: "fast-db/results/20260401/m1.json",
    result: [[0.5, 0.25, 0.25]],
  },
  {
    system: "Fast-DB",
    date: "2026-04-02",
    machine: "m1",
    cluster_size: 1,
    source: "fast-db/results/20260402/m1.json",
    result: [[0.6, 0.3, 0.35]],
  },
  // Malformed rows the adapter must skip rather than crash on:
  { system: "Stub", date: "2026-01-01", machine: "x", result: { error: "issue #891" } },
  { system: "No Result", date: "2026-01-01", machine: "x" },
  { system: "No Date", machine: "x", result: [[1, 1, 1]] },
  { machine: "orphan", date: "2026-01-01", result: [[1, 1, 1]] },
  "not even an object",
];

const T_RETRIEVED = Date.UTC(2026, 6, 4);
const archiveFor = (data: unknown) => ({
  readJson: (name: string) => {
    if (name !== "data.json") throw new Error(`fixture missing: ${name}`);
    return data;
  },
  manifest: { retrieved_at: T_RETRIEVED, files: [] },
});
const archive = archiveFor(entries);

describe("clickbench adapter", () => {
  it("declares CC-BY-NC-SA provenance (NC-cleared for smplmark.org) and the raw-host pull surface", () => {
    expect(meta.key).toBe("clickbench");
    expect(meta.license).toBe("CC-BY-NC-SA-4.0");
    expect(meta.url).toBe("https://github.com/ClickHouse/ClickBench");
    expect(meta.robotsOrigin).toBe("https://raw.githubusercontent.com");
  });

  it("maps one benchmark: subject per system+machine, one leaderboard run, per-subject measurements", () => {
    const benchmarks = adapt(archive as never);
    expect(benchmarks).toHaveLength(1);
    const [b] = benchmarks;
    expect(b.key).toBe("clickbench");
    expect(b.name).toBe("ClickBench — analytical databases");
    // Publication proxy: the earliest dated USABLE entry (min over all parsed, pre-curation).
    expect(b.published_at).toBe(Date.UTC(2026, 3, 1));
    expect(b.category).toBe("DATABASE");
    expect(b.tags).toEqual(["olap", "sql", "analytics", "databases"]);
    expect(b.measurementSchema).toMatchObject({ chart: { x: null, y: "hot_total_s", x_kind: "CATEGORY" } });
    // One benchmark-level run: the whole leaderboard is one comparative sweep.
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0]).toEqual({ key: "leaderboard", name: "ClickBench leaderboard" });
    // Every emitted metric key is declared in the measurement schema.
    const declared = new Set((b.measurementSchema as { metrics: { name: string }[] }).metrics.map((m) => m.name));
    for (const m of b.measurements) {
      for (const k of Object.keys(m.metrics)) expect(declared).toContain(k);
    }
    // Every measurement references the single benchmark-level run and a real subject.
    const subjectKeys = new Set(b.subjects.map((t: { key: string }) => t.key));
    for (const m of b.measurements) {
      expect(m.run_key).toBe("leaderboard");
      expect(subjectKeys).toContain(m.subject_key);
    }
    // One measurement per curated subject.
    expect(b.measurements).toHaveLength(b.subjects.length);

    // Malformed rows (error stub, missing result/date/system, non-object) are skipped.
    expect(b.subjects).toHaveLength(4);
    // Subjects are ordered fastest-first by hot_total_s.
    expect(b.subjects.map((t: { key: string }) => t.key)).toEqual([
      "fast-db-m1",
      "fast-db-m1-2",
      "motherduck-serverless-tier",
      "clickhouse-c6a-4xlarge",
    ]);

    // Each subject's measurement carries its own created_at (the entry date) and meta.
    const measurementFor = (subjectKey: string) =>
      b.measurements.find(
        (m: { run_key: string; subject_key: string }) =>
          m.run_key === "leaderboard" && m.subject_key === subjectKey,
      );

    const ch = b.subjects[3];
    expect(ch.name).toBe("ClickHouse (c6a.4xlarge)");
    expect(ch.details).toEqual({
      tags: ["C++", "column-oriented"],
      machine: "c6a.4xlarge",
      cluster_size: "1",
      proprietary: "no",
      tuned: "no",
      hardware: "cpu",
    });
    expect(measurementFor(ch.key)).toEqual({
      run_key: "leaderboard",
      subject_key: ch.key,
      created_at: Date.UTC(2026, 5, 24),
      metrics: {
        load_time_s: 294,
        data_size_bytes: 15267535124,
        cold_total_s: 1.01,
        hot_total_s: 2.502,
        concurrent_qps: 0.745,
      },
      meta: {
        result: [
          [0.01, 0.002, 0.003],
          [1, 0.5, 0.6],
          [null, 2, null],
        ],
        source: "clickhouse/results/20260624/c6a.4xlarge.json",
        missing_queries: 1,
      },
    });

    // Emoji survives in the display name; "serverless" cluster_size is stringly kept; the null
    // concurrent_qps is NOT emitted as a metric; the comment lands in measurement meta.
    const md = b.subjects[2];
    expect(md.name).toBe("MotherDuck ☁️ (serverless-tier)");
    expect(md.details).toEqual({ tags: [], machine: "serverless-tier", cluster_size: "serverless" });
    const mdMeasurement = measurementFor(md.key);
    expect(mdMeasurement!.created_at).toBe(Date.UTC(2026, 4, 1));
    expect(mdMeasurement!.metrics).toEqual({ load_time_s: 0, data_size_bytes: 123, cold_total_s: 1.6, hot_total_s: 1.1 });
    expect(mdMeasurement!.meta).toMatchObject({ comment: "Managed service.", missing_queries: 0 });
  });

  it("caps at the 300 fastest subjects by hot_total_s by default; fullOptions lifts it", () => {
    const many = Array.from({ length: 305 }, (_, i) => ({
      system: `System ${i}`,
      machine: "m",
      date: "2026-01-02",
      cluster_size: 1,
      source: `system-${i}/results/20260102/m.json`,
      result: [[1, i + 1, null]], // hot total = i + 1 → fastest is System 0
    }));
    const big = archiveFor(many);

    const [capped] = adapt(big as never);
    expect(capped.subjects).toHaveLength(300);
    expect(capped.subjects[0].name).toBe("System 0 (m)");
    expect(capped.subjects[299].name).toBe("System 299 (m)");
    expect(capped.subjects.some((t: { name: string }) => t.name === "System 304 (m)")).toBe(false);

    const [full] = adapt(big as never, fullOptions);
    expect(full.subjects).toHaveLength(305);

    const [top2] = adapt(archive as never, { topSubjects: 2 });
    expect(top2.subjects.map((t: { key: string }) => t.key)).toEqual(["fast-db-m1", "fast-db-m1-2"]);
  });

  it("throws loudly when the payload shape is unrecognizable", () => {
    expect(() => adapt(archiveFor({ not: "an array" }) as never)).toThrow(/not an array/);
    expect(() => adapt(archiveFor([{ bogus: true }, null]) as never)).toThrow(/no usable entries/);
  });
});
