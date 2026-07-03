// Serialize observation resources to CSV (§9 / ADR-014 content negotiation). Columns: id, created_at,
// run, then one column per metric name (union across the page, sorted), then meta (a JSON cell).
// RFC-4180 quoting; rows separated by CRLF. Empty input yields a header-only document.
import type { ResourceObject } from "../http/jsonapi";

const FIXED_LEADING = ["id", "created_at", "run"];

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

export function observationsToCsv(resources: ResourceObject[]): string {
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
      ...sortedMetricKeys.map((k) => cellFor(metrics[k])),
      cellFor(r.attributes.meta),
    ];
    lines.push(row.map(quote).join(","));
  }
  return lines.join("\r\n");
}
