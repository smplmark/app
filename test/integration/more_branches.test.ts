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
  makeSubject,
  publish,
  register,
  resetDb,
} from "./helpers";

beforeEach(resetDb);

describe("run + subject read visibility", () => {
  it("covers anonymous, cross-account, and published reads", async () => {
    const a = await register("a@example.com");
    const b = await makeBenchmark(a.token);
    const t = await makeSubject(a.token, b.id);
    const r = await makeRun(a.token, b.id, { name: "named-run" });

    // Private: anonymous and cross-account both 404.
    expect((await apiGet(`/api/v1/runs/${r.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/subjects/${t.id}`)).status).toBe(404);
    const other = await register("b@example.com");
    expect((await apiGet(`/api/v1/runs/${r.id}`, bearer(other.token))).status).toBe(404);
    expect(
      (await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(other.token))).status,
    ).toBe(404);

    // Publish → public reads succeed, including a PUT that only touches prose.
    await publish(a.token, a.user_id, b.id);
    expect((await apiGet(`/api/v1/runs/${r.id}`)).status).toBe(200);
    expect((await apiGet(`/api/v1/subjects/${t.id}`)).status).toBe(200);
    const put = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "renamed", details: { note: "x" } } } },
      bearer(a.token),
    );
    expect(put.status).toBe(200);
  });
});

describe("measurements created_at range", () => {
  it("filters measurements by a date range", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeSubject(me.token, b.id);
    const r = await makeRun(me.token, b.id);
    const meas = (createdAt: number) => ({
      data: { type: "measurement", attributes: { run: r.id, subject: t.id, created_at: createdAt } },
    });
    await apiPost("/api/v1/measurements", meas(Date.UTC(2026, 6, 1)), bearer(me.token));
    await apiPost("/api/v1/measurements", meas(Date.UTC(2026, 6, 10)), bearer(me.token));

    const range = "[2026-07-05T00:00:00Z,2026-07-15T00:00:00Z)";
    const res = await apiGet(
      `/api/v1/measurements?filter[run]=${r.id}&filter[created_at]=${encodeURIComponent(range)}`,
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
    const b = await makeBenchmark(me.token);
    const t = await makeSubject(me.token, b.id);
    // Linking a subject into a non-existent benchmark is an indistinguishable 404 (no leak).
    expect(
      (await apiPost("/api/v1/benchmark_subjects", { data: { type: "benchmark_subject", attributes: { benchmark: "ghost", subject: t.id } } }, bearer(me.token))).status,
    ).toBe(404);
    expect(
      (await apiPost("/api/v1/runs", { data: { type: "run", attributes: { benchmark: "ghost", key: "k" } } }, bearer(me.token))).status,
    ).toBe(404);
    expect(
      (await apiPost("/api/v1/measurements", { data: { type: "measurement", attributes: { run: "ghost", subject: t.id } } }, bearer(me.token))).status,
    ).toBe(404);
  });

  it("treats a non-string password as an auth failure (401)", async () => {
    await authPost("/api/v1/auth/register", { email: "pw@example.com", password: "correct horse battery" });
    const res = await authPost("/api/v1/auth/login", { email: "pw@example.com", password: 12345 });
    expect(res.status).toBe(401);
  });
});
