# Ingestion sources — due-diligence matrix

The paper trail for every third-party source smplmark ingests. Two hard principles:

1. **The raw files are the source of truth; D1 is a rebuildable projection.** Stage A (`pull.mjs`)
   downloads each source's data once into `ingestion/archive/<source>/` (gitignored, lives on the
   operator's machine); Stage B (`import.mjs`) builds D1 from the archive, never by re-hitting the
   source.
2. **Only ingest what's explicitly permitted.** A source is ingestable when its license
   affirmatively grants reuse, or when it is published for public consumption with no hint that
   reuse is disallowed. Honor `robots.txt`. Attribute prominently (the frozen `INGESTED`
   attribution snapshot: source name, URL, license, retrieval date). Fast removal path: a re-run of
   the importer with a source removed deletes every trace of it; source-removal requests go to
   support@smplmark.org.

**Re-verify before every pull:** licenses and robots.txt change. `pull.mjs` re-fetches robots.txt
and refuses paths that have become disallowed; re-check the license statements below (URLs given)
before a re-pull, and update this file with a new "verified" date.

**Trademark note:** results are ingested as *facts with attribution*. Never brand a section with a
source's trademark in a way that implies endorsement. Cite as
"Source: &lt;name&gt; (&lt;license&gt;), retrieved &lt;date&gt;."

---

## Tier-1 (approved, in the importer)

### Blender Open Data — `blender`

| | |
|---|---|
| What | Community-submitted Blender Cycles render benchmark results (opendata.blender.org) |
| License | **CC0 1.0** (public-domain dedication). Stated at https://opendata.blender.org/download/ ("The data in this archive is licensed under the CC0 - Creative Commons Zero license") and as `LICENSE.txt` inside the snapshot archive. Attribution not legally required; we give it anyway. |
| robots.txt | `User-agent: * / Disallow: /snapshots/` — the full-dump directory is disallowed; everything else (incl. the aggregated query API) is allowed. **We pull only the robots-allowed `/benchmarks/query/` endpoint**, which also happens to be exactly the aggregated granularity we ingest. The 1.8 GB raw dump is never touched. |
| Pull | `GET /benchmarks/query/suggest/?column=blender_version` (version list), then `GET /benchmarks/query/?blender_version=<v>&compute_type=<CPU\|CUDA\|OPTIX\|HIP\|METAL\|ONEAPI>&group_by=device_name&response_type=datatables` per (version, compute type). ~60 requests, &lt; 2 MB. |
| Mapping | Two benchmarks mirroring the site's headline split: `blender-cpu` and `blender-gpu` (category `HARDWARE`; tags `rendering`, `blender`, `cycles`, + `cpu`/`gpu`). Target = device; run = version slice (`v5.1.1`, GPU also per API `v5.1.1-optix`); observation metrics `median_score` (samples/min, higher is better) + `sample_count`. Scalar → CATEGORY chart on `median_score`. |
| Default import cap | Latest Blender version only; top 200 devices per benchmark by `sample_count` (full matrix in the archive). |
| Verified | 2026-07-04 |

### Stanford HELM (Capabilities) — `helm`

| | |
|---|---|
| What | HELM Capabilities leaderboard — aggregated LLM eval scores (crfm.stanford.edu/helm) |
| License | Code Apache-2.0. **Results data: publicly released, no standalone license.** The docs affirmatively sanction bulk download ("All of HELM's raw result data is stored … in the public crfm-helm-public bucket", https://crfm-helm.readthedocs.io/en/latest/downloading_raw_results/) and the Maintenance Mode Policy (https://crfm-helm.readthedocs.io/en/latest/maintenance_mode/, effective 2026-06-01) states "You are welcome to use the HELM software or data for your own research" and calls the leaderboards "open-source resources for the community". No hint reuse is disallowed; attribution required posture, no claim of Stanford endorsement. |
| robots.txt | None on crfm.stanford.edu (404) or the GCS bucket host. Bulk download explicitly documented. |
| Pull | GCS `crfm-helm-public/capabilities/benchmark_output/releases/v1.15.0/` — the ~30 aggregated release files (schema.json, groups/*.json, runs.json, …; ~460 KB stored, gzip). **Never** the per-instance `runs/<suite>/` tree (hundreds of GB). HELM is in maintenance mode — frozen final dataset, one-time pull. |
| Mapping | One benchmark `helm-capabilities` (category `ML_AI`; tags `llm`, `evaluation`, `helm`). Target = model (meta: creator org, access, release date); run = release (`v1.15.0`); observation metrics: `mean_score`, `mmlu_pro`, `gpqa`, `ifeval`, `wildbench`, `omni_math` (0–1, higher is better). Scalar → CATEGORY chart on `mean_score`. |
| Default import cap | None needed (68 models). |
| Verified | 2026-07-04 |

### HF Open LLM Leaderboard (archived) — `openllm`

| | |
|---|---|
| What | The retired (March 2025) Open LLM Leaderboard v2 final table — 4,576 model evaluations across six benchmarks |
| License | **Unspecified** (dataset card has no license tag → HF renders "unknown"). Published by Hugging Face itself as an open community resource; the official FAQ directs the public to consume this exact dataset ("Contents Dataset: A full dataset that contains information about all evaluated models. It's available here."). Factual benchmark scores; no hint reuse is disallowed → ingest with prominent attribution to "Hugging Face Open LLM Leaderboard" + dataset link. |
| robots.txt | huggingface.co: `User-agent: * / Allow: /`. datasets-server.huggingface.co: none. Permitted. |
| Pull | Aggregated table via the documented datasets-server rows API (`/rows?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train`, 100 rows/page × 46 pages ≈ 4 MB JSON; avoids a parquet-parsing dependency). Dataset frozen at commit `9c09a7cae43334062a82cb164f2ef255013dafa2` (recorded in the manifest) — one-time pull. |
| Mapping | One benchmark `open-llm-leaderboard` (category `ML_AI`; tags `llm`, `evaluation`, `open-weights`, `huggingface`). Target = evaluated model config (`eval_name`; meta: precision, architecture, params, hub license); one run per target dated by `Submission Date`; observation metrics: `average`, `ifeval`, `bbh`, `math_lvl_5`, `gpqa`, `musr`, `mmlu_pro` (normalized 0–100, higher is better). Scalar → CATEGORY chart on `average`. Rows with `Flagged == true` are skipped (mirrors the upstream default view). |
| Default import cap | Top 300 by `average` + every `Official Providers` row (full 4,576 in the archive). |
| Verified | 2026-07-04 |

### OpenML (CC18 + AMLB) — `openml`

| | |
|---|---|
| What | OpenML evaluation results: the OpenML-CC18 curated classification suite (study 99, 72 tasks) and the AutoML Benchmark study 226 |
| License | **CC-BY 4.0** — openml.org/terms: "You are free to use OpenML and all data under the CC-BY license. This means that you can use and reuse it freely if you also give appropriate credit." Attribution: Vanschoren et al., "OpenML: networked science in machine learning", SIGKDD Explorations 15(2), 2013; CC18 additionally Bischl et al., arXiv:1708.03731. |
| robots.txt | `Disallow: /data/` and `/cgi-bin/` — we use only `/api/v1/`, which is allowed. Anonymous read access; throttle ≥ 1 req/s; page cap 1000. |
| Pull | Study 99 task list, then per task the top-1000 `predictive_accuracy` evaluations (`/api/v1/json/evaluation/list/function/predictive_accuracy/task/<id>/sort_order/desc/limit/1000`); plus study 226 evaluations (`predictive_accuracy` + `area_under_roc_curve`). ~75 requests ≈ 25 MB. |
| Mapping | One benchmark per CC18 task (`openml-cc18-<data_name>`, category `ML_AI`; tags `openml`, `cc18`, `classification`) — target = flow (best run per flow after dedupe), one run per target (provenance: run id, upload time), metric `predictive_accuracy`. Plus one benchmark `openml-amlb` for study 226 (target = AutoML framework, run per task). Scalar → CATEGORY charts. |
| Default import cap | 20 most-evaluated CC18 tasks, top 50 flows per task (all 72 tasks in the archive). |
| Verified | 2026-07-04 |

---

## Held — needs an explicit call from Mike before remote publish

### ClickBench — `clickbench`

| | |
|---|---|
| What | Analytical-DBMS benchmark results, 149 systems (github.com/ClickHouse/ClickBench, benchmark.clickhouse.com) |
| License | **CC-BY-NC-SA-4.0** (repo LICENSE file, complete legalcode; GitHub's API mislabels it NOASSERTION). Reuse with attribution is affirmatively permitted, **but only NonCommercial, and derivatives must be ShareAlike**. README explicitly allows scoreboards: "We allow but do not encourage creating scoreboards from this benchmark…". |
| Status | **Adapter built and tested; archive pulled; EXCLUDED from the remote seed by default** (`HELD_SOURCES` in import.mjs). The NC rider is a business/legal judgment: if smplmark is (or becomes) commercial, redistributing this dataset is a genuine license problem, and SA would require the hosted derivative to carry CC-BY-NC-SA-4.0. Mike decides; flipping it on is removing the source key from `HELD_SOURCES`. |
| robots.txt | github.com disallows crawling its HTML UI (`/*/tree/`, `/*/raw/`, `/*/archive/`); raw.githubusercontent.com and codeload.github.com publish no robots.txt. We pull one file from raw.githubusercontent.com (commit-pinned) — permitted. |
| Pull | `data.generated.js` from the `main` branch (the dashboard's own aggregated dataset: latest result per system+machine, 778 entries, 0.95 MB) plus the LICENSE file. Not commit-pinned — resolving a SHA needs api.github.com, whose robots.txt disallows crawling; the manifest's sha256 + retrieved_at pin the archive instead. |
| Mapping | One benchmark `clickbench` (category `DATABASE`; tags `olap`, `sql`, `analytics`). Target = system + machine; run = the dated benchmark execution; observation metrics: `load_time_s`, `data_size_bytes`, `cold_total_s`, `hot_total_s` (sums over the 43 queries; the official "relative" score needs a cross-target baseline and is deliberately not reproduced); meta keeps the 43×3 per-query matrix. Scalar → CATEGORY chart on `hot_total_s`. |
| Verified | 2026-07-04 |

---

## Explicitly OUT (do not ingest)

- **OpenBenchmarking.org** — "all rights reserved", no reuse license, no API, active bot-detection.
  Fails the "no hint it's not okay" test; business decision not to approach them either.
- **Geekbench Browser, SPEC, TPC, UserBenchmark, PassMark** — commercial/standards-body,
  restrictive terms + trademark exposure.
- **LMArena / Chatbot Arena live board** — now commercial; released datasets only if separately
  licensed (revisit per-dataset).
- **Benchmark *dataset* hosts (OGB, PMLB, ImageNet, …)** — test *inputs*, not *results*; don't map
  to the model.
