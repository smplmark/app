import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  makeRun,
  makeTarget,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

async function scaffold(token: string, runAttrs: Record<string, unknown> = {}) {
  const b = await makeBenchmark(token);
  const t = await makeTarget(token, b.id);
  const r = await makeRun(token, t.id, runAttrs);
  return { b, t, r };
}

describe("run liveness + actions", () => {
  it("a new run is live (ended_at null)", async () => {
    const me = await register();
    const { r } = await scaffold(me.token);
    expect(r.attributes.live).toBe(true);
    expect(r.attributes.ended_at).toBeNull();
  });

  it("actions/end stamps ended_at and cannot be repeated", async () => {
    const me = await register();
    const { r } = await scaffold(me.token);
    const end = await apiPost(`/api/v1/runs/${r.id}/actions/end`, undefined, bearer(me.token));
    expect(end.status).toBe(200);
    const ended = ((await end.json()) as { data: Resource }).data;
    expect(ended.attributes.live).toBe(false);
    expect(ended.attributes.ended_at).not.toBeNull();
    expect((await apiPost(`/api/v1/runs/${r.id}/actions/end`, undefined, bearer(me.token))).status).toBe(409);
  });

  it("actions/invalidate flags the run but keeps it visible", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
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

    // Still listed after publish (no default-hide).
    await publish(me.token, me.user_id, b.id);
    const list = await apiGet(`/api/v1/runs?filter[target]=${t.id}`);
    expect(((await list.json()) as { data: Resource[] }).data.length).toBe(1);
  });
});

describe("started_at freeze + delete rules", () => {
  it("freezes started_at once published", async () => {
    const me = await register();
    const started = Date.UTC(2026, 6, 1, 0, 0, 0);
    const { b, r } = await scaffold(me.token, { started_at: started });
    await publish(me.token, me.user_id, b.id);

    // Same started_at is fine.
    const same = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", started_at: new Date(started).toISOString() } } },
      bearer(me.token),
    );
    expect(same.status).toBe(200);

    // Changing it is frozen.
    const changed = await apiPut(
      `/api/v1/runs/${r.id}`,
      { data: { type: "run", attributes: { name: "n", started_at: started + 1000 } } },
      bearer(me.token),
    );
    expect(changed.status).toBe(409);
  });

  it("forbids deleting a run of a published benchmark", async () => {
    const me = await register();
    const { b, r } = await scaffold(me.token);
    await publish(me.token, me.user_id, b.id);
    expect((await apiDelete(`/api/v1/runs/${r.id}`, bearer(me.token))).status).toBe(409);
  });
});
