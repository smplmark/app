// Validate a client-supplied sample_schema (benchmark create/update only — never the hot path) and
// parse a stored one back. Enforces unique metric names across metrics + derived so the merged read
// surface is unambiguous (§4), validates the chart declaration (§11), and — for PUBLISHED benchmarks
// — enforces the interpretation freeze (§8/§10): the semantic core (derived expressions, metric set,
// chart mapping) is immutable; only cosmetic unit/description labels may change.
import { BadRequestError, ConflictError } from "../errors";
import type {
  ChartDecl,
  DerivedDecl,
  MetricDecl,
  SampleSchema,
  XKind,
} from "../types";
import { X_KINDS } from "../types";

function asArray(v: unknown, field: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new BadRequestError(`sample_schema.${field} must be an array.`);
  }
  return v;
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new BadRequestError(`${field} must be a non-empty string.`);
  }
  return v;
}

function asObject(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new BadRequestError(`${field} must be an object.`);
  }
  return v as Record<string, unknown>;
}

function parseMetric(m: unknown, i: number): MetricDecl {
  const mm = asObject(m, `sample_schema.metrics[${i}]`);
  const decl: MetricDecl = {
    name: nonEmptyString(mm.name, `sample_schema.metrics[${i}].name`),
    type: nonEmptyString(mm.type, `sample_schema.metrics[${i}].type`),
  };
  if (mm.unit !== undefined) {
    decl.unit = nonEmptyString(mm.unit, `sample_schema.metrics[${i}].unit`);
  }
  if (mm.description !== undefined) {
    decl.description = nonEmptyString(
      mm.description,
      `sample_schema.metrics[${i}].description`,
    );
  }
  return decl;
}

function parseDerived(d: unknown, i: number): DerivedDecl {
  const dd = asObject(d, `sample_schema.derived[${i}]`);
  if (!("expr" in dd)) {
    throw new BadRequestError(`sample_schema.derived[${i}].expr is required.`);
  }
  const decl: DerivedDecl = {
    name: nonEmptyString(dd.name, `sample_schema.derived[${i}].name`),
    expr: dd.expr,
  };
  if (dd.unit !== undefined) {
    decl.unit = nonEmptyString(dd.unit, `sample_schema.derived[${i}].unit`);
  }
  if (dd.description !== undefined) {
    decl.description = nonEmptyString(
      dd.description,
      `sample_schema.derived[${i}].description`,
    );
  }
  return decl;
}

function parseChart(v: unknown, names: Set<string>): ChartDecl {
  const c = asObject(v, "sample_schema.chart");
  if (!("y" in c)) {
    throw new BadRequestError("sample_schema.chart.y is required.");
  }
  const y = nonEmptyString(c.y, "sample_schema.chart.y");
  if (!names.has(y)) {
    throw new BadRequestError(
      `sample_schema.chart.y references unknown metric ${JSON.stringify(y)}.`,
    );
  }

  let x: string | null = null;
  if ("x" in c && c.x !== null) {
    x = nonEmptyString(c.x, "sample_schema.chart.x");
    if (x !== "created_at" && !names.has(x)) {
      throw new BadRequestError(
        `sample_schema.chart.x references unknown metric ${JSON.stringify(x)}.`,
      );
    }
  }

  const chart: ChartDecl = { x, y };
  if (c.x_kind !== undefined) {
    if (typeof c.x_kind !== "string" || !X_KINDS.includes(c.x_kind as XKind)) {
      throw new BadRequestError(
        `sample_schema.chart.x_kind must be one of: ${X_KINDS.join(", ")}.`,
      );
    }
    chart.x_kind = c.x_kind as XKind;
  }
  return chart;
}

export function validateSampleSchema(value: unknown): SampleSchema {
  const obj = asObject(value, "sample_schema");
  const metrics = asArray(obj.metrics, "metrics").map(parseMetric);
  const derived = asArray(obj.derived, "derived").map(parseDerived);

  const names = new Set<string>();
  for (const name of [...metrics.map((m) => m.name), ...derived.map((d) => d.name)]) {
    if (names.has(name)) {
      throw new BadRequestError(
        `Duplicate metric name in sample_schema: ${JSON.stringify(name)}.`,
      );
    }
    names.add(name);
  }

  const schema: SampleSchema = { metrics, derived };
  if (obj.chart !== undefined && obj.chart !== null) {
    schema.chart = parseChart(obj.chart, names);
  }
  return schema;
}

/** Read a stored sample_schema JSON back into a normalized object (trusted DB value). */
export function parseSampleSchema(json: string): SampleSchema {
  const parsed = JSON.parse(json) as Partial<SampleSchema> | null;
  const schema: SampleSchema = {
    metrics: parsed?.metrics ?? [],
    derived: parsed?.derived ?? [],
  };
  if (parsed?.chart) schema.chart = parsed.chart;
  return schema;
}

// ── freeze-on-publish ────────────────────────────────────────────────────────

/** Recursively key-sorted JSON, so semantic-equality ignores key ordering. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/** The immutable "semantic core" of a schema: metric names+types, derived names+exprs, chart. */
function semanticCore(s: SampleSchema): string {
  return canonical({
    metrics: s.metrics.map((m) => ({ name: m.name, type: m.type })).sort((a, b) => a.name.localeCompare(b.name)),
    derived: s.derived
      .map((d) => ({ name: d.name, expr: d.expr }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    chart: s.chart ?? null,
  });
}

/**
 * Enforce the interpretation freeze: when a benchmark is PUBLISHED/WITHDRAWN, an update may change
 * only cosmetic labels. If the semantic core differs, reject with 409 (§8).
 */
export function assertFrozenCompatible(
  oldSchema: SampleSchema,
  newSchema: SampleSchema,
): void {
  if (semanticCore(oldSchema) !== semanticCore(newSchema)) {
    throw new ConflictError(
      "The interpretation of a published benchmark is frozen: metrics, derived expressions, and the chart mapping cannot change. Only descriptions and unit labels may be edited.",
    );
  }
}
