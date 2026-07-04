// @ts-check
// Stanford HELM Capabilities (crfm.stanford.edu/helm/capabilities) — aggregated LLM leaderboard
// scores, publicly released. Pulled from the public crfm-helm-public GCS bucket, whose bulk
// download is explicitly documented by the HELM maintainers; ONLY the tiny aggregated
// releases/<release>/ tree is fetched — never the per-instance runs/ tree (hundreds of GB).
// HELM is in maintenance mode (June 2026): the dataset is frozen, so this is a one-time pull.
// See ingestion/SOURCES.md.
import { epochMsOrNull, slugify, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "helm",
  name: "Stanford HELM",
  url: "https://crfm.stanford.edu/helm/capabilities/latest/",
  license: "Open access",
  licenseUrl: "https://crfm-helm.readthedocs.io/en/latest/maintenance_mode/",
  robotsOrigin: "https://crfm.stanford.edu",
};

const CONFIG_URL = "https://crfm.stanford.edu/helm/capabilities/latest/config.js";
const BUCKET = "crfm-helm-public";
const LIST_URL = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`;
const OBJECT_BASE = `https://storage.googleapis.com/${BUCKET}/`;
const ACCURACY_TABLE = "groups/json/core_scenarios_accuracy.json";

/** Robots preflight: the only path fetched from robotsOrigin (GCS is a separate origin). */
export const robotsPaths = ["/helm/capabilities/latest/config.js"];

/** `--full`: no default curation caps — the 68-model leaderboard is already the curated set. */
export const fullOptions = {};

/**
 * Stage A: resolve the latest Capabilities release from the leaderboard's config.js, then
 * download every aggregated file under releases/<release>/ from the public GCS bucket
 * (~30 files, ~500 KB). The per-instance benchmark_output/runs/ tree is never touched.
 * @param {{ fetchJson: (url: string) => Promise<any>,
 *   fetchText: (url: string) => Promise<string>,
 *   writeText: (name: string, text: string) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  const configJs = await ctx.fetchText(CONFIG_URL);
  const match = /window\.RELEASE\s*=\s*"([^"]+)"/.exec(configJs);
  if (!match) throw new Error(`helm: could not parse window.RELEASE from ${CONFIG_URL}`);
  const release = match[1];
  await ctx.writeText("release.txt", release);

  const prefix = `capabilities/benchmark_output/releases/${release}/`;
  /** @type {string[]} */
  const objectNames = [];
  /** @type {string | undefined} */
  let pageToken;
  do {
    const url =
      `${LIST_URL}?prefix=${encodeURIComponent(prefix)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const listing = await ctx.fetchJson(url);
    for (const item of Array.isArray(listing?.items) ? listing.items : []) {
      if (item && typeof item.name === "string") objectNames.push(item.name);
    }
    pageToken = typeof listing?.nextPageToken === "string" ? listing.nextPageToken : undefined;
  } while (pageToken);
  if (objectNames.length === 0) {
    throw new Error(`helm: GCS listing for ${prefix} returned no objects`);
  }

  for (const objectName of objectNames) {
    // Belt and braces: the prefix already scopes the listing to the aggregated release files,
    // but never let a surprise listing entry reach the per-instance tree.
    if (!objectName.startsWith(prefix) || objectName.includes("/benchmark_output/runs/")) continue;
    const relative = objectName.slice(prefix.length);
    if (relative.length === 0 || relative.endsWith("/")) continue; // directory placeholder
    const url = OBJECT_BASE + objectName.split("/").map(encodeURIComponent).join("/");
    await ctx.writeText(relative, await ctx.fetchText(url));
  }
}

// Leaderboard column → observation metric. Header cells carry the scenario in
// metadata.run_group ("GPQA", "Omni-MATH", …); the "Mean score" column has no run_group, so the
// display value is the fallback. Unknown columns are skipped — every emitted metric key must be
// declared in the sample schema.
const METRIC_BY_GROUP = new Map([
  ["mean-score", "mean_score"],
  ["mmlu-pro", "mmlu_pro"],
  ["gpqa", "gpqa"],
  ["ifeval", "ifeval"],
  ["wildbench", "wildbench"],
  ["omni-math", "omni_math"],
]);

const SCHEMA = {
  metrics: [
    {
      name: "mean_score",
      type: "number",
      description:
        "Mean of the model's five scenario scores, each normalized to a 0-1 scale. The leaderboard's headline number; higher is better.",
    },
    {
      name: "mmlu_pro",
      type: "number",
      description:
        "MMLU-Pro: fraction of correct answers, with chain-of-thought reasoning, on graduate-level multiple-choice questions spanning 14 subject areas (0-1, higher is better).",
    },
    {
      name: "gpqa",
      type: "number",
      description:
        "GPQA: fraction of correct answers, with chain-of-thought reasoning, on graduate-level science questions written to be search-resistant (0-1, higher is better).",
    },
    {
      name: "ifeval",
      type: "number",
      description:
        "IFEval: fraction of responses satisfying every verifiable instruction in the prompt, under strict checking (0-1, higher is better).",
    },
    {
      name: "wildbench",
      type: "number",
      description:
        "WildBench: judged response quality on challenging real-world user queries, rescaled to 0-1; higher is better.",
    },
    {
      name: "omni_math",
      type: "number",
      description:
        "Omni-MATH: fraction of correct answers, with chain-of-thought reasoning, on Olympiad-level mathematics problems (0-1, higher is better).",
    },
  ],
  derived: [],
  chart: { x: null, y: "mean_score", x_kind: "CATEGORY" },
};

// Factual citation only — what the numbers are, per the source's own definitions. No smplmark
// voice, and no methodology authored here (a source's methodology is theirs to publish).
const ABOUT =
  "Aggregated scores from the HELM Capabilities leaderboard, published by Stanford's Center for Research on Foundation Models (crfm.stanford.edu/helm). Each model row carries the release's mean score and per-scenario scores for MMLU-Pro, GPQA, IFEval, WildBench, and Omni-MATH on a 0-1 scale (higher is better), exactly as published. HELM entered maintenance mode in June 2026, so these results are final.";

/**
 * Stage B: one benchmark from the release's core-scenarios accuracy table. Targets are models
 * (keyed by the schema.json model id, e.g. "amazon/nova-premier-v1:0" → "amazon-nova-premier-v1-0");
 * each has one run keyed by the release with one observation of the row's scores. Null or missing
 * cells are omitted rather than recorded as zeros. No curation caps (68 models).
 * @param {import("../model.mjs").Archive & { readText: (name: string) => string }} archive
 * @param {object} [options] no options — the default is already the full dataset
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const release = archive.readText("release.txt").trim();
  if (release.length === 0) throw new Error("helm: release.txt is empty");

  const table = archive.readJson(ACCURACY_TABLE);
  if (!table || !Array.isArray(table.header) || !Array.isArray(table.rows)) {
    throw new Error(`helm: ${ACCURACY_TABLE} is not a header/rows leaderboard table`);
  }
  const columns = mapColumns(table.header);
  if (columns.length === 0) {
    throw new Error(`helm: no recognizable metric columns in ${ACCURACY_TABLE}`);
  }

  const modelsByDisplayName = indexModels(archive.readJson("schema.json"));
  const createdAt = releaseDate(archive) ?? archive.manifest.retrieved_at;
  const runKey = slugify(release);

  /** @type {import("../model.mjs").IngestTarget[]} */
  const targets = [];
  const seen = new Map();
  for (const row of table.rows) {
    if (!Array.isArray(row)) continue;
    const displayName = cellValue(row[0]);
    if (typeof displayName !== "string" || displayName.length === 0) continue;

    /** @type {Record<string, number>} */
    const metrics = {};
    for (const { index, metric } of columns) {
      const value = cellValue(row[index]);
      if (typeof value === "number" && Number.isFinite(value)) metrics[metric] = value;
    }
    if (Object.keys(metrics).length === 0) continue; // no scores at all — nothing to ingest

    const model = modelsByDisplayName.get(displayName);
    targets.push({
      key: uniqueSlug(model ? model.name : displayName, seen),
      name: displayName,
      details: model ? modelDetails(model) : undefined,
      runs: [
        {
          key: runKey,
          name: `HELM Capabilities ${release}`,
          details: { release },
          observations: [{ created_at: createdAt, metrics }],
        },
      ],
    });
  }

  return [
    {
      key: "helm-capabilities",
      name: "HELM Capabilities",
      description: "Language models scored on five scenarios by the Stanford HELM Capabilities leaderboard.",
      about: ABOUT,
      methodology: null,
      category: "ML_AI",
      tags: ["llm", "evaluation", "helm", "language-models"],
      sampleSchema: SCHEMA,
      targets,
    },
  ];
}

/**
 * Header cells → [{index, metric}] for the columns we ingest (column 0 is the model name).
 * Prefers metadata.run_group; falls back to the display value's scenario prefix.
 * @param {unknown[]} header
 * @returns {{ index: number, metric: string }[]}
 */
function mapColumns(header) {
  /** @type {{ index: number, metric: string }[]} */
  const columns = [];
  for (let index = 1; index < header.length; index++) {
    const cell = header[index];
    if (!cell || typeof cell !== "object") continue;
    const { value, metadata } = /** @type {{ value?: unknown, metadata?: { run_group?: unknown } }} */ (cell);
    const group = metadata?.run_group ?? String(value ?? "").split(" - ")[0];
    const metric = METRIC_BY_GROUP.get(slugify(group));
    if (metric) columns.push({ index, metric });
  }
  return columns;
}

/**
 * schema.json models[] indexed by display_name (the accuracy table's row label).
 * @param {{ models?: unknown } | null | undefined} schema
 * @returns {Map<string, { name: string, creator_organization?: unknown, access?: unknown, release_date?: unknown }>}
 */
function indexModels(schema) {
  if (!schema || !Array.isArray(schema.models)) {
    throw new Error("helm: schema.json has no models[] array");
  }
  /** @type {Map<string, { name: string, creator_organization?: unknown, access?: unknown, release_date?: unknown }>} */
  const byDisplayName = new Map();
  for (const model of schema.models) {
    if (!model || typeof model !== "object") continue;
    const m = /** @type {{ name?: unknown, display_name?: unknown }} */ (model);
    if (typeof m.name !== "string" || typeof m.display_name !== "string") continue;
    byDisplayName.set(m.display_name, /** @type {any} */ (model));
  }
  return byDisplayName;
}

/**
 * Target details from a schema.json model record — only the fields that are present.
 * @param {{ creator_organization?: unknown, access?: unknown, release_date?: unknown }} model
 * @returns {Record<string, unknown>}
 */
function modelDetails(model) {
  /** @type {Record<string, unknown>} */
  const details = {};
  if (model.creator_organization != null) details.creator_organization = model.creator_organization;
  if (model.access != null) details.access = model.access;
  if (model.release_date != null) details.release_date = model.release_date;
  return details;
}

/**
 * The release's publication date from summary.json (epoch-ms), or null if unavailable — the
 * observation timestamp falls back to the archive's retrieved_at.
 * @param {import("../model.mjs").Archive} archive
 * @returns {number | null}
 */
function releaseDate(archive) {
  try {
    const summary = archive.readJson("summary.json");
    return epochMsOrNull(summary?.date);
  } catch {
    return null;
  }
}

/**
 * A leaderboard cell's raw value ({value: …} objects; anything else is malformed → undefined).
 * @param {unknown} cell
 * @returns {unknown}
 */
function cellValue(cell) {
  if (!cell || typeof cell !== "object") return undefined;
  return /** @type {{ value?: unknown }} */ (cell).value;
}
