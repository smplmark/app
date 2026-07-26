// Turn a parsed DateRange into a SQL predicate fragment + bind params. The `column` is always
// an internal constant (never user input), so interpolating it is safe.
import type { DateRange } from "./daterange";

export interface SqlFragment {
  sql: string;
  binds: number[];
}

export function dateRangePredicate(column: string, range: DateRange): SqlFragment {
  const clauses: string[] = [];
  const binds: number[] = [];
  if (range.start !== null) {
    clauses.push(`${column} ${range.startInclusive ? ">=" : ">"} ?`);
    binds.push(range.start);
  }
  if (range.end !== null) {
    clauses.push(`${column} ${range.endInclusive ? "<=" : "<"} ?`);
    binds.push(range.end);
  }
  return { sql: clauses.join(" AND "), binds };
}
