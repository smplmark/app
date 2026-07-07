// @ts-check
// The --limit sampler. Applies at IMPORT (the archive always holds the full pull); caps targets
// per benchmark for fast local iteration. The sample must be REPRESENTATIVE, not "first N": an
// even stride across each benchmark's target list plus the edge cases most likely to surface
// shape problems — the busiest target, the sparsest, any target measured under multiple runs, and
// any target whose measurements carry missing/null metric values. Trimming a target also drops its
// measurements and prunes any run left with no measurement.

/**
 * @typedef {import("./model.mjs").IngestBenchmark} IngestBenchmark
 * @typedef {import("./model.mjs").IngestTarget} IngestTarget
 * @typedef {import("./model.mjs").IngestMeasurement} IngestMeasurement
 */

/**
 * Cap each benchmark at `limit` targets, representatively. limit <= 0 or undefined → unchanged.
 * @param {IngestBenchmark[]} benchmarks
 * @param {number | undefined} limit
 * @returns {IngestBenchmark[]}
 */
export function sampleBenchmarks(benchmarks, limit) {
  if (!limit || limit <= 0) return benchmarks;
  return benchmarks.map((b) => {
    if (b.targets.length <= limit) return b;

    // Measurements now hang off the benchmark, keyed to a target; group them for the heuristics.
    /** @type {Map<string, IngestMeasurement[]>} target key → its measurements */
    const byTarget = new Map();
    for (const m of b.measurements) {
      const list = byTarget.get(m.target_key);
      if (list) list.push(m);
      else byTarget.set(m.target_key, [m]);
    }
    /** @param {IngestTarget} t */
    const measurementCount = (t) => (byTarget.get(t.key) ?? []).length;
    /** @param {IngestTarget} t */
    const runCount = (t) => new Set((byTarget.get(t.key) ?? []).map((m) => m.run_key)).size;
    /** @param {IngestTarget} t */
    const hasSparseMetrics = (t) =>
      (byTarget.get(t.key) ?? []).some((m) =>
        Object.values(m.metrics).some((v) => v === null || v === undefined || Number.isNaN(v)),
      );

    /** @type {Set<number>} indices to keep */
    const keep = new Set();

    // Edge cases first, in priority order (dedupe via the set): busiest, sparsest, multi-run,
    // sparse-metric. Each add is guarded by the size cap, so when `limit` is smaller than the number
    // of distinct edge cases the highest-priority ones are retained (not an arbitrary index slice).
    const byCount = b.targets.map((t, i) => ({ i, n: measurementCount(t) }));
    byCount.sort((a, z) => z.n - a.n);
    const multiRun = b.targets.findIndex((t) => runCount(t) > 1);
    const sparse = b.targets.findIndex(hasSparseMetrics);
    for (const idx of [byCount[0].i, byCount[byCount.length - 1].i, multiRun, sparse]) {
      if (idx !== -1 && keep.size < limit) keep.add(idx);
    }

    // Fill the rest with an even stride across the whole list.
    const stride = b.targets.length / limit;
    for (let k = 0; keep.size < limit && k < limit * 2; k++) {
      keep.add(Math.min(b.targets.length - 1, Math.floor(k * stride)));
    }
    // Deterministic fallback if stride collisions left slots unfilled.
    for (let i = 0; keep.size < limit && i < b.targets.length; i++) keep.add(i);

    // keep.size never exceeds limit now; sort for deterministic order (slice is a safety no-op).
    const indices = [...keep].sort((a, z) => a - z).slice(0, limit);
    const targets = indices.map((i) => b.targets[i]);
    const keptTargetKeys = new Set(targets.map((t) => t.key));
    // Drop measurements for trimmed targets, then prune runs left with no surviving measurement.
    const measurements = b.measurements.filter((m) => keptTargetKeys.has(m.target_key));
    const usedRunKeys = new Set(measurements.map((m) => m.run_key));
    const runs = b.runs.filter((r) => usedRunKeys.has(r.key));
    return { ...b, targets, runs, measurements };
  });
}
