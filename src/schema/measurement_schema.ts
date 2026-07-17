// Validate a client-supplied measurement_schema (benchmark create/update only — never the hot path) and
// parse a stored one back. Enforces unique metric names across metrics + derived so the merged read
// surface is unambiguous (§4) and validates the chart declaration (§11). A published benchmark's
// schema is editable — the auditable-record model replaced the old freeze — but a change to the
// semantic core (derived expressions, metric set, chart mapping) is detected here and flagged on
// the audit event so the History surfaces it.
import { BadRequestError } from "../errors";
import type {
  ChartDecl,
  DerivedDecl,
  MetricDecl,
  MeasurementSchema,
  XKind,
} from "../types";
import { X_KINDS } from "../types";

function asArray(v: unknown, field: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new BadRequestError(`measurement_schema.${field} must be an array.`);
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
  const mm = asObject(m, `measurement_schema.metrics[${i}]`);
  const decl: MetricDecl = {
    name: nonEmptyString(mm.name, `measurement_schema.metrics[${i}].name`),
    type: nonEmptyString(mm.type, `measurement_schema.metrics[${i}].type`),
  };
  if (mm.unit !== undefined) {
    decl.unit = nonEmptyString(mm.unit, `measurement_schema.metrics[${i}].unit`);
  }
  if (mm.format !== undefined) {
    decl.format = nonEmptyString(mm.format, `measurement_schema.metrics[${i}].format`);
  }
  if (mm.description !== undefined) {
    decl.description = nonEmptyString(
      mm.description,
      `measurement_schema.metrics[${i}].description`,
    );
  }
  return decl;
}

function parseDerived(d: unknown, i: number): DerivedDecl {
  const dd = asObject(d, `measurement_schema.derived[${i}]`);
  if (!("expr" in dd)) {
    throw new BadRequestError(`measurement_schema.derived[${i}].expr is required.`);
  }
  const decl: DerivedDecl = {
    name: nonEmptyString(dd.name, `measurement_schema.derived[${i}].name`),
    expr: dd.expr,
  };
  if (dd.unit !== undefined) {
    decl.unit = nonEmptyString(dd.unit, `measurement_schema.derived[${i}].unit`);
  }
  if (dd.format !== undefined) {
    decl.format = nonEmptyString(dd.format, `measurement_schema.derived[${i}].format`);
  }
  if (dd.description !== undefined) {
    decl.description = nonEmptyString(
      dd.description,
      `measurement_schema.derived[${i}].description`,
    );
  }
  return decl;
}

function parseChart(v: unknown, names: Set<string>): ChartDecl {
  const c = asObject(v, "measurement_schema.chart");
  if (!("y" in c)) {
    throw new BadRequestError("measurement_schema.chart.y is required.");
  }
  const y = nonEmptyString(c.y, "measurement_schema.chart.y");
  if (!names.has(y)) {
    throw new BadRequestError(
      `measurement_schema.chart.y references unknown metric ${JSON.stringify(y)}.`,
    );
  }

  let x: string | null = null;
  if ("x" in c && c.x !== null) {
    x = nonEmptyString(c.x, "measurement_schema.chart.x");
    if (x !== "created_at" && !names.has(x)) {
      throw new BadRequestError(
        `measurement_schema.chart.x references unknown metric ${JSON.stringify(x)}.`,
      );
    }
  }

  const chart: ChartDecl = { x, y };
  if (c.x_kind !== undefined) {
    if (typeof c.x_kind !== "string" || !X_KINDS.includes(c.x_kind as XKind)) {
      throw new BadRequestError(
        `measurement_schema.chart.x_kind must be one of: ${X_KINDS.join(", ")}.`,
      );
    }
    chart.x_kind = c.x_kind as XKind;
  }
  return chart;
}

export function validateMeasurementSchema(value: unknown): MeasurementSchema {
  const obj = asObject(value, "measurement_schema");
  const metrics = asArray(obj.metrics, "metrics").map(parseMetric);
  const derived = asArray(obj.derived, "derived").map(parseDerived);

  const names = new Set<string>();
  for (const name of [...metrics.map((m) => m.name), ...derived.map((d) => d.name)]) {
    if (names.has(name)) {
      throw new BadRequestError(
        `Duplicate metric name in measurement_schema: ${JSON.stringify(name)}.`,
      );
    }
    names.add(name);
  }

  const schema: MeasurementSchema = { metrics, derived };
  if (obj.chart !== undefined && obj.chart !== null) {
    schema.chart = parseChart(obj.chart, names);
  }
  return schema;
}

/** Read a stored measurement_schema JSON back into a normalized object (trusted DB value). */
export function parseMeasurementSchema(json: string): MeasurementSchema {
  const parsed = JSON.parse(json) as Partial<MeasurementSchema> | null;
  const schema: MeasurementSchema = {
    metrics: parsed?.metrics ?? [],
    derived: parsed?.derived ?? [],
  };
  if (parsed?.chart) schema.chart = parsed.chart;
  return schema;
}

// ── semantic-core change detection ───────────────────────────────────────────

/** Recursively key-sorted JSON, so semantic-equality ignores key ordering. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

export interface SchemaDiff {
  /** Any difference at all (including cosmetic unit/format/description edits). */
  changed: boolean;
  /**
   * The semantic core moved: the metric set (names/types), a derived expression, or the chart/axis
   * mapping changed — i.e. the numbers now mean something different. Post-publish, an edit like
   * this is allowed but its audit event is flagged so the History surfaces it prominently.
   */
  semantic_core: boolean;
}

/** Compare two measurement schemas: did anything change, and did the semantic core change? */
export function diffMeasurementSchema(
  oldSchema: MeasurementSchema,
  newSchema: MeasurementSchema,
): SchemaDiff {
  const changed = canonical(oldSchema) !== canonical(newSchema);
  if (!changed) return { changed: false, semantic_core: false };
  const core = (s: MeasurementSchema) =>
    canonical({
      metrics: [...s.metrics.map((m) => ({ name: m.name, type: m.type }))].sort((a, b) =>
        a.name < b.name ? -1 : 1,
      ),
      derived: [...s.derived.map((d) => ({ name: d.name, expr: d.expr }))].sort((a, b) =>
        a.name < b.name ? -1 : 1,
      ),
      chart: s.chart ?? null,
    });
  return { changed: true, semantic_core: core(oldSchema) !== core(newSchema) };
}
