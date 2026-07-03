// Request-body parsing helpers. Every path here turns bad client input into a 400 (never a 500).
import { BadRequestError } from "../errors";
import { MAX_EPOCH_MS, isoToEpochMs } from "../time";

/** Parse a request body; empty body → undefined; malformed JSON → 400. */
export function parseJsonBody(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body must be valid JSON.");
  }
}

/** Extract `data.attributes` from a JSON:API document (missing attributes → {}). */
export function attributesOf(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a JSON:API document.");
  }
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new BadRequestError("Request body must contain a data object.");
  }
  const attrs = (data as Record<string, unknown>).attributes;
  if (attrs === undefined) return {};
  if (attrs === null || typeof attrs !== "object" || Array.isArray(attrs)) {
    throw new BadRequestError("data.attributes must be an object.");
  }
  return attrs as Record<string, unknown>;
}

function pointer(field: string) {
  return { pointer: `/data/attributes/${field}` };
}

export function requireString(
  attrs: Record<string, unknown>,
  field: string,
): string {
  const v = attrs[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new BadRequestError(
      `${field} is required and must be a non-empty string.`,
      pointer(field),
    );
  }
  return v;
}

/** Present → string|null; absent → undefined; wrong type → 400. */
export function optionalStringOrNull(
  attrs: Record<string, unknown>,
  field: string,
): string | null | undefined {
  if (!(field in attrs)) return undefined;
  const v = attrs[field];
  if (v === null || typeof v === "string") return v;
  throw new BadRequestError(`${field} must be a string or null.`, pointer(field));
}

/** Present → boolean; absent → undefined; wrong type → 400. */
export function optionalBoolean(
  attrs: Record<string, unknown>,
  field: string,
): boolean | undefined {
  if (!(field in attrs)) return undefined;
  const v = attrs[field];
  if (typeof v === "boolean") return v;
  throw new BadRequestError(`${field} must be a boolean.`, pointer(field));
}

/**
 * Enum parsing (ADR-014): SCREAMING_SNAKE_CASE on the wire, case-insensitive on input. The input is
 * upper-cased before matching, so `"private"`/`"Private"`/`"PRIVATE"` all resolve to `"PRIVATE"`.
 */
export function optionalEnum<T extends string>(
  attrs: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (!(field in attrs)) return undefined;
  const v = attrs[field];
  if (typeof v === "string") {
    const normalized = v.toUpperCase();
    if ((allowed as readonly string[]).includes(normalized)) return normalized as T;
  }
  throw new BadRequestError(
    `${field} must be one of: ${allowed.join(", ")}.`,
    pointer(field),
  );
}

/** Like optionalEnum but required (missing → 400). */
export function requireEnum<T extends string>(
  attrs: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  if (!(field in attrs)) {
    throw new BadRequestError(
      `${field} is required and must be one of: ${allowed.join(", ")}.`,
      pointer(field),
    );
  }
  return optionalEnum(attrs, field, allowed) as T;
}

/** A plain JSON object (not array/null), or 400. */
export function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError(`${field} must be an object.`, pointer(field));
  }
  return value as Record<string, unknown>;
}

/**
 * A client-supplied timestamp: epoch-ms number or ISO-8601 string → epoch-ms. A timezone-less
 * datetime is treated as UTC (consistent with the read-side range grammar). The result is bounded
 * to the representable Date range so it can never make toISOString() throw downstream (400, not 500).
 */
export function parseEpochMs(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.trunc(value);
    if (Math.abs(ms) <= MAX_EPOCH_MS) return ms;
  } else if (typeof value === "string") {
    const ms = isoToEpochMs(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new BadRequestError(
    `${field} must be an epoch-ms number or an ISO-8601 datetime within the supported range.`,
    pointer(field),
  );
}

/** Extract a Bearer token from an Authorization header, or null. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}
