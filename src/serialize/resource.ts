// Row → JSON:API resource object. Explicit per-resource serializers that enforce the spec's rules:
// SINGULAR `type` (verified against live smplkit responses), NO relationships (parent refs are bare
// id attributes without `_id`), booleans without `is_` prefix, epoch-ms → ISO-8601, and write-only
// columns (password_hash, key_hash/key_encrypted, client_ip) never emitted.
import type { ResourceObject } from "../http/jsonapi";
import { computeMetrics, type DerivedContext } from "../logic/derived";
import { parseMeasurementSchema } from "../schema/measurement_schema";
import { metricExprToJsonLogic, parseStoredFormula } from "../schema/metric";
import { parseStoredFieldDefs } from "../schema/subject_type";
import type {
  AccountRow,
  AccountUserRow,
  ApiKeyRow,
  BenchmarkMetricRow,
  BenchmarkRow,
  BenchmarkSubjectRow,
  DerivedDecl,
  ExternalSourceRow,
  IngestedAttributionSnapshot,
  InvitationRow,
  MeasurementRow,
  MetricRow,
  OrgAttributionSnapshot,
  PersonalAttributionSnapshot,
  PublisherRow,
  Role,
  RunRow,
  MeasurementSchema,
  SubjectRow,
  SubjectTypeRow,
  UserRow,
} from "../types";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
function parseJsonOrNull(s: string | null): unknown {
  return s === null ? null : JSON.parse(s);
}

export function serializeUser(row: UserRow): ResourceObject {
  return {
    type: "user",
    id: row.id,
    attributes: {
      email: row.email,
      verified: row.email_verified === 1,
      display_name: row.display_name,
      created_at: iso(row.created_at),
    },
  };
}

export function serializeAccount(row: AccountRow): ResourceObject {
  return {
    type: "account",
    id: row.id,
    attributes: {
      key: row.key,
      name: row.name,
      description: row.description,
      allow_personal_publish: row.allow_personal_publish === 1,
      created_at: iso(row.created_at),
    },
  };
}

/**
 * A membership. When the caller passes the joined identity fields (the members-list query), the
 * member's `email`, `display_name`, and `verified` are surfaced too; the bare form omits them.
 */
export function serializeAccountUser(
  row: AccountUserRow & {
    email?: string;
    display_name?: string | null;
    email_verified?: number;
  },
): ResourceObject {
  const attributes: Record<string, unknown> = {
    account: row.account_id,
    user: row.user_id,
    role: row.role,
    created_at: iso(row.created_at),
  };
  if (row.email !== undefined) {
    attributes.email = row.email;
    attributes.display_name = row.display_name ?? null;
    attributes.verified = row.email_verified === 1;
  }
  return {
    type: "account_user",
    id: `${row.account_id}:${row.user_id}`,
    attributes,
  };
}

/** One of the caller's accounts, carrying their role in it (the account switcher). */
export function serializeAccountMembership(row: {
  account_id: string;
  account_key: string;
  account_name: string;
  role: Role;
  created_at: number;
}): ResourceObject {
  return {
    type: "account_membership",
    id: row.account_id,
    attributes: {
      account: row.account_id,
      key: row.account_key,
      name: row.account_name,
      role: row.role,
      created_at: iso(row.created_at),
    },
  };
}

/** `token` (the emailed plaintext) is included only on create + resend, never on list. */
export function serializeInvitation(row: InvitationRow, token?: string): ResourceObject {
  const attributes: Record<string, unknown> = {
    account: row.account_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invited_by_user: row.invited_by_user_id,
    expires_at: iso(row.expires_at),
    accepted_at: isoOrNull(row.accepted_at),
    created_at: iso(row.created_at),
  };
  if (token !== undefined) attributes.token = token;
  return { type: "invitation", id: row.id, attributes };
}

/** `plaintext` is included (as the `key` attribute) only on create + reveal, never on list. */
export function serializeApiKey(
  row: ApiKeyRow,
  plaintext?: string,
): ResourceObject {
  const attributes: Record<string, unknown> = {
    account: row.account_id,
    name: row.name,
    scope_type: row.scope_type,
    scope_ref: row.scope_ref,
    prefix: row.prefix,
    expires_at: isoOrNull(row.expires_at),
    last_used_at: isoOrNull(row.last_used_at),
    revoked: row.revoked_at !== null,
    created_by_user: row.created_by_user_id,
    created_at: iso(row.created_at),
  };
  if (plaintext !== undefined) attributes.key = plaintext;
  return { type: "api_key", id: row.id, attributes };
}

/**
 * The publish-attribution badge, sourced entirely from the frozen `attribution_snapshot` (never a live
 * lookup) so it survives a later domain lapse or identity deletion. `null` for an unpublished benchmark.
 */
function buildPublishedAs(row: BenchmarkRow): Record<string, unknown> | null {
  if (row.published_as_kind === null || row.attribution_snapshot === null) return null;
  if (row.published_as_kind === "ORGANIZATION") {
    const snap = JSON.parse(row.attribution_snapshot) as OrgAttributionSnapshot;
    return {
      kind: "ORGANIZATION",
      domain: snap.domain,
      icon: snap.icon,
      ...(snap.since != null ? { since: iso(snap.since) } : {}),
    };
  }
  if (row.published_as_kind === "INGESTED") {
    const snap = JSON.parse(row.attribution_snapshot) as IngestedAttributionSnapshot;
    return {
      kind: "INGESTED",
      source_name: snap.source_name,
      source_url: snap.source_url,
      license: snap.license,
      retrieved_at: iso(snap.retrieved_at),
    };
  }
  const snap = JSON.parse(row.attribution_snapshot) as PersonalAttributionSnapshot;
  return {
    kind: "PERSONAL",
    display_name: snap.display_name,
    gravatar_hash: snap.email_sha256,
    ...(snap.since != null ? { since: iso(snap.since) } : {}),
  };
}

/**
 * `tags` comes from the benchmark_tag join — callers fetch it alongside the row(s). The row carries
 * `publisher_slug` (the owning account's key) from the read-path resolution; it pairs with `key` to
 * form the benchmark's public URL, `/{publisher_slug}/{key}`. It also carries `subject_type_key` —
 * the referenced subject type's public key — resolved via a join on the internal subject_type UUID;
 * the raw UUID (row.subject_type) is never surfaced. Null when the benchmark has no subject type.
 */
export function serializeBenchmark(
  row: BenchmarkRow & { publisher_slug: string; subject_type_key: string | null },
  tags: readonly string[],
  // The benchmark's LIVE derived metrics (resolved from its linked FORMULA metrics via
  // loadLiveDerivedByBenchmark). When provided, they replace the stored measurement_schema.derived
  // SNAPSHOT so the console surfaces the CURRENT formula/unit/format the moment a library metric is
  // edited. Omitted (or undefined) → the stored snapshot is surfaced unchanged.
  liveDerived?: DerivedDecl[],
): ResourceObject {
  const measurement_schema = parseMeasurementSchema(row.measurement_schema);
  // Surface derived metrics WITHOUT their JSON Logic `expr`: the formula is an internal implementation
  // detail (resolved live from the linked library metric), not part of the public contract. The
  // consumer references metrics by name and reads computed values from each measurement's `metrics`.
  const derivedSource = liveDerived ?? measurement_schema.derived;
  measurement_schema.derived = derivedSource.map((d) => {
    const pub: DerivedDecl = { name: d.name };
    if (d.unit !== undefined) pub.unit = d.unit;
    if (d.format !== undefined) pub.format = d.format;
    if (d.description !== undefined) pub.description = d.description;
    return pub;
  });
  const attributes: Record<string, unknown> = {
    account: row.account_id,
    publisher_slug: row.publisher_slug,
    key: row.key,
    name: row.name,
    description: row.description,
    about: row.about,
    methodology: row.methodology,
    // The subject type is referenced by its key (its public id), consistent with the subject_type
    // resource; the internal subject_type UUID is never surfaced. Null when the benchmark is untyped.
    subject_type: row.subject_type_key,
    status: row.status,
    draft: row.draft === 1,
    created_by: row.created_by_user_id,
    published_at: isoOrNull(row.published_at),
    withdrawn_at: isoOrNull(row.withdrawn_at),
    withdrawal_reason: row.withdrawal_reason,
    measurement_schema,
    category: row.category,
    tags: [...tags],
    views: row.views_total,
    closed: row.closed_at !== null,
    closed_at: isoOrNull(row.closed_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
  const publishedAs = buildPublishedAs(row);
  if (publishedAs !== null) {
    attributes.published_by = row.published_by_user_id;
    attributes.published_as = publishedAs;
  }
  return { type: "benchmark", id: row.id, attributes };
}

export function serializePublisher(row: PublisherRow): ResourceObject {
  return {
    type: "publisher",
    id: row.id,
    attributes: {
      account: row.account_id,
      domain: row.domain,
      status: row.status,
      verification_token: row.verification_token,
      verified: row.status === "VERIFIED",
      verified_at: isoOrNull(row.verified_at),
      last_checked_at: isoOrNull(row.last_checked_at),
      icon: row.icon,
      created_at: iso(row.created_at),
    },
  };
}

export function serializeSubject(
  row: SubjectRow & { subject_type_key: string | null },
): ResourceObject {
  return {
    type: "subject",
    // The customer's key is the public id for a subject; the internal UUID (row.id) is never surfaced.
    id: row.key,
    attributes: {
      account: row.account_id,
      // The subject_type is referenced by its key (its public id), consistent with the subject_type
      // resource; the internal subject_type_id UUID is never surfaced. Null when the subject is untyped.
      subject_type: row.subject_type_key,
      key: row.key,
      name: row.name,
      details: parseJsonOrNull(row.details),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  };
}

export function serializeSubjectType(row: SubjectTypeRow): ResourceObject {
  return {
    type: "subject_type",
    // The customer's key is the public id for a subject type; the internal UUID (row.id) is never surfaced.
    id: row.key,
    attributes: {
      account: row.account_id,
      key: row.key,
      name: row.name,
      fields: parseStoredFieldDefs(row.fields),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  };
}

export function serializeMetric(row: MetricRow): ResourceObject {
  const formula = parseStoredFormula(row.formula);
  return {
    type: "metric",
    id: row.id,
    attributes: {
      account: row.account_id,
      name: row.name,
      label: row.label,
      description: row.description,
      type: row.type,
      unit: row.unit,
      format: row.format,
      // The structured formula (FORMULA metrics only), plus the JSON Logic it compiles to — the
      // expression the compute-on-read engine evaluates once the metric is attached to a benchmark.
      formula: formula,
      expr: formula ? metricExprToJsonLogic(formula) : null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  };
}

/** One membership of a subject in a benchmark (the M:N link). */
export function serializeBenchmarkSubject(
  row: BenchmarkSubjectRow & { subject_key: string },
): ResourceObject {
  return {
    type: "benchmark_subject",
    id: row.id,
    attributes: {
      benchmark: row.benchmark_id,
      // The subject is referenced by its key (its public id), consistent with the subject resource.
      subject: row.subject_key,
      created_at: iso(row.created_at),
    },
  };
}

/** One membership of a library metric in a benchmark (the M:N link). */
export function serializeBenchmarkMetric(row: BenchmarkMetricRow): ResourceObject {
  return {
    type: "benchmark_metric",
    id: row.id,
    attributes: {
      benchmark: row.benchmark_id,
      metric: row.metric_id,
      created_at: iso(row.created_at),
    },
  };
}

export function serializeRun(row: RunRow): ResourceObject {
  return {
    type: "run",
    // The customer's key is the public id for a run; the internal UUID (row.id) is never surfaced.
    id: row.key,
    attributes: {
      // The benchmark stays a UUID — benchmarks are a later slice of the key-as-id migration.
      benchmark: row.benchmark_id,
      key: row.key,
      name: row.name,
      details: parseJsonOrNull(row.details),
      started_at: isoOrNull(row.started_at),
      ended_at: isoOrNull(row.ended_at),
      live: row.ended_at === null,
      invalidated: row.invalidated_at !== null,
      invalidated_at: isoOrNull(row.invalidated_at),
      invalidation_reason: row.invalidation_reason,
      invalidated_by_user: row.invalidated_by_user_id,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  };
}

export function serializeMeasurement(
  row: Pick<MeasurementRow, "id" | "run_id" | "subject_id" | "created_at" | "metrics" | "meta"> & {
    subject_key: string;
    run_key: string;
  },
  schema: MeasurementSchema,
  ctx: DerivedContext,
): ResourceObject {
  // client_ip is never surfaced. id (rowid INTEGER) is stringified on the wire. A measurement names
  // both its run (the occasion) and its subject (the thing measured). Both are referenced by their
  // key (their public id): the run by run_key, the subject by subject_key — never their internal UUIDs.
  const attributes: Record<string, unknown> = {
    created_at: iso(row.created_at),
    run: row.run_key,
    subject: row.subject_key,
  };
  const metrics = computeMetrics(row.metrics, schema, ctx);
  if (metrics !== null) attributes.metrics = metrics;

  const meta = parseJsonOrNull(row.meta);
  if (
    meta !== null &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    Object.keys(meta).length > 0
  ) {
    attributes.meta = meta;
  }

  return { type: "measurement", id: String(row.id), attributes };
}

/**
 * The publisher-facing display label for a benchmark's attribution — what the PUBLIC History shows
 * as the actor instead of an individual user or key (never an email or user id). Falls back to the
 * account's URL slug for unpublished rows (covered-caller surfaces only).
 */
export function publisherLabel(row: BenchmarkRow & { publisher_slug: string }): string {
  const publishedAs = buildPublishedAs(row);
  if (publishedAs !== null) {
    if (publishedAs.kind === "ORGANIZATION") return publishedAs.domain as string;
    if (publishedAs.kind === "INGESTED") return publishedAs.source_name as string;
    return (publishedAs.display_name as string | null) ?? row.publisher_slug;
  }
  return row.publisher_slug;
}

/**
 * One audit event from Smpl Audit, rendered for a History tab. Two views: the console (covered
 * caller) sees the real actor; the public view passes `redact` and the actor collapses to the
 * publisher identity — individual emails and user ids never reach the public surface.
 */
export function serializeHistoryEvent(
  ev: {
    id: string;
    event_type: string;
    resource_type: string;
    resource_id: string;
    occurred_at: string;
    description: string | null;
    actor_type: string | null;
    actor_id: string | null;
    actor_label: string | null;
    visibility: "public" | "internal";
    benchmark_id: string | null;
    changes: Record<string, { before: unknown; after: unknown }> | null;
    semantic_core: boolean;
  },
  redact: { publisher_label: string } | null,
): ResourceObject {
  const actor =
    redact !== null
      ? { type: "PUBLISHER", id: null, label: redact.publisher_label }
      : { type: ev.actor_type, id: ev.actor_id, label: ev.actor_label };
  return {
    type: "history_event",
    id: ev.id,
    attributes: {
      event_type: ev.event_type,
      resource_type: ev.resource_type,
      resource_id: ev.resource_id,
      benchmark: ev.benchmark_id,
      occurred_at: ev.occurred_at,
      description: ev.description,
      actor,
      changes: ev.changes,
      semantic_core: ev.semantic_core,
      visibility: ev.visibility,
    },
  };
}

/** A takedown request as echoed back to its (possibly anonymous) submitter. */
export function serializeTakedownRequest(row: {
  id: string;
  benchmark_id: string;
  requester_name: string;
  requester_email: string;
  reason: string;
  status: string;
  created_at: number;
}): ResourceObject {
  return {
    type: "takedown_request",
    id: row.id,
    attributes: {
      benchmark: row.benchmark_id,
      requester_name: row.requester_name,
      requester_email: row.requester_email,
      reason: row.reason,
      status: row.status,
      created_at: iso(row.created_at),
    },
  };
}

/** The external-source catalog entry (importer-maintained; see GET /api/v1/external_sources). */
export function serializeExternalSource(row: ExternalSourceRow): ResourceObject {
  return {
    type: "external_source",
    id: row.id,
    attributes: {
      key: row.key,
      name: row.name,
      description: row.description,
      url: row.url,
      license: row.license,
      license_url: row.license_url,
      benchmark_count: row.benchmark_count,
      retrieved_at: iso(row.retrieved_at),
    },
  };
}
