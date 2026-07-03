// The web-layer rendering of JSON:API documents into Response objects. Thin: it wraps the
// pure resource/error shapes with the correct media type and status.
import { toErrorDocument } from "../errors";

export const JSONAPI_CONTENT_TYPE = "application/vnd.api+json";

export interface ResourceObject {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function jsonApiBody(
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": JSONAPI_CONTENT_TYPE, ...extraHeaders },
  });
}

/** Single-resource document: `{ data: {...} }` (optionally with top-level `meta`). */
export function resourceResponse(
  resource: ResourceObject,
  opts: {
    status?: number;
    meta?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Response {
  const body: { data: ResourceObject; meta?: Record<string, unknown> } = {
    data: resource,
  };
  if (opts.meta !== undefined) body.meta = opts.meta;
  return jsonApiBody(body, opts.status ?? 200, opts.headers);
}

/** Collection document: `{ data: [...], meta: {...} }`. */
export function collectionResponse(
  resources: ResourceObject[],
  opts: {
    meta?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Response {
  const body: { data: ResourceObject[]; meta?: Record<string, unknown> } = {
    data: resources,
  };
  if (opts.meta !== undefined) body.meta = opts.meta;
  return jsonApiBody(body, 200, opts.headers);
}

/** 204 No Content — the success shape for DELETE (ADR-014). */
export function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

/** Render any thrown error into a JSON:API error Response. */
export function errorResponse(err: unknown): Response {
  const { status, document } = toErrorDocument(err);
  return jsonApiBody(document, status);
}
