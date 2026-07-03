// Domain row types (as stored in D1; snake_case columns), the sample_schema shape, and the
// resolved auth context. This is the shared vocabulary the whole codebase speaks.

// ── Enums (SCREAMING_SNAKE_CASE on the wire, per ADR-014) ────────────────────

/** Benchmark lifecycle. PRIVATE → PUBLISHED (one-way) → WITHDRAWN (one-way). */
export type Status = "PRIVATE" | "PUBLISHED" | "WITHDRAWN";
export const STATUSES: readonly Status[] = ["PRIVATE", "PUBLISHED", "WITHDRAWN"];

/** API-key scope. Grants read+write on the scoped resource and its whole subtree. */
export type ScopeType = "ACCOUNT" | "BENCHMARK" | "RUN";
export const SCOPE_TYPES: readonly ScopeType[] = ["ACCOUNT", "BENCHMARK", "RUN"];

/** Login method. */
export type Provider = "GOOGLE" | "MICROSOFT" | "PASSWORD";
export const PROVIDERS: readonly Provider[] = ["GOOGLE", "MICROSOFT", "PASSWORD"];

/**
 * Account membership role. A strict superset chain (mirrors smplkit): each tier inherits everything
 * below it. VIEWER (read-only) < MEMBER (create/edit benchmarks) < ADMIN (manage users, keys,
 * settings) < OWNER (delete account, immutable). Every account has exactly one OWNER — its creator.
 */
export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export const ROLES: readonly Role[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

/** Roles that can be handed out via invitation. OWNER is never invitable. */
export type InvitableRole = "ADMIN" | "MEMBER" | "VIEWER";
export const INVITABLE_ROLES: readonly InvitableRole[] = ["ADMIN", "MEMBER", "VIEWER"];

/** Invitation lifecycle. PENDING → ACCEPTED | REVOKED | EXPIRED (each terminal). */
export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
export const INVITATION_STATUSES: readonly InvitationStatus[] = [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
];

/** A publisher domain's verification lifecycle. PENDING → VERIFIED ↔ LAPSED. */
export type PublisherDomainStatus = "PENDING" | "VERIFIED" | "LAPSED";
export const PUBLISHER_DOMAIN_STATUSES: readonly PublisherDomainStatus[] = [
  "PENDING",
  "VERIFIED",
  "LAPSED",
];

/** How a published benchmark is attributed: to its author (personal) or an org brand. */
export type PublishedKind = "PERSONAL" | "ORGANIZATION";
export const PUBLISHED_KINDS: readonly PublishedKind[] = ["PERSONAL", "ORGANIZATION"];

// ── Identity & tenancy ───────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  /** 0/1 boolean. Surfaced as `verified` (no is_ prefix). */
  email_verified: number;
  display_name: string | null;
  created_at: number;
}

export interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: Provider;
  /** OIDC subject, or null for PASSWORD. */
  provider_subject: string | null;
  /** PBKDF2 hash string, or null unless PASSWORD. Never surfaced. */
  password_hash: string | null;
  created_at: number;
}

export interface AccountRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  url: string | null;
  /** 0/1 boolean. Gates the direct personal self-publish shortcut. Surfaced as `allow_personal_publish`. */
  allow_personal_publish: number;
  created_at: number;
}

export interface AccountUserRow {
  account_id: string;
  user_id: string;
  role: Role;
  created_at: number;
}

export interface InvitationRow {
  id: string;
  account_id: string;
  email: string;
  role: InvitableRole;
  /** SHA-256 of the emailed token (plaintext never stored). Rotated on resend. */
  token_hash: string;
  status: InvitationStatus;
  invited_by_user_id: string | null;
  expires_at: number;
  accepted_at: number | null;
  created_at: number;
}

export interface EmailVerificationRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

// ── API keys ─────────────────────────────────────────────────────────────────

export interface ApiKeyRow {
  id: string;
  account_id: string;
  name: string;
  scope_type: ScopeType;
  scope_ref: string | null;
  key_hash: string;
  key_encrypted: string;
  prefix: string;
  expires_at: number | null;
  created_by_user_id: string | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

// ── Benchmark hierarchy ──────────────────────────────────────────────────────

export interface BenchmarkRow {
  id: string;
  account_id: string;
  key: string;
  name: string;
  description: string | null;
  about: string | null;
  methodology: string | null;
  status: Status;
  published_at: number | null;
  withdrawn_at: number | null;
  withdrawal_reason: string | null;
  /** JSON string of a SampleSchema. */
  sample_schema: string;
  /** The user who created the benchmark, or null if an API key created it. */
  created_by_user_id: string | null;
  /** 0/1 boolean. 1 = still cooking (editable); 0 = marked ready (subtree locked). Surfaced as `draft`. */
  draft: number;
  /** The user who performed the publish (the admin, for an org publish); null until published. */
  published_by_user_id: string | null;
  /** How the published benchmark is attributed; null until published. */
  published_as_kind: PublishedKind | null;
  /** Soft pointer to the org identity for an ORGANIZATION publish; null otherwise (no FK — see 0003). */
  published_identity_id: string | null;
  /** JSON AttributionSnapshot, frozen at publish; null until published. */
  attribution_snapshot: string | null;
  created_at: number;
  updated_at: number;
}

/** The frozen-at-publish attribution for an ORGANIZATION publish. */
export interface OrgAttributionSnapshot {
  name: string;
  logo_url: string | null;
  /** Domains that were VERIFIED at the instant of publish. */
  verified_domains: string[];
}

/** The frozen-at-publish attribution for a PERSONAL publish. */
export interface PersonalAttributionSnapshot {
  display_name: string | null;
  /** SHA-256 of the author's normalized email at publish (for a stable gravatar). */
  email_sha256: string;
}

export interface PublisherIdentityRow {
  id: string;
  account_id: string;
  key: string;
  name: string;
  logo_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface PublisherDomainRow {
  id: string;
  account_id: string;
  publisher_identity_id: string;
  domain: string;
  /** The TXT record value the user adds to DNS. Public (goes in DNS) — stored plaintext, surfaced. */
  verification_token: string;
  status: PublisherDomainStatus;
  verified_at: number | null;
  last_checked_at: number | null;
  created_at: number;
}

export interface TargetRow {
  id: string;
  benchmark_id: string;
  key: string;
  name: string;
  /** JSON string or null. */
  details: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  target_id: string;
  key: string;
  name: string | null;
  /** JSON string or null. */
  details: string | null;
  started_at: number | null;
  /** NULL ⇒ live. */
  ended_at: number | null;
  invalidated_at: number | null;
  invalidation_reason: string | null;
  invalidated_by_user_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ObservationRow {
  /** rowid — database-assigned INTEGER; stringified on the wire. */
  id: number;
  run_id: string;
  created_at: number;
  /** JSON string or null (stored metrics only). */
  metrics: string | null;
  /** JSON string or null. */
  meta: string | null;
  /** From CF-Connecting-IP. Write-only: captured on ingest, never surfaced. */
  client_ip: string | null;
}

// ── sample_schema ──────────────────────────────────────────────────────────

/** A JSON Logic rule, e.g. `{ "minute_offset_ms": [{ "var": "created_at" }] }`. */
export type JsonLogicRule = unknown;

/** A stored numeric value a client supplies on write. */
export interface MetricDecl {
  name: string;
  type: string;
  /** Cosmetic — editable after publish. */
  unit?: string;
  /** Human-readable description, surfaced on the benchmark page. Cosmetic — editable after publish. */
  description?: string;
}

/** A numeric value computed on read from a JSON Logic expression against the widened context. */
export interface DerivedDecl {
  name: string;
  /** Cosmetic — editable after publish. */
  unit?: string;
  /** Semantic core — frozen on publish. */
  expr: JsonLogicRule;
  /** Human-readable description, surfaced on the benchmark page. Cosmetic — editable after publish. */
  description?: string;
}

/** How the site's chart should render this benchmark by default. Semantic core — frozen on publish. */
export type XKind = "TIME" | "NUMBER" | "CATEGORY";
export const X_KINDS: readonly XKind[] = ["TIME", "NUMBER", "CATEGORY"];

export interface ChartDecl {
  /** A metric name, or "created_at", or null (scalar / no x-axis). */
  x: string | null;
  /** A metric name. */
  y: string;
  /** Optional; inferred from `x` when absent. */
  x_kind?: XKind;
}

export interface SampleSchema {
  metrics: MetricDecl[];
  derived: DerivedDecl[];
  /** Optional default chart declaration; the visitor may override at chart time. */
  chart?: ChartDecl;
}

// ── Auth context ─────────────────────────────────────────────────────────────

/**
 * The uniform authenticated principal both credential sources resolve to, so handlers never branch
 * on method. A session OWNER normalizes to ACCOUNT scope (full-account authority). `scope_type` /
 * `scope_ref` are the *effective* authority used by the authorization layer (§7).
 */
export interface AuthContext {
  source: "API_KEY" | "SESSION";
  account_id: string;
  scope_type: ScopeType;
  scope_ref: string | null;
  /** The acting user, for SESSION credentials; null for API_KEY. */
  user_id: string | null;
  /** The account role, for SESSION credentials; null for API_KEY. */
  role: Role | null;
  /** The session id (jti), for SESSION credentials; null for API_KEY. Used by logout. */
  session_id: string | null;
}
