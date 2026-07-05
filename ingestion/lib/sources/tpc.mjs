// @ts-check
// TPC (Transaction Processing Performance Council, www.tpc.org) — republished under the TPC Fair
// Use Policy (TPC Policies §8.2), which affirmatively encourages non-profit republication of
// published results with attribution, a retrieval date, and a link to each result's TPC page.
// smplmark.org is permanently non-commercial. Only the robots-ALLOWED /downloaded_result_files/
// bulk exports are fetched; the /cgi-bin/ and /dtSearch/ interactive tools are never touched.
// See ingestion/SOURCES.md.
//
// Each active benchmark family (TPC-C, TPC-E, TPC-DS, TPC-H) publishes one flat export listing
// every result. We prefer the tab-delimited `.xlsx` variant (honestly plain tab-separated text
// despite the extension) because the comma `.txt` variant carries UNescaped commas inside text
// fields (database/OS names) that would corrupt a naive split. TPC-H is the exception — its
// `.xlsx` URL is served as an HTML page by tpc.org — so it falls back to the `.txt` variant with
// an embedded-comma guard (rows whose field count exceeds the header are skipped, never
// mis-parsed).
import { epochMsOrNull, uniqueSlug } from "../model.mjs";

/** @type {import("../model.mjs").SourceMeta} */
export const meta = {
  key: "tpc",
  name: "TPC (Transaction Processing Performance Council)",
  description:
    "Audited transaction-processing and decision-support results: OLTP throughput (TPC-C, TPC-E) and query throughput (TPC-H, TPC-DS) for priced, availability-dated system configurations.",
  url: "https://www.tpc.org",
  license: "TPC Fair Use Policy",
  licenseUrl: "https://www.tpc.org/TPC_Documents_Current_Versions/pdf/Policies_v6.19.pdf",
  robotsOrigin: "https://www.tpc.org",
};

const DL = "https://www.tpc.org/downloaded_result_files";

/**
 * @typedef {Object} MetricSpec
 * @property {string} col header column name to read
 * @property {string} name observation_schema metric name
 * @property {string} [unit]
 * @property {string} description
 *
 * @typedef {Object} Family
 * @property {string} bench benchmark key (also the archive file's logical name)
 * @property {string} file archive file name
 * @property {string} url source URL fetched
 * @property {"\t"|","} delimiter
 * @property {string} name benchmark display name
 * @property {string} tagline one-line description
 * @property {string} about factual citation
 * @property {string[]} tags
 * @property {MetricSpec} perf the headline throughput metric (higher is better)
 * @property {MetricSpec} price the price/performance metric (lower is better)
 * @property {string | null} scaleCol "Scale Factor" header column, or null for un-scaled families
 */

/** @type {Family[]} */
export const FAMILIES = [
  {
    bench: "tpc-c",
    file: "tpcc_results.xlsx",
    url: `${DL}/tpcc_results.xlsx`,
    delimiter: "\t",
    name: "TPC-C — OLTP throughput",
    tagline: "Audited on-line transaction-processing throughput for priced system configurations.",
    about:
      "Published TPC-C results from the Transaction Processing Performance Council (www.tpc.org). TPC-C is an on-line transaction-processing (OLTP) benchmark; each result reports the maximum qualified throughput in New-Order transactions per minute (tpmC) for a priced, availability-dated system, audited under the TPC-C standard. Throughput and price/performance are as published by the TPC. Each result links to its TPC result page. Rows are marked active, historical (past their active period), or recently withdrawn in their details.",
    tags: ["tpc", "oltp", "databases", "transaction-processing"],
    perf: {
      col: "tpmC",
      name: "tpmc",
      unit: "tpmC",
      description:
        "Maximum qualified throughput in New-Order transactions executed per minute (tpmC), as published by the TPC. Higher is better.",
    },
    price: {
      col: "Price/Perf",
      name: "price_per_tpmc",
      description:
        "Total priced system cost divided by throughput, in the result's stated currency per tpmC (see currency in the result details). Lower is better. Not comparable across different currencies.",
    },
    scaleCol: null,
  },
  {
    bench: "tpc-e",
    file: "tpce_results.xlsx",
    url: `${DL}/tpce_results.xlsx`,
    delimiter: "\t",
    name: "TPC-E — OLTP throughput",
    tagline: "Audited brokerage-house OLTP throughput for priced system configurations.",
    about:
      "Published TPC-E results from the Transaction Processing Performance Council (www.tpc.org). TPC-E is an on-line transaction-processing (OLTP) benchmark modeling a brokerage firm; each result reports throughput in transactions per second (tpsE) for a priced, availability-dated system, audited under the TPC-E standard. Throughput and price/performance are as published by the TPC. Each result links to its TPC result page. Rows are marked active, historical, or recently withdrawn in their details.",
    tags: ["tpc", "oltp", "databases", "transaction-processing"],
    perf: {
      col: "TpsE",
      name: "tpse",
      unit: "tpsE",
      description:
        "Throughput in transactions per second (tpsE), as published by the TPC. Higher is better.",
    },
    price: {
      col: "Price/Perf",
      name: "price_per_tpse",
      description:
        "Total priced system cost divided by throughput, in the result's stated currency per tpsE (see currency in the result details). Lower is better. Not comparable across different currencies.",
    },
    scaleCol: null,
  },
  {
    bench: "tpc-h",
    file: "tpch_results_v3.txt",
    url: `${DL}/tpch_results_v3.txt`,
    delimiter: ",",
    name: "TPC-H — decision support",
    tagline: "Audited ad-hoc decision-support query throughput at a stated data scale factor.",
    about:
      "Published TPC-H results (Revision 3) from the Transaction Processing Performance Council (www.tpc.org). TPC-H is an ad-hoc decision-support benchmark; each result reports the composite query-per-hour throughput at a stated scale factor (QphH@Size) for a priced, availability-dated system, audited under the TPC-H standard. Throughput and price/performance are as published by the TPC. Each result links to its TPC result page. Results at different scale factors are not directly comparable; the scale factor is a column on each result.",
    tags: ["tpc", "olap", "decision-support", "databases", "sql"],
    perf: {
      col: "QphH",
      name: "qphh",
      unit: "QphH",
      description:
        "Composite query-per-hour throughput at the stated scale factor (QphH@Size), as published by the TPC. Higher is better; comparable only among results at the same scale factor.",
    },
    price: {
      col: "Price Perf",
      name: "price_per_qphh",
      description:
        "Total priced system cost divided by throughput, in the result's stated currency per QphH (see currency in the result details). Lower is better. Not comparable across different currencies.",
    },
    scaleCol: "Scale Factor",
  },
  {
    bench: "tpc-ds",
    file: "tpcds_results_v3.xlsx",
    url: `${DL}/tpcds_results_v3.xlsx`,
    delimiter: "\t",
    name: "TPC-DS — decision support",
    tagline: "Audited decision-support query throughput at a stated data scale factor.",
    about:
      "Published TPC-DS results (Revision 3) from the Transaction Processing Performance Council (www.tpc.org). TPC-DS is a decision-support benchmark over a retail schema; each result reports the composite query-per-hour throughput at a stated scale factor (QphDS@Size) for a priced, availability-dated system, audited under the TPC-DS standard. Throughput and price/performance are as published by the TPC. Each result links to its TPC result page. Results at different scale factors are not directly comparable; the scale factor is a column on each result.",
    tags: ["tpc", "olap", "decision-support", "databases", "sql"],
    perf: {
      col: "QphDS",
      name: "qphds",
      unit: "QphDS",
      description:
        "Composite query-per-hour throughput at the stated scale factor (QphDS@Size), as published by the TPC. Higher is better; comparable only among results at the same scale factor.",
    },
    price: {
      col: "Price Perf",
      name: "price_per_qphds",
      description:
        "Total priced system cost divided by throughput, in the result's stated currency per QphDS (see currency in the result details). Lower is better. Not comparable across different currencies.",
    },
    scaleCol: "Scale Factor",
  },
];

/** Robots preflight: every bulk file this source fetches. */
export const robotsPaths = FAMILIES.map((f) => `/downloaded_result_files/${f.file}`);

/** `--full`: lift the per-family default cap (keep every published result, not the top slice). */
export const fullOptions = /** @type {{ topResults: number }} */ ({
  topResults: Number.POSITIVE_INFINITY,
});

/**
 * Stage A: one bulk export per family (~4 requests, &lt; 1 MB total). Tab `.xlsx` variants for
 * C/E/DS, comma `.txt` for H (its xlsx is served as HTML by tpc.org).
 * @param {{ fetchText: (url: string) => Promise<string>, writeText: (name: string, text: string) => Promise<void> }} ctx
 */
export async function pull(ctx) {
  for (const fam of FAMILIES) {
    const text = await ctx.fetchText(fam.url);
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error(`tpc: ${fam.url} returned HTML, not a result export — the file may have moved`);
    }
    await ctx.writeText(fam.file, text);
  }
}

const SCALE_GB_METRIC = {
  name: "scale_factor_gb",
  unit: "GB",
  description: "The benchmark scale factor (raw data size) in GB for this result.",
};

/**
 * Numeric parse tolerant of thousands commas, padding, and blanks. Returns null on non-numeric.
 * @param {string | undefined} raw
 */
function toNum(raw) {
  if (raw == null) return null;
  const s = raw.replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** @param {string | undefined} raw */
function clean(raw) {
  return (raw ?? "").trim();
}

/**
 * Split one export into (sectionLabel, header→index map, cells[]) rows. Section labels come from
 * "… Part N: <label>" lines; header rows re-key the columns (positions are stable within a family,
 * but re-reading is harmless). A data row is any line whose first cell is a numeric Result ID.
 *
 * Column count is deliberately NOT used to validate rows: TPC-H's comma export carries a few
 * trailing power columns beyond its own header width, so a width guard would reject every clean
 * row. Integrity against unescaped commas inside text fields is enforced in adapt() via a semantic
 * anchor (the Currency column must read as an ISO 3-letter code), which catches a shifted row
 * without discarding a merely wider one.
 * @param {string} text
 * @param {"\t"|","} delimiter
 * @returns {{ section: string, get: (col: string) => string | undefined }[]}
 */
export function parseExport(text, delimiter) {
  const lines = text.split(/\r?\n/);
  /** @type {{ section: string, get: (col: string) => string | undefined }[]} */
  const rows = [];
  let section = "active";
  /** @type {Map<string, number>} */
  let colIndex = new Map();

  for (const line of lines) {
    if (line.trim() === "") continue;
    const partMatch = /Part\s+\d+:\s*(.+?)\s*$/.exec(line.replace(/\t/g, " "));
    if (partMatch) {
      section = classifySection(partMatch[1]);
      continue;
    }
    const cells = line.split(delimiter);
    const first = clean(cells[0]);
    if (first === "Result ID") {
      colIndex = new Map(cells.map((c, i) => [normalizeHeader(c), i]));
      continue;
    }
    if (!/^\d{4,}$/.test(first)) continue; // not a result row (title lines, notes, blanks)
    const map = colIndex;
    rows.push({
      section,
      get: (col) => {
        const i = map.get(normalizeHeader(col));
        return i === undefined ? undefined : cells[i];
      },
    });
  }
  return rows;
}

/**
 * Normalize a header name for lookup: lowercased, alnum only ("Price/Perf" == "Price Perf").
 * @param {string} raw
 */
function normalizeHeader(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Map a "Part N:" label to a compact lifecycle status kept in each result's details.
 * @param {string} label
 */
function classifySection(label) {
  const l = label.toLowerCase();
  if (l.includes("withdrawn")) return "withdrawn";
  if (l.includes("historical")) return "historical";
  return "active";
}

/**
 * Stage B: one benchmark per TPC family. Target = a published result's system (deduped by
 * company+system with numeric suffixes); one completed run per result; one observation carrying
 * the family's throughput + price/performance (+ scale factor for DS/H).
 * @param {import("../model.mjs").Archive} archive
 * @param {{ topResults?: number }} [options]
 * @returns {import("../model.mjs").IngestBenchmark[]}
 */
export function adapt(archive, options = {}) {
  const topResults = options.topResults ?? 250;
  const retrievedAt = archive.manifest.retrieved_at;
  /** @type {import("../model.mjs").IngestBenchmark[]} */
  const benchmarks = [];

  for (const fam of FAMILIES) {
    let text;
    try {
      text = archive.readText(fam.file);
    } catch {
      continue; // family file absent from this archive — skip it
    }
    const rows = parseExport(text, fam.delimiter);

    /** @type {{ perf: number, target: import("../model.mjs").IngestTarget, earliest: number | null }[]} */
    const parsed = [];
    for (const row of rows) {
      // Currency is a fixed ISO 3-letter code between the numeric block and the free-text columns.
      // If it doesn't read as one, an unescaped comma in Company/System shifted the columns — drop
      // the row rather than trust mis-aligned metric values. Absent column (never emitted) is ok.
      const currency = clean(row.get("Currency"));
      if (currency !== "" && !/^[A-Za-z]{3}$/.test(currency)) continue;
      const perf = toNum(row.get(fam.perf.col));
      if (perf === null) continue; // a result with no headline throughput is unusable
      const shortId = clean(row.get("Short ID"));
      const company = clean(row.get("Company"));
      const system = clean(row.get("System"));
      if (system === "") continue;

      const availability =
        epochMsOrNull(toDate(row.get("Availability Date"))) ??
        epochMsOrNull(toDate(row.get("Date Submitted")));
      const price = toNum(row.get(fam.price.col));
      const scale = fam.scaleCol ? toNum(row.get(fam.scaleCol)) : null;

      /** @type {Record<string, number>} */
      const metrics = { [fam.perf.name]: perf };
      if (price !== null) metrics[fam.price.name] = price;
      if (scale !== null) metrics.scale_factor_gb = scale;

      /** @type {Record<string, unknown>} */
      const obsMeta = { tpc_status: row.section };
      if (shortId !== "") obsMeta.source_url = `https://www.tpc.org/${shortId}`;
      const cost = toNum(row.get("Total Sys. Cost"));
      if (cost !== null) obsMeta.total_system_cost = cost;
      if (currency !== "") obsMeta.currency = currency;

      /** @type {Record<string, unknown>} */
      const details = {};
      if (company !== "") details.sponsor = company;
      const cpu = clean(row.get("Server CPU Type")) || clean(row.get("CPU Type"));
      if (cpu !== "") details.cpu = cpu;
      const db = clean(row.get("Database Software"));
      if (db !== "") details.database = db;
      const os = clean(row.get("Operating System"));
      if (os !== "") details.os = os;
      if (currency !== "") details.currency = currency;

      /** @type {import("../model.mjs").IngestRun} */
      const run = {
        key: shortId !== "" ? `r-${shortId}` : `r-${parsed.length}`,
        name: fam.scaleCol && scale !== null ? `Scale factor ${scale} GB` : system,
        observations: [{ created_at: availability ?? retrievedAt, metrics, meta: obsMeta }],
      };
      if (availability !== null) {
        run.started_at = availability;
        run.ended_at = availability; // a TPC result is a completed, audited measurement
      }

      parsed.push({
        perf,
        earliest: availability,
        target: {
          key: shortId !== "" ? `${slugSafe(company, system)}-${shortId}` : slugSafe(company, system),
          name: company !== "" ? `${system} (${company})` : system,
          details,
          runs: [run],
        },
      });
    }
    if (parsed.length === 0) continue;

    // Default curation: keep the highest-throughput slice (the results people look at first); the
    // whole corpus stays in the archive and rides along under --full. Deterministic tie-break.
    parsed.sort((a, z) => z.perf - a.perf || a.target.key.localeCompare(z.target.key));
    const kept = parsed.slice(0, topResults);

    let publishedAt = null;
    for (const p of parsed) {
      if (p.earliest !== null && (publishedAt === null || p.earliest < publishedAt)) {
        publishedAt = p.earliest;
      }
    }

    // Keys are already unique per result (company+system+shortId), but re-run through uniqueSlug so
    // a rare shortId-less collision still can't merge two targets.
    /** @type {Map<string, number>} */
    const seen = new Map();
    benchmarks.push({
      key: fam.bench,
      name: fam.name,
      description: fam.tagline,
      about: fam.about,
      methodology: null,
      published_at: publishedAt ?? undefined,
      category: "DATABASE",
      tags: fam.tags,
      observationSchema: buildSchema(fam),
      targets: kept.map((p) => ({ ...p.target, key: uniqueSlug(p.target.key, seen) })),
    });
  }
  return benchmarks;
}

/**
 * TPC dates are "M/D/YYYY" (sometimes with a trailing time). epochMsOrNull wants ISO-ish input, so
 * normalize "7/18/2025" → "2025-07-18" first; anything unparseable falls through to null.
 * @param {string | undefined} raw
 * @returns {string | null}
 */
function toDate(raw) {
  const s = clean(raw);
  if (s === "") return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** @param {Family} fam */
function buildSchema(fam) {
  const metrics = [
    { name: fam.perf.name, type: "number", unit: fam.perf.unit, description: fam.perf.description },
    { name: fam.price.name, type: "number", description: fam.price.description },
  ];
  if (fam.scaleCol) {
    metrics.push({ name: SCALE_GB_METRIC.name, type: "number", unit: SCALE_GB_METRIC.unit, description: SCALE_GB_METRIC.description });
  }
  return { metrics, derived: [], chart: { x: null, y: fam.perf.name, x_kind: "CATEGORY" } };
}

/**
 * A short, collision-resistant base for a target key from company + system.
 * @param {string} company
 * @param {string} system
 */
function slugSafe(company, system) {
  const base = `${company} ${system}`.trim();
  return base === "" ? "result" : base;
}
