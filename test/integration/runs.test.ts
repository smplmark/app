import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  makeMeasurement,
  mintKey,
  makeRun,
  makeSubject,
  publish,
  register,
  resetDb,
  runUuid,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

async function scaffold(token: string, runAttrs: Record<string, unknown> = {}) {
  const b = await makeBenchmark(token);
  const t = await makeSubject(token, b.id);
  const r = await makeRun(token, b.id, runAttrs);
  return { b, t, r };
}

async function errorDetail(res: Response): Promise<string> {
  return ((await res.json()) as { errors: { detail: string }[] }).errors[0].detail;
}

const DELETE_BLOCKED =
  "A published benchmark's runs can't be deleted — the public record must not vanish. Invalidate the run instead.";

describe("run liveness + actions", () => {
  it("creates a run under a benchmark", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);

    // Happy path: a run under a real benchmark returns 201 and echoes its benchmark.
    const created = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "run-1" } } },
      bearer(me.token),
    );
    expect(created.status).toBe(201);
    const run = ((await created.json()) as { data: Resource }).data;
    expect(run.attributes.benchmark).toBe(b.id);

    // A missing benchmark is a 404.
    const ghost = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: "ghost", key: "run-1" } } },
      bearer(me.token),
    );
    expect(ghost.status).toBe(404);

    // Run keys are unique within a benchmark: a duplicate key under the same benchmark is a 409.
    const dup = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "run-1" } } },
      bearer(me.token),
    );
    expect(dup.status).toBe(409);

    // The same key under a DIFFERENT benchmark is fine — uniqueness is scoped per-benchmark.
    const b2 = await makeBenchmark(me.token, { key: "other-benchmark" });
    const reuse = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b2.id, key: "run-1" } } },
      bearer(me.token),
    );
    expect(reuse.status).toBe(201);
  });

  it("auto-generates a run key when omitted and defaults started_at to now", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const before = Date.now();
    const res = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id } } },
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const run = ((await res.json()) as { data: Resource }).data;
    // A key was generated (run-…) and started_at defaulted to roughly now.
    expect(run.attributes.key).toMatch(/^run-/);
    const started = Date.parse(run.attributes.started_at as string);
    expect(started).toBeGreaterThanOrEqual(before - 1000);
    expect(started).toBeLessThanOrEqual(Date.now() + 1000);

    // Two omitted-key runs under the same benchmark don't collide.
    const res2 = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id } } },
      bearer(me.token),
    );
    expect(res2.status).toBe(201);
    const run2 = ((await res2.json()) as { data: Resource }).data;
    expect(run2.attributes.key).not.toBe(run.attributes.key);

    // An explicit null started_at is preserved (no start time).
    const res3 = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, started_at: null } } },
      bearer(me.token),
    );
    expect(res3.status).toBe(201);
    expect(((await res3.json()) as { data: Resource }).data.attributes.started_at).toBeNull();
  });

  it("uses the run key as its public id and resolves a run by key or by UUID on read and mutate", async () => {
    const me = await register();
    const { r } = await scaffold(me.token);
    // The run's public id is its key; the internal UUID is never surfaced.
    expect(r.id).toBe(r.attributes.key);

    // GET by key works and echoes the key as the id.
    const byKey = await apiGet(`/api/v1/runs/${r.id}`, bearer(me.token));
    expect(byKey.status).toBe(200);
    expect(((await byKey.json()) as { data: Resource }).data.id).toBe(r.id);

    // GET by the internal UUID (legacy path) also resolves and still emits the key as the id.
    const byUuid = await apiGet(`/api/v1/runs/${await runUuid(r)}`, bearer(me.token));
    expect(byUuid.status).toBe(200);
    expect(((await byUuid.json()) as { data: Resource }).data.id).toBe(r.id);

    // A mutation addressed by the key resolves to the same run.
    const put = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "renamed" } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("renamed");
  });

  it("a new run is live (ended_at null)", async () => {
    const me = await register();
    const { r } = await scaffold(me.token);
    expect(r.attributes.live).toBe(true);
    expect(r.attributes.ended_at).toBeNull();
  });

  it("creating a run with ended_at set yields a non-live run", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const started = Date.UTC(2026, 6, 1, 0, 0, 0);
    const ended = started + 60_000;
    const res = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "done", started_at: started, ended_at: ended } } },
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const run = ((await res.json()) as { data: Resource }).data;
    expect(run.attributes.live).toBe(false);
    expect(Date.parse(run.attributes.ended_at as string)).toBe(ended);

    // ended_at also accepts an ISO string.
    const iso = await apiPost(
      "/api/v1/runs",
      {
        data: {
          type: "run",
          attributes: { benchmark: b.id, key: "done-iso", started_at: started, ended_at: new Date(ended).toISOString() },
        },
      },
      bearer(me.token),
    );
    expect(iso.status).toBe(201);
    expect(((await iso.json()) as { data: Resource }).data.attributes.live).toBe(false);

    // An explicit null ended_at is a live run, same as omitting it.
    const live = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "live", ended_at: null } } },
      bearer(me.token),
    );
    expect(live.status).toBe(201);
    expect(((await live.json()) as { data: Resource }).data.attributes.live).toBe(true);
  });

  it("PUT sets ended_at on a private benchmark's run and an explicit null clears it back to live", async () => {
    const me = await register();
    const started = Date.UTC(2026, 6, 1, 0, 0, 0);
    const { r } = await scaffold(me.token, { started_at: started });
    const ended = started + 3_600_000;

    // Set ended_at via PUT → run is no longer live.
    const set = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", ended_at: ended } } },
      bearer(me.token),
    );
    expect(set.status).toBe(200);
    const setRun = ((await set.json()) as { data: Resource }).data;
    expect(setRun.attributes.live).toBe(false);
    expect(Date.parse(setRun.attributes.ended_at as string)).toBe(ended);
    // Omitted started_at was kept.
    expect(Date.parse(setRun.attributes.started_at as string)).toBe(started);

    // Omitting ended_at on a later PUT keeps it.
    const keep = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "renamed" } } },
      bearer(me.token),
    );
    expect(keep.status).toBe(200);
    expect(Date.parse(((await keep.json()) as { data: Resource }).data.attributes.ended_at as string)).toBe(ended);

    // An explicit null clears ended_at — the run returns to live.
    const clear = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", ended_at: null } } },
      bearer(me.token),
    );
    expect(clear.status).toBe(200);
    const cleared = ((await clear.json()) as { data: Resource }).data;
    expect(cleared.attributes.live).toBe(true);
    expect(cleared.attributes.ended_at).toBeNull();
  });

  it("rejects ended_at earlier than started_at on both POST and PUT", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const started = Date.UTC(2026, 6, 1, 0, 0, 0);

    // POST with an inverted interval → 400.
    const post = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "bad", started_at: started, ended_at: started - 1000 } } },
      bearer(me.token),
    );
    expect(post.status).toBe(400);
    expect(await errorDetail(post)).toBe("ended_at must not be earlier than started_at.");

    // PUT: started_at omitted keeps the current value, so an earlier ended_at still inverts → 400.
    const r = await makeRun(me.token, b.id, { started_at: started });
    const put = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", ended_at: started - 1000 } } },
      bearer(me.token),
    );
    expect(put.status).toBe(400);
    expect(await errorDetail(put)).toBe("ended_at must not be earlier than started_at.");

    // PUT with both supplied and inverted → 400 too.
    const putBoth = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", started_at: started, ended_at: started - 1 } } },
      bearer(me.token),
    );
    expect(putBoth.status).toBe(400);
  });

  it("actions/end stamps ended_at and cannot be repeated", async () => {
    const me = await register();
    const { r } = await scaffold(me.token);
    const end = await apiPost(`/api/v1/runs/${r.id}/actions/end`, undefined, bearer(me.token));
    expect(end.status).toBe(200);
    const ended = ((await end.json()) as { data: Resource }).data;
    expect(ended.attributes.live).toBe(false);
    expect(ended.attributes.ended_at).not.toBeNull();
    const again = await apiPost(`/api/v1/runs/${r.id}/actions/end`, undefined, bearer(me.token));
    expect(again.status).toBe(409);
    expect(await errorDetail(again)).toBe("This run has already ended.");
  });

  it("actions/end refuses a run whose started_at is in the future (would invert the interval)", async () => {
    const me = await register();
    const { b } = await scaffold(me.token);
    const future = await makeRun(me.token, b.id, { key: "future", started_at: Date.now() + 60 * 60 * 1000 });
    const end = await apiPost(`/api/v1/runs/${future.id}/actions/end`, undefined, bearer(me.token));
    expect(end.status).toBe(400);
    expect(await errorDetail(end)).toBe("ended_at must not be earlier than started_at.");
  });

  it("actions/invalidate flags the run but keeps it visible", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    // Give the benchmark its measurement up front so the publish helper has nothing to seed and the
    // run list below stays exactly one run.
    await makeMeasurement(me.token, r.id, t.id, { metrics: { skew_ms: 1 } });
    await publish(me.token, me.user_id, b.id);

    // Invalidation is still allowed after publish (the sanctioned way to retract a bad run).
    const inv = await apiPost(
      `/api/v1/runs/${r.id}/actions/invalidate`,
      { data: { type: "run", attributes: { invalidation_reason: "bad clock" } } },
      bearer(me.token),
    );
    expect(inv.status).toBe(200);
    const invalidated = ((await inv.json()) as { data: Resource }).data;
    expect(invalidated.attributes.invalidated).toBe(true);
    expect(invalidated.attributes.invalidation_reason).toBe("bad clock");
    expect(invalidated.attributes.invalidated_by_user).toBe(me.user_id);

    // Still listed after publish (no default-hide). Runs list under their benchmark now.
    const list = await apiGet(`/api/v1/runs?filter[benchmark]=${b.id}`);
    expect(((await list.json()) as { data: Resource[] }).data.length).toBe(1);
  });
});

describe("post-publish run rules (editable, never deletable)", () => {
  /** A published benchmark with two runs: one carrying a measurement, one empty. Content is created
   *  explicitly (not via seedPublishable) so the tests control exactly which runs exist. */
  async function publishedWithRuns(token: string, userId: string) {
    const b = await makeBenchmark(token);
    const t = await makeSubject(token, b.id);
    const withData = await makeRun(token, b.id, {});
    const empty = await makeRun(token, b.id, { key: "empty" });
    await makeMeasurement(token, withData.id, t.id, { metrics: { skew_ms: 1 } });
    await publish(token, userId, b.id);
    return { b, t, withData, empty };
  }

  it("keeps runs editable once published: PUT succeeds, including timestamp changes and reopening", async () => {
    const me = await register();
    const started = Date.UTC(2026, 6, 1, 0, 0, 0);
    const b = await makeBenchmark(me.token);
    const t = await makeSubject(me.token, b.id);
    const r = await makeRun(me.token, b.id, { started_at: started });
    await makeMeasurement(me.token, r.id, t.id, { metrics: { skew_ms: 1 } });
    await publish(me.token, me.user_id, b.id);

    // Round-tripping the same started_at is a clean no-op update.
    const same = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", started_at: new Date(started).toISOString() } } },
      bearer(me.token),
    );
    expect(same.status).toBe(200);

    // Changing it succeeds too — the edit becomes part of the audited public record.
    const changed = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", started_at: started + 1000 } } },
      bearer(me.token),
    );
    expect(changed.status).toBe(200);
    expect(
      Date.parse(((await changed.json()) as { data: Resource }).data.attributes.started_at as string),
    ).toBe(started + 1000);

    // Ending via PUT and clearing ended_at back to live (reopening) both work post-publish.
    const ended = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", ended_at: started + 60_000 } } },
      bearer(me.token),
    );
    expect(ended.status).toBe(200);
    expect(((await ended.json()) as { data: Resource }).data.attributes.live).toBe(false);
    const reopened = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", ended_at: null } } },
      bearer(me.token),
    );
    expect(reopened.status).toBe(200);
    expect(((await reopened.json()) as { data: Resource }).data.attributes.live).toBe(true);
  });

  it("deletes a draft benchmark's run freely (even with measurements), cascading its scoped keys", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    await makeMeasurement(me.token, r.id, t.id, { metrics: { skew_ms: 1 } });
    const { resource: key } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r.id });
    expect(b.attributes.status).toBe("PRIVATE");
    expect((await apiDelete(`/api/v1/runs/${r.id}`, bearer(me.token))).status).toBe(204);
    // The run-scoped key authorizes nothing once its run is gone — it must not linger.
    expect((await apiGet(`/api/v1/api_keys/${key.id}`, bearer(me.token))).status).toBe(404);
  });

  it("on a published benchmark, no run can be deleted — not even an empty one", async () => {
    const me = await register();
    const { withData, empty } = await publishedWithRuns(me.token, me.user_id);

    // The run carrying measurements can't vanish from the public record → 409 (invalidate instead).
    const del = await apiDelete(`/api/v1/runs/${withData.id}`, bearer(me.token));
    expect(del.status).toBe(409);
    expect(await errorDetail(del)).toBe(DELETE_BLOCKED);

    // Even a run with no measurements is delete-blocked once the benchmark is published.
    const delEmpty = await apiDelete(`/api/v1/runs/${empty.id}`, bearer(me.token));
    expect(delEmpty.status).toBe(409);
    expect(await errorDetail(delEmpty)).toBe(DELETE_BLOCKED);
  });

  it("on a published benchmark, run creation and actions/end remain open", async () => {
    const me = await register();
    const { b, withData } = await publishedWithRuns(me.token, me.user_id);

    // New runs can still be added — the public record grows, it doesn't freeze.
    const create = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "late" } } },
      bearer(me.token),
    );
    expect(create.status).toBe(201);
    expect(((await create.json()) as { data: Resource }).data.attributes.key).toBe("late");

    // Ending a still-live run works too.
    const end = await apiPost(`/api/v1/runs/${withData.id}/actions/end`, undefined, bearer(me.token));
    expect(end.status).toBe(200);
    expect(((await end.json()) as { data: Resource }).data.attributes.live).toBe(false);
  });
});
