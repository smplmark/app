// Resource-count and string-size ceilings. Enforced at create/update time (count ceilings → 409,
// size ceilings → 400) and documented in the OpenAPI spec; the ingestion importer validates the
// same numbers before generating SQL (ingestion/lib/limits.mjs mirrors this file — a unit test
// keeps the two identical).
//
// Observations are deliberately uncapped: they are the append-only time-series payload, bounded by
// read-side pagination rather than a write ceiling.
export const LIMITS = {
  /** Benchmarks one account may own. */
  benchmarksPerAccount: 100,
  /** Targets one benchmark may hold. */
  targetsPerBenchmark: 5000,
  /** Runs one target may hold. */
  runsPerTarget: 100,
  /** key fields (benchmark, target, run) — URL-safe identifiers. */
  keyLength: 100,
  /** name fields. */
  nameLength: 200,
  /** description (the one-line tagline). */
  descriptionLength: 500,
  /** about + methodology (long-form prose). */
  longTextLength: 20_000,
} as const;
