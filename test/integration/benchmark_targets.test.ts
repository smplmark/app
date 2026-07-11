import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  linkTarget,
  makeAccountTarget,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  markReady,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

async function link(token: string, benchmarkId: string, targetId: string) {
  return apiPost(
    "/api/v1/benchmark_targets",
    { data: { type: "benchmark_target", attributes: { benchmark: benchmarkId, target: targetId } } },
    bearer(token),
  );
}

describe("benchmark_targets (the M:N link)", () => {
  it("links a target and rejects a duplicate link", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(me.token, "sys-a");

    const res = await link(me.token, b.id, t.id);
    expect(res.status).toBe(201);
    const linkRes = ((await res.json()) as { data: Resource }).data;
    expect(linkRes.attributes.benchmark).toBe(b.id);
    expect(linkRes.attributes.target).toBe(t.id);

    // Linking the same pair again → 409.
    expect((await link(me.token, b.id, t.id)).status).toBe(409);
  });

  it("rejects linking a target from another account (no cross-tenant sharing)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const b = await makeBenchmark(me.token);
    const foreign = await makeAccountTarget(other.token, "foreign");
    expect((await link(me.token, b.id, foreign.id)).status).toBe(409);
  });

  it("rejects linking a non-existent target (409) and deleting a non-existent link (404)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    expect((await link(me.token, b.id, "ghost-target")).status).toBe(409);
    expect((await apiDelete("/api/v1/benchmark_targets/ghost-link", bearer(me.token))).status).toBe(404);
  });

  it("blocks unlinking while a benchmark is marked ready", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(me.token, "t");
    const linkRes = ((await (await link(me.token, b.id, t.id)).json()) as { data: Resource }).data;
    await markReady(me.token, b.id);
    expect((await apiDelete(`/api/v1/benchmark_targets/${linkRes.id}`, bearer(me.token))).status).toBe(409);
  });

  it("rejects linking into a benchmark the caller can't cover (404, no leak)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(other.token, "t");
    // other tries to link into me's benchmark → indistinguishable 404.
    expect((await link(other.token, b.id, t.id)).status).toBe(404);
  });

  it("lists links by benchmark and by target", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(me.token, "t");
    await linkTarget(me.token, b.id, t.id);

    const byBench = await apiGet(`/api/v1/benchmark_targets?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await byBench.json()) as { data: Resource[] }).data.length).toBe(1);
    const byTarget = await apiGet(`/api/v1/benchmark_targets?filter[target]=${t.id}`, bearer(me.token));
    expect(((await byTarget.json()) as { data: Resource[] }).data.length).toBe(1);

    // A scope is required.
    expect((await apiGet("/api/v1/benchmark_targets", bearer(me.token))).status).toBe(404);
  });

  it("unlinks a target from a private benchmark and drops its measurements there", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(me.token, "t");
    const linkRes = ((await (await link(me.token, b.id, t.id)).json()) as { data: Resource }).data;

    // Removing the link succeeds while private; the target row survives.
    expect((await apiDelete(`/api/v1/benchmark_targets/${linkRes.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/targets/${t.id}`, bearer(me.token))).status).toBe(200);
    const remaining = await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await remaining.json()) as { data: Resource[] }).data.length).toBe(0);
  });

  it("blocks linking while a benchmark is marked ready, and unlinking after publish", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(me.token, "t");
    const linkRes = ((await (await link(me.token, b.id, t.id)).json()) as { data: Resource }).data;

    const t2 = await makeAccountTarget(me.token, "t2");
    await markReady(me.token, b.id);
    // Marked-ready freezes the subtree → linking is blocked.
    expect((await link(me.token, b.id, t2.id)).status).toBe(409);

    await publish(me.token, me.user_id, b.id);
    // Published data is append-only → the existing link can't be removed.
    expect((await apiDelete(`/api/v1/benchmark_targets/${linkRes.id}`, bearer(me.token))).status).toBe(409);
  });

  // A shared target may span a private and a public benchmark; filter[target] must not leak the
  // private benchmark's id to callers who can't cover it.
  it("filter[target] hides a private benchmark's link from anonymous callers", async () => {
    const me = await register();
    const t = await makeAccountTarget(me.token, "shared");
    const priv = await makeBenchmark(me.token, { key: "priv" });
    await linkTarget(me.token, priv.id, t.id);
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await linkTarget(me.token, pub.id, t.id);
    await publish(me.token, me.user_id, pub.id);

    const anon = await apiGet(`/api/v1/benchmark_targets?filter[target]=${t.id}`);
    expect(anon.status).toBe(200);
    const anonLinks = ((await anon.json()) as { data: Resource[] }).data;
    expect(anonLinks.length).toBe(1);
    expect(anonLinks[0].attributes.benchmark).toBe(pub.id); // never the private benchmark id
    // The owner sees both links.
    const owner = await apiGet(`/api/v1/benchmark_targets?filter[target]=${t.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(2);
  });
});

describe("measurements filter[target] visibility across a shared target's benchmarks", () => {
  it("hides a private sibling benchmark's measurements from anonymous callers", async () => {
    const me = await register();
    const t = await makeAccountTarget(me.token, "shared");
    // A PRIVATE benchmark with a measurement of the shared target (must stay hidden).
    const priv = await makeBenchmark(me.token, { key: "priv" });
    await linkTarget(me.token, priv.id, t.id);
    const runPriv = await makeRun(me.token, priv.id);
    await makeMeasurement(me.token, runPriv.id, t.id, { metrics: { skew_ms: 999 } });
    // A PUBLISHED benchmark with a measurement of the same target (public).
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await linkTarget(me.token, pub.id, t.id);
    const runPub = await makeRun(me.token, pub.id);
    await makeMeasurement(me.token, runPub.id, t.id, { metrics: { skew_ms: 1 } });
    await publish(me.token, me.user_id, pub.id);

    // Anonymous filter[target]: only the published run's measurement, never the private one.
    const anon = await apiGet(`/api/v1/measurements?filter[target]=${t.id}`);
    expect(anon.status).toBe(200);
    const anonRows = ((await anon.json()) as { data: Resource[] }).data;
    expect(anonRows.length).toBe(1);
    expect(anonRows[0].attributes.run).toBe(runPub.id); // the public run, not the private one
    // The owner sees both.
    const owner = await apiGet(`/api/v1/measurements?filter[target]=${t.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(2);
  });
});
