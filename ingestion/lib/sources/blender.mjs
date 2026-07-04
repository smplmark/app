// @ts-check
// Blender Open Data (opendata.blender.org) — CC0. Pulled from the robots-ALLOWED aggregated query
// endpoint (/benchmarks/query/), which serves exactly the leaderboard granularity we ingest; the
// robots-disallowed /snapshots/ raw dump (1.8 GB) is never touched. See ingestion/SOURCES.md.
import { slugify, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "blender",
  name: "Blender Open Data",
  url: "https://opendata.blender.org",
  license: "CC0-1.0",
  licenseUrl: "https://opendata.blender.org/download/",
  robotsOrigin: "https://opendata.blender.org",
};

const BASE = "https://opendata.blender.org/benchmarks/query/";
const GPU_APIS = ["CUDA", "OPTIX", "HIP", "METAL", "ONEAPI"];
const COMPUTE_TYPES = ["CPU", ...GPU_APIS];

/** Robots preflight: the paths this source fetches. */
export const robotsPaths = ["/benchmarks/query/", "/benchmarks/query/suggest/"];

/** `--full`: lift the default curation caps (see SOURCES.md "Default import cap"). */
export const fullOptions = /** @type {{ versions: "all", topDevices: number }} */ ({
  versions: "all",
  topDevices: Number.POSITIVE_INFINITY,
});

/**
 * Stage A: the complete aggregated matrix — every listed Blender version × compute type,
 * grouped by device. ~60 small requests.
 * @param {{ fetchJson: (url: string) => Promise<any>, writeJson: (name: string, data: any) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  const suggest = await ctx.fetchJson(`${BASE}suggest/?column=blender_version`);
  const versions = normalizeVersions(suggest);
  if (versions.length === 0) throw new Error("blender: no versions from suggest endpoint");
  await ctx.writeJson("versions.json", versions);
  for (const version of versions) {
    for (const compute of COMPUTE_TYPES) {
      const url = `${BASE}?blender_version=${encodeURIComponent(version)}&compute_type=${compute}&group_by=device_name&response_type=datatables`;
      const data = await ctx.fetchJson(url);
      await ctx.writeJson(fileName(version, compute), data);
    }
  }
}

/**
 * The suggest endpoint's shape is undocumented — currently `[{label, value}, …]`; accept plain
 * strings, {value}/{label} objects, and a wrapped array.
 * @param {unknown} suggest
 * @returns {string[]}
 */
function normalizeVersions(suggest) {
  const arr = Array.isArray(suggest)
    ? suggest
    : suggest && typeof suggest === "object"
      ? (Object.values(suggest).find(Array.isArray) ?? [])
      : [];
  /** @type {string[]} */
  const versions = [];
  for (const v of arr) {
    if (typeof v === "string" || typeof v === "number") {
      versions.push(String(v));
    } else if (v && typeof v === "object") {
      const cand = /** @type {{value?: unknown, label?: unknown}} */ (v).value ??
        /** @type {{label?: unknown}} */ (v).label;
      if (typeof cand === "string" || typeof cand === "number") versions.push(String(cand));
    }
  }
  return versions;
}

/** @param {string} version @param {string} compute */
function fileName(version, compute) {
  return `query-${slugify(version)}-${compute.toLowerCase()}.json`;
}

/**
 * Positional datatables → [{device, score, count}]; columns located by display_name.
 * @param {{ columns?: { display_name?: unknown }[], rows?: unknown[][] } | null | undefined} data
 * @returns {{ device: string, score: number, count: number | null }[]}
 */
function parseSlice(data) {
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return [];
  const names = data.columns.map((c) => String(c?.display_name ?? "").toLowerCase());
  const deviceCol = names.findIndex((s) => s.includes("device"));
  const scoreCol = names.findIndex((s) => s.includes("score"));
  const countCol = names.findIndex((s) => s.includes("number"));
  if (deviceCol === -1 || scoreCol === -1) return [];
  /** @type {{ device: string, score: number, count: number | null }[]} */
  const out = [];
  for (const r of data.rows) {
    if (!Array.isArray(r)) continue;
    const score = r[scoreCol];
    if (typeof score !== "number") continue;
    const count = countCol !== -1 ? r[countCol] : null;
    out.push({
      device: String(r[deviceCol]),
      score,
      count: typeof count === "number" ? count : null,
    });
  }
  return out;
}

const SCHEMA = {
  metrics: [
    {
      name: "median_score",
      type: "number",
      unit: "samples/min",
      description:
        "Median benchmark score: the estimated number of Cycles samples rendered per minute, summed across the benchmark scenes. Higher is faster. Scores are comparable within one Blender version.",
    },
    {
      name: "sample_count",
      type: "number",
      description: "How many community submissions the median is computed from.",
    },
  ],
  derived: [],
  chart: { x: null, y: "median_score", x_kind: "CATEGORY" },
};

const ABOUT_COMMON =
  "Blender Open Data is a community platform where anyone can run the Blender Benchmark and share how their hardware performs in Cycles rendering. smplmark ingests the aggregated per-device leaderboard (median score per device per Blender version) — not individual submissions.";
const METHODOLOGY =
  "Data comes from the Blender Open Data aggregation endpoint, grouped by device name. The score is the median across community submissions of samples-per-minute, summed over the benchmark scenes. Each run on a target corresponds to one Blender version (GPU targets: one run per version and compute API), so scores are only compared within a run's version. Source: Blender Open Data (CC0), opendata.blender.org.";

/**
 * @param {import("../model.mjs").Archive} archive
 * @param {{ versions?: "latest" | "all", topDevices?: number }} [options]
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const allVersions = /** @type {string[]} */ (archive.readJson("versions.json"));
  const versions = (options.versions ?? "latest") === "all" ? allVersions : allVersions.slice(0, 1);
  const topDevices = options.topDevices ?? 200;

  return [
    buildBenchmark({
      key: "blender-cpu",
      name: "Blender Benchmark — CPU",
      description: "Cycles CPU render performance across community-benchmarked processors.",
      tags: ["rendering", "blender", "cycles", "cpu"],
      slices: versions.map((v) => ({ version: v, compute: "CPU", runKey: `v${slugify(v)}` })),
      archive,
      topDevices,
    }),
    buildBenchmark({
      key: "blender-gpu",
      name: "Blender Benchmark — GPU",
      description: "Cycles GPU render performance across community-benchmarked graphics devices.",
      tags: ["rendering", "blender", "cycles", "gpu"],
      slices: versions.flatMap((v) =>
        GPU_APIS.map((api) => ({
          version: v,
          compute: api,
          runKey: `v${slugify(v)}-${api.toLowerCase()}`,
        })),
      ),
      archive,
      topDevices,
    }),
  ];
}

/**
 * @param {{ key: string, name: string, description: string, tags: string[],
 *   slices: { version: string, compute: string, runKey: string }[],
 *   archive: import("../model.mjs").Archive, topDevices: number }} input
 * @returns {import("../model.mjs").IngestBenchmark}
 */
function buildBenchmark({ key, name, description, tags, slices, archive, topDevices }) {
  /** @type {Map<string, { name: string, runs: any[], totalCount: number }>} */
  const devices = new Map();
  const retrievedAt = archive.manifest.retrieved_at;

  for (const slice of slices) {
    const rows = parseSlice(archive.readJson(fileName(slice.version, slice.compute)));
    for (const row of rows) {
      let device = devices.get(row.device);
      if (!device) {
        device = { name: row.device, runs: [], totalCount: 0 };
        devices.set(row.device, device);
      }
      /** @type {Record<string, number>} */
      const metrics = { median_score: row.score };
      if (row.count !== null) metrics.sample_count = row.count;
      device.runs.push({
        key: slice.runKey,
        name: slice.compute === "CPU" ? `Blender ${slice.version}` : `Blender ${slice.version} (${slice.compute})`,
        details: { blender_version: slice.version, compute_type: slice.compute },
        observations: [{ created_at: retrievedAt, metrics }],
      });
      device.totalCount += row.count ?? 0;
    }
  }

  // Keep the most-benchmarked devices (recognizable hardware, trustworthy medians); the full
  // matrix stays in the archive.
  const ranked = [...devices.values()]
    .sort((a, z) => z.totalCount - a.totalCount)
    .slice(0, topDevices);

  const seen = new Map();
  return {
    key,
    name,
    description,
    about: ABOUT_COMMON,
    methodology: METHODOLOGY,
    category: "HARDWARE",
    tags,
    sampleSchema: SCHEMA,
    targets: ranked.map((d) => ({
      key: uniqueSlug(d.name, seen),
      name: d.name,
      details: undefined,
      runs: d.runs,
    })),
  };
}
