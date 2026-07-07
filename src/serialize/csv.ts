// Serialize measurement resources to CSV (§9 / ADR-014 content negotiation). Columns: id, created_at,
// run, target, then one column per metric name (union across the page, sorted), then meta (a JSON
// cell). RFC-4180 quoting; rows separated by CRLF. Empty input yields a header-only document.
import type { ResourceObject } from "../http/jsonapi";

const FIXED_LEADING = ["id", "created_at", "run", "target"];

function quote(cell: string): string {
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

function metricsOf(r: ResourceObject): Record<string, unknown> {
  const m = r.attributes.metrics;
  return m !== null && typeof m === "object" && !Array.isArray(m)
    ? (m as Record<string, unknown>)
    : {};
}

function cellFor(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Serialize leaderboard rows to CSV: key, name, one column per declared metric (in schema order),
 * then one column per details key (union across rows, sorted). details/metrics arrive as JSON text.
 */
export function leaderboardToCsv(
  rows: { key: string; name: string; details: string | null; metrics: string | null }[],
  metricNames: string[],
): string {
  const parse = (s: string | null): Record<string, unknown> => {
    if (!s) return {};
    try {
      const o = JSON.parse(s);
      return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const parsed = rows.map((r) => ({
    key: r.key,
    name: r.name,
    metrics: parse(r.metrics),
    details: parse(r.details),
  }));
  const detailKeys = new Set<string>();
  for (const r of parsed) for (const k of Object.keys(r.details)) detailKeys.add(k);
  const sortedDetails = [...detailKeys].sort();
  const header = ["key", "name", ...metricNames, ...sortedDetails];

  const lines = [header.map(quote).join(",")];
  for (const r of parsed) {
    const row = [
      r.key,
      r.name,
      ...metricNames.map((m) => cellFor(r.metrics[m])),
      ...sortedDetails.map((d) => cellFor(r.details[d])),
    ];
    lines.push(row.map(quote).join(","));
  }
  return lines.join("\r\n");
}

export function measurementsToCsv(resources: ResourceObject[]): string {
  const metricKeys = new Set<string>();
  for (const r of resources) {
    for (const k of Object.keys(metricsOf(r))) metricKeys.add(k);
  }
  const sortedMetricKeys = [...metricKeys].sort();
  const header = [...FIXED_LEADING, ...sortedMetricKeys, "meta"];

  const lines = [header.map(quote).join(",")];
  for (const r of resources) {
    const metrics = metricsOf(r);
    const row = [
      r.id,
      cellFor(r.attributes.created_at),
      cellFor(r.attributes.run),
      cellFor(r.attributes.target),
      ...sortedMetricKeys.map((k) => cellFor(metrics[k])),
      cellFor(r.attributes.meta),
    ];
    lines.push(row.map(quote).join(","));
  }
  return lines.join("\r\n");
}
