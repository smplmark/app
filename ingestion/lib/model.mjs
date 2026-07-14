// @ts-check
// The shared shape every source adapter emits, plus tiny pure helpers. Stage B's contract:
// adapt(archive, options) → IngestBenchmark[] — plain data, no I/O, so adapters are unit-testable
// against fixture archives.

/**
 * @typedef {Object} IngestMeasurement a single (run, subject) data point
 * @property {string} run_key the key of the run (occasion) — must be a run of the same benchmark
 * @property {string} subject_key the key of the subject measured — must be a subject of the same benchmark
 * @property {number} created_at epoch-ms (source timestamp, or the archive's retrieved_at)
 * @property {Record<string, number>} metrics numeric measures (keys must match the measurement_schema)
 * @property {Record<string, unknown>} [meta] non-numeric context
 *
 * @typedef {Object} IngestRun a measurement occasion; a benchmark child that spans whatever subjects
 *   have measurements in it (one comparative sweep, or one run per independent result)
 * @property {string} key unique within its benchmark
 * @property {string} [name]
 * @property {Record<string, unknown>} [details]
 * @property {number} [started_at] epoch-ms
 * @property {number} [ended_at] epoch-ms — ingested runs are completed, not live
 *
 * @typedef {Object} IngestSubject
 * @property {string} key benchmark-local handle (measurements reference it); the importer maps it to
 *   an account-scoped, unique-per-account stored key
 * @property {string} name
 * @property {string} [source_external_id] a stable id the SOURCE assigns this subject (a model id, a
 *   system name, …). When two of a source's benchmarks emit the same source_external_id, the importer
 *   treats them as ONE account-owned subject and links it into both (M:N dedup). Omit when the source
 *   has no cross-benchmark identity — the subject then stays scoped to its benchmark.
 * @property {Record<string, unknown>} [details]
 *
 * @typedef {Object} IngestBenchmark benchmark → { subjects, runs } → measurements (each measurement
 *   names one run + one subject, both benchmark children)
 * @property {string} key unique within the owning publisher account
 * @property {string} name
 * @property {string} description one-line tagline
 * @property {string} about
 * @property {string | null} methodology null — sources' methodology is theirs to publish, never paraphrased here
 * @property {"HARDWARE"|"DATABASE"|"ML_AI"|"STORAGE"|"NETWORK"|"OTHER"} category
 * @property {string[]} tags lowercase slugs
 * @property {object} measurementSchema the benchmark's measurement_schema (metrics/derived/chart)
 * @property {number} [published_at] epoch-ms — when the SOURCE published this dataset; omitted
 *   when the archive carries no usable publication date (the importer falls back to retrieved_at)
 * @property {IngestSubject[]} subjects
 * @property {IngestRun[]} runs
 * @property {IngestMeasurement[]} measurements
 *
 * @typedef {Object} SourceMeta
 * @property {string} key archive directory name, e.g. "blender"
 * @property {string} name attribution display name, e.g. "Blender Open Data"
 * @property {{ slug: string, name: string }} publisher the owning account (URL slug +
 *   display name) that this source's benchmarks are published under — one per source, so a
 *   person from the source can claim it later. e.g. { slug: "stanford-helm", name: "Stanford HELM" }
 * @property {string} description what kinds of benchmark results the source publishes (display
 *   copy for the /sources catalog via the external_source table)
 * @property {string} url link back to the source
 * @property {string} license e.g. "CC0-1.0"
 * @property {string} licenseUrl where the license statement lives
 * @property {string} [licenseNote] nuance recorded in SOURCES.md
 * @property {string} robotsOrigin origin whose robots.txt governs the pull
 *
 * @typedef {Object} Archive read-only view of ingestion/archive/<source>/
 * @property {(name: string) => any} readJson
 * @property {(name: string) => string} readText
 * @property {{ retrieved_at: number, files: {name: string, url: string, sha256: string, bytes: number}[] }} manifest
 */

/**
 * URL-safe lowercase slug for subject/run keys derived from free-form source strings.
 * @param {unknown} raw
 * @param {number} [maxLen]
 */
export function slugify(raw, maxLen = 80) {
  const slug = String(raw)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "unnamed";
}

/**
 * Slugify with collision suffixes (`-2`, `-3`, …) so distinct source names never merge into one
 * key. `seen` persists across calls for one keyspace (e.g. one benchmark's subjects).
 * @param {string} raw
 * @param {Map<string, number>} seen
 * @param {number} [maxLen]
 */
export function uniqueSlug(raw, seen, maxLen = 80) {
  const base = slugify(raw, maxLen);
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n + 1}`;
}

// CPU-vendor detection for the client-derived `vendor` facet, matched against a processor/system
// string. Order matters: check the more specific brands before generic words.
const VENDOR_PATTERNS = /** @type {[RegExp, string][]} */ ([
  [/\bamd\b|\bepyc\b|\bryzen\b|\bthreadripper\b/i, "AMD"],
  [/\bintel\b|\bxeon\b|\bpentium\b|\bitanium\b|\bcore\s+(i[3579]|ultra)\b/i, "Intel"],
  [/\bnvidia\b|\bgrace\b/i, "NVIDIA"],
  [/\bibm\b|\bpower\d?\b|\bpowerpc\b/i, "IBM"],
  [/\bapple\b|\bm[1-4]\b/i, "Apple"],
  [/\bampere\b|\baltra\b|\bgraviton\b|\barm\b|\baarch64\b|\bkunpeng\b|\bneoverse\b/i, "Arm"],
  [/\bfujitsu\b|\bsparc\b|\ba64fx\b/i, "Fujitsu"],
  [/\bqualcomm\b|\bsnapdragon\b/i, "Qualcomm"],
]);

/**
 * Best-effort CPU vendor from a processor or system string (e.g. "AMD EPYC 9754" → "AMD"), or null
 * when nothing recognizable matches. Feeds the client-derived `vendor` facet.
 * @param {unknown} text
 * @returns {string | null}
 */
export function vendorFromText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const [re, vendor] of VENDOR_PATTERNS) {
    if (re.test(text)) return vendor;
  }
  return null;
}

/**
 * Parse an ISO-8601 or "YYYY-MM-DD" source date to epoch-ms, or null. Timestamps without an
 * explicit offset (OpenML's "YYYY-MM-DD HH:MM:SS", study creation_date) are read as UTC —
 * Date.parse would read them as machine-local time, making imports machine-dependent.
 * @param {unknown} value
 */
export function epochMsOrNull(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let s = value.trim();
  if (!s.includes("T") && !s.includes(" ")) s = `${s}T00:00:00Z`;
  else {
    s = s.replace(" ", "T");
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
