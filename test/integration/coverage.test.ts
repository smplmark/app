// Branch-coverage sweep: list params (meta[total]/sort/filter[key]), edge/404 paths, and the
// verify-email + OIDC-only-login data paths that the happy-path tests don't reach.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/crypto";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  authPost,
  bearer,
  makeBenchmark,
  makeRun,
  makeTarget,
  markVerified,
  mintKey,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const obs = (runId: string, attrs: Record<string, unknown> = {}) => ({
  data: { type: "observation", attributes: { run: runId, ...attrs } },
});

describe("list params", () => {
  it("honors meta[total], sort, and filter[key] across resources", async () => {
    const me = await register();
    const b1 = await makeBenchmark(me.token, { key: "aaa", name: "Aaa" });
    await makeBenchmark(me.token, { key: "bbb", name: "Bbb" });
    await publish(me.token, me.user_id, b1.id);

    const withTotal = await apiGet(
      `/api/v1/benchmarks?filter[account]=${me.account_id}&meta[total]=true&sort=name`,
      bearer(me.token),
    );
    const body = (await withTotal.json()) as { data: Resource[]; meta: { pagination: { total: number; total_pages: number } } };
    expect(body.meta.pagination.total).toBe(2);
    expect(body.meta.pagination.total_pages).toBe(1);
    expect(body.data[0].attributes.key).toBe("aaa"); // sorted by name asc

    const byKey = await apiGet("/api/v1/benchmarks?filter[key]=aaa");
    expect(((await byKey.json()) as { data: Resource[] }).data.length).toBe(1);

    const t = await makeTarget(me.token, b1.id, "tk");
    await makeRun(me.token, t.id);
    const targets = await apiGet(`/api/v1/targets?filter[benchmark]=${b1.id}&filter[key]=tk&meta[total]=true&sort=-created_at`, bearer(me.token));
    expect(((await targets.json()) as { data: Resource[] }).data.length).toBe(1);
    const runs = await apiGet(`/api/v1/runs?filter[target]=${t.id}&filter[key]=default&meta[total]=true&sort=key`, bearer(me.token));
    expect(((await runs.json()) as { data: Resource[] }).data.length).toBe(1);

    await mintKey(me.token, { scope_type: "ACCOUNT", name: "k1" });
    const keys = await apiGet("/api/v1/api_keys?meta[total]=true&sort=name", bearer(me.token));
    expect(((await keys.json()) as { data: Resource[] }).data.length).toBe(1);

    const members = await apiGet("/api/v1/account_users?meta[total]=true", bearer(me.token));
    expect(((await members.json()) as { meta: { pagination: { total: number } } }).meta.pagination.total).toBe(1);
  });

  it("rejects an unknown sort field with 400", async () => {
    const me = await register();
    const res = await apiGet(`/api/v1/benchmarks?filter[account]=${me.account_id}&sort=evil`, bearer(me.token));
    expect(res.status).toBe(400);
  });
});

describe("edge + not-found paths", () => {
  it("returns 404 for missing resources and 401 without a credential", async () => {
    const me = await register();
    expect((await apiGet("/api/v1/benchmarks/nope")).status).toBe(404);
    expect((await apiPut("/api/v1/benchmarks/nope", { data: { type: "benchmark", attributes: { name: "x" } } }, bearer(me.token))).status).toBe(404);
    expect((await apiGet("/api/v1/targets/nope", bearer(me.token))).status).toBe(404);
    expect((await apiGet("/api/v1/runs/nope", bearer(me.token))).status).toBe(404);
    expect((await apiGet("/api/v1/benchmarks/x")).status).toBe(404);
    // No credential at all.
    expect((await apiPost("/api/v1/benchmarks", { data: { type: "benchmark", attributes: { key: "k", name: "n" } } })).status).toBe(401);
    expect((await apiGet("/api/v1/accounts/current")).status).toBe(401);
    // Malformed bearer that isn't an API key → treated as a JWT → 401.
    expect((await apiGet("/api/v1/accounts/current", { Authorization: "Bearer not.a.jwt" })).status).toBe(401);
  });

  it("resend is a no-op for an already-verified user", async () => {
    const me = await register();
    await markVerified(me.user_id);
    expect((await authPost("/api/v1/auth/resend-verification", undefined, bearer(me.token))).status).toBe(200);
  });

  it("accepts ISO created_at and a meta bag on observations", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);
    const res = await apiPost(
      "/api/v1/observations",
      obs(r.id, { created_at: "2026-07-01T10:00:00Z", meta: { commit: "abc" } }),
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Resource }).data.attributes.meta).toEqual({ commit: "abc" });
  });
});

describe("api key scope resolution", () => {
  it("mints BENCHMARK/RUN keys, resolves reveal/rotate/delete 404s, and blocks cross-account refs", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);

    const bench = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });
    expect(bench.resource.attributes.scope_type).toBe("BENCHMARK");
    const run = await mintKey(me.token, { scope_type: "RUN", scope_ref: r.id });
    expect(run.resource.attributes.scope_ref).toBe(r.id);

    // scope_ref required for non-ACCOUNT scopes.
    const missingRef = await apiPost("/api/v1/api_keys", { data: { type: "api_key", attributes: { name: "x", scope_type: "BENCHMARK" } } }, bearer(me.token));
    expect(missingRef.status).toBe(404);

    // reveal / rotate / delete of an unknown key → 404.
    expect((await apiGet("/api/v1/api_keys/nope", bearer(me.token))).status).toBe(404);
    expect((await apiPost("/api/v1/api_keys/nope/actions/rotate", undefined, bearer(me.token))).status).toBe(404);
    expect((await apiDelete("/api/v1/api_keys/nope", bearer(me.token))).status).toBe(404);

    // A key scoped to another account's benchmark → 404 (cross-tenant ref).
    const other = await register("other@example.com");
    const scoped = await apiPost("/api/v1/api_keys", { data: { type: "api_key", attributes: { name: "x", scope_type: "BENCHMARK", scope_ref: b.id } } }, bearer(other.token));
    expect(scoped.status).toBe(404);
  });
});

describe("auth data paths", () => {
  it("verifies email via a valid token and rejects reuse", async () => {
    const me = await register();
    const token = "known-verification-token";
    await env.DB.prepare(
      "INSERT INTO email_verification (id, user_id, token_hash, expires_at, consumed_at, created_at) VALUES (?,?,?,?,NULL,?)",
    )
      .bind(crypto.randomUUID(), me.user_id, await sha256Hex(token), Date.now() + 100_000, Date.now())
      .run();

    expect((await authPost("/api/v1/auth/verify-email", { token })).status).toBe(200);
    const cur = await apiGet("/api/v1/users/current", bearer(me.token));
    expect(((await cur.json()) as { data: Resource }).data.attributes.verified).toBe(true);
    // Reuse → consumed → 400.
    expect((await authPost("/api/v1/auth/verify-email", { token })).status).toBe(400);
    // Missing token field → 400.
    expect((await authPost("/api/v1/auth/verify-email", {})).status).toBe(400);
  });

  it("returns 401 for an OIDC-only user trying password login", async () => {
    const uid = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO user (id, email, email_verified, display_name, created_at) VALUES (?,?,1,?,?)",
    )
      .bind(uid, "oidc-only@example.com", "O", Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO user_identity (id, user_id, provider, provider_subject, password_hash, created_at) VALUES (?,?,?,?,NULL,?)",
    )
      .bind(crypto.randomUUID(), uid, "GOOGLE", "sub-123", Date.now())
      .run();
    const res = await authPost("/api/v1/auth/login", { email: "oidc-only@example.com", password: "whatever ok" });
    expect(res.status).toBe(401);
  });
});
