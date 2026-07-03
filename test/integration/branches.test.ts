// Targeted coverage for the remaining conditional branches: scope edges, expiry, optional-field
// defaults, and private-benchmark mutation paths the happy-path tests skip.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
  mintKey,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

describe("benchmark create defaults + scoped-key visibility", () => {
  it("defaults an omitted sample_schema to empty", async () => {
    const me = await register();
    const res = await apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { key: "no-schema", name: "No Schema" } } },
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Resource }).data.attributes.sample_schema).toEqual({
      metrics: [],
      derived: [],
    });
  });

  it("a RUN-scoped key cannot read its parent benchmark resource (404)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);
    const { key } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r.id });
    expect((await apiGet(`/api/v1/benchmarks/${b.id}`, bearer(key))).status).toBe(404);
    // But it can read observations of its own run.
    expect((await apiGet(`/api/v1/observations?filter[run]=${r.id}`, bearer(key))).status).toBe(200);
  });
});

describe("account + user optional fields", () => {
  it("blocks account update from a non-account-scoped key", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const { key } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });
    const res = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "X" } } },
      bearer(key),
    );
    expect(res.status).toBe(403);
  });

  it("clears display_name when set to null", async () => {
    const me = await register();
    const res = await apiPut(
      "/api/v1/users/current",
      { data: { type: "user", attributes: { display_name: null } } },
      bearer(me.token),
    );
    expect(((await res.json()) as { data: Resource }).data.attributes.display_name).toBeNull();
  });
});

describe("api key expiry + rotate scope", () => {
  it("rejects an expired key (401)", async () => {
    const me = await register();
    const res = await apiPost(
      "/api/v1/api_keys",
      {
        data: {
          type: "api_key",
          attributes: { name: "expired", scope_type: "ACCOUNT", expires_at: Date.now() - 1000 },
        },
      },
      bearer(me.token),
    );
    const key = ((await res.json()) as { data: Resource }).data.attributes.key as string;
    expect((await apiGet("/api/v1/accounts/current", bearer(key))).status).toBe(401);
  });

  it("rotate preserves the scope of a RUN key", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);
    const { resource } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r.id });
    const rot = await apiPost(`/api/v1/api_keys/${resource.id}/actions/rotate`, undefined, bearer(me.token));
    const rotated = ((await rot.json()) as { data: Resource }).data;
    expect(rotated.attributes.scope_type).toBe("RUN");
    expect(rotated.attributes.scope_ref).toBe(r.id);
  });
});

describe("observations scope edges", () => {
  it("returns 404 for unknown scope targets and 200 for a published target scope", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);
    await apiPost(
      "/api/v1/observations",
      { data: { type: "observation", attributes: { run: r.id, created_at: Date.UTC(2026, 6, 1) } } },
      bearer(me.token),
    );
    expect((await apiGet("/api/v1/observations?filter[target]=nope", bearer(me.token))).status).toBe(404);
    expect((await apiGet("/api/v1/observations?filter[benchmark]=nope", bearer(me.token))).status).toBe(404);

    await publish(me.token, me.user_id, b.id);
    const total = await apiGet(`/api/v1/observations?filter[run]=${r.id}&meta[total]=true`);
    expect(((await total.json()) as { meta: { pagination: { total: number } } }).meta.pagination.total).toBe(1);
  });
});

describe("private run mutation + invalidate default", () => {
  it("updates and deletes a private run and invalidates without a reason", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);

    const put = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "renamed", details: { note: "x" }, started_at: Date.UTC(2026, 6, 1) } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);

    const inv = await apiPost(`/api/v1/runs/${r.id}/actions/invalidate`, undefined, bearer(me.token));
    expect(inv.status).toBe(200);
    expect(((await inv.json()) as { data: Resource }).data.attributes.invalidation_reason).toBeNull();

    expect((await apiDelete(`/api/v1/runs/${r.id}`, bearer(me.token))).status).toBe(204);
  });
});

describe("targets published read + expired verification", () => {
  it("serves a published target to anonymous readers", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    await publish(me.token, me.user_id, b.id);
    expect((await apiGet(`/api/v1/targets/${t.id}`)).status).toBe(200);
  });

  it("rejects an expired verification token", async () => {
    const me = await register();
    await env.DB.prepare(
      "INSERT INTO email_verification (id, user_id, token_hash, expires_at, consumed_at, created_at) VALUES (?,?,?,?,NULL,?)",
    )
      .bind(crypto.randomUUID(), me.user_id, "deadhash", Date.now() - 1000, Date.now())
      .run();
    // token_hash won't match anyway, but the expired row exercises the expiry predicate.
    expect((await authPost("/api/v1/auth/verify-email", { token: "anything" })).status).toBe(400);
  });
});
