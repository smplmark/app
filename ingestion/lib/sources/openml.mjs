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
  name: "OpenML",
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

  const taskIds = studyTaskIds(archive.readJson("study-99.json"));

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
    .map((task) => cc18Benchmark(task, topFlows, retrievedAt, benchmarkSeen));

  const amlb = amlbBenchmark(archive, retrievedAt);
  if (amlb) benchmarks.push(amlb);
  return benchmarks;
}

/**
 * One CC18 task → one benchmark: targets are flows (best run each), ranked by accuracy.
 * @param {{ taskId: number, dataName: string, flows: EvalRow[] }} task
 * @param {number} topFlows
 * @param {number} retrievedAt
 * @param {Map<string, number>} benchmarkSeen keyspace shared by all CC18 benchmark keys
 * @returns {import("../model.mjs").IngestBenchmark}
 */
function cc18Benchmark(task, topFlows, retrievedAt, benchmarkSeen) {
  const flows = [...task.flows]
    .sort((a, z) => z.value - a.value || a.flowId - z.flowId)
    .slice(0, topFlows);
  /** @type {Map<string, number>} */
  const seen = new Map();
  return {
    key: `openml-cc18-${uniqueSlug(task.dataName, benchmarkSeen)}`,
    name: `OpenML-CC18: ${task.dataName}`,
    description: `Best predictive accuracy per machine-learning flow on the ${task.dataName} classification task from the OpenML-CC18 suite.`,
    about:
      `OpenML is an open platform for sharing machine-learning datasets, algorithms, and experiment results. OpenML-CC18 is its curated suite of 72 classification tasks; this benchmark covers the ${task.dataName} task. Each target is a "flow" — a specific algorithm or pipeline (for example a scikit-learn, mlr, or Weka setup) — shown with the best predictive accuracy the community achieved with it on this task. Scores come from OpenML (CC-BY 4.0): https://www.openml.org/t/${task.taskId}`,
    methodology:
      "Results come from OpenML's public evaluation listing for this task, sorted by predictive accuracy, keeping each flow's single best-scoring run. Predictive accuracy is the fraction of test instances classified correctly (0 to 1, higher is better), computed by OpenML under the task's fixed estimation procedure (typically 10-fold cross-validation), so scores are comparable across flows within the benchmark. Only the top of the leaderboard is retrieved, so each value is a flow's best known result, not an average. Source: OpenML (CC-BY-4.0), https://www.openml.org.",
    category: "ML_AI",
    tags: ["openml", "cc18", "classification"],
    sampleSchema: CC18_SCHEMA,
    targets: flows.map((row) => ({
      key: uniqueSlug(row.flowName, seen),
      name: row.flowName,
      details: { openml_flow_id: row.flowId },
      runs: [bestRun(row, retrievedAt)],
    })),
  };
}

/**
 * The single best OpenML run for a flow on a task.
 * @param {EvalRow} row
 * @param {number} retrievedAt
 * @returns {import("../model.mjs").IngestRun}
 */
function bestRun(row, retrievedAt) {
  const started = epochMsOrNull(row.uploadTime);
  /** @type {import("../model.mjs").IngestRun} */
  const run = {
    key: "best",
    observations: [
      {
        created_at: started ?? retrievedAt,
        metrics: { predictive_accuracy: row.value },
        meta: {
          openml_run_id: row.runId,
          ...(row.setupId !== null ? { openml_setup_id: row.setupId } : {}),
          source_url: `https://www.openml.org/r/${row.runId}`,
        },
      },
    ],
  };
  if (started !== null) run.started_at = started;
  return run;
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
 * Study 226 → one benchmark: targets are the AutoML frameworks, one run per (framework, dataset),
 * one observation merging predictive_accuracy and area_under_roc_curve for that OpenML run.
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

  /** @type {Map<string, AmlbEntry[]>} */
  const frameworks = new Map();
  for (const entry of byRun.values()) {
    const list = frameworks.get(entry.framework);
    if (list) list.push(entry);
    else frameworks.set(entry.framework, [entry]);
  }

  /** @type {Map<string, number>} */
  const targetSeen = new Map();
  return {
    key: "openml-amlb",
    name: "AutoML Benchmark (AMLB)",
    description:
      "AutoML frameworks compared on classification accuracy and ROC AUC across a shared set of OpenML tasks.",
    about:
      "The AutoML Benchmark (AMLB) compares automated machine-learning frameworks — systems that build and tune models without manual intervention — on a shared set of classification tasks, with the results published on OpenML as study 226. Each target is one framework (or baseline learner); each run is one dataset, showing the accuracy and ROC AUC that framework achieved on it. Scores come from OpenML (CC-BY 4.0): https://www.openml.org/s/226",
    methodology:
      "Each framework was executed by the AutoML Benchmark project on every dataset under a shared protocol, and the resulting evaluations were uploaded to OpenML (study 226, published 2019). For each framework-dataset run, one observation merges both published measures: predictive accuracy (fraction of test instances classified correctly) and area under the ROC curve — both range 0 to 1, higher is better. Source: OpenML (CC-BY-4.0), https://www.openml.org.",
    category: "ML_AI",
    tags: ["openml", "automl"],
    sampleSchema: AMLB_SCHEMA,
    targets: [...frameworks.entries()].map(([framework, entries]) => {
      /** @type {Map<string, number>} */
      const runSeen = new Map();
      return {
        key: uniqueSlug(framework, targetSeen),
        name: framework,
        details: { openml_flow_id: entries[0].flowId },
        runs: entries.map((entry) => {
          const started = epochMsOrNull(entry.uploadTime);
          /** @type {import("../model.mjs").IngestRun} */
          const run = {
            key: uniqueSlug(entry.dataName, runSeen),
            name: entry.dataName,
            observations: [
              {
                created_at: started ?? retrievedAt,
                metrics: entry.metrics,
                meta: { openml_run_id: entry.runId, data_name: entry.dataName },
              },
            ],
          };
          if (started !== null) run.started_at = started;
          return run;
        }),
      };
    }),
  };
}
