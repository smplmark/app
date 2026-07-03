// The smplkit range grammar for date filters, ported from python-core's smplcore/filters.py
// (ADR-014). Syntax: `[lower,upper)` where the first char is `[` (inclusive) or `(` (exclusive),
// the last is `]` (inclusive) or `)` (exclusive), the interior is exactly two comma-separated
// tokens, and each token is `*` (unbounded) or an ISO-8601 datetime.
import { BadRequestError } from "../errors";
import { isoToEpochMs } from "../time";

export interface DateRange {
  /** Lower bound as epoch-ms, or null for unbounded. */
  start: number | null;
  startInclusive: boolean;
  /** Upper bound as epoch-ms, or null for unbounded. */
  end: number | null;
  endInclusive: boolean;
}

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseToken(token: string, label: string): number | null {
  if (token === "*") return null;
  if (!ISO_RE.test(token)) {
    throw new BadRequestError(
      `Invalid ISO-8601 datetime for ${label} bound: ${JSON.stringify(token)}.`,
    );
  }
  const ms = isoToEpochMs(token);
  if (Number.isNaN(ms)) {
    throw new BadRequestError(
      `Invalid ISO-8601 datetime for ${label} bound: ${JSON.stringify(token)}.`,
    );
  }
  return ms;
}

export function parseDateRange(value: string): DateRange {
  if (value.length === 0) {
    throw new BadRequestError("Date range filter must not be empty.");
  }
  const first = value[0];
  const last = value[value.length - 1];
  if (first !== "[" && first !== "(") {
    throw new BadRequestError("Date range filter must start with '[' or '('.");
  }
  if (last !== "]" && last !== ")") {
    throw new BadRequestError("Date range filter must end with ']' or ')'.");
  }

  const interior = value.slice(1, -1);
  const parts = interior.split(",");
  if (parts.length !== 2) {
    throw new BadRequestError(
      "Date range filter must contain exactly two comma-separated values.",
    );
  }

  return {
    start: parseToken(parts[0].trim(), "lower"),
    startInclusive: first === "[",
    end: parseToken(parts[1].trim(), "upper"),
    endInclusive: last === "]",
  };
}
