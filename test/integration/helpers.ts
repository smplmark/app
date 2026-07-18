import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import { clearScopeCache } from "../../src/auth/scope_cache";
import type { MeasurementSchema } from "../../src/types";

export const JSONAPI = "application/vnd.api+json";

export const SKEW_SCHEMA: MeasurementSchema = {
  metrics: [],
  derived: [
    { name: "skew_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } },
  ],
  chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
};

// Every table, child-first, so resetDb never trips a logical FK.
const TABLES = [
  "takedown_request",
  "external_source",
  "measurement",
  "benchmark_metric",
  "benchmark_subject",
  "run",
  "subject",
  "benchmark_tag",
  "tag",
  "benchmark_view_day",
  "benchmark",
  "subject_type",
  "metric",
  "publisher",
  "api_key",
  "email_verification",
  "session",
  "invitation",
  "account_user",
  "account",
  "user_identity",
  "user",
] as const;

export async function resetDb(): Promise<void> {
  for (const t of TABLES) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  clearScopeCache();
}

const base = (path: string) => `http://smplmark.test${path}`;

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function apiGet(path: string, headers: Record<string, string> = {}) {
  return SELF.fetch(base(path), { headers });
}

export function apiPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(base(path), {
    method: "POST",
    headers: { "Content-Type": JSONAPI, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(base(path), {
    method: "PUT",
    headers: { "Content-Type": JSONAPI, ...headers },
    body: JSON.stringify(body),
  });
}

export function apiDelete(path: string, headers: Record<string, string> = {}) {
  return SELF.fetch(base(path), { method: "DELETE", headers });
}

/** POST a plain-JSON (non-resource) auth body. */
export function authPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(base(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export interface Resource {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
}

export interface Registered {
  token: string;
  account_id: string;
  user_id: string;
}

let seq = 0;

/** Register a fresh user+account; returns the session token + ids. */
export async function register(email?: string): Promise<Registered> {
  seq += 1;
  const res = await authPost("/api/v1/auth/register", {
    email: email ?? `user${seq}-${Date.now()}@example.com`,
    password: "correct horse battery",
    display_name: "Test User",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Registered;
}

/** Mark a user's email verified directly (skips the email round-trip in tests). */
export async function markVerified(userId: string): Promise<void> {
  await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(userId).run();
}

/** Invite an email to an account at a role (admin token); returns the invitation resource (+ token). */
export async function invite(token: string, email: string, role: string): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/invitations",
    { data: { type: "invitation", attributes: { email, role } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Register `email`, accept the invite, and switch into the inviter's account; returns a scoped token. */
export async function joinAs(
  email: string,
  inviterAccountId: string,
  inviteToken: string,
): Promise<{ user: Registered; memberToken: string }> {
  const user = await register(email);
  const acc = await apiPost(
    "/api/v1/invitations/accept",
    { data: { type: "invitation", attributes: { token: inviteToken } } },
    bearer(user.token),
  );
  expect(acc.status).toBe(200);
  const sw = await authPost("/api/v1/auth/switch", { account_id: inviterAccountId }, bearer(user.token));
  expect(sw.status).toBe(200);
  const memberToken = ((await sw.json()) as { token: string }).token;
  return { user, memberToken };
}

/** Invite + join in one step, returning the new member's session token (scoped to the account) + user. */
export async function addMember(
  ownerToken: string,
  ownerAccountId: string,
  email: string,
  role: string,
): Promise<{ user: Registered; memberToken: string }> {
  const inv = await invite(ownerToken, email, role);
  return joinAs(email, ownerAccountId, inv.attributes.token as string);
}

/** Create a benchmark (PRIVATE by default); returns its resource. `subject_type` is required by the
 *  API, so the account's default subject type is supplied unless the caller passes one. */
export async function makeBenchmark(
  token: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const subject_type = (attrs.subject_type as string | undefined) ?? (await defaultSubjectTypeId(token));
  const res = await apiPost(
    "/api/v1/benchmarks",
    {
      data: {
        type: "benchmark",
        attributes: {
          key: "scheduler-latency",
          name: "Scheduler Latency",
          measurement_schema: SKEW_SCHEMA,
          subject_type,
          ...attrs,
        },
      },
    },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Create a metric in the account library (defaults to a DECIMAL metric); returns its resource. */
export async function makeMetric(
  token: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/metrics",
    { data: { type: "metric", attributes: { label: "Throughput", type: "DECIMAL", ...attrs } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Link a library metric into a benchmark (M:N, snapshots into measurement_schema). Returns the link. */
export async function linkMetric(
  token: string,
  benchmarkId: string,
  metricId: string,
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/benchmark_metrics",
    { data: { type: "benchmark_metric", attributes: { benchmark: benchmarkId, metric: metricId } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Create a subject type (defaults to a no-field "Default" type); returns its resource. */
export async function makeSubjectType(
  token: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/subject_types",
    { data: { type: "subject_type", attributes: { name: "Default", ...attrs } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/**
 * The internal UUID of a subject type. The subject_type API now exposes its key as the public id (the
 * key-as-id migration), but benchmark create/update still reference a subject type by its internal
 * UUID (the benchmark slice is not migrated yet — it keeps taking/storing/emitting the UUID). Tests
 * that drive a benchmark endpoint therefore resolve the UUID from the DB rather than the (now
 * key-valued) resource id. Subject endpoints accept either, so this is safe to feed them too.
 */
export async function subjectTypeUuid(st: Resource): Promise<string> {
  const row = await env.DB
    .prepare("SELECT id FROM subject_type WHERE account_id = ? AND key = ?")
    .bind(st.attributes.account as string, st.attributes.key as string)
    .first<{ id: string }>();
  if (row === null) throw new Error(`subject type not found for key ${String(st.attributes.key)}`);
  return row.id;
}

/** The account's first subject type (its internal UUID), creating a no-field default on demand — so
 *  subject/benchmark helpers can satisfy the required `subject_type` without every caller wiring one up. */
async function defaultSubjectTypeId(token: string): Promise<string> {
  const list = (await (await apiGet("/api/v1/subject_types", bearer(token))).json()) as { data: Resource[] };
  const st = list.data.length > 0 ? list.data[0] : await makeSubjectType(token);
  return subjectTypeUuid(st);
}

/** Create an account-owned subject (not linked to any benchmark). Uses the account's default type
 *  unless a `subject_type` is supplied in attrs. */
export async function makeAccountSubject(
  token: string,
  key = "sched-a",
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const subject_type = (attrs.subject_type as string | undefined) ?? (await defaultSubjectTypeId(token));
  const res = await apiPost(
    "/api/v1/subjects",
    { data: { type: "subject", attributes: { key, name: key, subject_type, ...attrs } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Link an existing subject into a benchmark (M:N). Returns the benchmark_subject link resource. */
export async function linkSubject(
  token: string,
  benchmarkId: string,
  subjectId: string,
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/benchmark_subjects",
    { data: { type: "benchmark_subject", attributes: { benchmark: benchmarkId, subject: subjectId } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/**
 * Create an account subject and link it into a benchmark in one step (the common "add a subject to my
 * benchmark" path), returning the subject resource — the M:N shape of the old benchmark-scoped helper.
 */
export async function makeSubject(
  token: string,
  benchmarkId: string,
  key = "sched-a",
): Promise<Resource> {
  const subject = await makeAccountSubject(token, key);
  await linkSubject(token, benchmarkId, subject.id);
  return subject;
}

/** The internal UUID behind a run's key — never surfaced by the API, read straight from D1 so a test
 *  can supply it where an internal reference still keyed by UUID is needed (an api_key `scope_ref`, an
 *  audit `resource_id`). Run keys are unique per benchmark, so the run's `benchmark` disambiguates. */
export async function runUuid(run: Resource): Promise<string> {
  const row = await env.DB
    .prepare("SELECT id FROM run WHERE benchmark_id = ? AND key = ?")
    .bind(run.attributes.benchmark, run.id)
    .first<{ id: string }>();
  return row!.id;
}

export async function makeRun(
  token: string,
  benchmarkId: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/runs",
    { data: { type: "run", attributes: { benchmark: benchmarkId, key: "default", ...attrs } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Record a measurement naming a run + a subject (both must share a benchmark). */
export async function makeMeasurement(
  token: string,
  runId: string,
  subjectId: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/measurements",
    { data: { type: "measurement", attributes: { run: runId, subject: subjectId, ...attrs } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Mint an API key; returns the plaintext + the resource. */
export async function mintKey(
  token: string,
  attrs: { name?: string; scope_type: string; scope_ref?: string | null },
): Promise<{ key: string; resource: Resource }> {
  const res = await apiPost(
    "/api/v1/api_keys",
    { data: { type: "api_key", attributes: { name: "test-key", ...attrs } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  const resource = ((await res.json()) as { data: Resource }).data;
  return { key: resource.attributes.key as string, resource };
}

/** Mark a benchmark ready to publish (author or admin). */
export async function markReady(token: string, benchmarkId: string): Promise<void> {
  const res = await apiPost(
    `/api/v1/benchmarks/${benchmarkId}/actions/mark_ready`,
    undefined,
    bearer(token),
  );
  expect(res.status).toBe(200);
}

/** Turn on the personal-publish opt-in for the account that owns this benchmark (test shortcut). */
export async function allowPersonalPublish(benchmarkId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE account SET allow_personal_publish = 1 WHERE id = (SELECT account_id FROM benchmark WHERE id = ?)",
  )
    .bind(benchmarkId)
    .run();
}

/**
 * Ensure the benchmark clears the publish readiness gate (>=1 subject, metric, run, measurement) by
 * creating whatever is missing. Metrics come from the schema, which makeBenchmark's SKEW_SCHEMA
 * already satisfies. Idempotent: existing content is reused, seeds get unique keys.
 */
export async function seedPublishable(token: string, benchmarkId: string): Promise<void> {
  const h = bearer(token);
  const hex = () => crypto.randomUUID().slice(0, 8);
  const list = async (url: string): Promise<Resource[]> =>
    (((await (await apiGet(url, h)).json()) as { data: Resource[] }).data);

  let subjects = await list(`/api/v1/subjects?filter[benchmark]=${benchmarkId}&page[size]=1`);
  if (subjects.length === 0) {
    const s = await makeAccountSubject(token, `seed-${hex()}`);
    await linkSubject(token, benchmarkId, s.id);
    subjects = [s];
  }
  const runs = await list(`/api/v1/runs?filter[benchmark]=${benchmarkId}&page[size]=100`);
  let liveRun = runs.find((r) => r.attributes.ended_at === null && !r.attributes.invalidated);
  if (!liveRun) liveRun = await makeRun(token, benchmarkId, { key: `seed-${hex()}` });
  const meas = await list(`/api/v1/measurements?filter[benchmark]=${benchmarkId}&page[size]=1`);
  if (meas.length === 0) await makeMeasurement(token, liveRun.id, subjects[0].id);
}

/**
 * Publish a benchmark under the author's personal identity: verify the owner's email, seed any
 * missing readiness content, mark ready, and enable the account's personal-publish opt-in, then
 * publish. Mirrors the common author-driven path.
 */
export async function publish(token: string, userId: string, benchmarkId: string): Promise<Resource> {
  await markVerified(userId);
  await seedPublishable(token, benchmarkId);
  await markReady(token, benchmarkId);
  await allowPersonalPublish(benchmarkId);
  const res = await apiPost(`/api/v1/benchmarks/${benchmarkId}/actions/publish`, undefined, bearer(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Resource }).data;
}
