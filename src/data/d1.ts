// Small shared helpers for the D1 data layer.

/** True if a D1 error is a UNIQUE-constraint violation (mapped to a 409 by callers). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Serialize a free-form details/meta value for storage, or null. */
export function jsonOrNull(value: unknown | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
