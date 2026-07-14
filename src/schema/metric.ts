// Validate a client-supplied metric (create/update only — never a hot path). A metric has a snake_case
// `name` (unique per account, the key it occupies in a measurement's metrics bag — normalized from the
// label when omitted), a display `label`, an optional `description`, a semantic `type`, and a `kind`:
// STORED (a value clients POST) or DERIVED (computed on read). DERIVED metrics carry a structured
// `formula` from a small, closed OOTB set; `metricExprToJsonLogic` turns it into the JSON Logic
// expression the compute-on-read engine (src/logic) evaluates. New formulas are added here, not by
// clients (ADR-022: keep the built-in set small and closed).
import { BadRequestError } from "../errors";
import {
  METRIC_FORMULA_OPS,
  METRIC_KINDS,
  METRIC_TYPES,
  type DerivedDecl,
  type MetricDecl,
  type MetricFormula,
  type MetricFormulaOp,
  type MetricKind,
  type MetricRow,
  type MetricType,
} from "../types";

const MAX_DESCRIPTION = 500;

/** Snake_case a label/name into a metric identifier: lowercase, runs of non-alphanumerics → single
 *  underscore. Metric names are JSON keys in a measurement's metrics bag, so they use `[a-z0-9_]` only. */
export function metricNameSlug(input: string): string {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0) throw new BadRequestError(`${field} must be a non-empty string.`);
  return v;
}
function isMetricType(v: unknown): v is MetricType { return typeof v === "string" && (METRIC_TYPES as readonly string[]).includes(v); }
function isMetricKind(v: unknown): v is MetricKind { return typeof v === "string" && (METRIC_KINDS as readonly string[]).includes(v); }
function isFormulaOp(v: unknown): v is MetricFormulaOp { return typeof v === "string" && (METRIC_FORMULA_OPS as readonly string[]).includes(v); }

export interface ParsedMetric {
  name: string;
  label: string;
  description: string | null;
  type: MetricType;
  kind: MetricKind;
  formula: MetricFormula | null;
}

/** Validate + normalize a client-supplied metric. `name` is the given name (or the label) slugified. */
export function parseMetric(attrs: Record<string, unknown>): ParsedMetric {
  const label = nonEmptyString(attrs.label, "label");
  const source = typeof attrs.name === "string" && attrs.name.trim().length > 0 ? attrs.name : label;
  const name = metricNameSlug(source);
  if (!name) throw new BadRequestError("name must contain at least one letter or number.");
  if (!isMetricType(attrs.type)) throw new BadRequestError(`type must be one of: ${METRIC_TYPES.join(", ")}.`);
  const kind: MetricKind = isMetricKind(attrs.kind) ? attrs.kind : "STORED";

  let description: string | null = null;
  if (attrs.description !== undefined && attrs.description !== null) {
    if (typeof attrs.description !== "string") throw new BadRequestError("description must be a string.");
    const d = attrs.description.trim();
    if (d.length > MAX_DESCRIPTION) throw new BadRequestError(`description must be at most ${MAX_DESCRIPTION} characters.`);
    description = d || null;
  }

  const formula = kind === "DERIVED" ? parseFormula(attrs.formula) : null;
  return { name, label, description, type: attrs.type, kind, formula };
}

function parseFormula(input: unknown): MetricFormula {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("formula must be an object for a DERIVED metric.");
  }
  const f = input as Record<string, unknown>;
  if (!isFormulaOp(f.op)) throw new BadRequestError(`formula.op must be one of: ${METRIC_FORMULA_OPS.join(", ")}.`);
  if (f.op === "SKEW_MS") return { op: "SKEW_MS" };
  const a = metricNameSlug(nonEmptyString(f.a, "formula.a"));
  const b = metricNameSlug(nonEmptyString(f.b, "formula.b"));
  if (!a || !b) throw new BadRequestError("formula.a and formula.b must reference metric names.");
  return { op: f.op, a, b };
}

/** Turn a structured formula into the JSON Logic expression the compute-on-read engine evaluates.
 *  Operands reference other metrics as `{ "var": "metrics.<name>" }`; SKEW_MS uses `created_at`. */
export function metricExprToJsonLogic(formula: MetricFormula): unknown {
  const m = (n: string | undefined) => ({ var: "metrics." + (n ?? "") });
  switch (formula.op) {
    case "SKEW_MS": return { minute_offset_ms: [{ var: "created_at" }] };
    case "SUM": return { "+": [m(formula.a), m(formula.b)] };
    case "DIFFERENCE": return { "-": [m(formula.a), m(formula.b)] };
    case "RATIO": return { "/": [m(formula.a), m(formula.b)] };
    case "PERCENT": return { "*": [100, { "/": [m(formula.a), m(formula.b)] }] };
  }
}

/** Parse a stored `formula` JSON string back into MetricFormula (tolerant of NULL/garbage → null). */
export function parseStoredFormula(formula: string | null): MetricFormula | null {
  if (!formula) return null;
  try {
    const p = JSON.parse(formula);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as MetricFormula) : null;
  } catch {
    return null;
  }
}

/**
 * Snapshot a library metric into a measurement_schema entry (the copy taken when it's linked to a
 * benchmark). A STORED metric becomes a `MetricDecl` in `metrics[]`; a DERIVED metric becomes a
 * `DerivedDecl` in `derived[]` whose `expr` is the compiled JSON Logic. The metric's `name` is the
 * schema key (immutable, unique per account); `description` carries over as the cosmetic label. Exactly
 * one of `{ metric, derived }` is returned.
 */
export function metricSnapshot(row: MetricRow): { metric?: MetricDecl; derived?: DerivedDecl } {
  const description = row.description ?? undefined;
  if (row.kind === "DERIVED") {
    const formula = parseStoredFormula(row.formula);
    const derived: DerivedDecl = {
      name: row.name,
      expr: formula ? metricExprToJsonLogic(formula) : null,
    };
    if (description) derived.description = description;
    return { derived };
  }
  const metric: MetricDecl = { name: row.name, type: row.type };
  if (description) metric.description = description;
  return { metric };
}
