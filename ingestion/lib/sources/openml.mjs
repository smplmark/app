// @ts-check
// OpenML (www.openml.org) — CC-BY 4.0. Evaluation results from OpenML's REST API: the
// OpenML-CC18 curated classification suite (study 99 — one leaderboard per task, targets are the
// submitted flows) and the AutoML Benchmark study 226 (targets are AutoML frameworks). Only the
// robots-ALLOWED /api/v1/ JSON API is fetched; the robots-disallowed /data/ tree (raw dataset
// files) is never touched. See ingestion/SOURCES.md.
import { epochMsOrNull, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "openml",
  publisher: { slug: "openml", name: "OpenML" },
  name: "OpenML",
  description: "Machine-learning results from OpenML: best predictive accuracy per flow on curated task suites.",
  url: "https://www.openml.org",
  license: "CC-BY-4.0",
  licenseUrl: "https://www.openml.org/terms",
  robotsOrigin: "https://www.openml.org",
};

const API = "https://www.openml.org/api/v1/json";
const CC18_STUDY = 99;
const AMLB_STUDY = 226;

/** Robots preflight: the paths this source fetches. */
export const robotsPaths = ["/api/v1/"];

/** `--full`: lift the default curation caps (see SOURCES.md "Default import cap"). */
export const fullOptions = /** @type {{ topTasks: number, topFlows: number }} */ ({
  topTasks: Number.POSITIVE_INFINITY,
  topFlows: Number.POSITIVE_INFINITY,
});

// OpenML asks for at most ~1 request/second; the shared ctx spacing is only 600 ms, so the pull
// loop adds its own gap. (Host timer typed locally — this file type-checks with lib ES2022 only.)
const EXTRA_GAP_MS = 500;
const setTimeoutFn = /** @type {(cb: (...args: unknown[]) => void, ms: number) => unknown} */ (
  /** @type {any} */ (globalThis).setTimeout
);
/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => void setTimeoutFn(resolve, ms));
}

/**
 * Stage A: study 99's task list, the top-1000 predictive-accuracy evaluations per CC18 task, and
 * both AMLB (study 226) evaluation lists. ~76 requests, ~25 MB — takes several minutes.
 * @param {{ fetchJson: (url: string) => Promise<any>, writeJson: (name: string, data: any) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  const study = await ctx.fetchJson(`${API}/study/${CC18_STUDY}`);
  const taskIds = studyTaskIds(study);
  if (taskIds.length === 0) throw new Error("openml: no task ids in study 99 response");
  await ctx.writeJson("study-99.json", study);

  for (const id of taskIds) {
    await sleep(EXTRA_GAP_MS);
    const url = `${API}/evaluation/list/function/predictive_accuracy/task/${id}/sort_order/desc/limit/1000`;
    try {
      await ctx.writeJson(`task-${id}.json`, await ctx.fetchJson(url));
    } catch {
      // The odd task can 412/5xx even after the client's retries. Record an empty file so the
      // archive stays complete (visible as a 2-byte file in the pull log); adapt() skips it.
      await ctx.writeJson(`task-${id}.json`, {});
    }
  }

  await sleep(EXTRA_GAP_MS);
  await ctx.writeJson(
    "amlb-accuracy.json",
    await ctx.fetchJson(`${API}/evaluation/list/function/predictive_accuracy/study/${AMLB_STUDY}`),
  );
  await sleep(EXTRA_GAP_MS);
  await ctx.writeJson(
    "amlb-auc.json",
    await ctx.fetchJson(`${API}/evaluation/list/function/area_under_roc_curve/study/${AMLB_STUDY}`),
  );
}

/**
 * study/99 nests its task ids under study.tasks.task_id (numbers, or strings in some OpenML
 * JSON renderings).
 * @param {unknown} study
 * @returns {number[]}
 */
function studyTaskIds(study) {
  const ids = /** @type {any} */ (study)?.study?.tasks?.task_id;
  if (!Array.isArray(ids)) {
    throw new Error("openml: unrecognizable study payload (study.tasks.task_id missing)");
  }
  return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * evaluation/list responses nest records under evaluations.evaluation. A failed task request is
 * archived as an empty `{}` file → treated as no records. Anything else non-conforming throws.
 * @param {unknown} payload
 * @param {string} name archive file name, for the error message
 * @returns {any[]}
 */
function evaluationRecords(payload, name) {
  if (payload == null || (typeof payload === "object" && Object.keys(payload).length === 0)) {
    return [];
  }
  const list = /** @type {any} */ (payload)?.evaluations?.evaluation;
  if (Array.isArray(list)) return list;
  // XML-derived JSON APIs sometimes unwrap single-element lists.
  if (list && typeof list === "object") return [list];
  throw new Error(`openml: unrecognizable evaluation payload in ${name}`);
}

/**
 * @param {unknown} v
 * @returns {number | null} finite number (accepting numeric strings), else null
 */
function toNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * @typedef {Object} EvalRow one validated evaluation record
 * @property {number} runId
 * @property {number | null} setupId
 * @property {number} flowId
 * @property {string} flowName
 * @property {string} dataName
 * @property {string} fn evaluation function name ("" when absent)
 * @property {string | null} uploadTime
 * @property {number} value
 */

/**
 * Validate one raw evaluation record; malformed rows return null and are skipped.
 * @param {any} r
 * @returns {EvalRow | null}
 */
function parseRow(r) {
  if (!r || typeof r !== "object") return null;
  const runId = toNum(r.run_id);
  const flowId = toNum(r.flow_id);
  const value = toNum(r.value);
  const flowName = typeof r.flow_name === "string" && r.flow_name.length > 0 ? r.flow_name : null;
  const dataName = typeof r.data_name === "string" && r.data_name.length > 0 ? r.data_name : null;
  if (runId === null || flowId === null || value === null || flowName === null || dataName === null) {
    return null;
  }
  return {
    runId,
    setupId: toNum(r.setup_id),
    flowId,
    flowName,
    dataName,
    fn: typeof r.function === "string" ? r.function : "",
    uploadTime: typeof r.upload_time === "string" && r.upload_time.length > 0 ? r.upload_time : null,
    value,
  };
}

const CC18_SCHEMA = {
  metrics: [
    {
      name: "predictive_accuracy",
      type: "number",
      description:
        "Best predictive accuracy this flow achieved on the task: the fraction of test instances classified correctly, from 0 to 1. Higher is better.",
    },
  ],
  derived: [],
  chart: { x: null, y: "predictive_accuracy", x_kind: "CATEGORY" },
};

const AMLB_SCHEMA = {
  metrics: [
    {
      name: "predictive_accuracy",
      type: "number",
      description:
        "Fraction of test instances classified correctly, from 0 to 1. Higher is better.",
    },
    {
      name: "area_under_roc_curve",
      type: "number",
      description:
        "Area under the ROC curve, from 0 to 1. Higher is better; 0.5 corresponds to random guessing.",
    },
  ],
  derived: [],
  chart: { x: null, y: "predictive_accuracy", x_kind: "CATEGORY" },
};

/**
 * Stage B: one benchmark per CC18 task (leaderboard of flows) plus the AMLB benchmark
 * (frameworks × datasets). Defaults keep the 20 tasks with the most distinct flows and the top
 * 50 flows per task; the full archive stays available via `fullOptions`.
 * @param {import("../model.mjs").Archive} archive
 * @param {{ topTasks?: number, topFlows?: number }} [options]
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const topTasks = options.topTasks ?? 20;
  const topFlows = options.topFlows ?? 50;
  const retrievedAt = archive.manifest.retrieved_at;

  const study = archive.readJson("study-99.json");
  const taskIds = studyTaskIds(study);
  // The CC18 study's creation on OpenML is the suite's publication moment (all cc18-* benchmarks).
  const cc18PublishedAt = epochMsOrNull(/** @type {any} */ (study)?.study?.creation_date);

  /** @type {{ taskId: number, dataName: string, flows: EvalRow[] }[]} */
  const tasks = [];
  for (const taskId of taskIds) {
    const name = `task-${taskId}.json`;
    const records = evaluationRecords(archive.readJson(name), name);
    /** @type {Map<number, EvalRow>} */
    const bestByFlow = new Map();
    /** @type {string | null} */
    let dataName = null;
    for (const raw of records) {
      const row = parseRow(raw);
      if (!row) continue;
      if (row.fn !== "" && row.fn !== "predictive_accuracy") continue;
      dataName ??= row.dataName;
      const prev = bestByFlow.get(row.flowId);
      if (!prev || row.value > prev.value) bestByFlow.set(row.flowId, row);
    }
    if (dataName === null || bestByFlow.size === 0) continue; // empty/failed task file
    tasks.push({ taskId, dataName, flows: [...bestByFlow.values()] });
  }

  // Default curation: keep the tasks whose pulled page shows the most distinct flows (the most
  // broadly exercised leaderboards). Deterministic tie-break on task id.
  tasks.sort((a, z) => z.flows.length - a.flows.length || a.taskId - z.taskId);

  /** @type {Map<string, number>} */
  const benchmarkSeen = new Map();
  const benchmarks = tasks
    .slice(0, topTasks)
    .map((task) => cc18Benchmark(task, topFlows, retrievedAt, cc18PublishedAt, benchmarkSeen));

  const amlb = amlbBenchmark(archive, retrievedAt);
  if (amlb) benchmarks.push(amlb);
  return benchmarks;
}

/**
 * One CC18 task → one benchmark: targets are flows (best run each), ranked by accuracy.
 * @param {{ taskId: number, dataName: string, flows: EvalRow[] }} task
 * @param {number} topFlows
 * @param {number} retrievedAt
 * @param {number | null} publishedAt the CC18 study's creation date on OpenML
 * @param {Map<string, number>} benchmarkSeen keyspace shared by all CC18 benchmark keys
 * @returns {import("../model.mjs").IngestBenchmark}
 */
function cc18Benchmark(task, topFlows, retrievedAt, publishedAt, benchmarkSeen) {
  const flows = [...task.flows]
    .sort((a, z) => z.value - a.value || a.flowId - z.flowId)
    .slice(0, topFlows);
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {import("../model.mjs").IngestTarget[]} */
  const targets = [];
  /** @type {import("../model.mjs").IngestMeasurement[]} */
  const measurements = [];
  // Every flow's best result is one measurement on the task's shared "best" run; the run started
  // at the earliest such upload (null → falls back to retrieval).
  /** @type {number | null} */
  let runStartedAt = null;
  for (const row of flows) {
    const targetKey = uniqueSlug(row.flowName, seen);
    targets.push({
      key: targetKey,
      name: row.flowName,
      details: { openml_flow_id: row.flowId },
    });
    const started = epochMsOrNull(row.uploadTime);
    if (started !== null && (runStartedAt === null || started < runStartedAt)) {
      runStartedAt = started;
    }
    measurements.push({
      run_key: "best",
      target_key: targetKey,
      created_at: started ?? retrievedAt,
      metrics: { predictive_accuracy: row.value },
      meta: {
        openml_run_id: row.runId,
        ...(row.setupId !== null ? { openml_setup_id: row.setupId } : {}),
        source_url: `https://www.openml.org/r/${row.runId}`,
      },
    });
  }
  /** @type {import("../model.mjs").IngestRun} */
  const bestRun = { key: "best" };
  if (runStartedAt !== null) bestRun.started_at = runStartedAt;
  return {
    key: `openml-cc18-${uniqueSlug(task.dataName, benchmarkSeen)}`,
    name: `OpenML-CC18: ${task.dataName}`,
    description: `Best predictive accuracy per machine-learning flow on the ${task.dataName} classification task from the OpenML-CC18 suite.`,
    about:
      `Community results for the ${task.dataName} classification task from OpenML-CC18, OpenML's curated suite of 72 classification tasks (www.openml.org/t/${task.taskId}). Each target is a flow — a specific algorithm or pipeline — shown with the best predictive accuracy recorded for it on this task in OpenML's public evaluation listing, under the task's fixed estimation procedure.`,
    methodology: null,
    published_at: publishedAt ?? undefined,
    category: "ML_AI",
    tags: ["openml", "cc18", "classification"],
    observationSchema: CC18_SCHEMA,
    targets,
    runs: [bestRun],
    measurements,
  };
}

/**
 * "automlbenchmark_autosklearn(1)" → "autosklearn".
 * @param {string} flowName
 */
function frameworkName(flowName) {
  const cleaned = flowName
    .replace(/^automlbenchmark_/i, "")
    .replace(/\(\d+\)\s*$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : flowName;
}

/**
 * @typedef {Object} AmlbEntry one AMLB OpenML run, metrics merged across both evaluation lists
 * @property {number} runId
 * @property {string} framework
 * @property {number} flowId
 * @property {string} dataName
 * @property {string | null} uploadTime
 * @property {Record<string, number>} metrics
 */

/**
 * Study 226 → one benchmark: targets are the AutoML frameworks, runs are the shared datasets (one
 * run per dataset, deduped benchmark-wide so every framework's cell on a dataset names the same
 * run), and each (framework, dataset) cell is one measurement merging predictive_accuracy and
 * area_under_roc_curve for that OpenML run.
 * Returns null when the archive holds no usable AMLB records.
 * @param {import("../model.mjs").Archive} archive
 * @param {number} retrievedAt
 * @returns {import("../model.mjs").IngestBenchmark | null}
 */
function amlbBenchmark(archive, retrievedAt) {
  /** @type {Map<number, AmlbEntry>} */
  const byRun = new Map();
  for (const name of ["amlb-accuracy.json", "amlb-auc.json"]) {
    for (const raw of evaluationRecords(archive.readJson(name), name)) {
      const row = parseRow(raw);
      if (!row) continue;
      if (row.fn !== "predictive_accuracy" && row.fn !== "area_under_roc_curve") continue;
      let entry = byRun.get(row.runId);
      if (!entry) {
        entry = {
          runId: row.runId,
          framework: frameworkName(row.flowName),
          flowId: row.flowId,
          dataName: row.dataName,
          uploadTime: row.uploadTime,
          metrics: {},
        };
        byRun.set(row.runId, entry);
      }
      entry.metrics[row.fn] = row.value;
    }
  }
  if (byRun.size === 0) return null;

  // No study-level metadata is archived for AMLB (study 226); the earliest upload is the proxy
  // for when its results were published on OpenML.
  let publishedAt = null;
  for (const entry of byRun.values()) {
    const t = epochMsOrNull(entry.uploadTime);
    if (t !== null && (publishedAt === null || t < publishedAt)) publishedAt = t;
  }

  /** @type {Map<string, AmlbEntry[]>} */
  const frameworks = new Map();
  for (const entry of byRun.values()) {
    const list = frameworks.get(entry.framework);
    if (list) list.push(entry);
    else frameworks.set(entry.framework, [entry]);
  }

  // Datasets are shared runs across all frameworks: slugify each dataset name ONCE and dedup
  // benchmark-wide (no per-framework suffixing) so every framework's cell on a given dataset names
  // the identical run. A run's started_at is the earliest upload across its measurements.
  /** @type {Map<string, string>} */
  const datasetRunKey = new Map();
  /** @type {Map<string, import("../model.mjs").IngestRun>} */
  const runsByKey = new Map();
  /** @type {Map<string, number>} */
  const runSeen = new Map();
  /** @type {import("../model.mjs").IngestMeasurement[]} */
  const measurements = [];
  /** @type {Map<string, number>} */
  const targetSeen = new Map();
  /** @type {import("../model.mjs").IngestTarget[]} */
  const targets = [];

  for (const [framework, entries] of frameworks.entries()) {
    const targetKey = uniqueSlug(framework, targetSeen);
    targets.push({
      key: targetKey,
      name: framework,
      details: { openml_flow_id: entries[0].flowId },
    });
    for (const entry of entries) {
      let runKey = datasetRunKey.get(entry.dataName);
      if (runKey === undefined) {
        runKey = uniqueSlug(entry.dataName, runSeen);
        datasetRunKey.set(entry.dataName, runKey);
        runsByKey.set(runKey, { key: runKey, name: entry.dataName });
      }
      const started = epochMsOrNull(entry.uploadTime);
      if (started !== null) {
        const run = runsByKey.get(runKey);
        if (run && (run.started_at === undefined || started < run.started_at)) {
          run.started_at = started;
        }
      }
      measurements.push({
        run_key: runKey,
        target_key: targetKey,
        created_at: started ?? retrievedAt,
        metrics: entry.metrics,
        meta: { openml_run_id: entry.runId, data_name: entry.dataName },
      });
    }
  }

  return {
    key: "openml-amlb",
    name: "AutoML Benchmark (AMLB)",
    description:
      "AutoML frameworks compared on classification accuracy and ROC AUC across a shared set of OpenML tasks.",
    about:
      "Results of the AutoML Benchmark (AMLB), which ran automated machine-learning frameworks on a shared set of classification tasks and published the evaluations on OpenML as study 226 (www.openml.org/s/226, 2019). Each target is one framework; each run is one dataset, with the predictive accuracy and ROC AUC recorded there (0-1, higher is better).",
    methodology: null,
    published_at: publishedAt ?? undefined,
    category: "ML_AI",
    tags: ["openml", "automl"],
    observationSchema: AMLB_SCHEMA,
    targets,
    runs: [...runsByKey.values()],
    measurements,
  };
}
