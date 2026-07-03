// Row → JSON:API resource object. Explicit per-resource serializers that enforce the spec's rules:
// SINGULAR `type` (verified against live smplkit responses), NO relationships (parent refs are bare
// id attributes without `_id`), booleans without `is_` prefix, epoch-ms → ISO-8601, and write-only
// columns (password_hash, key_hash/key_encrypted, client_ip) never emitted.
import type { ResourceObject } from "../http/jsonapi";
import { computeMetrics, type DerivedContext } from "../logic/derived";
import { parseSampleSchema } from "../schema/sample_schema";
import type {
  AccountRow,
  AccountUserRow,
  ApiKeyRow,
  BenchmarkRow,
  InvitationRow,
  ObservationRow,
  OrgAttributionSnapshot,
  PersonalAttributionSnapshot,
  PublisherDomainRow,
  PublisherIdentityRow,
  Role,
  RunRow,
  SampleSchema,
  TargetRow,
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
      url: row.url,
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
      identity: row.published_identity_id,
      name: snap.name,
      logo_url: snap.logo_url,
      verified_domains: snap.verified_domains,
    };
  }
  const snap = JSON.parse(row.attribution_snapshot) as PersonalAttributionSnapshot;
  return {
    kind: "PERSONAL",
    display_name: snap.display_name,
    gravatar_hash: snap.email_sha256,
  };
}

export function serializeBenchmark(row: BenchmarkRow): ResourceObject {
  const attributes: Record<string, unknown> = {
    account: row.account_id,
    key: row.key,
    name: row.name,
    description: row.description,
    about: row.about,
    methodology: row.methodology,
    status: row.status,
    draft: row.draft === 1,
    created_by: row.created_by_user_id,
    published_at: isoOrNull(row.published_at),
    withdrawn_at: isoOrNull(row.withdrawn_at),
    withdrawal_reason: row.withdrawal_reason,
    sample_schema: parseSampleSchema(row.sample_schema),
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

export function serializePublisherIdentity(row: PublisherIdentityRow): ResourceObject {
  return {
    type: "publisher_identity",
    id: row.id,
    attributes: {
      account: row.account_id,
      key: row.key,
      name: row.name,
      logo_url: row.logo_url,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  };
}

export function serializePublisherDomain(row: PublisherDomainRow): ResourceObject {
  return {
    type: "publisher_domain",
    id: row.id,
    attributes: {
      account: row.account_id,
      publisher_identity: row.publisher_identity_id,
      domain: row.domain,
      status: row.status,
      verification_token: row.verification_token,
      verified: row.status === "VERIFIED",
      verified_at: isoOrNull(row.verified_at),
      last_checked_at: isoOrNull(row.last_checked_at),
      created_at: iso(row.created_at),
    },
  };
}

export function serializeTarget(row: TargetRow): ResourceObject {
  return {
    type: "target",
    id: row.id,
    attributes: {
      benchmark: row.benchmark_id,
      key: row.key,
      name: row.name,
      details: parseJsonOrNull(row.details),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  };
}

export function serializeRun(row: RunRow): ResourceObject {
  return {
    type: "run",
    id: row.id,
    attributes: {
      target: row.target_id,
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

export function serializeObservation(
  row: Pick<ObservationRow, "id" | "run_id" | "created_at" | "metrics" | "meta">,
  schema: SampleSchema,
  ctx: DerivedContext,
): ResourceObject {
  // client_ip is never surfaced. id (rowid INTEGER) is stringified on the wire.
  const attributes: Record<string, unknown> = {
    created_at: iso(row.created_at),
    run: row.run_id,
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

  return { type: "observation", id: String(row.id), attributes };
}
