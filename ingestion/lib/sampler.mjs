// @ts-check
// The --limit sampler. Applies at IMPORT (the archive always holds the full pull); caps targets
// per benchmark for fast local iteration. The sample must be REPRESENTATIVE, not "first N": an
// even stride across each benchmark's target list plus the edge cases most likely to surface
// shape problems — the busiest target, the sparsest, any multi-run target, and any target whose
// observations carry missing/null metric values.

/**
 * @typedef {import("./model.mjs").IngestBenchmark} IngestBenchmark
 * @typedef {import("./model.mjs").IngestTarget} IngestTarget
 */

/** @param {IngestTarget} t */
function observationCount(t) {
  return t.runs.reduce((acc, r) => acc + r.observations.length, 0);
}

/** @param {IngestTarget} t */
function hasSparseMetrics(t) {
  return t.runs.some((r) =>
    r.observations.some((o) =>
      Object.values(o.metrics).some((v) => v === null || v === undefined || Number.isNaN(v)),
    ),
  );
}

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

    /** @type {Set<number>} indices to keep */
    const keep = new Set();

    // Edge cases first (dedupe via the set): busiest, sparsest, multi-run, sparse-metric.
    const byObs = b.targets.map((t, i) => ({ i, obs: observationCount(t) }));
    byObs.sort((a, z) => z.obs - a.obs);
    keep.add(byObs[0].i);
    keep.add(byObs[byObs.length - 1].i);
    const multiRun = b.targets.findIndex((t) => t.runs.length > 1);
    if (multiRun !== -1) keep.add(multiRun);
    const sparse = b.targets.findIndex(hasSparseMetrics);
    if (sparse !== -1) keep.add(sparse);

    // Fill the rest with an even stride across the whole list.
    const stride = b.targets.length / limit;
    for (let k = 0; keep.size < limit && k < limit * 2; k++) {
      keep.add(Math.min(b.targets.length - 1, Math.floor(k * stride)));
    }
    // Deterministic fallback if stride collisions left slots unfilled.
    for (let i = 0; keep.size < limit && i < b.targets.length; i++) keep.add(i);

    const indices = [...keep].sort((a, z) => a - z).slice(0, limit);
    return { ...b, targets: indices.map((i) => b.targets[i]) };
  });
}
