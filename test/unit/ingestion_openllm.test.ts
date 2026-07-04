import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta } from "../../ingestion/lib/sources/openllm.mjs";

// A miniature fixture archive shaped exactly like the datasets-server rows-API pages.
const T_RETRIEVED = Date.UTC(2026, 6, 4);

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eval_name: "org_model_bfloat16",
    Precision: "bfloat16",
    Type: "🟢 pretrained",
    T: "🟢",
    "Weight type": "Original",
    Architecture: "LlamaForCausalLM",
    Model: '<a href="https://huggingface.co/org/model">org/model</a>',
    fullname: "org/model",
    "Model sha": "sha",
    "Average ⬆️": 10,
    "Hub License": "apache-2.0",
    "Hub ❤️": 1,
    "#Params (B)": 7,
    "Available on the hub": true,
    MoE: false,
    Flagged: false,
    "Chat Template": true,
    "CO₂ cost (kg)": 1.2,
    "IFEval Raw": 0.5,
    IFEval: 50,
    "BBH Raw": 0.4,
    BBH: 40,
    "MATH Lvl 5 Raw": 0.3,
    "MATH Lvl 5": 30,
    "GPQA Raw": 0.2,
    GPQA: 20,
    "MUSR Raw": 0.1,
    MUSR: 10,
    "MMLU-PRO Raw": 0.05,
    "MMLU-PRO": 5,
    Merged: false,
    "Official Providers": false,
    "Upload To Hub Date": "2024-04-13",
    "Submission Date": "2024-08-05",
    Generation: 0,
    "Base Model": "org/model",
    ...overrides,
  };
}

function makePage(rows: unknown[], total: number) {
  return {
    features: [],
    rows: rows.map((row, i) => ({ row_idx: i, row, truncated_cells: [] })),
    num_rows_total: total,
  };
}

function makeArchive(files: Record<string, unknown>) {
  return {
    manifest: {
      retrieved_at: T_RETRIEVED,
      files: Object.keys(files).map((name) => ({ name, url: "u", sha256: "x", bytes: 1 })),
    },
    readJson: (name: string) => {
      if (!(name in files)) throw new Error(`fixture missing: ${name}`);
      return files[name];
    },
  };
}

const files: Record<string, unknown> = {
  "dataset-info.json": { sha: "9c09a7cae43334062a82cb164f2ef255013dafa2" },
  "page-000.json": makePage(
    [
      makeRow({
        eval_name: "meta-llama_Llama-3.1-70B-Instruct_bfloat16",
        fullname: "meta-llama/Llama-3.1-70B-Instruct",
        Type: "💬 chat models (RLHF, DPO, IFT, ...)",
        Architecture: "LlamaForCausalLM",
        "#Params (B)": 70.554,
        "Hub License": "llama3.1",
        "Model sha": "abc123",
        "Average ⬆️": 43.5,
        IFEval: 86.7,
        BBH: 55.9,
        "MATH Lvl 5": 28.9,
        GPQA: 14.2,
        MUSR: 17.7,
        "MMLU-PRO": 46.8,
        "Official Providers": true,
        "Submission Date": "2024-06-26",
      }),
      makeRow({
        eval_name: "Qwen_Qwen2-7B_bfloat16",
        fullname: "Qwen/Qwen2-7B",
        Precision: "bfloat16",
        "Average ⬆️": 30,
      }),
      makeRow({
        eval_name: "Qwen_Qwen2-7B_float16",
        fullname: "Qwen/Qwen2-7B",
        Precision: "float16",
        "Average ⬆️": 29.5,
      }),
      // Community-flagged submission: skipped even though it would top the chart.
      makeRow({
        eval_name: "bad_model_bfloat16",
        fullname: "bad/model",
        "Average ⬆️": 99.9,
        Flagged: true,
      }),
    ],
    7,
  ),
  "page-001.json": makePage(
    [
      makeRow({
        eval_name: "tiny_model_4bit",
        fullname: "tiny/model",
        Precision: "4bit",
        "Average ⬆️": 5,
        // Non-number cells must be omitted from metrics, not crash the row.
        GPQA: null,
        "Submission Date": null,
      }),
      makeRow({
        eval_name: "official_low_org_model_bfloat16",
        fullname: "official-low/model",
        "Average ⬆️": 2,
        "Official Providers": true,
      }),
      // Malformed: no eval_name → skipped.
      makeRow({ eval_name: null, fullname: "nameless/model" }),
      // Malformed: every leaderboard score missing → skipped.
      makeRow({
        eval_name: "no_scores_model_bfloat16",
        fullname: "no-scores/model",
        "Average ⬆️": null,
        IFEval: null,
        BBH: null,
        "MATH Lvl 5": null,
        GPQA: null,
        MUSR: null,
        "MMLU-PRO": null,
      }),
      // Malformed row-API entry (no .row object) → skipped.
      null,
    ],
    7,
  ),
};

const archive = makeArchive(files);

describe("openllm adapter", () => {
  it("declares the unspecified-license provenance", () => {
    expect(meta.key).toBe("openllm");
    expect(meta.name).toBe("Hugging Face Open LLM Leaderboard");
    expect(meta.license).toBe("Unspecified license");
    expect(meta.licenseUrl).toBe("https://huggingface.co/datasets/open-llm-leaderboard/contents");
    expect(meta.robotsOrigin).toBe("https://huggingface.co");
  });

  it("maps the final table to one benchmark with normalized 0-100 metrics", () => {
    const benchmarks = adapt(archive as never);
    expect(benchmarks).toHaveLength(1);
    const [b] = benchmarks;
    expect(b.key).toBe("open-llm-leaderboard");
    expect(b.name).toBe("Open LLM Leaderboard (archived)");
    expect(b.category).toBe("ML_AI");
    expect(b.tags).toEqual(["llm", "evaluation", "open-weights", "huggingface"]);
    expect(b.observationSchema).toMatchObject({ chart: { x: null, y: "average", x_kind: "CATEGORY" } });

    // 5 valid targets (flagged + malformed rows dropped), in average-descending order.
    expect(b.targets.map((t) => t.key)).toEqual([
      "meta-llama-llama-3-1-70b-instruct-bfloat16",
      "qwen-qwen2-7b-bfloat16",
      "qwen-qwen2-7b-float16",
      "tiny-model-4bit",
      "official-low-org-model-bfloat16",
    ]);

    const llama = b.targets[0];
    expect(llama.name).toBe("meta-llama/Llama-3.1-70B-Instruct"); // single precision → no suffix
    expect(llama.details).toEqual({
      precision: "bfloat16",
      type: "chat models (RLHF, DPO, IFT, ...)", // emoji prefix stripped
      architecture: "LlamaForCausalLM",
      params_b: 70.554,
      hub_license: "llama3.1",
    });
    expect(llama.runs).toHaveLength(1);
    const run = llama.runs[0];
    expect(run.key).toBe("final");
    expect(run.started_at).toBe(Date.UTC(2024, 5, 26));
    expect(run.observations).toEqual([
      {
        created_at: Date.UTC(2024, 5, 26),
        metrics: {
          average: 43.5,
          ifeval: 86.7,
          bbh: 55.9,
          math_lvl_5: 28.9,
          gpqa: 14.2,
          musr: 17.7,
          mmlu_pro: 46.8,
        },
        meta: { official_providers: true, model_sha: "abc123", moe: false, merged: false },
      },
    ]);

    // Every observation metric key is declared in the observation schema.
    const schema = b.observationSchema as { metrics: { name: string }[] };
    const declared = new Set(schema.metrics.map((m) => m.name));
    for (const t of b.targets) {
      for (const key of Object.keys(t.runs[0].observations[0].metrics)) {
        expect(declared.has(key)).toBe(true);
      }
    }

    // A fullname evaluated under several precisions gets the disambiguating suffix.
    expect(b.targets[1].name).toBe("Qwen/Qwen2-7B (bfloat16)");
    expect(b.targets[2].name).toBe("Qwen/Qwen2-7B (float16)");

    // Flagged and malformed rows never surface.
    expect(b.targets.some((t) => t.name.includes("bad/model"))).toBe(false);
    expect(b.targets.some((t) => t.name.includes("nameless"))).toBe(false);
    expect(b.targets.some((t) => t.name.includes("no-scores"))).toBe(false);
  });

  it("omits non-number cells and falls back to retrieved_at when the date is missing", () => {
    const [b] = adapt(archive as never);
    const tiny = b.targets.find((t) => t.key === "tiny-model-4bit");
    expect(tiny).toBeDefined();
    const run = tiny!.runs[0];
    expect(run.started_at).toBeUndefined(); // null Submission Date
    expect(run.observations[0].created_at).toBe(T_RETRIEVED);
    expect(run.observations[0].metrics).toEqual({
      average: 5,
      ifeval: 50,
      bbh: 40,
      math_lvl_5: 30,
      musr: 10,
      mmlu_pro: 5,
      // gpqa (null cell) omitted
    });
  });

  it("caps to the top N by average plus every official-provider row", () => {
    const [b] = adapt(archive as never, { topTargets: 2 });
    expect(b.targets.map((t) => t.key)).toEqual([
      "meta-llama-llama-3-1-70b-instruct-bfloat16",
      "qwen-qwen2-7b-bfloat16",
      "official-low-org-model-bfloat16", // rank 5 by average, kept because Official Providers
    ]);
    // Only one Qwen precision survives the cap → the suffix is no longer needed.
    expect(b.targets[1].name).toBe("Qwen/Qwen2-7B");
  });

  it("defaults the cap to 300 targets", () => {
    const many = Array.from({ length: 305 }, (_, i) =>
      makeRow({
        eval_name: `org_model-${i}_bfloat16`,
        fullname: `org/model-${i}`,
        "Average ⬆️": 1000 - i,
      }),
    );
    many.push(
      makeRow({
        eval_name: "official_tail_bfloat16",
        fullname: "official/tail",
        "Average ⬆️": -1,
        "Official Providers": true,
      }),
    );
    const big = makeArchive({ "page-000.json": makePage(many, many.length) });

    const [b] = adapt(big as never);
    expect(b.targets).toHaveLength(301); // top 300 + 1 official straggler
    expect(b.targets.at(-1)!.key).toBe("official-tail-bfloat16");
    expect(b.targets.some((t) => t.key === "org-model-304-bfloat16")).toBe(false);

    const [full] = adapt(big as never, fullOptions);
    expect(full.targets).toHaveLength(306);
  });

  it("fullOptions lifts the cap entirely", () => {
    expect(fullOptions.topTargets).toBe(Number.POSITIVE_INFINITY);
    const [b] = adapt(archive as never, fullOptions);
    expect(b.targets).toHaveLength(5);
  });

  it("throws loudly when the archive shape is unrecognizable", () => {
    const noPages = makeArchive({ "dataset-info.json": {} });
    expect(() => adapt(noPages as never)).toThrow(/no page-.*files/);

    const badPage = makeArchive({ "page-000.json": { rows: "not-an-array" } });
    expect(() => adapt(badPage as never)).toThrow(/unrecognizable page shape/);
  });
});
