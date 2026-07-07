// @ts-check
// Mirror of src/limits.ts for the Node-side importer (which can't import Worker TS). A unit test
// asserts the two stay identical — change them together.
export const LIMITS = {
  benchmarksPerAccount: 100,
  targetsPerBenchmark: 20_000,
  runsPerBenchmark: 20_000,
  keyLength: 100,
  nameLength: 200,
  descriptionLength: 500,
  longTextLength: 20_000,
};
