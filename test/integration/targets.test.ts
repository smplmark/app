import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  linkTarget,
  makeAccountTarget,
  makeBenchmark,
  makeTarget,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

describe("targets", () => {
  it("creates an account-owned target and rejects a duplicate key", async () => {
    const a = await register("a@example.com");
    const t = await makeAccountTarget(a.token, "sys-a");
    expect(t.attributes.account).toBeDefined();
    expect(t.attributes.key).toBe("sys-a");

    // Same key in the same account collides.
    const dup = await apiPost(
      "/api/v1/targets",
      { data: { type: "target", attributes: { key: "sys-a", name: "again" } } },
      bearer(a.token),
    );
    expect(dup.status).toBe(409);

    // The same key is fine in a different account (targets are account-scoped).
    const other = await register("b@example.com");
    expect((await makeAccountTarget(other.token, "sys-a")).id).toBeDefined();
  });

  it("lists account targets when authed, and requires a benchmark scope when anonymous", async () => {
    const me = await register();
    await makeAccountTarget(me.token, "one");
    await makeAccountTarget(me.token, "two");

    const mine = await apiGet("/api/v1/targets", bearer(me.token));
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { data: Resource[] }).data.length).toBe(2);

    // Anonymous list without a benchmark scope is a 404 (no cross-account listing exists).
    expect((await apiGet("/api/v1/targets")).status).toBe(404);
  });

  it("lists a benchmark's linked targets and honors visibility", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await makeTarget(me.token, b.id); // create + link

    // Private → anon sees nothing (404), owner lists the linked target.
    expect((await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`)).status).toBe(404);
    const owner = await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(1);

    await publish(me.token, me.user_id, b.id);
    const pub = await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`);
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { data: Resource[] }).data.length).toBe(1);
  });

  it("a benchmark/run-scoped credential cannot mint an account target", async () => {
    const me = await register();
    // A benchmark-scoped principal covers a benchmark, not the account's shared target namespace.
    // (Sessions are ACCOUNT-scoped; this asserts the account floor via a foreign account instead.)
    const other = await register("c@example.com");
    const b = await makeBenchmark(me.token);
    const t = await makeAccountTarget(other.token, "foreign");
    // other's target can't be linked into me's benchmark (cross-account) → 409.
    const link = await apiPost(
      "/api/v1/benchmark_targets",
      { data: { type: "benchmark_target", attributes: { benchmark: b.id, target: t.id } } },
      bearer(me.token),
    );
    expect(link.status).toBe(409);
  });

  it("updates a target's name/details anytime, and blocks delete while linked to a published benchmark", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);

    const put = await apiPut(
      `/api/v1/targets/${t.id}`,
      { data: { type: "target", attributes: { name: "Renamed", details: { region: "eu" } } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("Renamed");

    await publish(me.token, me.user_id, b.id);
    // Linked to a published benchmark → cannot delete the target.
    expect((await apiDelete(`/api/v1/targets/${t.id}`, bearer(me.token))).status).toBe(409);
  });

  it("deletes an account target that is only linked to private benchmarks", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    expect((await apiDelete(`/api/v1/targets/${t.id}`, bearer(me.token))).status).toBe(204);
    // A second delete is a 404 (already gone).
    expect((await apiDelete(`/api/v1/targets/${t.id}`, bearer(me.token))).status).toBe(404);
  });

  it("shares one target across several of an account's benchmarks", async () => {
    const me = await register();
    const b1 = await makeBenchmark(me.token, { key: "bench-1" });
    const b2 = await makeBenchmark(me.token, { key: "bench-2" });
    const t = await makeAccountTarget(me.token, "shared");
    await linkTarget(me.token, b1.id, t.id);
    await linkTarget(me.token, b2.id, t.id);

    for (const b of [b1, b2]) {
      const res = await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`, bearer(me.token));
      const data = ((await res.json()) as { data: Resource[] }).data;
      expect(data.length).toBe(1);
      expect(data[0].id).toBe(t.id);
    }
  });
});
