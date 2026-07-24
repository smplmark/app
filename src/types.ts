// Domain row types (as stored in D1; snake_case columns), the measurement_schema shape, and the
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

/** A publisher's domain-verification lifecycle. PENDING → VERIFIED ↔ LAPSED. */
export type PublisherStatus = "PENDING" | "VERIFIED" | "LAPSED";
export const PUBLISHER_STATUSES: readonly PublisherStatus[] = [
  "PENDING",
  "VERIFIED",
  "LAPSED",
];

/** How a publisher's icon is displayed: a domain-initial monogram, or the domain's own favicon. */
export type PublisherIconKind = "monogram" | "favicon";
export const PUBLISHER_ICON_KINDS: readonly PublisherIconKind[] = ["monogram", "favicon"];

/**
 * How a published benchmark is attributed: to its author (personal), an org brand, or — for open
 * reference data seeded by the ingestion importer — its third-party source. INGESTED is never
 * settable through the API; only the importer writes it.
 */
export type PublishedKind = "PERSONAL" | "ORGANIZATION" | "INGESTED";
export const PUBLISHED_KINDS: readonly PublishedKind[] = [
  "PERSONAL",
  "ORGANIZATION",
  "INGESTED",
];

/** One coarse browse bucket per benchmark (the nav rail); tags carry the flexible long tail. */
export type Category =
  | "HARDWARE"
  | "DATABASE"
  | "ML_AI"
  | "STORAGE"
  | "NETWORK"
  | "OTHER";
export const CATEGORIES: readonly Category[] = [
  "HARDWARE",
  "DATABASE",
  "ML_AI",
  "STORAGE",
  "NETWORK",
  "OTHER",
];

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
  /** 0/1 boolean. Gates the direct personal self-publish shortcut. Surfaced as `allow_personal_publish`. */
  allow_personal_publish: number;
  created_at: number;
  /** Soft-delete stamp (epoch-ms); null while live. A deleted account is blocked at auth. Never surfaced. */
  deleted_at: number | null;
}

/** One third-party source the ingestion importer republishes from. Importer-owned; no API writes. */
export interface ExternalSourceRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  url: string;
  license: string | null;
  license_url: string | null;
  benchmark_count: number;
  /** When we last retrieved data from the source (the imported archive's pull time). */
  retrieved_at: number;
  created_at: number;
  updated_at: number;
}

export interface AccountUserRow {
  account_id: string;
  user_id: string;
  role: Role;
  created_at: number;
  /** Opaque JSON bag of the member's per-account UI preferences (e.g. theme); a JSON string or null. */
  settings: string | null;
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
  /** Publisher-declared license for the benchmark's published data (an SPDX identifier), or null.
   *  INGESTED benchmarks carry their source's license in the attribution snapshot instead. */
  license: string | null;
  /** The subject_type every linked subject must conform to (a benchmark compares like against like).
   *  Nullable at the DB level for pre-0023 rows with no subjects; the API requires it on write. */
  subject_type: string | null;
  status: Status;
  published_at: number | null;
  withdrawn_at: number | null;
  withdrawal_reason: string | null;
  /** JSON string of a MeasurementSchema. */
  measurement_schema: string;
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
  /** One coarse browse bucket (the nav rail). Tags carry the flexible long tail. */
  category: Category;
  /** Lowercased concatenation of the searchable fields — filter[search]'s low-tech index. */
  search_text: string;
  /** All-time view count (the popularity beacon increments it; windows live in benchmark_view_day). */
  views_total: number;
  /** Publisher's "complete" signal: nothing new may be added beneath. Reversible. Surfaced as `closed`. */
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TagRow {
  id: string;
  /** Lowercase slug — a free-form string, not a SCREAMING_SNAKE_CASE enum. */
  key: string;
  created_at: number;
}

export interface BenchmarkTagRow {
  benchmark_id: string;
  tag_id: string;
  created_at: number;
}

/** The frozen-at-publish attribution for an ORGANIZATION publish: the verified domain + icon choice. */
export interface OrgAttributionSnapshot {
  domain: string;
  icon: PublisherIconKind;
  /** The publisher account's creation date (epoch-ms), frozen so the public byline can show a
   *  "publishing since" line without a live account lookup. Optional: absent on pre-v-since snapshots. */
  since?: number;
}

/** The frozen-at-publish attribution for a PERSONAL publish. */
export interface PersonalAttributionSnapshot {
  display_name: string | null;
  /** SHA-256 of the author's normalized email at publish (for a stable gravatar). */
  email_sha256: string;
  /** The publisher account's creation date (epoch-ms), frozen for a "publishing since" byline.
   *  Optional: absent on pre-v-since snapshots. */
  since?: number;
}

/**
 * The frozen attribution for an INGESTED benchmark — written by the ingestion importer at insert
 * time (ingested benchmarks are born PUBLISHED; there is no API publish path for them).
 */
export interface IngestedAttributionSnapshot {
  /** e.g. "Blender Open Data". */
  source_name: string;
  /** Link back to the original data. */
  source_url: string;
  /** The source's license for the ingested results, e.g. "CC0". */
  license: string;
  /** When the archive snapshot this build came from was pulled (epoch-ms). */
  retrieved_at: number;
}

/**
 * A publisher IS a domain (§3). It's publishable once its domain is VERIFIED via DNS TXT. There's no
 * free-text name/logo — attribution shows only the verified domain — so a user can't impersonate a
 * brand they don't control.
 */
export interface PublisherRow {
  id: string;
  account_id: string;
  domain: string;
  status: PublisherStatus;
  /** The TXT record value the owner adds to DNS. Public (goes in DNS) — stored plaintext, surfaced. */
  verification_token: string;
  verified_at: number | null;
  last_checked_at: number | null;
  icon: PublisherIconKind;
  created_at: number;
}

/**
 * A subject is an account-owned entity (a system/model/config the publisher measures), reusable across
 * that account's benchmarks. Its membership in a benchmark lives in `benchmark_subject` (M:N), not on
 * the row. `key` is unique per account.
 */
export interface SubjectRow {
  id: string;
  account_id: string;
  /** The subject_type this subject conforms to. Nullable at the DB level (see 0018) but app-required. */
  subject_type_id: string | null;
  key: string;
  name: string;
  /** JSON string of the typed field values (keyed by field key), or null. */
  details: string | null;
  created_at: number;
  updated_at: number;
}

// ── Subject types ── a formal schema for subjects (a subject picks a type, then carries typed fields).
export type SubjectFieldType = "STRING" | "NUMBER" | "BOOLEAN" | "ENUM" | "DATE";
export const SUBJECT_FIELD_TYPES: readonly SubjectFieldType[] = ["STRING", "NUMBER", "BOOLEAN", "ENUM", "DATE"];

/**
 * One typed attribute a subject of a given subject_type carries. `name` is the stable identifier used
 * in the subject's `details` JSON (kebab-case, unique within the type; derived from `label` when the
 * client omits it); `label` is the human-readable display name; `description` is an optional note.
 * `max_length` applies only to STRING and `options` (the allowed values) only to ENUM.
 */
export interface SubjectFieldDef {
  name: string;
  label: string;
  type: SubjectFieldType;
  required: boolean;
  description?: string;
  max_length?: number;
  options?: string[];
}

/** A subject type: a named, account-owned schema of `fields` that subjects of this type conform to. */
export interface SubjectTypeRow {
  id: string;
  account_id: string;
  key: string;
  name: string;
  /** JSON string of SubjectFieldDef[]. */
  fields: string;
  created_at: number;
  updated_at: number;
}

// ── Metrics ── a reusable, account-owned catalogue of metric definitions (stored or computed-on-read).
// Every metric is a numeric measurement; `type` says what it is: an INTEGER or DECIMAL value clients
// POST on each measurement, or a FORMULA computed on read. What it measures (`unit`) and how it renders
// (`format`) are separate, cosmetic facets.
export type MetricType = "INTEGER" | "DECIMAL" | "FORMULA";
export const METRIC_TYPES: readonly MetricType[] = ["INTEGER", "DECIMAL", "FORMULA"];
/** The binary operators a formula step can apply: add, subtract, multiply, divide, modulo. */
export type MetricStepOp = "ADD" | "SUB" | "MUL" | "DIV" | "MOD";
export const METRIC_STEP_OPS: readonly MetricStepOp[] = ["ADD", "SUB", "MUL", "DIV", "MOD"];
/** The unary functions a formula step can apply. `created_at mod 60000` expresses a minute-skew, so no
 *  dedicated skew function is needed — floor/round/ceil/abs plus MOD cover it from primitives. */
export type MetricStepFn = "FLOOR" | "ROUND" | "CEIL" | "ABS";
export const METRIC_STEP_FNS: readonly MetricStepFn[] = ["FLOOR", "ROUND", "CEIL", "ABS"];

/** One operand in a step: another metric's value, a literal number, the measurement's `created_at`
 *  (epoch ms), or the value of an earlier step. */
export type MetricToken =
  | { kind: "METRIC"; name: string }
  | { kind: "NUMBER"; value: number }
  | { kind: "CREATED_AT" }
  | { kind: "STEP"; step: string };

/** One lettered step (A, B, C…) in a derived-metric formula: either a binary operation `a <op> b` or a
 *  unary function `fn(a)`. A step's operands may reference earlier steps, so any arithmetic tree is
 *  expressible with pickers alone (no free-text expression to parse). */
export type MetricStep =
  | { id: string; kind: "OP"; op: MetricStepOp; a: MetricToken; b: MetricToken }
  | { id: string; kind: "FN"; fn: MetricStepFn; a: MetricToken };

/** A derived-metric formula: an ordered list of steps plus the id of the step that is the metric's
 *  value. Compiled to JSON Logic by `metricExprToJsonLogic` for the compute-on-read engine. */
export interface MetricFormula {
  steps: MetricStep[];
  result: string;
}

/** A metric definition: `name` is the snake_case identifier (the key it occupies in a measurement's
 *  metrics bag, unique per account); `label` is the display name; `type` is INTEGER/DECIMAL (a value
 *  clients POST) or FORMULA (computed on read from `formula`). */
export interface MetricRow {
  id: string;
  account_id: string;
  name: string;
  label: string;
  description: string | null;
  type: MetricType;
  /** The unit of measure — a short display label (`ms`, `bytes`, `req/s`, `%`). Cosmetic; null when unset. */
  unit: string | null;
  /** An Excel-style number-format pattern (`#,##0.00`, `0.0%`). Cosmetic; null uses a default per type. */
  format: string | null;
  /** JSON string of MetricFormula, for FORMULA metrics; null otherwise. */
  formula: string | null;
  created_at: number;
  updated_at: number;
}

/** One many-to-many link between a benchmark and a subject. */
export interface BenchmarkSubjectRow {
  id: string;
  benchmark_id: string;
  subject_id: string;
  created_at: number;
}

/** One many-to-many link between a benchmark and a metric from the account's metric library. Linking
 *  snapshots the metric's definition into the benchmark's measurement_schema. */
export interface BenchmarkMetricRow {
  id: string;
  benchmark_id: string;
  metric_id: string;
  created_at: number;
}

export interface RunRow {
  id: string;
  benchmark_id: string;
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

/** Takedown-request lifecycle: OPEN until an operator fulfills (or otherwise closes) it. */
export type TakedownRequestStatus = "OPEN" | "RESOLVED";

/**
 * A request that a published benchmark be truly removed (legal/PII), filed from the public page or
 * the console and routed to smplmark operators. Never a self-serve delete: an operator fulfills it
 * via the system takedown endpoint. benchmark_id is a soft pointer (no FK) — the row must survive
 * the benchmark's deletion as the record of why it was removed.
 */
export interface TakedownRequestRow {
  id: string;
  benchmark_id: string;
  /** Snapshotted at filing so the request stays legible after the benchmark is removed. */
  benchmark_key: string;
  publisher_slug: string;
  requester_name: string;
  requester_email: string;
  reason: string;
  status: TakedownRequestStatus;
  resolved_at: number | null;
  created_at: number;
}

export interface MeasurementRow {
  /** rowid — database-assigned INTEGER; stringified on the wire. */
  id: number;
  run_id: string;
  subject_id: string;
  created_at: number;
  /** JSON string or null (stored metrics only). */
  metrics: string | null;
  /** JSON string or null. */
  meta: string | null;
  /** From CF-Connecting-IP. Write-only: captured on ingest, never surfaced. */
  client_ip: string | null;
}

// ── measurement_schema ──────────────────────────────────────────────────────────

/** A JSON Logic rule, e.g. `{ "minute_offset_ms": [{ "var": "created_at" }] }`. */
export type JsonLogicRule = unknown;

/** A stored numeric value a client supplies on write. */
export interface MetricDecl {
  name: string;
  type: string;
  /** Cosmetic display label. */
  unit?: string;
  /** Excel-style number-format pattern for display. Cosmetic. */
  format?: string;
  /** Human-readable description, surfaced on the benchmark page. Cosmetic. */
  description?: string;
}

/** A numeric value computed on read from a JSON Logic expression against the widened context. */
export interface DerivedDecl {
  name: string;
  /** Cosmetic display label. */
  unit?: string;
  /** Excel-style number-format pattern for display. Cosmetic. */
  format?: string;
  /** The compiled JSON Logic formula. INTERNAL only: resolved live from the linked library metric for
   *  compute-on-read, and never surfaced in the API — the formula is not part of the public contract.
   *  Optional because a stored snapshot (or a client's get-mutate-put round-trip) may omit it. */
  expr?: JsonLogicRule;
  /** Human-readable description, surfaced on the benchmark page. Cosmetic. */
  description?: string;
}

/** How the site's chart should render this benchmark by default. Semantic core — a post-publish
 *  change is allowed but flagged in the audited History. */
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

export interface MeasurementSchema {
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
  /** The key id, for API_KEY credentials; null for SESSION. Identifies the actor in audit events. */
  api_key_id: string | null;
}
