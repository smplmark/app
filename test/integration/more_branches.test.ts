// The last conditional branches: read-visibility across credential states, the created_at range
// filter, malformed auth bodies, and an unknown API key.
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  authPost,
  bearer,
  makeBenchmark,
  makeRun,
  makeTarget,
  publish,
  register,
  resetDb,
} from "./helpers";

beforeEach(resetDb);

describe("run + target read visibility", () => {
  it("covers anonymous, cross-account, and published reads", async () => {
    const a = await register("a@example.com");
    const b = await makeBenchmark(a.token);
    const t = await makeTarget(a.token, b.id);
    const r = await makeRun(a.token, t.id, { name: "named-run" });

    // Private: anonymous and cross-account both 404.
    expect((await apiGet(`/api/v1/runs/${r.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/targets/${t.id}`)).status).toBe(404);
    const other = await register("b@example.com");
    expect((await apiGet(`/api/v1/runs/${r.id}`, bearer(other.token))).status).toBe(404);
    expect(
      (await apiGet(`/api/v1/observations?filter[run]=${r.id}`, bearer(other.token))).status,
    ).toBe(404);

    // Publish → public reads succeed, including a PUT that only touches prose.
    await publish(a.token, a.user_id, b.id);
    expect((await apiGet(`/api/v1/runs/${r.id}`)).status).toBe(200);
    expect((await apiGet(`/api/v1/targets/${t.id}`)).status).toBe(200);
    const put = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "renamed", details: { note: "x" } } } },
      bearer(a.token),
    );
    expect(put.status).toBe(200);
  });
});

describe("observations created_at range", () => {
  it("filters observations by a date range", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);
    const obs = (createdAt: number) => ({ data: { type: "observation", attributes: { run: r.id, created_at: createdAt } } });
    await apiPost("/api/v1/observations", obs(Date.UTC(2026, 6, 1)), bearer(me.token));
    await apiPost("/api/v1/observations", obs(Date.UTC(2026, 6, 10)), bearer(me.token));

    const range = "[2026-07-05T00:00:00Z,2026-07-15T00:00:00Z)";
    const res = await apiGet(
      `/api/v1/observations?filter[run]=${r.id}&filter[created_at]=${encodeURIComponent(range)}`,
      bearer(me.token),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data.length).toBe(1);
  });
});

describe("malformed inputs + unknown credential", () => {
  it("rejects a non-object auth body with 400", async () => {
    const res = await authPost("/api/v1/auth/register", ["not", "an", "object"]);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown API key with 401", async () => {
    const res = await apiGet("/api/v1/accounts/current", bearer("sm_api_unknownkeyvalue123"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when a create references a non-existent parent", async () => {
    const me = await register();
    expect(
      (await apiPost("/api/v1/targets", { data: { type: "target", attributes: { benchmark: "ghost", key: "k", name: "n" } } }, bearer(me.token))).status,
    ).toBe(404);
    expect(
      (await apiPost("/api/v1/runs", { data: { type: "run", attributes: { target: "ghost", key: "k" } } }, bearer(me.token))).status,
    ).toBe(404);
    expect(
      (await apiPost("/api/v1/observations", { data: { type: "observation", attributes: { run: "ghost" } } }, bearer(me.token))).status,
    ).toBe(404);
  });

  it("treats a non-string password as an auth failure (401)", async () => {
    await authPost("/api/v1/auth/register", { email: "pw@example.com", password: "correct horse battery" });
    const res = await authPost("/api/v1/auth/login", { email: "pw@example.com", password: 12345 });
    expect(res.status).toBe(401);
  });
});
