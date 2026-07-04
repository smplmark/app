// @ts-check
// The shared shape every source adapter emits, plus tiny pure helpers. Stage B's contract:
// adapt(archive, options) → IngestBenchmark[] — plain data, no I/O, so adapters are unit-testable
// against fixture archives.

/**
 * @typedef {Object} IngestObservation
 * @property {number} created_at epoch-ms (source timestamp, or the archive's retrieved_at)
 * @property {Record<string, number>} metrics numeric measures (keys must match the sample_schema)
 * @property {Record<string, unknown>} [meta] non-numeric context
 *
 * @typedef {Object} IngestRun
 * @property {string} key unique within its target
 * @property {string} [name]
 * @property {Record<string, unknown>} [details]
 * @property {number} [started_at] epoch-ms
 * @property {number} [ended_at] epoch-ms — ingested runs are completed measurements, not live
 * @property {IngestObservation[]} observations
 *
 * @typedef {Object} IngestTarget
 * @property {string} key unique within its benchmark
 * @property {string} name
 * @property {Record<string, unknown>} [details]
 * @property {IngestRun[]} runs
 *
 * @typedef {Object} IngestBenchmark
 * @property {string} key unique within the system account
 * @property {string} name
 * @property {string} description one-line tagline
 * @property {string} about
 * @property {string | null} methodology null — sources' methodology is theirs to publish, never paraphrased here
 * @property {"HARDWARE"|"DATABASE"|"ML_AI"|"STORAGE"|"NETWORK"|"OTHER"} category
 * @property {string[]} tags lowercase slugs
 * @property {object} sampleSchema the benchmark's sample_schema (metrics/derived/chart)
 * @property {boolean} [closed] true when the source dataset is final (frozen leaderboards) — the
 *   benchmark imports pre-closed, so nothing new can be appended beneath it
 * @property {IngestTarget[]} targets
 *
 * @typedef {Object} SourceMeta
 * @property {string} key archive directory name, e.g. "blender"
 * @property {string} name attribution display name, e.g. "Blender Open Data"
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
 * URL-safe lowercase slug for target/run keys derived from free-form source strings.
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
 * key. `seen` persists across calls for one keyspace (e.g. one benchmark's targets).
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

/**
 * Parse an ISO-8601 or "YYYY-MM-DD" source date to epoch-ms, or null.
 * @param {unknown} value
 */
export function epochMsOrNull(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value.includes("T") || value.includes(" ") ? value : `${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}
