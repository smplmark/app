import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta, robotsPaths } from "../../ingestion/lib/sources/openml.mjs";

// A miniature fixture archive shaped exactly like the /api/v1/json evaluation/list payloads.
function rec(over: Record<string, unknown> = {}) {
  return {
    run_id: 1,
    task_id: 3,
    setup_id: 4007069,
    flow_id: 10,
    flow_name: "mlr.classif.svm(6)",
    data_name: "kr-vs-kp",
    function: "predictive_accuracy",
    upload_time: "2017-07-16 13:36:20",
    value: 0.99,
    ...over,
  };
}

const files: Record<string, unknown> = {
  "study-99.json": { study: { id: "99", tasks: { task_id: [3, 6, 11] } } },
  "task-3.json": {
    evaluations: {
      evaluation: [
        rec({ run_id: 1, flow_id: 10, value: 0.998123 }),
        // Same flow again, lower score — dedupe must keep the max.
        rec({ run_id: 2, flow_id: 10, value: 0.9953 }),
        rec({ run_id: 3, flow_id: 20, flow_name: "sklearn.pipeline.Pipeline(AdaBoost)(1)", value: 0.9912 }),
        rec({ run_id: 4, flow_id: 30, flow_name: "weka.J48(2)", value: 0.95 }),
        // Malformed rows the parser must drop: no value, no flow_name, not an object.
        rec({ run_id: 5, flow_id: 40, flow_name: "broken.NoValue(1)", value: null }),
        rec({ run_id: 6, flow_id: 50, flow_name: "", value: 0.5 }),
        "junk",
      ],
    },
  },
  "task-6.json": {
    evaluations: {
      evaluation: [
        rec({ task_id: 6, data_name: "letter", run_id: 7, flow_id: 10, value: 0.97 }),
        // No upload_time → run has no started_at; observation falls back to retrieved_at.
        rec({
          task_id: 6,
          data_name: "letter",
          run_id: 8,
          flow_id: 60,
          flow_name: "weka.RandomForest(1)",
          value: 0.96,
          upload_time: null,
        }),
      ],
    },
  },
  // A task whose pull failed after retries is archived as an empty file — skipped, no benchmark.
  "task-11.json": {},
  "amlb-accuracy.json": {
    evaluations: {
      evaluation: [
        rec({
          run_id: 100,
          task_id: 7592,
          flow_id: 15509,
          flow_name: "automlbenchmark_autosklearn(1)",
          data_name: "adult",
          value: 0.87,
          upload_time: "2019-08-22 17:43:17",
        }),
        rec({
          run_id: 101,
          flow_id: 15509,
          flow_name: "automlbenchmark_autosklearn(1)",
          data_name: "credit-g",
          value: 0.76,
        }),
        rec({
          run_id: 102,
          flow_id: 15510,
          flow_name: "automlbenchmark_tpot(1)",
          data_name: "adult",
          value: 0.86,
        }),
        // A run with no AUC counterpart — observation carries accuracy only.
        rec({
          run_id: 103,
          flow_id: 15511,
          flow_name: "automlbenchmark_h2oautoml(1)",
          data_name: "kc1",
          value: 0.5,
        }),
      ],
    },
  },
  "amlb-auc.json": {
    evaluations: {
      evaluation: [
        rec({
          run_id: 100,
          flow_id: 15509,
          flow_name: "automlbenchmark_autosklearn(1)",
          data_name: "adult",
          function: "area_under_roc_curve",
          value: 0.8879,
          upload_time: "2019-08-22 17:43:17",
        }),
        rec({
          run_id: 101,
          flow_id: 15509,
          flow_name: "automlbenchmark_autosklearn(1)",
          data_name: "credit-g",
          function: "area_under_roc_curve",
          value: 0.79,
        }),
        rec({
          run_id: 102,
          flow_id: 15510,
          flow_name: "automlbenchmark_tpot(1)",
          data_name: "adult",
          function: "area_under_roc_curve",
          value: 0.88,
        }),
      ],
    },
  },
};

const T_RETRIEVED = Date.UTC(2026, 6, 4);

function archiveOf(fixture: Record<string, unknown>) {
  return {
    readJson: (name: string) => {
      if (!(name in fixture)) throw new Error(`fixture missing: ${name}`);
      return fixture[name];
    },
    manifest: { retrieved_at: T_RETRIEVED, files: [] },
  };
}

const archive = archiveOf(files);

// upload_time strings have no zone; the adapter parses them with the shared helper (Date.parse).
const T_SVM_UPLOAD = new Date("2017-07-16 13:36:20").getTime();
const T_AMLB_UPLOAD = new Date("2019-08-22 17:43:17").getTime();

describe("openml adapter", () => {
  it("declares CC-BY provenance and the robots-allowed API surface", () => {
    expect(meta.key).toBe("openml");
    expect(meta.license).toBe("CC-BY-4.0");
    expect(meta.licenseUrl).toBe("https://www.openml.org/terms");
    expect(robotsPaths).toEqual(["/api/v1/"]);
  });

  it("maps CC18 tasks to per-task benchmarks with best-run-per-flow targets", () => {
    const benchmarks = adapt(archive as never);
    // Tasks ranked by distinct flows (3 > 2); the empty task-11 file yields no benchmark.
    expect(benchmarks.map((b) => b.key)).toEqual([
      "openml-cc18-kr-vs-kp",
      "openml-cc18-letter",
      "openml-amlb",
    ]);

    const krvskp = benchmarks[0];
    expect(krvskp.name).toBe("OpenML-CC18: kr-vs-kp");
    expect(krvskp.category).toBe("ML_AI");
    expect(krvskp.tags).toEqual(["openml", "cc18", "classification"]);
    expect(krvskp.observationSchema).toMatchObject({
      chart: { x: null, y: "predictive_accuracy", x_kind: "CATEGORY" },
    });

    // Targets ranked by accuracy; malformed rows (no value / no flow_name / junk) are gone.
    expect(krvskp.targets.map((t: { key: string }) => t.key)).toEqual([
      "mlr-classif-svm-6",
      "sklearn-pipeline-pipeline-adaboost-1",
      "weka-j48-2",
    ]);

    const svm = krvskp.targets[0];
    expect(svm.name).toBe("mlr.classif.svm(6)");
    expect(svm.details).toEqual({ openml_flow_id: 10 });
    expect(svm.runs).toHaveLength(1);
    expect(svm.runs[0].key).toBe("best");
    expect(svm.runs[0].started_at).toBe(T_SVM_UPLOAD);
    // Dedupe kept flow 10's max (run 1 at 0.998123), not the later 0.9953.
    expect(svm.runs[0].observations).toEqual([
      {
        created_at: T_SVM_UPLOAD,
        metrics: { predictive_accuracy: 0.998123 },
        meta: {
          openml_run_id: 1,
          openml_setup_id: 4007069,
          source_url: "https://www.openml.org/r/1",
        },
      },
    ]);

    // Missing upload_time: no started_at, observation timestamped at retrieval.
    const letter = benchmarks[1];
    const rf = letter.targets.find((t: { key: string }) => t.key === "weka-randomforest-1");
    expect(rf).toBeDefined();
    expect(rf!.runs[0].started_at).toBeUndefined();
    expect(rf!.runs[0].observations[0].created_at).toBe(T_RETRIEVED);
  });

  it("maps AMLB study 226 to frameworks with per-dataset runs merging both metrics", () => {
    const amlb = adapt(archive as never).at(-1)!;
    expect(amlb.key).toBe("openml-amlb");
    expect(amlb.name).toBe("AutoML Benchmark (AMLB)");
    expect(amlb.category).toBe("ML_AI");
    expect(amlb.tags).toEqual(["openml", "automl"]);
    expect(amlb.observationSchema).toMatchObject({
      chart: { x: null, y: "predictive_accuracy", x_kind: "CATEGORY" },
    });

    // Flow names cleaned to framework names.
    expect(amlb.targets.map((t: { name: string }) => t.name).sort()).toEqual([
      "autosklearn",
      "h2oautoml",
      "tpot",
    ]);

    const ask = amlb.targets.find((t: { key: string }) => t.key === "autosklearn")!;
    expect(ask.details).toEqual({ openml_flow_id: 15509 });
    expect(ask.runs.map((r: { key: string }) => r.key).sort()).toEqual(["adult", "credit-g"]);
    const adult = ask.runs.find((r: { key: string }) => r.key === "adult")!;
    expect(adult.started_at).toBe(T_AMLB_UPLOAD);
    expect(adult.observations).toEqual([
      {
        created_at: T_AMLB_UPLOAD,
        metrics: { predictive_accuracy: 0.87, area_under_roc_curve: 0.8879 },
        meta: { openml_run_id: 100, data_name: "adult" },
      },
    ]);

    // Accuracy-only run (no AUC counterpart) still lands, with just the one metric.
    const h2o = amlb.targets.find((t: { key: string }) => t.key === "h2oautoml")!;
    expect(h2o.runs[0].observations[0].metrics).toEqual({ predictive_accuracy: 0.5 });
  });

  it("caps tasks by distinct-flow count and flows by value", () => {
    const capped = adapt(archive as never, { topTasks: 1, topFlows: 2 });
    // Only kr-vs-kp (3 distinct flows beats letter's 2) plus AMLB, which is never capped.
    expect(capped.map((b) => b.key)).toEqual(["openml-cc18-kr-vs-kp", "openml-amlb"]);
    expect(capped[0].targets.map((t: { key: string }) => t.key)).toEqual([
      "mlr-classif-svm-6",
      "sklearn-pipeline-pipeline-adaboost-1",
    ]);
  });

  it("applies the default caps (20 tasks, 50 flows) and fullOptions lifts them", () => {
    // 22 tasks: task 1000+i has i+2 distinct flows, except the last which has 55.
    const taskIds = Array.from({ length: 22 }, (_, i) => 1000 + i);
    const big: Record<string, unknown> = {
      "study-99.json": { study: { tasks: { task_id: taskIds } } },
      "amlb-accuracy.json": {},
      "amlb-auc.json": {},
    };
    for (const [i, taskId] of taskIds.entries()) {
      const flowCount = i === 21 ? 55 : i + 2;
      big[`task-${taskId}.json`] = {
        evaluations: {
          evaluation: Array.from({ length: flowCount }, (_, f) =>
            rec({
              task_id: taskId,
              data_name: `ds-${taskId}`,
              run_id: taskId * 1000 + f,
              flow_id: f + 1,
              flow_name: `flow.Pipeline(${f + 1})`,
              value: 1 - f / 100,
            }),
          ),
        },
      };
    }
    const bigArchive = archiveOf(big);

    const capped = adapt(bigArchive as never);
    // 20 of 22 tasks (the two with the fewest distinct flows dropped); empty AMLB files → no
    // AMLB benchmark. The 55-flow task ranks first and is capped to 50 targets.
    expect(capped).toHaveLength(20);
    expect(capped[0].key).toBe("openml-cc18-ds-1021");
    expect(capped[0].targets).toHaveLength(50);
    const keys = capped.map((b) => b.key);
    expect(keys).not.toContain("openml-cc18-ds-1000");
    expect(keys).not.toContain("openml-cc18-ds-1001");

    const full = adapt(bigArchive as never, fullOptions);
    expect(full).toHaveLength(22);
    expect(full[0].targets).toHaveLength(55);
  });

  it("throws loudly on unrecognizable payloads", () => {
    const badStudy = archiveOf({ ...files, "study-99.json": { nonsense: true } });
    expect(() => adapt(badStudy as never)).toThrow(/study/);

    const badTask = archiveOf({ ...files, "task-3.json": { evaluations: { evaluation: "nope" } } });
    expect(() => adapt(badTask as never)).toThrow(/task-3\.json/);
  });
});
