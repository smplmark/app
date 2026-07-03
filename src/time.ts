// Shared time parsing so the ingest path and the read-side date grammar agree on UTC.

/** Largest |epoch-ms| the ECMAScript Date can represent; larger values make toISOString() throw. */
export const MAX_EPOCH_MS = 8_640_000_000_000_000;

const TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an ISO-8601 datetime to epoch-ms, treating a timezone-less datetime as UTC (matching the
 * smplkit range grammar / filters.py). Returns NaN if the string is unparseable.
 */
export function isoToEpochMs(value: string): number {
  let s = value.replace(" ", "T");
  if (s.includes("T") && !TZ_RE.test(s)) s += "Z";
  return Date.parse(s);
}
