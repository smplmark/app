// @ts-check
// SPEC (Standard Performance Evaluation Corporation, www.spec.org) — republished under the SPEC
// Fair Use Rules (www.spec.org/products/fairuse/), which permit republishing COMPLIANT results with
// attribution; the copyright notice restricts only for-profit distribution, which a permanently
// non-commercial aggregator clears. Conditions honored: only the published (compliant) results are
// ingested, each carries its retrieval date and a link back to its spec.org result page, and the
// SPEC trademark is surfaced via the source attribution. See ingestion/SOURCES.md.
//
// Each result-listing page is one big HTML table with the headline score inline (no per-result
// crawl needed): the four CPU2017 metric pages, SPECjbb2015, and SPEChpc2021. spec.org publishes a
// site-wide `Crawl-delay: 10`; the pull spaces its requests accordingly. Robots-disallowed paths
// (/cgi-bin/ etc.) are never touched — these static result pages are allowed.
import { epochMsOrNull, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "spec",
  name: "SPEC (Standard Performance Evaluation Corporation)",
  description:
    "Audited, compliant performance results: SPEC CPU 2017 (integer & floating-point, rate & speed), SPECjbb 2015 (Java), and SPEC HPC 2021.",
  url: "https://www.spec.org",
  license: "SPEC Fair Use Rules",
  licenseUrl: "https://www.spec.org/products/fairuse/",
  robotsOrigin: "https://www.spec.org",
};

const ROOT = "https://www.spec.org";

/**
 * @typedef {Object} SpecMetric
 * @property {string} cls the result cell's CSS class (e.g. "basemean")
 * @property {string} name observation_schema metric name
 * @property {string} [unit]
 * @property {string} description
 *
 * @typedef {Object} Suite
 * @property {string} key benchmark key
 * @property {string} suiteDir spec.org sub-site + the result-file name prefix (e.g. "cpu2017")
 * @property {string} file archive file name
 * @property {string} path page path under ROOT
 * @property {string} name benchmark display name
 * @property {string} tagline
 * @property {string} about factual citation
 * @property {string[]} tags
 * @property {string} sponsorCls test-sponsor cell class
 * @property {string} systemCls system-name cell class (holds the disclosure links)
 * @property {SpecMetric[]} metrics first entry is the headline (chart) metric; all higher-is-better
 * @property {Record<string, string>} [details] extra display columns: detailKey → cell class
 */

const RATE_BASE = {
  cls: "basemean",
  name: "base_score",
  description:
    "The SPEC base metric — the guaranteed-conformant result run under conservative build flags, as published by SPEC. Higher is better.",
};
const RATE_PEAK = {
  cls: "peakmean",
  name: "peak_score",
  description:
    "The SPEC peak metric — the optionally more aggressively tuned result, as published by SPEC. Higher is better. Absent for results that reported base only.",
};

/** @type {Suite[]} */
export const SUITES = [
  {
    key: "spec-cpu2017-intrate",
    suiteDir: "cpu2017",
    file: "rint2017.html",
    path: "/cpu2017/results/rint2017.html",
    name: "SPEC CPU 2017 — Integer Rate (SPECrate)",
    tagline: "Audited integer-throughput results for priced, availability-dated systems.",
    about:
      "Published SPECrate 2017 Integer results from the Standard Performance Evaluation Corporation (www.spec.org). SPECrate measures integer compute throughput — how much work a system completes by running many copies of the workload at once. Each result is an audited, compliant run for a specific system; the base and (where reported) peak scores are as published by SPEC. Each result links to its SPEC result page. SPEC® and SPECrate® are trademarks of the Standard Performance Evaluation Corporation.",
    tags: ["spec", "cpu", "integer", "throughput"],
    sponsorCls: "test_sponsor",
    systemCls: "hw_model",
    metrics: [RATE_BASE, RATE_PEAK],
    details: { copies: "base_copies", cores: "hw_ncores", chips: "hw_nchips", threads_per_core: "hw_nthreadspercore" },
  },
  {
    key: "spec-cpu2017-fprate",
    suiteDir: "cpu2017",
    file: "rfp2017.html",
    path: "/cpu2017/results/rfp2017.html",
    name: "SPEC CPU 2017 — Floating-Point Rate (SPECrate)",
    tagline: "Audited floating-point-throughput results for priced, availability-dated systems.",
    about:
      "Published SPECrate 2017 Floating-Point results from the Standard Performance Evaluation Corporation (www.spec.org). SPECrate measures floating-point compute throughput — how much work a system completes by running many copies of the workload at once. Each result is an audited, compliant run for a specific system; the base and (where reported) peak scores are as published by SPEC. Each result links to its SPEC result page. SPEC® and SPECrate® are trademarks of the Standard Performance Evaluation Corporation.",
    tags: ["spec", "cpu", "floating-point", "throughput"],
    sponsorCls: "test_sponsor",
    systemCls: "hw_model",
    metrics: [RATE_BASE, RATE_PEAK],
    details: { copies: "base_copies", cores: "hw_ncores", chips: "hw_nchips", threads_per_core: "hw_nthreadspercore" },
  },
  {
    key: "spec-cpu2017-intspeed",
    suiteDir: "cpu2017",
    file: "cint2017.html",
    path: "/cpu2017/results/cint2017.html",
    name: "SPEC CPU 2017 — Integer Speed (SPECspeed)",
    tagline: "Audited single-workload integer-speed results for priced, availability-dated systems.",
    about:
      "Published SPECspeed 2017 Integer results from the Standard Performance Evaluation Corporation (www.spec.org). SPECspeed measures how fast a system completes a single copy of the integer workload. Each result is an audited, compliant run for a specific system; the base and (where reported) peak scores are as published by SPEC. Each result links to its SPEC result page. SPEC® and SPECspeed® are trademarks of the Standard Performance Evaluation Corporation.",
    tags: ["spec", "cpu", "integer", "speed"],
    sponsorCls: "test_sponsor",
    systemCls: "hw_model",
    metrics: [RATE_BASE, RATE_PEAK],
    details: { cores: "hw_ncores", chips: "hw_nchips", threads_per_core: "hw_nthreadspercore" },
  },
  {
    key: "spec-cpu2017-fpspeed",
    suiteDir: "cpu2017",
    file: "cfp2017.html",
    path: "/cpu2017/results/cfp2017.html",
    name: "SPEC CPU 2017 — Floating-Point Speed (SPECspeed)",
    tagline: "Audited single-workload floating-point-speed results for priced, availability-dated systems.",
    about:
      "Published SPECspeed 2017 Floating-Point results from the Standard Performance Evaluation Corporation (www.spec.org). SPECspeed measures how fast a system completes a single copy of the floating-point workload. Each result is an audited, compliant run for a specific system; the base and (where reported) peak scores are as published by SPEC. Each result links to its SPEC result page. SPEC® and SPECspeed® are trademarks of the Standard Performance Evaluation Corporation.",
    tags: ["spec", "cpu", "floating-point", "speed"],
    sponsorCls: "test_sponsor",
    systemCls: "hw_model",
    metrics: [RATE_BASE, RATE_PEAK],
    details: { cores: "hw_ncores", chips: "hw_nchips", threads_per_core: "hw_nthreadspercore" },
  },
  {
    key: "spec-jbb2015",
    suiteDir: "jbb2015",
    file: "jbb2015.html",
    path: "/jbb2015/results/jbb2015.html",
    name: "SPECjbb 2015 — Java business throughput",
    tagline: "Audited Java server throughput (max-jOPS and critical-jOPS) for tested systems.",
    about:
      "Published SPECjbb 2015 results from the Standard Performance Evaluation Corporation (www.spec.org). SPECjbb2015 measures Java server performance with two metrics: max-jOPS (the peak throughput) and critical-jOPS (throughput under response-time constraints). Each result is a tested, compliant run; scores and the JVM used are as published by SPEC. Each result links to its SPEC result page. SPEC® and SPECjbb® are trademarks of the Standard Performance Evaluation Corporation.",
    tags: ["spec", "java", "server", "throughput"],
    sponsorCls: "test.testedBy",
    systemCls: "product.SUT.hw.system.hw_1.name",
    metrics: [
      {
        cls: "result.metric.max-jOPS",
        name: "max_jops",
        description:
          "SPECjbb2015 max-jOPS: the maximum Java operations per second the system sustained, as published by SPEC. Higher is better.",
      },
      {
        cls: "result.metric.critical-jOPS",
        name: "critical_jops",
        description:
          "SPECjbb2015 critical-jOPS: throughput under a set of response-time (latency) constraints, as published by SPEC. Higher is better.",
      },
    ],
    details: { jvm: "product.SUT.sw.jvm.jvm_1.name", jvm_version: "product.SUT.sw.jvm.jvm_1.version" },
  },
  {
    key: "spec-hpc2021",
    suiteDir: "hpc2021",
    file: "hpc2021.html",
    path: "/hpc2021/results/hpc2021.html",
    name: "SPEC HPC 2021 — high-performance computing",
    tagline: "Audited HPC application-suite results for tested compute systems.",
    about:
      "Published SPEC HPC 2021 results from the Standard Performance Evaluation Corporation (www.spec.org). SPEChpc 2021 measures performance on a suite of real high-performance-computing applications across CPUs and accelerators. Each result is a tested, compliant run for a specific system; the base and (where reported) peak scores are as published by SPEC. Each result links to its SPEC result page. SPEC® and SPEChpc® are trademarks of the Standard Performance Evaluation Corporation.",
    tags: ["spec", "hpc", "scientific-computing"],
    sponsorCls: "test_sponsor",
    systemCls: "system_name",
    metrics: [RATE_BASE, RATE_PEAK],
    details: { nodes: "node_compute_count", ranks: "max_ranks", threads: "base_threads" },
  },
];

/** Robots preflight: every result page this source fetches. */
export const robotsPaths = SUITES.map((s) => s.path);

// spec.org publishes Crawl-delay: 10. The shared pull spacing is only 600 ms, so add the balance.
const CRAWL_DELAY_MS = 10_000;
const setTimeoutFn = /** @type {(cb: (...a: unknown[]) => void, ms: number) => unknown} */ (
  /** @type {any} */ (globalThis).setTimeout
);
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => void setTimeoutFn(r, ms));

// Platform cap is 5,000 targets/benchmark (src/limits.ts). CPU2017 lists ~11.8k results per metric,
// so even --full keeps only the top 5,000 by base score; the default keeps a browsable 500.
const PLATFORM_TARGET_CAP = 5000;

/** `--full`: raise the per-benchmark cap to the platform maximum. */
export const fullOptions = /** @type {{ topResults: number }} */ ({ topResults: PLATFORM_TARGET_CAP });

/**
 * Stage A: one HTML result page per benchmark (6 requests; CPU2017 pages are ~10 MB each). Spaced
 * by the site's Crawl-delay.
 * @param {{ fetchText: (url: string) => Promise<string>, writeText: (name: string, text: string) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  let first = true;
  for (const suite of SUITES) {
    if (!first) await sleep(CRAWL_DELAY_MS);
    first = false;
    const html = await ctx.fetchText(`${ROOT}${suite.path}`);
    if (!/<table/i.test(html)) {
      throw new Error(`spec: ${suite.path} has no result table — the page may have moved`);
    }
    await ctx.writeText(suite.file, html);
  }
}

/**
 * Decode the handful of HTML entities SPEC's tables use, strip tags, collapse whitespace.
 * @param {string | null | undefined} inner
 */
function textOf(inner) {
  if (inner == null) return "";
  // System-name cells carry the value before a <br> / the disclosures <span>; cut at the first tag.
  const head = inner.split(/<br|<span/i)[0];
  return head
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A numeric cell value, or null. SPEC writes "--" for an absent (e.g. peak-not-run) score.
 * @param {string} inner
 */
function numOf(inner) {
  const t = textOf(inner).replace(/,/g, "");
  if (t === "" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Regex-escape a CSS class string (jbb2015's classes carry dots and hyphens).
 * @param {string} s
 */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Read one `<td class="cls">…</td>` cell's inner HTML from a row, or "" when absent.
 * @param {string} row
 * @param {string} cls
 */
function cell(row, cls) {
  const m = new RegExp(`<td[^>]*class="${esc(cls)}"[^>]*>([\\s\\S]*?)</td>`, "i").exec(row);
  return m ? m[1] : "";
}

/**
 * Parse one SPEC result page into rows (pure — the adapter is unit-tested against fixtures).
 * A data row is any `<tr>` carrying a `<suiteDir>-YYYYMMDD-NNN` result link.
 * @param {string} html
 * @param {Suite} suite
 * @returns {{ resultBase: string, quarter: string, date: string, sponsor: string, system: string, cells: (cls: string) => string }[]}
 */
export function parseSuite(html, suite) {
  const linkRe = new RegExp(`res(\\d{4}q\\d)/(${esc(suite.suiteDir)}-(\\d{8})-\\d+)\\.`, "i");
  const rows = [];
  for (const chunk of html.split(/<tr[ >]/i).slice(1)) {
    const row = chunk.slice(0, chunk.search(/<\/tr>/i) >= 0 ? chunk.search(/<\/tr>/i) : undefined);
    const link = linkRe.exec(row);
    if (!link) continue; // header-repeat rows and layout rows carry no result link
    const [, quarter, resultBase, ymd] = link;
    rows.push({
      resultBase,
      quarter,
      date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      sponsor: textOf(cell(row, suite.sponsorCls)),
      system: textOf(cell(row, suite.systemCls)),
      cells: (/** @type {string} */ cls) => cell(row, cls),
    });
  }
  return rows;
}

/**
 * Stage B: one benchmark per SPEC result page. Target = a tested system (deduped by
 * sponsor + system + result id); one completed, audited run per result; observation metrics are
 * the suite's headline score(s).
 * @param {import("../model.mjs").Archive} archive
 * @param {{ topResults?: number }} [options]
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const topResults = Math.min(options.topResults ?? 500, PLATFORM_TARGET_CAP);
  const retrievedAt = archive.manifest.retrieved_at;
  /** @type {import("../model.mjs").IngestBenchmark[]} */
  const benchmarks = [];

  for (const suite of SUITES) {
    let html;
    try {
      html = archive.readText(suite.file);
    } catch {
      continue; // page absent from this archive — skip the benchmark
    }
    const primary = suite.metrics[0];

    /** @type {{ score: number, earliest: number | null, target: import("../model.mjs").IngestTarget }[]} */
    const parsed = [];
    for (const row of parseSuite(html, suite)) {
      const score = numOf(row.cells(primary.cls));
      if (score === null || row.system === "") continue; // no headline score → unusable

      /** @type {Record<string, number>} */
      const metrics = {};
      for (const m of suite.metrics) {
        const v = numOf(row.cells(m.cls));
        if (v !== null) metrics[m.name] = v;
      }
      const started = epochMsOrNull(row.date);
      const sourceUrl = `${ROOT}/${suite.suiteDir}/results/res${row.quarter}/${row.resultBase}.html`;

      /** @type {Record<string, unknown>} */
      const details = {};
      if (row.sponsor !== "") details.sponsor = row.sponsor;
      for (const [key, cls] of Object.entries(suite.details ?? {})) {
        const t = textOf(row.cells(cls));
        if (t !== "") details[key] = t;
      }

      /** @type {import("../model.mjs").IngestRun} */
      const run = {
        key: `r-${row.resultBase}`,
        name: row.date,
        observations: [{ created_at: started ?? retrievedAt, metrics, meta: { source_url: sourceUrl } }],
      };
      if (started !== null) {
        run.started_at = started;
        run.ended_at = started; // a published SPEC result is a completed, audited measurement
      }

      parsed.push({
        score,
        earliest: started,
        target: {
          key: `${row.sponsor} ${row.system} ${row.resultBase}`,
          name: row.sponsor !== "" ? `${row.system} (${row.sponsor})` : row.system,
          details,
          runs: [run],
        },
      });
    }
    if (parsed.length === 0) continue;

    // Default curation: the highest-scoring slice (also what keeps us under the target cap); the
    // whole page stays in the archive. Deterministic tie-break on the (unique) target key.
    parsed.sort((a, z) => z.score - a.score || a.target.key.localeCompare(z.target.key));
    const kept = parsed.slice(0, topResults);

    let publishedAt = null;
    for (const p of parsed) {
      if (p.earliest !== null && (publishedAt === null || p.earliest < publishedAt)) {
        publishedAt = p.earliest;
      }
    }

    /** @type {Map<string, number>} */
    const seen = new Map();
    benchmarks.push({
      key: suite.key,
      name: suite.name,
      description: suite.tagline,
      about: suite.about,
      methodology: null,
      published_at: publishedAt ?? undefined,
      category: "HARDWARE",
      tags: suite.tags,
      observationSchema: {
        metrics: suite.metrics.map((m) => ({ name: m.name, type: "number", unit: m.unit, description: m.description })),
        derived: [],
        chart: { x: null, y: primary.name, x_kind: "CATEGORY" },
      },
      targets: kept.map((p) => ({ ...p.target, key: uniqueSlug(p.target.key, seen) })),
    });
  }
  return benchmarks;
}
