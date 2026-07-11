// Resource-count and string-size ceilings. Enforced at create/update time (count ceilings → 409,
// size ceilings → 400) and documented in the OpenAPI spec; the ingestion importer validates the
// same numbers before generating SQL (ingestion/lib/limits.mjs mirrors this file — a unit test
// keeps the two identical).
//
// Measurements are deliberately uncapped: they are the append-only time-series payload, bounded by
// read-side pagination rather than a write ceiling.
export const LIMITS = {
  /** Benchmarks one account may own. */
  benchmarksPerAccount: 100,
  /** Standalone targets one account may own (targets are account-owned, reusable across benchmarks).
   *  Generous for large ingested corpora deduped into one publisher account. */
  targetsPerAccount: 200_000,
  /** Targets one benchmark may link. Kept at 20k for large ingested corpora (e.g. SPEC CPU2017's
   *  ~11.8k results/metric); the viewer fetches and renders all of them client-side. */
  targetsPerBenchmark: 20_000,
  /** Runs one benchmark may hold. A run is a benchmark-level occasion (a comparative sweep is one run
   *  over many targets); independent per-result corpora (SPEC/TPC) reach one run per target, so the
   *  ceiling matches targetsPerBenchmark rather than a small per-target cap. */
  runsPerBenchmark: 20_000,
  /** key fields (benchmark, target, run) — URL-safe identifiers. */
  keyLength: 100,
  /** name fields. */
  nameLength: 200,
  /** description (the one-line tagline). */
  descriptionLength: 500,
  /** about + methodology (long-form prose). */
  longTextLength: 20_000,
} as const;
