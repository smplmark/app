// The `sort` query param (ADR-014): a single field name, optional leading `-` for descending. Every
// read-many endpoint documents a default and enumerates its allowed fields; an unknown field is a
// 400. Callers always append `id` as a tiebreaker so pagination is stable across non-unique columns.
// Multi-field sort is deferred (§17).
import { BadRequestError } from "../errors";

export interface Sort {
  field: string;
  desc: boolean;
}

/**
 * Parse a `sort` value against an allowed set. `raw` null/empty → the documented default.
 * @param defaultSort e.g. "created_at" or "-created_at".
 * @param allowed the field names permitted (without the `-`).
 */
export function parseSort(
  raw: string | null,
  defaultSort: string,
  allowed: readonly string[],
): Sort {
  const value = raw === null || raw === "" ? defaultSort : raw;
  const desc = value.startsWith("-");
  const field = desc ? value.slice(1) : value;
  if (!allowed.includes(field)) {
    throw new BadRequestError(
      `sort field ${JSON.stringify(field)} is not allowed; allowed fields: ${allowed.join(", ")}.`,
    );
  }
  return { field, desc };
}

/** Build an `ORDER BY <col> ASC|DESC, <tiebreak>` clause. `col`/`tiebreak` are internal constants. */
export function orderByClause(
  sort: Sort,
  columnFor: (field: string) => string,
  tiebreak: string,
): string {
  const col = columnFor(sort.field);
  const dir = sort.desc ? "DESC" : "ASC";
  return `ORDER BY ${col} ${dir}, ${tiebreak}`;
}
