import { beforeEach, describe, expect, it } from "vitest";
import {
  allowPersonalPublish,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  markReady,
  markVerified,
  publish,
  register,
  resetDb,
  SKEW_SCHEMA,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const putBody = (attrs: Record<string, unknown>) => ({
  data: { type: "benchmark", attributes: attrs },
});

describe("benchmark create + read", () => {
  it("creates a PRIVATE benchmark owned by the caller's account", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    expect(b.attributes.status).toBe("PRIVATE");
    expect(b.attributes.account).toBe(me.account_id);
    expect(b.attributes.published_at).toBeNull();
  });

  it("defaults to an empty sample_schema when none is supplied, as a draft", async () => {
    const me = await register();
    const res = await apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { key: "no-schema", name: "No Schema" } } },
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const b = ((await res.json()) as { data: Resource }).data;
    expect(b.attributes.sample_schema).toEqual({ metrics: [], derived: [] });
    expect(b.attributes.draft).toBe(true);
    expect(b.attributes.created_by).toBe(me.user_id);
  });

  it("hides a PRIVATE benchmark from anonymous reads (404) but shows it to the owner", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    expect((await apiGet(`/api/v1/benchmarks/${b.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/benchmarks/${b.id}`, bearer(me.token))).status).toBe(200);
  });

  it("lists public benchmarks anonymously; owner sees their private ones via filter[account]", async () => {
    const me = await register();
    const priv = await makeBenchmark(me.token, { key: "priv" });
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await publish(me.token, me.user_id, pub.id);

    const anon = (await (await apiGet("/api/v1/benchmarks")).json()) as { data: Resource[] };
    const anonKeys = anon.data.map((r) => r.attributes.key);
    expect(anonKeys).toContain("pub");
    expect(anonKeys).not.toContain("priv");

    const owner = (await (
      await apiGet(`/api/v1/benchmarks?filter[account]=${me.account_id}`, bearer(me.token))
    ).json()) as { data: Resource[] };
    expect(owner.data.map((r) => r.attributes.key).sort()).toEqual(["priv", "pub"]);
    void priv;
  });
});

describe("publish gate + lifecycle", () => {
  it("blocks publishing until the owner's email is verified", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const blocked = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(blocked.status).toBe(403);

    await markVerified(me.user_id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(ok.status).toBe(200);
    const published = ((await ok.json()) as { data: Resource }).data;
    expect(published.attributes.status).toBe("PUBLISHED");
    expect(published.attributes.draft).toBe(false);
    expect((published.attributes.published_as as { kind: string }).kind).toBe("PERSONAL");
  });

  it("won't publish a benchmark that is still a draft (409)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await allowPersonalPublish(b.id);
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(res.status).toBe(409);
  });

  it("publish is a one-way door (re-publish → 409)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);
    const again = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(again.status).toBe(409);
  });

  it("withdraws a published benchmark (reason required) and keeps it world-visible", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);

    const noReason = await apiPost(`/api/v1/benchmarks/${b.id}/actions/withdraw`, { data: { type: "benchmark", attributes: {} } }, bearer(me.token));
    expect(noReason.status).toBe(400);

    const w = await apiPost(
      `/api/v1/benchmarks/${b.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "bad clock" } } },
      bearer(me.token),
    );
    expect(w.status).toBe(200);
    const anon = await apiGet(`/api/v1/benchmarks/${b.id}`);
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { data: Resource }).data.attributes.status).toBe("WITHDRAWN");
  });

  it("cannot withdraw a benchmark that was never published", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const w = await apiPost(
      `/api/v1/benchmarks/${b.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "x" } } },
      bearer(me.token),
    );
    expect(w.status).toBe(409);
  });
});

describe("interpretation freeze + append-only", () => {
  it("allows cosmetic edits but freezes the semantic core after publish", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);

    // Cosmetic prose edit is allowed.
    const ok = await apiPut(
      `/api/v1/benchmarks/${b.id}`,
      putBody({ name: "Renamed", description: "new tagline", sample_schema: SKEW_SCHEMA }),
      bearer(me.token),
    );
    expect(ok.status).toBe(200);

    // Changing a derived expression is frozen.
    const frozen = await apiPut(
      `/api/v1/benchmarks/${b.id}`,
      putBody({
        name: "Renamed",
        sample_schema: {
          metrics: [],
          derived: [{ name: "skew_ms", expr: { "+": [1, 1] } }],
          chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
        },
      }),
      bearer(me.token),
    );
    expect(frozen.status).toBe(409);
  });

  it("forbids deleting a published benchmark but allows deleting a private one", async () => {
    const me = await register();
    const priv = await makeBenchmark(me.token, { key: "priv" });
    expect((await apiDelete(`/api/v1/benchmarks/${priv.id}`, bearer(me.token))).status).toBe(204);

    const pub = await makeBenchmark(me.token, { key: "pub" });
    await publish(me.token, me.user_id, pub.id);
    expect((await apiDelete(`/api/v1/benchmarks/${pub.id}`, bearer(me.token))).status).toBe(409);
  });
});

describe("tenant isolation", () => {
  it("returns 404 (not 403) when another account touches a private benchmark", async () => {
    const a = await register("a@example.com");
    const bench = await makeBenchmark(a.token);
    const b = await register("b@example.com");
    expect((await apiGet(`/api/v1/benchmarks/${bench.id}`, bearer(b.token))).status).toBe(404);
    expect(
      (await apiPut(`/api/v1/benchmarks/${bench.id}`, putBody({ name: "x", sample_schema: SKEW_SCHEMA }), bearer(b.token))).status,
    ).toBe(404);
    expect((await apiDelete(`/api/v1/benchmarks/${bench.id}`, bearer(b.token))).status).toBe(404);
  });
});
