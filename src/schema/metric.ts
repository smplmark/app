// Validate a client-supplied metric (create/update only — never a hot path). A metric has a snake_case
// `name` (unique per account, the key it occupies in a measurement's metrics bag — normalized from the
// label when omitted), a display `label`, an optional `description`, a semantic `type`, and a `kind`:
// STORED (a value clients POST) or DERIVED (computed on read). A DERIVED metric carries a structured
// `formula` — an ordered list of lettered steps (A, B, C…), each a binary operation (`a <op> b`) or a
// unary function (`fn(a)`) over operands that are metrics, literal numbers, `created_at`, or earlier
// steps — plus the `result` step that is the metric's value. `metricExprToJsonLogic` compiles it into
// the JSON Logic expression the compute-on-read engine (src/logic) evaluates (ADR-022).
import { BadRequestError } from "../errors";
import {
  METRIC_KINDS,
  METRIC_STEP_FNS,
  METRIC_STEP_OPS,
  METRIC_TYPES,
  type DerivedDecl,
  type MetricDecl,
  type MetricFormula,
  type MetricKind,
  type MetricStep,
  type MetricStepFn,
  type MetricStepOp,
  type MetricToken,
  type MetricRow,
  type MetricType,
} from "../types";

const MAX_DESCRIPTION = 500;
const MAX_UNIT = 24;
const MAX_FORMAT = 32;
/** An Excel-style number-format pattern uses only these characters: digits placeholders (# and 0), a
 *  grouping comma, a decimal point, and a percent sign. */
const FORMAT_PATTERN = /^[#0.,%]+$/;

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
function isStepOp(v: unknown): v is MetricStepOp { return typeof v === "string" && (METRIC_STEP_OPS as readonly string[]).includes(v); }
function isStepFn(v: unknown): v is MetricStepFn { return typeof v === "string" && (METRIC_STEP_FNS as readonly string[]).includes(v); }

export interface ParsedMetric {
  name: string;
  label: string;
  description: string | null;
  type: MetricType;
  kind: MetricKind;
  unit: string | null;
  format: string | null;
  formula: MetricFormula | null;
}

/** The unit of measure — a short, optional display label. */
function parseUnit(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new BadRequestError("unit must be a string.");
  const u = v.trim();
  if (u.length > MAX_UNIT) throw new BadRequestError(`unit must be at most ${MAX_UNIT} characters.`);
  return u || null;
}

/** An optional Excel-style number-format pattern (`#,##0.00`, `0.0%`); null uses a default per type. */
function parseFormat(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new BadRequestError("format must be a string.");
  const f = v.trim();
  if (!f) return null;
  if (f.length > MAX_FORMAT) throw new BadRequestError(`format must be at most ${MAX_FORMAT} characters.`);
  if (!FORMAT_PATTERN.test(f)) throw new BadRequestError("format may use only the characters # 0 , . and %.");
  if ((f.match(/\./g) || []).length > 1) throw new BadRequestError("format may contain at most one decimal point.");
  return f;
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
  return { name, label, description, type: attrs.type, kind, unit: parseUnit(attrs.unit), format: parseFormat(attrs.format), formula };
}

/** Validate one step operand. A STEP operand may only reference an id in `priorIds` — a step defined
 *  earlier in the list — which forbids forward/self references and therefore any cycle. */
function parseToken(input: unknown, field: string, priorIds: Set<string>): MetricToken {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError(`${field} must be an operand object.`);
  }
  const t = input as Record<string, unknown>;
  switch (t.kind) {
    case "METRIC": {
      const name = metricNameSlug(nonEmptyString(t.name, `${field}.name`));
      if (!name) throw new BadRequestError(`${field}.name must reference a metric.`);
      return { kind: "METRIC", name };
    }
    case "NUMBER": {
      const value = typeof t.value === "number" ? t.value : Number(t.value);
      if (!Number.isFinite(value)) throw new BadRequestError(`${field}.value must be a finite number.`);
      return { kind: "NUMBER", value };
    }
    case "CREATED_AT":
      return { kind: "CREATED_AT" };
    case "STEP": {
      const step = typeof t.step === "string" ? t.step : "";
      if (!priorIds.has(step)) throw new BadRequestError(`${field}.step must reference an earlier step.`);
      return { kind: "STEP", step };
    }
    default:
      throw new BadRequestError(`${field}.kind must be METRIC, NUMBER, CREATED_AT, or STEP.`);
  }
}

function parseFormula(input: unknown): MetricFormula {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("formula must be an object for a DERIVED metric.");
  }
  const f = input as Record<string, unknown>;
  if (!Array.isArray(f.steps) || f.steps.length === 0) {
    throw new BadRequestError("formula.steps must be a non-empty array for a DERIVED metric.");
  }
  const steps: MetricStep[] = [];
  const priorIds = new Set<string>();
  f.steps.forEach((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BadRequestError(`formula.steps[${i}] must be a step object.`);
    }
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : String.fromCharCode(65 + i);
    if (priorIds.has(id)) throw new BadRequestError(`formula.steps[${i}].id "${id}" is duplicated.`);
    if (s.kind === "FN") {
      if (!isStepFn(s.fn)) throw new BadRequestError(`formula.steps[${i}].fn must be one of: ${METRIC_STEP_FNS.join(", ")}.`);
      steps.push({ id, kind: "FN", fn: s.fn, a: parseToken(s.a, `formula.steps[${i}].a`, priorIds) });
    } else if (s.kind === "OP") {
      if (!isStepOp(s.op)) throw new BadRequestError(`formula.steps[${i}].op must be one of: ${METRIC_STEP_OPS.join(", ")}.`);
      const a = parseToken(s.a, `formula.steps[${i}].a`, priorIds);
      const b = parseToken(s.b, `formula.steps[${i}].b`, priorIds);
      steps.push({ id, kind: "OP", op: s.op, a, b });
    } else {
      throw new BadRequestError(`formula.steps[${i}].kind must be OP or FN.`);
    }
    priorIds.add(id);
  });
  let result: string;
  if (f.result === undefined || f.result === null) {
    result = steps[steps.length - 1].id;
  } else if (typeof f.result === "string" && priorIds.has(f.result)) {
    result = f.result;
  } else {
    throw new BadRequestError("formula.result must name one of the steps.");
  }
  return { steps, result };
}

const OP_JSON: Record<MetricStepOp, string> = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%" };
const FN_JSON: Record<MetricStepFn, string> = { FLOOR: "floor", ROUND: "round", CEIL: "ceil", ABS: "abs" };

/** Compile a structured formula into the JSON Logic expression the compute-on-read engine evaluates.
 *  A METRIC operand becomes `{ "var": "metrics.<name>" }`, CREATED_AT becomes `{ "var": "created_at" }`,
 *  a NUMBER is a bare literal, and a STEP is inlined by compiling the step it references. Returns null
 *  for a malformed formula (e.g. legacy stored shape) so serialization never throws. */
export function metricExprToJsonLogic(formula: MetricFormula): unknown {
  if (!formula || !Array.isArray(formula.steps) || formula.steps.length === 0) return null;
  const byId = new Map<string, MetricStep>();
  for (const s of formula.steps) byId.set(s.id, s);
  const active = new Set<string>(); // recursion guard against a hand-edited cyclic reference
  const compileToken = (tok: MetricToken): unknown => {
    switch (tok.kind) {
      case "METRIC": return { var: "metrics." + tok.name };
      case "NUMBER": return tok.value;
      case "CREATED_AT": return { var: "created_at" };
      case "STEP": {
        const s = byId.get(tok.step);
        return s ? compileStep(s) : null;
      }
    }
  };
  const compileStep = (step: MetricStep): unknown => {
    if (active.has(step.id)) return null;
    active.add(step.id);
    const out = step.kind === "FN"
      ? { [FN_JSON[step.fn]]: [compileToken(step.a)] }
      : { [OP_JSON[step.op]]: [compileToken(step.a), compileToken(step.b)] };
    active.delete(step.id);
    return out;
  };
  const resultStep = byId.get(formula.result) ?? formula.steps[formula.steps.length - 1];
  return compileStep(resultStep);
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
  const unit = row.unit ?? undefined;
  const format = row.format ?? undefined;
  if (row.kind === "DERIVED") {
    const formula = parseStoredFormula(row.formula);
    const derived: DerivedDecl = {
      name: row.name,
      expr: formula ? metricExprToJsonLogic(formula) : null,
    };
    if (unit) derived.unit = unit;
    if (format) derived.format = format;
    if (description) derived.description = description;
    return { derived };
  }
  const metric: MetricDecl = { name: row.name, type: row.type };
  if (unit) metric.unit = unit;
  if (format) metric.format = format;
  if (description) metric.description = description;
  return { metric };
}
