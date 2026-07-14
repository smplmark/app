// @ts-check
// Blender Open Data (opendata.blender.org) — CC0. Pulled from the robots-ALLOWED aggregated query
// endpoint (/benchmarks/query/), which serves exactly the leaderboard granularity we ingest; the
// robots-disallowed /snapshots/ raw dump (1.8 GB) is never touched. See ingestion/SOURCES.md.
import { slugify, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "blender",
  publisher: { slug: "blender", name: "Blender" },
  name: "Blender Open Data",
  description: "Community Blender Benchmark results: median rendering performance per CPU and GPU device.",
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
      name: "submission_count",
      type: "number",
      description:
        'How many community submissions the median is computed from — the source\'s "Number of Benchmarks" column.',
    },
  ],
  derived: [],
  chart: { x: null, y: "median_score", x_kind: "CATEGORY" },
};

// Factual citation only — what the numbers are, per the source's own definitions. No smplmark
// voice, and no methodology authored here (a source's methodology is theirs to publish).
const ABOUT_COMMON =
  "Aggregated per-device results from Blender Open Data (opendata.blender.org), where the community runs the Blender Benchmark and shares hardware results for Cycles rendering. Each value is the source's median score for a device on a given Blender version; scores are comparable within one version.";

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
  /** @type {Map<string, { name: string, entries: { runKey: string, metrics: Record<string, number> }[], totalCount: number }>} */
  const devices = new Map();
  // One run per DISTINCT slice, deduped by slice runKey across every device.
  /** @type {Map<string, import("../model.mjs").IngestRun>} */
  const runsByKey = new Map();
  const retrievedAt = archive.manifest.retrieved_at;

  for (const slice of slices) {
    if (!runsByKey.has(slice.runKey)) {
      runsByKey.set(slice.runKey, {
        key: slice.runKey,
        name: slice.compute === "CPU" ? `Blender ${slice.version}` : `Blender ${slice.version} (${slice.compute})`,
        details: { blender_version: slice.version, compute_type: slice.compute },
      });
    }
    const rows = parseSlice(archive.readJson(fileName(slice.version, slice.compute)));
    for (const row of rows) {
      let device = devices.get(row.device);
      if (!device) {
        device = { name: row.device, entries: [], totalCount: 0 };
        devices.set(row.device, device);
      }
      /** @type {Record<string, number>} */
      const metrics = { median_score: row.score };
      if (row.count !== null) metrics.submission_count = row.count;
      device.entries.push({ runKey: slice.runKey, metrics });
      device.totalCount += row.count ?? 0;
    }
  }

  // Keep the most-benchmarked devices (recognizable hardware, trustworthy medians); the full
  // matrix stays in the archive.
  const ranked = [...devices.values()]
    .sort((a, z) => z.totalCount - a.totalCount)
    .slice(0, topDevices);

  const seen = new Map();
  /** @type {import("../model.mjs").IngestSubject[]} */
  const subjects = [];
  /** @type {import("../model.mjs").IngestMeasurement[]} */
  const measurements = [];
  // Only runs actually referenced by a surviving measurement are emitted.
  /** @type {Set<string>} */
  const usedRunKeys = new Set();

  for (const d of ranked) {
    const subjectKey = uniqueSlug(d.name, seen);
    // The device name is Blender's native stable id — the same device recurs across the CPU and GPU
    // benchmarks, so it dedups into one account-owned subject linked into both (M:N).
    subjects.push({ key: subjectKey, name: d.name, source_external_id: d.name, details: undefined });
    for (const entry of d.entries) {
      usedRunKeys.add(entry.runKey);
      measurements.push({
        run_key: entry.runKey,
        subject_key: subjectKey,
        created_at: retrievedAt,
        metrics: entry.metrics,
      });
    }
  }

  return {
    key,
    name,
    description,
    about: ABOUT_COMMON,
    methodology: null,
    category: "HARDWARE",
    tags,
    measurementSchema: SCHEMA,
    subjects,
    runs: [...runsByKey.values()].filter((r) => usedRunKeys.has(r.key)),
    measurements,
  };
}
