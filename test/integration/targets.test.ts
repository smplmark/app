import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  makeTarget,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

describe("targets", () => {
  it("creates a target under a benchmark and rejects a cross-account parent (404)", async () => {
    const a = await register("a@example.com");
    const b = await makeBenchmark(a.token);
    const t = await makeTarget(a.token, b.id);
    expect(t.attributes.benchmark).toBe(b.id);

    const other = await register("b@example.com");
    const res = await apiPost(
      "/api/v1/targets",
      { data: { type: "target", attributes: { benchmark: b.id, key: "x", name: "x" } } },
      bearer(other.token),
    );
    expect(res.status).toBe(404);
  });

  it("requires filter[benchmark] on list and honors visibility", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await makeTarget(me.token, b.id);
    expect((await apiGet("/api/v1/targets")).status).toBe(404);

    // Private → anon sees nothing (404), owner lists.
    expect((await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`)).status).toBe(404);
    const owner = await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(1);

    await publish(me.token, me.user_id, b.id);
    expect((await apiGet(`/api/v1/targets?filter[benchmark]=${b.id}`)).status).toBe(200);
  });

  it("updates a target and enforces append-only delete rules", async () => {
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
    expect((await apiDelete(`/api/v1/targets/${t.id}`, bearer(me.token))).status).toBe(409);
  });

  it("deletes a target of a private benchmark", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    expect((await apiDelete(`/api/v1/targets/${t.id}`, bearer(me.token))).status).toBe(204);
  });
});
