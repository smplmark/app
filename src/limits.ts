// Resource-count and string-size ceilings. Enforced at create/update time (count ceilings → 409,
// size ceilings → 400) and documented in the OpenAPI spec; the ingestion importer validates the
// same numbers before generating SQL (ingestion/lib/limits.mjs mirrors this file — a unit test
// keeps the two identical).
export const LIMITS = {
  /** Benchmarks one account may own. */
  benchmarksPerAccount: 100,
  /** Standalone subjects one account may own (subjects are account-owned, reusable across benchmarks).
   *  Generous for large ingested corpora deduped into one publisher account. */
  subjectsPerAccount: 200_000,
  /** Subjects one benchmark may link. Kept at 20k for large ingested corpora (e.g. SPEC CPU2017's
   *  ~11.8k results/metric); the viewer fetches and renders all of them client-side. */
  subjectsPerBenchmark: 20_000,
  /** Subject types (field schemas) one account may define. */
  subjectTypesPerAccount: 1000,
  /** Metrics (reusable metric definitions) one account may define. */
  metricsPerAccount: 1000,
  /** Metrics one benchmark may link from the account library. A benchmark reports a focused set of
   *  values; the viewer renders them all, so this stays far below the per-account library ceiling. */
  metricsPerBenchmark: 200,
  /** Runs one benchmark may hold. A run is a benchmark-level occasion (a comparative sweep is one run
   *  over many subjects); independent per-result corpora (SPEC/TPC) reach one run per subject, so the
   *  ceiling matches subjectsPerBenchmark rather than a small per-subject cap. */
  runsPerBenchmark: 20_000,
  /** Measurements one run may hold. A run is a bounded occasion; this makes that an invariant so a
   *  runaway writer cannot grow one run without bound (D1 has a hard per-database storage cap, so
   *  unbounded ingest is a whole-product outage, not just a cost). Enforced from the denormalized
   *  run.measurement_count maintained in the insert/delete batches — no COUNT(*) per write. It also
   *  bounds the statistics scan: run-scoped stats are always exact (see aggregateMeasurements). */
  measurementsPerRun: 100_000,
  /** key fields (benchmark, subject, run) — URL-safe identifiers. */
  keyLength: 100,
  /** name fields. */
  nameLength: 200,
  /** description (the one-line tagline). */
  descriptionLength: 500,
  /** license (an SPDX identifier or expression, e.g. "CC-BY-4.0"). */
  licenseLength: 100,
  /** about + methodology (long-form prose). */
  longTextLength: 20_000,
} as const;
