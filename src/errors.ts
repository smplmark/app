// Domain error classes and their JSON:API error-document mapping. Pure — no Response/Hono
// coupling — so the query/ schema/ auth/ modules can throw these without pulling in the web layer.
// ADR-014: client input never 500s; malformed input is 400 (not 422); every error carries a
// JSON:API body; 401s are descriptive but non-leaky; cross-tenant references return 404.

export interface JsonApiErrorObject {
  status: string;
  title: string;
  detail?: string;
  source?: { pointer: string };
}

export interface JsonApiErrorDocument {
  errors: JsonApiErrorObject[];
}

export class AppError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly source?: { pointer: string };

  constructor(
    status: number,
    title: string,
    detail?: string,
    source?: { pointer: string },
  ) {
    super(detail ?? title);
    this.name = title;
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.source = source;
  }
}

export class BadRequestError extends AppError {
  constructor(detail?: string, source?: { pointer: string }) {
    super(400, "Bad Request", detail, source);
  }
}

/**
 * A credential failure. Descriptive but non-leaky (ADR-014 §4a): the "invalid, expired, or revoked"
 * wording never reveals which check failed. The missing-credential case may name the expected header
 * format (that leaks nothing).
 */
export class UnauthorizedError extends AppError {
  constructor(
    detail = "Authentication credentials are missing, invalid, expired, or revoked.",
  ) {
    super(401, "Unauthorized", detail);
  }
}

/** Authenticated but not permitted (intra-tenant). Never used for cross-tenant isolation. */
export class ForbiddenError extends AppError {
  constructor(detail?: string) {
    super(403, "Forbidden", detail);
  }
}

/**
 * Not found. The default detail is the static, generic string ADR-016 mandates so cross-tenant
 * references are byte-identical to genuine 404s and leak no existence. Callers may override for
 * "no such API endpoint".
 */
export class NotFoundError extends AppError {
  constructor(detail = "The requested resource was not found.") {
    super(404, "Not Found", detail);
  }
}

export class ConflictError extends AppError {
  constructor(detail?: string, source?: { pointer: string }) {
    super(409, "Conflict", detail, source);
  }
}

/** A feature that exists but is not configured in this deployment (e.g. an OIDC provider). */
export class ServiceUnavailableError extends AppError {
  constructor(detail?: string) {
    super(503, "Service Unavailable", detail);
  }
}

/** Render any error into a JSON:API error document (pure). */
export function toErrorDocument(err: unknown): {
  status: number;
  document: JsonApiErrorDocument;
} {
  if (err instanceof AppError) {
    const obj: JsonApiErrorObject = {
      status: String(err.status),
      title: err.title,
    };
    if (err.detail !== undefined) obj.detail = err.detail;
    if (err.source !== undefined) obj.source = err.source;
    return { status: err.status, document: { errors: [obj] } };
  }
  return {
    status: 500,
    document: {
      errors: [{ status: "500", title: "Internal Server Error" }],
    },
  };
}
