// Compute-on-read: merge an observation's stored metrics with its benchmark's derived metrics into
// one flat object. The consumer can't tell stored from derived — that split lives only in
// sample_schema (spec §4). The evaluation context is WIDENED (§10) beyond the observation's own
// created_at to include its run's timing, so relative-time metrics (elapsed_ms = created_at −
// run.started_at) are a declared JSON Logic expression, not a chart hack.
import type { SampleSchema } from "../types";
import { applyRule } from "./evaluator";

/** The widened data context a derived expression may reference via `var`. */
export interface DerivedContext {
  created_at: number;
  run: {
    started_at: number | null;
    ended_at: number | null;
  };
}

function parseStored(metricsJson: string | null): Record<string, unknown> {
  if (metricsJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(metricsJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // stored metrics are written by us as a JSON object; anything else is treated as empty.
  }
  return {};
}

/**
 * Merge stored + derived. Derived values (schema-controlled) win on name collision. A per-row
 * expression error, or a non-finite result, omits that one field rather than failing the read
 * (never a 5xx — ADR-014). Returns null when nothing is emitted, so the serializer omits `metrics`.
 */
export function computeMetrics(
  metricsJson: string | null,
  schema: SampleSchema,
  ctx: DerivedContext,
): Record<string, unknown> | null {
  const data = {
    created_at: ctx.created_at,
    run: { started_at: ctx.run.started_at, ended_at: ctx.run.ended_at },
  };
  const merged: Record<string, unknown> = { ...parseStored(metricsJson) };
  for (const d of schema.derived) {
    try {
      const value = applyRule(d.expr, data);
      if (typeof value === "number" && Number.isFinite(value)) {
        merged[d.name] = value;
      }
    } catch {
      // omit this derived field
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}
