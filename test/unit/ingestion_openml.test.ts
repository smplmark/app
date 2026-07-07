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
  "study-99.json": {
    study: { id: "99", creation_date: "2019-02-21T18:47:13", tasks: { task_id: [3, 6, 11] } },
  },
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
    // Every CC18 benchmark carries the study's creation date as its publication moment (UTC).
    expect(krvskp.published_at).toBe(Date.UTC(2019, 1, 21, 18, 47, 13));
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
    // The task has one shared "best" run; targets carry no runs of their own now.
    expect(svm).not.toHaveProperty("runs");
    expect(krvskp.runs.map((r: { key: string }) => r.key)).toEqual(["best"]);
    // The "best" run started at the earliest flow upload; the svm flow's is the earliest here.
    expect(krvskp.runs[0].started_at).toBe(T_SVM_UPLOAD);
    // Dedupe kept flow 10's max (run 1 at 0.998123), not the later 0.9953. One measurement per
    // flow, on the shared "best" run.
    const svmMeasurement = krvskp.measurements.find(
      (m: { run_key: string; target_key: string }) =>
        m.run_key === "best" && m.target_key === svm.key,
    );
    expect(svmMeasurement).toEqual({
      run_key: "best",
      target_key: "mlr-classif-svm-6",
      created_at: T_SVM_UPLOAD,
      metrics: { predictive_accuracy: 0.998123 },
      meta: {
        openml_run_id: 1,
        openml_setup_id: 4007069,
        source_url: "https://www.openml.org/r/1",
      },
    });

    // Missing upload_time: measurement falls back to retrieved_at.
    const letter = benchmarks[1];
    const rf = letter.targets.find((t: { key: string }) => t.key === "weka-randomforest-1");
    expect(rf).toBeDefined();
    const rfMeasurement = letter.measurements.find(
      (m: { run_key: string; target_key: string }) =>
        m.run_key === "best" && m.target_key === "weka-randomforest-1",
    );
    expect(rfMeasurement).toBeDefined();
    expect(rfMeasurement!.created_at).toBe(T_RETRIEVED);
  });

  it("maps AMLB study 226 to frameworks with per-dataset runs merging both metrics", () => {
    const amlb = adapt(archive as never).at(-1)!;
    expect(amlb.key).toBe("openml-amlb");
    expect(amlb.name).toBe("AutoML Benchmark (AMLB)");
    // No archived study metadata for AMLB — earliest upload_time is the publication proxy
    // (the fixture's default row keeps 2017-07-16 13:36:20, read as UTC).
    expect(amlb.published_at).toBe(Date.UTC(2017, 6, 16, 13, 36, 20));
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
    // Datasets are benchmark-wide shared runs, not per-framework: "adult" is one run shared by
    // autosklearn and tpot, keyed identically for both.
    expect(amlb.runs.map((r: { key: string }) => r.key).sort()).toEqual([
      "adult",
      "credit-g",
      "kc1",
    ]);
    // autosklearn measured on adult and credit-g, each naming the shared dataset run.
    const askRunKeys = amlb.measurements
      .filter((m: { target_key: string }) => m.target_key === "autosklearn")
      .map((m: { run_key: string }) => m.run_key)
      .sort();
    expect(askRunKeys).toEqual(["adult", "credit-g"]);
    const adultRun = amlb.runs.find((r: { key: string }) => r.key === "adult")!;
    expect(adultRun.name).toBe("adult");
    // The shared "adult" run started at the EARLIEST upload across all its measurements.
    // autosklearn's adult uploaded 2019-08-22; tpot's adult inherits the fixture default
    // 2017-07-16, which is earlier — so the shared run's started_at is that.
    expect(adultRun.started_at).toBe(T_SVM_UPLOAD);
    const askAdult = amlb.measurements.find(
      (m: { run_key: string; target_key: string }) =>
        m.run_key === "adult" && m.target_key === "autosklearn",
    )!;
    expect(askAdult).toEqual({
      run_key: "adult",
      target_key: "autosklearn",
      created_at: T_AMLB_UPLOAD,
      metrics: { predictive_accuracy: 0.87, area_under_roc_curve: 0.8879 },
      meta: { openml_run_id: 100, data_name: "adult" },
    });
    // tpot's "adult" measurement names the SAME shared run key.
    const tpotAdult = amlb.measurements.find(
      (m: { run_key: string; target_key: string }) =>
        m.run_key === "adult" && m.target_key === "tpot",
    )!;
    expect(tpotAdult).toBeDefined();
    expect(tpotAdult.run_key).toBe("adult");

    // Accuracy-only cell (no AUC counterpart) still lands, with just the one metric.
    const h2o = amlb.targets.find((t: { key: string }) => t.key === "h2oautoml")!;
    const h2oMeasurement = amlb.measurements.find(
      (m: { target_key: string }) => m.target_key === h2o.key,
    )!;
    expect(h2oMeasurement.metrics).toEqual({ predictive_accuracy: 0.5 });
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
