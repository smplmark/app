// @ts-check
// Hugging Face Open LLM Leaderboard (v2, retired March 2025) — the final published table of
// ~4,576 model evaluations, pulled page-by-page from the documented datasets-server rows API.
// The dataset card carries no license tag ("unknown" on the Hub); we ingest the scores as facts
// with prominent attribution, per the due-diligence verdict in ingestion/SOURCES.md. The dataset
// is frozen (commit recorded via dataset-info.json), so this is a one-time pull.
import { epochMsOrNull, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "openllm",
  name: "Hugging Face Open LLM Leaderboard",
  description: "Final scores for open-weight language models from the retired Hugging Face Open LLM Leaderboard.",
  url: "https://huggingface.co/datasets/open-llm-leaderboard/contents",
  license: "Unspecified license",
  licenseUrl: "https://huggingface.co/datasets/open-llm-leaderboard/contents",
  robotsOrigin: "https://huggingface.co",
};

/**
 * dataset-info.json lastModified — when the Hub published the frozen final table this benchmark
 * mirrors. Absent or malformed (older archives) → null; published_at then falls back to
 * retrieved_at in the importer.
 * @param {import("../model.mjs").Archive} archive
 * @returns {number | null}
 */
function datasetPublishedAt(archive) {
  try {
    const info = archive.readJson("dataset-info.json");
    return epochMsOrNull(/** @type {any} */ (info)?.lastModified);
  } catch {
    return null;
  }
}

const INFO_URL = "https://huggingface.co/api/datasets/open-llm-leaderboard/contents";
const ROWS_URL =
  "https://datasets-server.huggingface.co/rows?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train";
const PAGE_LENGTH = 100;

/**
 * Robots preflight. The `/rows` endpoint actually lives on datasets-server.huggingface.co, which
 * publishes no robots.txt at all (verified in SOURCES.md); checking it against the parent
 * huggingface.co policy is a conservative stand-in.
 */
export const robotsPaths = ["/api/datasets/open-llm-leaderboard/contents", "/rows"];

/** `--full`: lift the default curation cap (see SOURCES.md "Default import cap"). */
export const fullOptions = /** @type {{ topTargets: number }} */ ({
  topTargets: Number.POSITIVE_INFINITY,
});

/** @param {number} page */
function pageName(page) {
  return `page-${String(page).padStart(3, "0")}.json`;
}

const RATE_LIMIT_BACKOFF_MS = 65_000;
const RATE_LIMIT_ATTEMPTS = 4;

/**
 * datasets-server rate-limits a sustained anonymous crawl (HTTP 429 after ~40 pages), outlasting
 * the quick generic retries in pull.mjs. Back off for a minute and resume — this is a one-time
 * pull of a frozen dataset, so patience beats speed.
 * @param {{ fetchJson: (url: string) => Promise<any> }} ctx
 * @param {string} url
 */
async function fetchJsonPatiently(ctx, url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.fetchJson(url);
    } catch (err) {
      const rateLimited = err instanceof Error && err.message.endsWith("→ 429");
      if (!rateLimited || attempt >= RATE_LIMIT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
    }
  }
}

/**
 * Stage A: the complete final leaderboard table — every rows-API page (100 rows each, ~46 pages)
 * plus the dataset's Hub metadata (which records the frozen commit sha).
 * @param {{ fetchJson: (url: string) => Promise<any>, writeJson: (name: string, data: any) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  const info = await fetchJsonPatiently(ctx, INFO_URL);
  await ctx.writeJson("dataset-info.json", info);

  let total = 0;
  for (let page = 0, offset = 0; page === 0 || offset < total; page++, offset += PAGE_LENGTH) {
    const data = await fetchJsonPatiently(ctx, `${ROWS_URL}&offset=${offset}&length=${PAGE_LENGTH}`);
    const reportedTotal = data?.num_rows_total;
    if (
      !data ||
      !Array.isArray(data.rows) ||
      typeof reportedTotal !== "number" ||
      !Number.isFinite(reportedTotal) ||
      reportedTotal <= 0
    ) {
      throw new Error(`openllm: unexpected rows-API payload at offset ${offset}`);
    }
    if (data.rows.length === 0) {
      throw new Error(
        `openllm: empty page at offset ${offset} before num_rows_total (${reportedTotal}) was covered`,
      );
    }
    total = reportedTotal;
    await ctx.writeJson(pageName(page), data);
  }
}

/** The normalized 0–100 leaderboard columns (NOT the "… Raw" 0–1 fractions). */
const METRIC_COLUMNS = {
  average: "Average ⬆️",
  ifeval: "IFEval",
  bbh: "BBH",
  math_lvl_5: "MATH Lvl 5",
  gpqa: "GPQA",
  musr: "MUSR",
  mmlu_pro: "MMLU-PRO",
};

const SCHEMA = {
  metrics: [
    {
      name: "average",
      type: "number",
      description:
        "Mean of the six normalized benchmark scores, on a 0–100 scale. The leaderboard's headline ranking number; higher is better.",
    },
    {
      name: "ifeval",
      type: "number",
      description:
        "IFEval: how reliably the model follows verifiable formatting instructions. Normalized to 0–100; higher is better.",
    },
    {
      name: "bbh",
      type: "number",
      description:
        "BBH (Big-Bench Hard): a suite of challenging reasoning tasks. Normalized to 0–100 above the random baseline; higher is better.",
    },
    {
      name: "math_lvl_5",
      type: "number",
      description:
        "MATH level 5: the hardest tier of competition mathematics problems. Normalized to 0–100; higher is better.",
    },
    {
      name: "gpqa",
      type: "number",
      description:
        "GPQA: graduate-level science questions written to resist lookup. Normalized to 0–100 above the random baseline; higher is better.",
    },
    {
      name: "musr",
      type: "number",
      description:
        "MuSR: multistep soft reasoning over long narrative problems. Normalized to 0–100 above the random baseline; higher is better.",
    },
    {
      name: "mmlu_pro",
      type: "number",
      description:
        "MMLU-Pro: a harder, ten-choice revision of the MMLU knowledge benchmark. Normalized to 0–100 above the random baseline; higher is better.",
    },
  ],
  derived: [],
  chart: { x: null, y: "average", x_kind: "CATEGORY" },
};

// Factual citation only — what the numbers are, per the source's own definitions. No smplmark
// voice, and no methodology authored here (a source's methodology is theirs to publish).
const ABOUT =
  "The final leaderboard table of Hugging Face's Open LLM Leaderboard, which evaluated open-weight language models on six benchmarks (IFEval, BBH, MATH level 5, GPQA, MuSR, MMLU-Pro) with one standardized harness until its retirement in March 2025. Scores are the leaderboard's published normalized values on a 0-100 scale (higher is better); the average is the mean of the six. Community-flagged submissions are excluded, mirroring the leaderboard's own default view.";

/**
 * @typedef {Object} ParsedRow
 * @property {string} evalName
 * @property {string} fullname
 * @property {string | null} precision
 * @property {string | null} type
 * @property {string | null} architecture
 * @property {number | null} paramsB
 * @property {string | null} hubLicense
 * @property {string | null} modelSha
 * @property {boolean | null} moe
 * @property {boolean | null} merged
 * @property {boolean} official
 * @property {number | null} submittedAt
 * @property {Record<string, number>} metrics
 */

/** @param {unknown} v @returns {string | null} */
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** @param {unknown} v @returns {number | null} */
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {unknown} v @returns {boolean | null} */
function boolOrNull(v) {
  return typeof v === "boolean" ? v : null;
}

/**
 * Strip the leaderboard's emoji prefix from the Type column
 * ("💬 chat models (RLHF, DPO, IFT, ...)" → "chat models (RLHF, DPO, IFT, ...)").
 * @param {unknown} value
 * @returns {string | null}
 */
function stripTypeEmoji(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * One leaderboard row → ParsedRow, or null for rows we skip: community-flagged submissions
 * (mirrors the upstream default view), rows missing their identifiers, and rows with no numeric
 * score in any of the seven leaderboard columns.
 * @param {unknown} raw
 * @returns {ParsedRow | null}
 */
function parseRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (r["Flagged"] === true) return null;
  const evalName = strOrNull(r["eval_name"]);
  const fullname = strOrNull(r["fullname"]);
  if (evalName === null || fullname === null) return null;

  /** @type {Record<string, number>} */
  const metrics = {};
  for (const [name, column] of Object.entries(METRIC_COLUMNS)) {
    const value = numOrNull(r[column]);
    if (value !== null) metrics[name] = value;
  }
  if (Object.keys(metrics).length === 0) return null;

  return {
    evalName,
    fullname,
    precision: strOrNull(r["Precision"]),
    type: stripTypeEmoji(r["Type"]),
    architecture: strOrNull(r["Architecture"]),
    paramsB: numOrNull(r["#Params (B)"]),
    hubLicense: strOrNull(r["Hub License"]),
    modelSha: strOrNull(r["Model sha"]),
    moe: boolOrNull(r["MoE"]),
    merged: boolOrNull(r["Merged"]),
    official: r["Official Providers"] === true,
    submittedAt: epochMsOrNull(r["Submission Date"]),
    metrics,
  };
}

/** @param {ParsedRow} row */
function averageOf(row) {
  const value = row.metrics["average"];
  return typeof value === "number" ? value : Number.NEGATIVE_INFINITY;
}

/**
 * @param {import("../model.mjs").Archive} archive
 * @param {{ topTargets?: number }} [options]
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const topTargets = options.topTargets ?? 300;
  const retrievedAt = archive.manifest.retrieved_at;

  const pageNames = archive.manifest.files
    .map((f) => f.name)
    .filter((name) => /^page-\d+\.json$/.test(name))
    .sort();
  if (pageNames.length === 0) {
    throw new Error("openllm: no page-*.json files in the archive manifest");
  }

  /** @type {ParsedRow[]} */
  const rows = [];
  for (const name of pageNames) {
    const page = archive.readJson(name);
    if (!page || !Array.isArray(page.rows)) {
      throw new Error(`openllm: unrecognizable page shape in ${name}`);
    }
    for (const entry of page.rows) {
      const parsed = parseRow(entry && typeof entry === "object" ? entry.row : null);
      if (parsed !== null) rows.push(parsed);
    }
  }

  // Leaderboard order (average descending), then the curation cap: the top N plus every
  // official-provider submission. The full 4,576-row table stays in the archive.
  const ranked = [...rows].sort((a, z) => {
    const av = averageOf(a);
    const zv = averageOf(z);
    return zv < av ? -1 : zv > av ? 1 : 0;
  });
  const kept = ranked.filter((row, i) => i < topTargets || row.official);

  // Disambiguate display names only where needed: a fullname evaluated under several precisions
  // gets " (<precision>)" appended; the (common) single-precision case keeps the bare fullname.
  /** @type {Map<string, Set<string>>} */
  const precisionsByModel = new Map();
  for (const row of kept) {
    let set = precisionsByModel.get(row.fullname);
    if (!set) {
      set = new Set();
      precisionsByModel.set(row.fullname, set);
    }
    set.add(row.precision ?? "");
  }

  const seen = new Map();
  const targets = kept.map((row) => {
    const ambiguous = (precisionsByModel.get(row.fullname)?.size ?? 0) > 1;
    /** @type {Record<string, unknown>} */
    const details = {};
    if (row.precision !== null) details.precision = row.precision;
    if (row.type !== null) details.type = row.type;
    if (row.architecture !== null) details.architecture = row.architecture;
    if (row.paramsB !== null) details.params_b = row.paramsB;
    if (row.hubLicense !== null) details.hub_license = row.hubLicense;

    /** @type {Record<string, unknown>} */
    const obsMeta = { official_providers: row.official };
    if (row.modelSha !== null) obsMeta.model_sha = row.modelSha;
    if (row.moe !== null) obsMeta.moe = row.moe;
    if (row.merged !== null) obsMeta.merged = row.merged;

    /** @type {import("../model.mjs").IngestRun} */
    const run = {
      key: "final",
      name: "Final leaderboard result",
      observations: [
        { created_at: row.submittedAt ?? retrievedAt, metrics: row.metrics, meta: obsMeta },
      ],
    };
    if (row.submittedAt !== null) run.started_at = row.submittedAt;

    return {
      key: uniqueSlug(row.evalName, seen),
      name: ambiguous && row.precision !== null ? `${row.fullname} (${row.precision})` : row.fullname,
      details,
      runs: [run],
    };
  });

  return [
    {
      key: "open-llm-leaderboard",
      // The source is retired/frozen — the dataset is final, so it imports pre-closed.
      closed: true,
      published_at: datasetPublishedAt(archive) ?? undefined,
      name: "Open LLM Leaderboard (archived)",
      description:
        "Final scores from the retired Hugging Face Open LLM Leaderboard: open-weight language models on six standardized benchmarks.",
      about: ABOUT,
      methodology: null,
      category: "ML_AI",
      tags: ["llm", "evaluation", "open-weights", "huggingface"],
      observationSchema: SCHEMA,
      targets,
    },
  ];
}
