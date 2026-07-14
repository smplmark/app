// @ts-check
// The --limit sampler. Applies at IMPORT (the archive always holds the full pull); caps subjects
// per benchmark for fast local iteration. The sample must be REPRESENTATIVE, not "first N": an
// even stride across each benchmark's subject list plus the edge cases most likely to surface
// shape problems — the busiest subject, the sparsest, any subject measured under multiple runs, and
// any subject whose measurements carry missing/null metric values. Trimming a subject also drops its
// measurements and prunes any run left with no measurement.

/**
 * @typedef {import("./model.mjs").IngestBenchmark} IngestBenchmark
 * @typedef {import("./model.mjs").IngestSubject} IngestSubject
 * @typedef {import("./model.mjs").IngestMeasurement} IngestMeasurement
 */

/**
 * Cap each benchmark at `limit` subjects, representatively. limit <= 0 or undefined → unchanged.
 * @param {IngestBenchmark[]} benchmarks
 * @param {number | undefined} limit
 * @returns {IngestBenchmark[]}
 */
export function sampleBenchmarks(benchmarks, limit) {
  if (!limit || limit <= 0) return benchmarks;
  return benchmarks.map((b) => {
    if (b.subjects.length <= limit) return b;

    // Measurements now hang off the benchmark, keyed to a subject; group them for the heuristics.
    /** @type {Map<string, IngestMeasurement[]>} subject key → its measurements */
    const bySubject = new Map();
    for (const m of b.measurements) {
      const list = bySubject.get(m.subject_key);
      if (list) list.push(m);
      else bySubject.set(m.subject_key, [m]);
    }
    /** @param {IngestSubject} t */
    const measurementCount = (t) => (bySubject.get(t.key) ?? []).length;
    /** @param {IngestSubject} t */
    const runCount = (t) => new Set((bySubject.get(t.key) ?? []).map((m) => m.run_key)).size;
    /** @param {IngestSubject} t */
    const hasSparseMetrics = (t) =>
      (bySubject.get(t.key) ?? []).some((m) =>
        Object.values(m.metrics).some((v) => v === null || v === undefined || Number.isNaN(v)),
      );

    /** @type {Set<number>} indices to keep */
    const keep = new Set();

    // Edge cases first, in priority order (dedupe via the set): busiest, sparsest, multi-run,
    // sparse-metric. Each add is guarded by the size cap, so when `limit` is smaller than the number
    // of distinct edge cases the highest-priority ones are retained (not an arbitrary index slice).
    const byCount = b.subjects.map((t, i) => ({ i, n: measurementCount(t) }));
    byCount.sort((a, z) => z.n - a.n);
    const multiRun = b.subjects.findIndex((t) => runCount(t) > 1);
    const sparse = b.subjects.findIndex(hasSparseMetrics);
    for (const idx of [byCount[0].i, byCount[byCount.length - 1].i, multiRun, sparse]) {
      if (idx !== -1 && keep.size < limit) keep.add(idx);
    }

    // Fill the rest with an even stride across the whole list.
    const stride = b.subjects.length / limit;
    for (let k = 0; keep.size < limit && k < limit * 2; k++) {
      keep.add(Math.min(b.subjects.length - 1, Math.floor(k * stride)));
    }
    // Deterministic fallback if stride collisions left slots unfilled.
    for (let i = 0; keep.size < limit && i < b.subjects.length; i++) keep.add(i);

    // keep.size never exceeds limit now; sort for deterministic order (slice is a safety no-op).
    const indices = [...keep].sort((a, z) => a - z).slice(0, limit);
    const subjects = indices.map((i) => b.subjects[i]);
    const keptSubjectKeys = new Set(subjects.map((t) => t.key));
    // Drop measurements for trimmed subjects, then prune runs left with no surviving measurement.
    const measurements = b.measurements.filter((m) => keptSubjectKeys.has(m.subject_key));
    const usedRunKeys = new Set(measurements.map((m) => m.run_key));
    const runs = b.runs.filter((r) => usedRunKeys.has(r.key));
    return { ...b, subjects, runs, measurements };
  });
}
