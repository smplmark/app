// Smpl Audit integration — the audit trail behind the History tabs. Every post-publish mutation
// (and the pre-publish lifecycle) is recorded as an event in Smpl Audit (audit-logs-as-a-service),
// keyed so a single resource's history and a whole benchmark subtree's history are both queryable.
//
// Transport: the smplkit TypeScript SDK via its `@smplkit/sdk/audit` edge entry — a Node-free
// import graph made for Workers. The client is constructed per call with `buffered: false` (the
// SDK's stateless write path): no background buffer, no timers, one awaited POST per record —
// the isolate-safe shape.
//
// Delivery contract:
//  - Writes are best-effort and NEVER on the response path — emitAuditEvent hands the record to
//    ctx.waitUntil, so a slow or down audit service can't add latency to (or fail) a mutation.
//    publish / withdraw / taken_down are the events most worth upgrading to guaranteed delivery
//    (a queue) later.
//  - When SMPLKIT_API_KEY is unset the whole feature degrades gracefully: writes become a
//    logged no-op and history reads return empty.
import { AuditClient } from "@smplkit/sdk/audit";
import type { Context } from "hono";
import { auditConfigured } from "../config";
import { getUserById } from "../data/users";
import { ServiceUnavailableError } from "../errors";
import type { AppBindings } from "../http/middleware";
import type { AuthContext } from "../types";

/** Who is shown in the public History for every public event: the benchmark's publisher identity. */
export type HistoryVisibility = "public" | "internal";

/** An explicitly-named actor for events with no credential (operator takedowns, public requesters). */
export interface NamedActor {
  type: "OPERATOR" | "PUBLIC";
  id: string | null;
  label: string | null;
}

export interface AuditEventInput {
  /** Catalog name, e.g. "benchmark.published", "measurement.corrected", "run.appended". */
  event_type: string;
  resource_type: "benchmark" | "run" | "measurement" | "subject" | "takedown_request";
  resource_id: string;
  /**
   * Subtree correlation: every event under a benchmark carries its id so the whole subtree's
   * history is one query. Omitted for account-level resources (subjects span benchmarks).
   */
  benchmark_id?: string;
  /** public → shown on the world-visible History tab; internal → console only. */
  visibility: HistoryVisibility;
  /** One human sentence: "what happened". */
  description: string;
  /** Changed-field payload, enough to render "what changed": { field: { before, after } }. */
  changes?: Record<string, { before: unknown; after: unknown }>;
  /** Flags a change to the semantic core (metric set, derived expressions, chart/axis mapping). */
  semantic_core?: boolean;
  /** Extra context (attribution snapshot on publish, reasons, operator identity). */
  extra?: Record<string, unknown>;
  /** The acting credential, or an explicit non-credential actor. */
  actor: AuthContext | NamedActor;
}

/** One parsed audit event, as the History endpoints consume it. */
export interface HistoryEventRecord {
  id: string;
  event_type: string;
  resource_type: string;
  resource_id: string;
  occurred_at: string;
  description: string | null;
  actor_type: string | null;
  actor_id: string | null;
  actor_label: string | null;
  visibility: HistoryVisibility;
  benchmark_id: string | null;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  semantic_core: boolean;
}

/** History reads are bounded: at most this many events per resource (newest first). */
const MAX_HISTORY_EVENTS = 1000;
const PAGE_SIZE = 200;
/** Per-field cap on a before/after entry in `changes` (JSON bytes). */
const MAX_CHANGE_FIELD_BYTES = 16_384;

/**
 * Bound the before/after payload. Several audited fields (run details, measurement meta, schema
 * expressions) are caller-controlled JSON with no size cap; unbounded, a deliberately inflated
 * edit could push the audit write past a request-size limit and make the change unauditable — the
 * mutation would land while its History entry silently failed. The record of WHICH fields moved
 * must survive even when a value can't be inlined, so an oversized entry collapses to a
 * truncation marker instead of sinking the whole event.
 */
function boundChanges(
  changes: Record<string, { before: unknown; after: unknown }>,
): Record<string, { before: unknown; after: unknown } | { truncated: true }> {
  const bounded: Record<string, { before: unknown; after: unknown } | { truncated: true }> = {};
  for (const [field, entry] of Object.entries(changes)) {
    bounded[field] = JSON.stringify(entry).length > MAX_CHANGE_FIELD_BYTES ? { truncated: true } : entry;
  }
  return bounded;
}

/** The indexed subtree-correlation key (Smpl Audit's `category` is its one exact-match label). */
function benchmarkCategory(benchmarkId: string): string {
  return `benchmark:${benchmarkId}`;
}

function isNamedActor(actor: AuthContext | NamedActor): actor is NamedActor {
  return !("account_id" in actor);
}

/**
 * A stateless SDK client for one call. Constructed per use — with `buffered: false` the SDK
 * installs no buffer or timers, so this is cheap and isolate-safe (a module-scope singleton would
 * not survive the Workers isolate model).
 */
function auditClient(env: Env): AuditClient {
  return new AuditClient({
    // Canonical smplkit config, read off the Worker env binding (a Worker has no process.env / no
    // ~/.smplkit for the SDK to auto-resolve from). baseUrl is omitted — the SDK derives
    // https://audit.smplkit.com from its default base domain.
    apiKey: env.SMPLKIT_API_KEY as string,
    environment: env.SMPLKIT_ENVIRONMENT,
    buffered: false,
    // Workers' outbound fetch sends no User-Agent, and the smplkit platform's WAF (CloudFront
    // managed rules) rejects UA-less requests with an HTML 403 before they reach the service.
    extraHeaders: { "User-Agent": "smplmark-app (+https://app.smplmark.org)" },
  });
}

/**
 * Record one audit event, off the response path. Fire-and-forget: hands the write to
 * ctx.waitUntil (house pattern — c.executionCtx throws in harnesses with no execution context,
 * in which case the send runs inline but still never throws into the handler).
 */
export function emitAuditEvent(c: Context<AppBindings>, input: AuditEventInput): void {
  if (!auditConfigured(c.env)) {
    console.log(`audit (no-op, SMPLKIT_API_KEY unset): ${input.event_type} ${input.resource_type}/${input.resource_id}`);
    return;
  }
  const task = sendAuditEvent(c.env, input);
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // no execution context (e.g. some test harnesses) — the promise still runs; it never rejects.
  }
}

/** Resolve the actor fields, record the event via the SDK, swallow (but log) every failure. */
async function sendAuditEvent(env: Env, input: AuditEventInput): Promise<void> {
  try {
    const actor = await resolveActor(env, input.actor);
    const data: Record<string, unknown> = {
      visibility: input.visibility,
      ...(input.benchmark_id !== undefined ? { benchmark_id: input.benchmark_id } : {}),
      ...(input.changes !== undefined ? { changes: boundChanges(input.changes) } : {}),
      ...(input.semantic_core !== undefined ? { semantic_core: input.semantic_core } : {}),
      ...(input.extra ?? {}),
    };
    await auditClient(env).events.record({
      eventType: input.event_type,
      resourceType: input.resource_type,
      resourceId: input.resource_id,
      description: input.description,
      occurredAt: new Date().toISOString(),
      ...(actor.type !== null ? { actorType: actor.type } : {}),
      ...(actor.id !== null ? { actorId: actor.id } : {}),
      ...(actor.label !== null ? { actorLabel: actor.label } : {}),
      ...(input.benchmark_id !== undefined ? { category: benchmarkCategory(input.benchmark_id) } : {}),
      data,
    });
  } catch (e) {
    console.error("audit write failed:", e);
  }
}

/** USER (email label) for sessions, API_KEY (key id) for keys, or the explicit named actor. */
async function resolveActor(
  env: Env,
  actor: AuthContext | NamedActor,
): Promise<{ type: string; id: string | null; label: string | null }> {
  if (isNamedActor(actor)) return actor;
  if (actor.source === "SESSION" && actor.user_id !== null) {
    const user = await getUserById(env.DB, actor.user_id);
    return { type: "USER", id: actor.user_id, label: user?.email ?? null };
  }
  return { type: "API_KEY", id: actor.api_key_id, label: null };
}

export type HistoryQuery =
  | { resource_type: "benchmark" | "run" | "measurement" | "subject"; resource_id: string }
  | { benchmark_id: string };

/** Optional narrowing and paging for a history read, passed through to Smpl Audit. */
export interface HistoryListOptions {
  /** Exact event-type slug, e.g. "benchmark.edited". */
  event_type?: string;
  /** Inclusive ISO-8601 lower bound on occurred_at. */
  from?: string;
  /** Inclusive ISO-8601 upper bound on occurred_at. */
  to?: string;
  /** Single-page mode: return at most this many audit rows plus a cursor. */
  page_size?: number;
  /** Opaque cursor from a prior page's next_cursor. */
  page_after?: string;
}

export interface HistoryPage {
  events: HistoryEventRecord[];
  /** Cursor for the next page; null when exhausted (always null in accumulate mode). */
  next_cursor: string | null;
}

/**
 * measurement.created is no longer emitted (plain ingest is data flow, not a record change), but
 * live-benchmark beacons wrote hundreds before the cut — dropping them at read time retires the
 * noise without a data migration.
 */
const RETIRED_EVENT_TYPES = new Set(["measurement.created"]);

/** Smpl Audit's interval notation (ADR-014): inclusive bounds, `*` for an open edge. */
function occurredAtRange(from: string | undefined, to: string | undefined): string | undefined {
  if (from === undefined && to === undefined) return undefined;
  return `[${from ?? "*"},${to ?? "*"}]`;
}

/**
 * Read a resource's audit trail, newest first. A subtree query ({benchmark_id}) uses the indexed
 * category correlation; a resource query uses the resource_type + resource_id pair. With
 * page_size/page_after set, one audit page is fetched and its cursor returned (the page may come
 * back short: retired event types are dropped read-side, and callers filter visibility after);
 * otherwise pages are accumulated up to MAX_HISTORY_EVENTS. Unconfigured → empty (the feature is
 * off); a configured but unreachable audit service → 503 (an empty history would misstate the
 * record).
 */
export async function listHistoryEvents(
  env: Env,
  query: HistoryQuery,
  options: HistoryListOptions = {},
): Promise<HistoryPage> {
  if (!auditConfigured(env)) return { events: [], next_cursor: null };
  const client = auditClient(env);
  const range = occurredAtRange(options.from, options.to);
  const filters = {
    ...("benchmark_id" in query
      ? { category: benchmarkCategory(query.benchmark_id) }
      : { resourceType: query.resource_type, resourceId: query.resource_id }),
    ...(options.event_type !== undefined ? { eventType: options.event_type } : {}),
    ...(range !== undefined ? { occurredAtRange: range } : {}),
  };
  const paged = options.page_size !== undefined || options.page_after !== undefined;

  try {
    if (paged) {
      const page = await client.events.list({
        ...filters,
        pageSize: options.page_size ?? PAGE_SIZE,
        pageAfter: options.page_after,
      });
      return {
        events: page.events.map(toRecord).filter((e) => !RETIRED_EVENT_TYPES.has(e.event_type)),
        next_cursor: page.nextCursor ?? null,
      };
    }
    const events: HistoryEventRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.events.list({ ...filters, pageSize: PAGE_SIZE, pageAfter: cursor });
      for (const ev of page.events) {
        const record = toRecord(ev);
        if (RETIRED_EVENT_TYPES.has(record.event_type)) continue;
        events.push(record);
        if (events.length >= MAX_HISTORY_EVENTS) return { events, next_cursor: null };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { events, next_cursor: null };
  } catch (e) {
    console.error("audit read failed:", e);
    throw new ServiceUnavailableError("History is temporarily unavailable.");
  }
}

/** Map one SDK audit event into the record shape the History endpoints serialize. */
function toRecord(ev: {
  id: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  description: string | null;
  actorType: string | null;
  actorId: string | null;
  actorLabel: string | null;
  data: Record<string, unknown> | null;
}): HistoryEventRecord {
  const data = ev.data ?? {};
  const changes = data.changes;
  return {
    id: ev.id,
    event_type: ev.eventType,
    resource_type: ev.resourceType,
    resource_id: ev.resourceId,
    occurred_at: ev.occurredAt,
    description: ev.description,
    actor_type: ev.actorType,
    actor_id: ev.actorId,
    actor_label: ev.actorLabel,
    // Anything not explicitly tagged public stays internal — the safe default for the public view.
    visibility: data.visibility === "public" ? "public" : "internal",
    benchmark_id: typeof data.benchmark_id === "string" ? data.benchmark_id : null,
    changes:
      changes !== null && changes !== undefined && typeof changes === "object" && !Array.isArray(changes)
        ? (changes as Record<string, { before: unknown; after: unknown }>)
        : null,
    semantic_core: data.semantic_core === true,
  };
}
