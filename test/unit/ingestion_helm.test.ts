import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta } from "../../ingestion/lib/sources/helm.mjs";

// A miniature fixture archive shaped exactly like a HELM Capabilities release: the accuracy
// leaderboard table (header cells with run_group metadata, row cells with {value}), the model
// registry in schema.json, and the release id/date.
const HEADER = [
  { value: "Model" },
  // The mean-score column carries no run_group metadata — mapped via its display value.
  { value: "Mean score", lower_is_better: false },
  { value: "MMLU-Pro - COT correct", metadata: { metric: "COT correct", run_group: "MMLU-Pro" } },
  { value: "GPQA - COT correct", metadata: { metric: "COT correct", run_group: "GPQA" } },
  { value: "IFEval - IFEval Strict Acc", metadata: { metric: "IFEval Strict Acc", run_group: "IFEval" } },
  { value: "WildBench - Score", metadata: { metric: "Score", run_group: "WildBench" } },
  { value: "Omni-MATH - COT correct", metadata: { metric: "COT correct", run_group: "Omni-MATH" } },
  // An unrecognized scenario column the adapter must skip (its key isn't in the sample schema).
  { value: "FutureBench - Score", metadata: { metric: "Score", run_group: "FutureBench" } },
];

const TABLE = {
  title: "Accuracy",
  name: "core_scenarios_accuracy",
  header: HEADER,
  rows: [
    [
      { value: "Amazon Nova Premier", href: "?group=core_scenarios" },
      { value: 0.665, description: "min=0.665, mean=0.665, max=0.665, sum=0.665 (1)" },
      { value: 0.702, run_spec_names: ["mmlu_pro:model=amazon_nova-premier-v1:0"] },
      { value: 0.463 },
      { value: 0.851 },
      { value: 0.712 },
      { value: 0.44 },
      { value: 0.999 }, // FutureBench — must not appear in metrics
    ],
    [
      { value: "GPT-4o (2024-11-20)" },
      { value: 0.61 },
      { value: 0.68 },
      { value: null }, // GPQA not evaluated — omit, don't invent a zero
      { value: 0.83 },
      {}, // WildBench cell without a value — omit
      { value: 0.39 },
      { value: null },
    ],
    // Two models missing from schema.json whose display names slugify identically — the
    // fallback key must get a collision suffix, not merge them.
    [{ value: "Mystery Model 9000" }, { value: 0.5 }],
    [{ value: "Mystery-Model 9000" }, { value: 0.45 }],
    // Malformed rows the parser must drop:
    null, // not an array
    [{ value: 123 }, { value: 0.5 }], // non-string model name
    [{ value: "All Nulls" }, { value: null }, {}, { value: null }], // no numeric cells at all
  ],
};

const FILES: Record<string, unknown> = {
  "schema.json": {
    models: [
      {
        name: "amazon/nova-premier-v1:0",
        display_name: "Amazon Nova Premier",
        creator_organization: "Amazon",
        access: "limited",
        release_date: "2025-04-30",
        description: "Multimodal Nova model.",
      },
      {
        name: "openai/gpt-4o-2024-11-20",
        display_name: "GPT-4o (2024-11-20)",
        creator_organization: "OpenAI",
        access: "limited",
        release_date: "2024-11-20",
      },
      // Junk registry entries the indexer must skip.
      null,
      { display_name: "No Name" },
    ],
  },
  "summary.json": { release: "v1.15.0", suites: ["v1.15.0"], date: "2025-11-24" },
  "groups/json/core_scenarios_accuracy.json": TABLE,
};

const T_RETRIEVED = Date.UTC(2026, 6, 4);
const T_RELEASE = Date.UTC(2025, 10, 24);

function makeArchive(files: Record<string, unknown>, texts: Record<string, string>) {
  return {
    readJson: (name: string) => {
      if (!(name in files)) throw new Error(`fixture missing: ${name}`);
      return files[name];
    },
    readText: (name: string) => {
      if (!(name in texts)) throw new Error(`fixture missing: ${name}`);
      return texts[name];
    },
    manifest: { retrieved_at: T_RETRIEVED, files: [] },
  };
}

const archive = makeArchive(FILES, { "release.txt": "v1.15.0\n" });

describe("helm adapter", () => {
  it("declares open-access provenance for the attribution badge", () => {
    expect(meta.key).toBe("helm");
    expect(meta.name).toBe("Stanford HELM");
    expect(meta.license).toBe("Open access");
    expect(meta.robotsOrigin).toBe("https://crfm.stanford.edu");
  });

  it("maps the accuracy table to one benchmark with a run per model per release", () => {
    const benchmarks = adapt(archive as never);
    expect(benchmarks).toHaveLength(1);
    const [bench] = benchmarks;
    expect(bench.key).toBe("helm-capabilities");
    expect(bench.category).toBe("ML_AI");
    expect(bench.tags).toEqual(["llm", "evaluation", "helm", "language-models"]);
    expect(bench.sampleSchema).toMatchObject({
      chart: { x: null, y: "mean_score", x_kind: "CATEGORY" },
    });

    // All four real rows survive, in leaderboard order; malformed rows are dropped.
    expect(bench.targets.map((t: { key: string }) => t.key)).toEqual([
      "amazon-nova-premier-v1-0",
      "openai-gpt-4o-2024-11-20",
      "mystery-model-9000",
      "mystery-model-9000-2",
    ]);

    const nova = bench.targets[0];
    expect(nova.name).toBe("Amazon Nova Premier");
    expect(nova.details).toEqual({
      creator_organization: "Amazon",
      access: "limited",
      release_date: "2025-04-30",
    });
    expect(nova.runs).toHaveLength(1);
    expect(nova.runs[0].key).toBe("v1-15-0");
    expect(nova.runs[0].name).toBe("HELM Capabilities v1.15.0");
    expect(nova.runs[0].details).toEqual({ release: "v1.15.0" });
    // Exact metrics: the unknown FutureBench column must NOT leak in, and created_at is the
    // release's publication date from summary.json.
    expect(nova.runs[0].observations).toEqual([
      {
        created_at: T_RELEASE,
        metrics: {
          mean_score: 0.665,
          mmlu_pro: 0.702,
          gpqa: 0.463,
          ifeval: 0.851,
          wildbench: 0.712,
          omni_math: 0.44,
        },
      },
    ]);
  });

  it("omits null or absent score cells instead of inventing zeros", () => {
    const [bench] = adapt(archive as never);
    const gpt4o = bench.targets.find((t: { key: string }) => t.key === "openai-gpt-4o-2024-11-20");
    expect(gpt4o!.runs[0].observations[0].metrics).toEqual({
      mean_score: 0.61,
      mmlu_pro: 0.68,
      ifeval: 0.83,
      omni_math: 0.39,
    });
  });

  it("falls back to display-name slugs (collision-safe) when a model is missing from schema.json", () => {
    const [bench] = adapt(archive as never);
    const mystery = bench.targets.filter((t: { key: string }) => t.key.startsWith("mystery-model-9000"));
    expect(mystery.map((t: { key: string }) => t.key)).toEqual([
      "mystery-model-9000",
      "mystery-model-9000-2",
    ]);
    expect(mystery[0].details).toBeUndefined();
  });

  it("only emits metric keys declared in the sample schema", () => {
    const [bench] = adapt(archive as never);
    const declared = new Set(
      (bench.sampleSchema as { metrics: { name: string }[] }).metrics.map((m) => m.name),
    );
    for (const target of bench.targets) {
      for (const run of target.runs) {
        for (const obs of run.observations) {
          for (const key of Object.keys(obs.metrics)) expect(declared.has(key)).toBe(true);
        }
      }
    }
  });

  it("has no curation caps: fullOptions is empty and changes nothing", () => {
    expect(fullOptions).toEqual({});
    expect(adapt(archive as never, fullOptions)).toEqual(adapt(archive as never));
  });

  it("falls back to the archive retrieval time when summary.json is unavailable", () => {
    const { "summary.json": _dropped, ...withoutSummary } = FILES;
    const bare = makeArchive(withoutSummary, { "release.txt": "v1.15.0" });
    const [bench] = adapt(bare as never);
    expect(bench.targets[0].runs[0].observations[0].created_at).toBe(T_RETRIEVED);
  });

  it("throws loudly when the payload shape is unrecognizable", () => {
    const badTable = makeArchive(
      { ...FILES, "groups/json/core_scenarios_accuracy.json": { html: "<table>" } },
      { "release.txt": "v1.15.0" },
    );
    expect(() => adapt(badTable as never)).toThrow(/leaderboard table/);

    const badSchema = makeArchive(
      { ...FILES, "schema.json": { metrics: [] } },
      { "release.txt": "v1.15.0" },
    );
    expect(() => adapt(badSchema as never)).toThrow(/models/);

    const noColumns = makeArchive(
      {
        ...FILES,
        "groups/json/core_scenarios_accuracy.json": {
          header: [{ value: "Model" }, { value: "Something Unrelated" }],
          rows: [],
        },
      },
      { "release.txt": "v1.15.0" },
    );
    expect(() => adapt(noColumns as never)).toThrow(/metric columns/);
  });
});
