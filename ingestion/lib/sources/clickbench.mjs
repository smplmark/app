// @ts-check
// ClickBench (github.com/ClickHouse/ClickBench) — CC-BY-NC-SA-4.0. A HELD source: the adapter and
// archive are fully built, but import.mjs keeps it out of any remote seed until the
// NonCommercial/ShareAlike riders get an explicit call. We pull exactly one data file —
// data.generated.js, the aggregated dataset behind benchmark.clickhouse.com (latest dated result
// per system + machine, error stubs and historical entries already filtered upstream) — from
// raw.githubusercontent.com, which publishes no robots.txt and is GitHub's intended file CDN
// (github.com's robots rules cover only its HTML UI). See ingestion/SOURCES.md.
import { epochMsOrNull, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "clickbench",
  name: "ClickBench",
  url: "https://github.com/ClickHouse/ClickBench",
  license: "CC-BY-NC-SA-4.0",
  licenseUrl: "https://github.com/ClickHouse/ClickBench/blob/main/LICENSE",
  robotsOrigin: "https://raw.githubusercontent.com",
};

const RAW_BASE = "https://raw.githubusercontent.com/ClickHouse/ClickBench/main";

/** Robots preflight: the two files this source fetches. */
export const robotsPaths = [
  "/ClickHouse/ClickBench/main/data.generated.js",
  "/ClickHouse/ClickBench/main/LICENSE",
];

/** `--full`: lift the default curation cap (default: the 300 fastest targets by hot_total_s). */
export const fullOptions = /** @type {{ topTargets: number }} */ ({
  topTargets: Number.POSITIVE_INFINITY,
});

/**
 * Stage A: the complete aggregated leaderboard (one ~1 MB file) plus the license text.
 * @param {{ fetchText: (url: string) => Promise<string>,
 *   writeJson: (name: string, data: any) => Promise<void>,
 *   writeText: (name: string, text: string) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  const js = await ctx.fetchText(`${RAW_BASE}/data.generated.js`);
  await ctx.writeJson("data.json", parseDataJs(js));
  await ctx.writeText("LICENSE.txt", await ctx.fetchText(`${RAW_BASE}/LICENSE`));
}

/**
 * data.generated.js is `const data = [ … ];` — strip the assignment wrapper, parse the array.
 * @param {string} text
 * @returns {unknown[]}
 */
function parseDataJs(text) {
  const trimmed = text.trim();
  const prefix = /^const\s+data\s*=\s*/.exec(trimmed);
  if (!prefix) {
    throw new Error("clickbench: data.generated.js does not start with `const data =`");
  }
  let body = trimmed.slice(prefix[0].length);
  if (body.endsWith(";")) body = body.slice(0, -1);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("clickbench: data.generated.js payload is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("clickbench: expected a non-empty array in data.generated.js");
  }
  return parsed;
}

const SCHEMA = {
  metrics: [
    {
      name: "hot_total_s",
      type: "number",
      unit: "s",
      description:
        "Total hot runtime: for each of the 43 benchmark queries, the best of the second and third runs, summed, in seconds. Lower is better — this is the headline number. Queries the system could not run are left out of the sum.",
    },
    {
      name: "cold_total_s",
      type: "number",
      unit: "s",
      description:
        "Total cold runtime: each query's first run (caches unprimed), summed, in seconds. Lower is better. Failed queries are left out of the sum and counted as missing_queries in the observation metadata.",
    },
    {
      name: "load_time_s",
      type: "number",
      unit: "s",
      description:
        "Time to load the benchmark dataset into the system, in seconds. Zero for systems that query the source files in place without a load step.",
    },
    {
      name: "data_size_bytes",
      type: "number",
      unit: "bytes",
      description:
        "Size of the dataset once loaded into the system, in bytes — smaller means better compression.",
    },
    {
      name: "concurrent_qps",
      type: "number",
      unit: "queries/s",
      description:
        "Sustained queries per second in ClickBench's concurrency test, where the system was measured. Higher is better.",
    },
  ],
  derived: [],
  chart: { x: null, y: "hot_total_s", x_kind: "CATEGORY" },
};

const ABOUT =
  "ClickBench is an open benchmark by the ClickHouse team that measures analytical database systems on a fixed set of 43 SQL queries over a web-analytics dataset of roughly 100 million rows. Results are community-submitted and cover cloud warehouses, embedded engines, and self-managed databases. smplmark ingests the aggregated leaderboard — the latest result per system and machine — not the full per-run history.";
const METHODOLOGY =
  "Data comes from the ClickBench repository's aggregated dataset (data.generated.js), the same file that powers benchmark.clickhouse.com; it keeps the latest dated result for each system + machine combination. A target is one system on one machine; its run is that dated benchmark execution. Each of the 43 queries is executed three times: cold_total_s sums the first (cold) runs and hot_total_s sums the best of the second and third (hot) runs — lower is better for both. Queries a system failed to run are excluded from the sums and counted as missing_queries; the full per-query timing matrix is preserved in each observation. Load time, loaded data size, and concurrent queries per second (where measured) are reported as-is. ClickBench's official \"relative\" leaderboard score requires a cross-system baseline and is deliberately not reproduced. Source: ClickBench (CC-BY-NC-SA-4.0), https://github.com/ClickHouse/ClickBench.";

/**
 * @typedef {Object} ParsedEntry
 * @property {string} system
 * @property {string} machine
 * @property {number | null} hotTotal null when no query produced a hot run
 * @property {Record<string, unknown>} details
 * @property {import("../model.mjs").IngestRun} run
 */

/**
 * @param {import("../model.mjs").Archive} archive
 * @param {{ topTargets?: number }} [options]
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const topTargets = options.topTargets ?? 300;
  const entries = archive.readJson("data.json");
  if (!Array.isArray(entries)) throw new Error("clickbench: data.json is not an array");
  const retrievedAt = archive.manifest.retrieved_at;

  /** @type {ParsedEntry[]} */
  const parsed = [];
  for (const entry of entries) {
    const t = parseEntry(entry, retrievedAt);
    if (t) parsed.push(t);
  }
  if (parsed.length === 0) throw new Error("clickbench: no usable entries in data.json");

  // Default curation: keep the fastest end of the leaderboard (most-lookedat systems); the full
  // 778-entry table stays in the archive. Targets with no hot runs at all sort last.
  parsed.sort(
    (a, z) => (a.hotTotal ?? Number.POSITIVE_INFINITY) - (z.hotTotal ?? Number.POSITIVE_INFINITY),
  );
  const kept = parsed.slice(0, topTargets);

  const seen = new Map();
  return [
    {
      key: "clickbench",
      name: "ClickBench — analytical databases",
      description:
        "Analytical-database runtimes for 43 SQL queries over a ~100M-row web-analytics dataset.",
      about: ABOUT,
      methodology: METHODOLOGY,
      category: "DATABASE",
      tags: ["olap", "sql", "analytics", "databases"],
      sampleSchema: SCHEMA,
      targets: kept.map((t) => ({
        key: uniqueSlug(`${t.system}-${t.machine}`, seen),
        // System names may carry emoji (e.g. "ClickHouse ☁️") — keep them in the display name.
        name: `${t.system} (${t.machine})`,
        details: t.details,
        runs: [t.run],
      })),
    },
  ];
}

/**
 * One data.generated.js record → target ingredients, or null when the row is malformed
 * (missing system/machine/date, or a missing/malformed result matrix).
 * @param {unknown} entry
 * @param {number} retrievedAt
 * @returns {ParsedEntry | null}
 */
function parseEntry(entry, retrievedAt) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = /** @type {Record<string, unknown>} */ (entry);
  const { system, machine, date, result } = e;
  if (typeof system !== "string" || system.length === 0) return null;
  if (typeof machine !== "string" || machine.length === 0) return null;
  if (typeof date !== "string" || date.length === 0) return null;
  if (!Array.isArray(result) || result.length === 0) return null;

  // The 43 query triples: [run1 (cold), run2, run3]; a null run means the query failed.
  let coldTotal = 0;
  let coldCount = 0;
  let hotTotal = 0;
  let hotCount = 0;
  let missing = 0;
  for (const triple of result) {
    const [run1, run2, run3] = Array.isArray(triple) ? triple : [];
    if (typeof run1 === "number") {
      coldTotal += run1;
      coldCount += 1;
    } else {
      missing += 1;
    }
    const hot =
      typeof run2 === "number"
        ? typeof run3 === "number"
          ? Math.min(run2, run3)
          : run2
        : typeof run3 === "number"
          ? run3
          : null;
    if (hot !== null) {
      hotTotal += hot;
      hotCount += 1;
    }
  }

  /** @type {Record<string, number>} */
  const metrics = {};
  if (typeof e.load_time === "number") metrics.load_time_s = e.load_time;
  if (typeof e.data_size === "number") metrics.data_size_bytes = e.data_size;
  if (coldCount > 0) metrics.cold_total_s = round3(coldTotal);
  if (hotCount > 0) metrics.hot_total_s = round3(hotTotal);
  if (typeof e.concurrent_qps === "number") metrics.concurrent_qps = e.concurrent_qps;

  /** @type {Record<string, unknown>} */
  const obsMeta = { result };
  if (typeof e.source === "string") obsMeta.source = e.source;
  if (typeof e.comment === "string" && e.comment.length > 0) obsMeta.comment = e.comment;
  obsMeta.missing_queries = missing;

  /** @type {Record<string, unknown>} */
  const details = {};
  if (Array.isArray(e.tags)) details.tags = e.tags;
  details.machine = machine;
  if (e.cluster_size != null) details.cluster_size = String(e.cluster_size);
  if (typeof e.proprietary === "string") details.proprietary = e.proprietary;
  if (typeof e.tuned === "string") details.tuned = e.tuned;
  if (typeof e.hardware === "string") details.hardware = e.hardware;

  const startedAt = epochMsOrNull(date);
  return {
    system,
    machine,
    hotTotal: hotCount > 0 ? round3(hotTotal) : null,
    details,
    run: {
      key: `r-${date}`,
      name: date,
      started_at: startedAt ?? undefined,
      observations: [{ created_at: startedAt ?? retrievedAt, metrics, meta: obsMeta }],
    },
  };
}

/**
 * Round a seconds total to millisecond precision, shedding float-summation noise.
 * @param {number} x
 */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}
