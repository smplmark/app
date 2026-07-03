import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import { clearScopeCache } from "../../src/auth/scope_cache";
import type { SampleSchema } from "../../src/types";

export const JSONAPI = "application/vnd.api+json";

export const SKEW_SCHEMA: SampleSchema = {
  metrics: [],
  derived: [
    { name: "skew_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } },
  ],
  chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
};

// Every table, child-first, so resetDb never trips a logical FK.
const TABLES = [
  "observation",
  "run",
  "target",
  "benchmark",
  "publisher_domain",
  "publisher_identity",
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

/** Create a benchmark (PRIVATE by default); returns its resource. */
export async function makeBenchmark(
  token: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/benchmarks",
    {
      data: {
        type: "benchmark",
        attributes: {
          key: "scheduler-latency",
          name: "Scheduler Latency",
          sample_schema: SKEW_SCHEMA,
          ...attrs,
        },
      },
    },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

export async function makeTarget(
  token: string,
  benchmarkId: string,
  key = "sched-a",
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/targets",
    { data: { type: "target", attributes: { benchmark: benchmarkId, key, name: key } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

export async function makeRun(
  token: string,
  targetId: string,
  attrs: Record<string, unknown> = {},
): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/runs",
    { data: { type: "run", attributes: { target: targetId, key: "default", ...attrs } } },
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
 * Publish a benchmark under the author's personal identity: verify the owner's email, mark ready, and
 * enable the account's personal-publish opt-in, then publish. Mirrors the common author-driven path.
 */
export async function publish(token: string, userId: string, benchmarkId: string): Promise<Resource> {
  await markVerified(userId);
  await markReady(token, benchmarkId);
  await allowPersonalPublish(benchmarkId);
  const res = await apiPost(`/api/v1/benchmarks/${benchmarkId}/actions/publish`, undefined, bearer(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Resource }).data;
}
