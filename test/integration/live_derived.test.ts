// Live compute-on-read for DERIVED (FORMULA) metrics: derived values are computed from the CURRENT
// library `metric` definition (resolved via the benchmark_metric join), NOT the frozen snapshot copied
// into benchmark.measurement_schema.derived at link time. Editing a library metric therefore changes
// every published benchmark's numbers on the next read — with no re-snapshot, no re-link, no migration.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPut,
  bearer,
  linkMetric,
  makeBenchmark,
  makeMeasurement,
  makeMetric,
  makeRun,
  makeSubject,
  register,
  resetDb,
  type Registered,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const EMPTY = { metrics: [], derived: [] };

// A one-step FORMULA: created_at MOD `mod` — ms elapsed since the last `mod` boundary. Compiles
// to `{ "%": [{ var: "created_at" }, mod] }`.
const modFormula = (mod: number) => ({
  steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: mod } }],
  result: "A",
});

const HOUR = 3_600_000;
const MINUTE = 60_000;
// A timestamp 20 ms below an hour boundary (a multiple of both HOUR and MINUTE). Under `% HOUR` a
// value just below the boundary wraps to just under the modulus — plain modulo, no centering or
// negative values.
const TOP = Date.UTC(2026, 6, 1, 10, 0, 0);
const NEAR_TOP = TOP - 20;

/** Stand up a PRIVATE benchmark with a linked FORMULA `elapsed` metric and one measurement at `createdAt`. */
async function seed(
  createdAt: number,
  mod: number,
): Promise<{ me: Registered; bm: Resource; metric: Resource }> {
  const me = await register();
  const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
  const metric = await makeMetric(me.token, { label: "Elapsed", type: "FORMULA", unit: "ms", formula: modFormula(mod) });
  await linkMetric(me.token, bm.id, metric.id);
  const subject = await makeSubject(me.token, bm.id, "sub-a");
  const run = await makeRun(me.token, bm.id);
  await makeMeasurement(me.token, run.id, subject.id, { created_at: createdAt });
  return { me, bm, metric };
}

/** The single measurement's derived `elapsed` value, read back through the list endpoint. */
async function readElapsed(token: string, benchmarkId: string): Promise<number> {
  const doc = (await (await apiGet(`/api/v1/measurements?filter[benchmark]=${benchmarkId}`, bearer(token))).json()) as {
    data: Resource[];
  };
  return (doc.data[0].attributes.metrics as Record<string, number>).elapsed;
}

/** The benchmark's stored measurement_schema.derived snapshot, read straight from D1 (bypasses the API,
 *  which now substitutes live derived), so we can prove the snapshot did NOT change. */
async function storedSnapshotDerived(benchmarkId: string): Promise<Array<{ name: string; expr: unknown }>> {
  const row = await env.DB.prepare("SELECT measurement_schema FROM benchmark WHERE id = ?").bind(benchmarkId).first<{
    measurement_schema: string;
  }>();
  return JSON.parse(row!.measurement_schema).derived;
}

describe("live derived — a FORMULA metric linked via benchmark_metric computes from the live definition", () => {
  it("computes the derived value from the linked library metric", async () => {
    const { me, bm } = await seed(TOP + 12345, HOUR);
    expect(await readElapsed(me.token, bm.id)).toBe(12345); // (TOP + 12345) % HOUR
  });

  it("a value just below the modulus boundary wraps to just under the modulus (plain %, no centering)", async () => {
    const { me, bm } = await seed(NEAR_TOP, HOUR);
    // (TOP - 20) % 3_600_000 === 3_599_980 — plain modulo, never a small −20.
    expect(await readElapsed(me.token, bm.id)).toBe(HOUR - 20);
    expect(await readElapsed(me.token, bm.id)).toBe(3_599_980);
  });
});

describe("live derived — editing the library metric takes effect on the next read without re-snapshotting", () => {
  it("changes the computed value while the stored snapshot keeps the OLD expr", async () => {
    const { me, bm, metric } = await seed(NEAR_TOP, HOUR);

    // Before the edit: % HOUR.
    expect(await readElapsed(me.token, bm.id)).toBe(3_599_980);
    // The snapshot copied at link time holds the % HOUR expr.
    expect(await storedSnapshotDerived(bm.id)).toEqual([
      { name: "elapsed", unit: "ms", expr: { "%": [{ var: "created_at" }, HOUR] } },
    ]);

    // Edit the LIBRARY metric's formula to % MINUTE (a plain PUT — does NOT touch any benchmark schema).
    const put = await apiPut(
      `/api/v1/metrics/${metric.id}`,
      { data: { type: "metric", attributes: { label: "Elapsed", type: "FORMULA", unit: "ms", formula: modFormula(MINUTE) } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);

    // The stored snapshot is UNCHANGED — still % HOUR (immutability-via-snapshot is retained but no
    // longer authoritative for compute).
    expect(await storedSnapshotDerived(bm.id)).toEqual([
      { name: "elapsed", unit: "ms", expr: { "%": [{ var: "created_at" }, HOUR] } },
    ]);
    // Yet the NEXT read reflects the new live formula: (TOP - 20) % 60_000 === 59_980.
    expect(await readElapsed(me.token, bm.id)).toBe(MINUTE - 20);
    expect(await readElapsed(me.token, bm.id)).toBe(59_980);
  });
});

describe("live derived — every read surface reflects the live definition", () => {
  it("list, single-create response, stats, and the benchmark resource all use the live formula", async () => {
    const { me, bm, metric } = await seed(NEAR_TOP, HOUR);
    const subjectRun = async () => {
      // Reuse the seeded subject/run for a fresh measurement created AFTER the edit.
      const runs = (await (await apiGet(`/api/v1/runs?filter[benchmark]=${bm.id}`, bearer(me.token))).json()) as { data: Resource[] };
      const subs = (await (await apiGet(`/api/v1/subjects?filter[benchmark]=${bm.id}`, bearer(me.token))).json()) as { data: Resource[] };
      return { runId: runs.data[0].id, subjectId: subs.data[0].id };
    };

    // Edit to % MINUTE.
    await apiPut(
      `/api/v1/metrics/${metric.id}`,
      { data: { type: "metric", attributes: { label: "Elapsed", type: "FORMULA", unit: "ms", formula: modFormula(MINUTE) } } },
      bearer(me.token),
    );

    // (a) LIST read reflects the live formula.
    expect(await readElapsed(me.token, bm.id)).toBe(59_980);

    // (b) The single measurement-CREATE response computes derived from the live formula too.
    const { runId, subjectId } = await subjectRun();
    const created = await makeMeasurement(me.token, runId, subjectId, { created_at: TOP - 5 });
    expect((created.attributes.metrics as Record<string, number>).elapsed).toBe(MINUTE - 5); // 59_995

    // (c) meta[stats] aggregates over the live-derived values.
    const statsDoc = (await (
      await apiGet(`/api/v1/measurements?filter[benchmark]=${bm.id}&meta[stats]=true`, bearer(me.token))
    ).json()) as { meta: { stats: { subjects: Array<{ metrics: Record<string, { max: number; min: number }> }> } } };
    const elapsedStats = statsDoc.meta.stats.subjects[0].metrics.elapsed;
    expect(elapsedStats.max).toBe(59_995); // the % MINUTE values, never the stale % HOUR 3_599_980
    expect(elapsedStats.min).toBe(59_980);

    // (d) The BENCHMARK resource surfaces the live derived metric's display fields AND its formula —
    // both the structured steps and the JSON Logic they compile to — reflecting the LIVE (% MINUTE)
    // definition. The stored snapshot in D1 still holds the old formula internally (never surfaced).
    const liveDecl = {
      name: "elapsed", label: "Elapsed", unit: "ms",
      formula: modFormula(MINUTE),
      expr: { "%": [{ var: "created_at" }, MINUTE] },
    };
    const benchDoc = (await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(me.token))).json()) as {
      data: { attributes: { measurement_schema: { derived: unknown[] } } };
    };
    expect(benchDoc.data.attributes.measurement_schema.derived).toEqual([liveDecl]);
    expect(await storedSnapshotDerived(bm.id)).toEqual([
      { name: "elapsed", unit: "ms", expr: { "%": [{ var: "created_at" }, HOUR] } },
    ]);

    // (e) The benchmark LIST endpoint likewise surfaces the live formula.
    const listDoc = (await (await apiGet(`/api/v1/benchmarks?filter[account]=${me.account_id}`, bearer(me.token))).json()) as {
      data: Array<{ id: string; attributes: { measurement_schema: { derived: unknown[] } } }>;
    };
    const mine = listDoc.data.find((b) => b.id === bm.id)!;
    expect(mine.attributes.measurement_schema.derived).toEqual([liveDecl]);
  });
});
