// Validate a client-supplied subject_type `fields` list (create/update only — never a hot path) and
// parse a stored one back. Each field carries a `label` (human display) and a `name` (the identifier
// used in a subject's `details` JSON) — the name is a snake_case slug (lowercase alphanumerics +
// underscore) derived from the label when the client omits it. STRING may carry a max_length; ENUM
// must carry a non-empty options list; every field may carry an optional description. Kept small.
import { BadRequestError } from "../errors";
import { SUBJECT_FIELD_TYPES, type SubjectFieldDef, type SubjectFieldType } from "../types";

const MAX_FIELDS = 40;
const MAX_STRING_LENGTH = 255;
const MAX_ENUM_OPTIONS = 100;
const MAX_DESCRIPTION = 500;

/** Kebab-case a display name into a storage key: lowercase, non-alphanumerics → single dash. Used for
 *  subject-type keys (which read like URL slugs). */
export function kebab(input: string): string {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Snake_case a label/name into a field identifier: lowercase, runs of non-alphanumerics → single
 *  underscore. Field names are JSON keys in a subject's `details`, so they use `[a-z0-9_]` only. */
export function fieldNameSlug(input: string): string {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function asObject(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new BadRequestError(`${field} must be an object.`);
  }
  return v as Record<string, unknown>;
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new BadRequestError(`${field} must be a non-empty string.`);
  }
  return v;
}

function isFieldType(v: unknown): v is SubjectFieldType {
  return typeof v === "string" && (SUBJECT_FIELD_TYPES as readonly string[]).includes(v);
}

/** A stable, unique-within-the-type identifier (snake_case) from a label/name; falls back to `field_N`. */
function uniqueFieldName(source: string, used: Set<string>, index: number): string {
  const base = fieldNameSlug(source) || `field_${index + 1}`;
  let candidate = base;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
  used.add(candidate);
  return candidate;
}

/** Validate and normalize a client-supplied `fields` value into SubjectFieldDef[]. */
export function parseFieldDefs(input: unknown): SubjectFieldDef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BadRequestError("fields must be an array.");
  if (input.length > MAX_FIELDS) {
    throw new BadRequestError(`A subject type may declare at most ${MAX_FIELDS} fields.`);
  }
  const usedNames = new Set<string>();
  return input.map((raw, i) => {
    const f = asObject(raw, `fields[${i}]`);
    const label = nonEmptyString(f.label, `fields[${i}].label`);
    // The identifier: an explicit `name` if supplied, otherwise derived from the label. Slugified and
    // made unique within the type either way.
    const source = typeof f.name === "string" && f.name.trim().length > 0 ? f.name : label;
    if (!isFieldType(f.type)) {
      throw new BadRequestError(`fields[${i}].type must be one of: ${SUBJECT_FIELD_TYPES.join(", ")}.`);
    }
    const def: SubjectFieldDef = {
      name: uniqueFieldName(source, usedNames, i),
      label,
      type: f.type,
      required: f.required === true,
    };
    if (f.description !== undefined && f.description !== null) {
      if (typeof f.description !== "string") {
        throw new BadRequestError(`fields[${i}].description must be a string.`);
      }
      const desc = f.description.trim();
      if (desc.length > MAX_DESCRIPTION) {
        throw new BadRequestError(`fields[${i}].description must be at most ${MAX_DESCRIPTION} characters.`);
      }
      if (desc) def.description = desc;
    }
    if (f.type === "STRING") {
      // Every string field carries a length limit (mirrors the field editor): validate a supplied one,
      // and default an omitted one to the maximum so it can never be unbounded.
      if (f.max_length !== undefined && f.max_length !== null) {
        const n = f.max_length;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_STRING_LENGTH) {
          throw new BadRequestError(`fields[${i}].max_length must be an integer between 1 and ${MAX_STRING_LENGTH}.`);
        }
        def.max_length = n;
      } else {
        def.max_length = MAX_STRING_LENGTH;
      }
    }
    if (f.type === "ENUM") {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        throw new BadRequestError(`fields[${i}].options must be a non-empty array for an ENUM field.`);
      }
      if (f.options.length > MAX_ENUM_OPTIONS) {
        throw new BadRequestError(`fields[${i}].options may list at most ${MAX_ENUM_OPTIONS} values.`);
      }
      const values = f.options.map((o, j) => nonEmptyString(o, `fields[${i}].options[${j}]`).trim());
      if (new Set(values).size !== values.length) {
        throw new BadRequestError(`fields[${i}].options must be unique.`);
      }
      def.options = values;
    }
    return def;
  });
}

/**
 * Validate a subject's field values against its type's field defs. The subject type is an OPEN schema:
 * a key that a field DEFINES is validated (required-ness, declared type, STRING max_length, ENUM
 * membership, DATE parse); any key the schema does NOT define is stored verbatim (subjects may carry
 * arbitrary extra data). Returns the normalized value object to store.
 */
export function validateSubjectValues(fields: SubjectFieldDef[], input: unknown): Record<string, unknown> {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    throw new BadRequestError("details must be an object.");
  }
  const values = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const defined = new Set<string>();
  for (const f of fields) {
    defined.add(f.name);
    const raw = values[f.name];
    if (raw === undefined || raw === null || raw === "") {
      if (f.required) throw new BadRequestError(`The field "${f.label}" is required.`);
      continue;
    }
    out[f.name] = coerceValue(f, raw);
  }
  // Undefined-by-schema keys pass through unchanged (open schema).
  for (const [k, v] of Object.entries(values)) {
    if (!defined.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

function coerceValue(f: SubjectFieldDef, raw: unknown): unknown {
  switch (f.type) {
    case "STRING": {
      if (typeof raw !== "string") throw new BadRequestError(`"${f.label}" must be a string.`);
      if (f.max_length !== undefined && raw.length > f.max_length) {
        throw new BadRequestError(`"${f.label}" must be at most ${f.max_length} characters.`);
      }
      return raw;
    }
    case "NUMBER": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (typeof raw === "boolean" || Number.isNaN(n) || (typeof raw === "string" && raw.trim() === "")) {
        throw new BadRequestError(`"${f.label}" must be a number.`);
      }
      return n;
    }
    case "BOOLEAN": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new BadRequestError(`"${f.label}" must be true or false.`);
    }
    case "ENUM": {
      if (typeof raw !== "string" || !(f.options ?? []).includes(raw)) {
        throw new BadRequestError(`"${f.label}" must be one of: ${(f.options ?? []).join(", ")}.`);
      }
      return raw;
    }
    case "DATE": {
      if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
        throw new BadRequestError(`"${f.label}" must be a date (e.g. 2026-01-31).`);
      }
      return raw;
    }
  }
}

/** Parse a stored `fields` JSON string back into SubjectFieldDef[] (tolerant of NULL/garbage → []). */
export function parseStoredFieldDefs(fields: string | null): SubjectFieldDef[] {
  if (!fields) return [];
  try {
    const parsed = JSON.parse(fields);
    return Array.isArray(parsed) ? (parsed as SubjectFieldDef[]) : [];
  } catch {
    return [];
  }
}
