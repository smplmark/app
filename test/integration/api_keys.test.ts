import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  makeBenchmark,
  makeRun,
  makeTarget,
  mintKey,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const obs = (runId: string) => ({ data: { type: "observation", attributes: { run: runId } } });

describe("minting + authority ceiling", () => {
  it("an account session mints an ACCOUNT key and returns the plaintext once", async () => {
    const me = await register();
    const { key, resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    expect(key.startsWith("sm_api_")).toBe(true);
    expect(resource.attributes.scope_type).toBe("ACCOUNT");
    // The key authenticates.
    expect((await apiGet("/api/v1/accounts/current", bearer(key))).status).toBe(200);
  });

  it("a RUN-scoped key cannot mint an ACCOUNT key (authority ceiling → 403)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r = await makeRun(me.token, t.id);
    const { key: runKey } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r.id });

    const escalate = await apiPost(
      "/api/v1/api_keys",
      { data: { type: "api_key", attributes: { name: "evil", scope_type: "ACCOUNT" } } },
      bearer(runKey),
    );
    expect(escalate.status).toBe(403);
  });
});

describe("scope enforcement", () => {
  it("a RUN key can append to its run but not another run, and cannot create benchmarks", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id);
    const r1 = await makeRun(me.token, t.id);
    const r2 = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { target: t.id, key: "second" } } },
      bearer(me.token),
    );
    const run2 = ((await r2.json()) as { data: Resource }).data;
    const { key: runKey } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r1.id });

    expect((await apiPost("/api/v1/observations", obs(r1.id), bearer(runKey))).status).toBe(201);
    expect((await apiPost("/api/v1/observations", obs(run2.id), bearer(runKey))).status).toBe(404);
    // Cannot create a benchmark (scope < ACCOUNT).
    const create = await apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { key: "x", name: "x" } } },
      bearer(runKey),
    );
    expect(create.status).toBe(403);
    // Cannot manage keys either.
    expect((await apiGet("/api/v1/api_keys", bearer(runKey))).status).toBe(403);
  });
});

describe("reveal / rotate / revoke", () => {
  it("reveals the full key value", async () => {
    const me = await register();
    const { key, resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const res = await apiGet(`/api/v1/api_keys/${resource.id}`, bearer(me.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Resource }).data.attributes.key).toBe(key);
  });

  it("rotate revokes the old key and issues a new one", async () => {
    const me = await register();
    const { key: oldKey, resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const rot = await apiPost(`/api/v1/api_keys/${resource.id}/actions/rotate`, undefined, bearer(me.token));
    expect(rot.status).toBe(201);
    const newKey = ((await rot.json()) as { data: Resource }).data.attributes.key as string;
    expect(newKey).not.toBe(oldKey);
    // Old key no longer authenticates; new key does.
    expect((await apiGet("/api/v1/accounts/current", bearer(oldKey))).status).toBe(401);
    expect((await apiGet("/api/v1/accounts/current", bearer(newKey))).status).toBe(200);
  });

  it("revokes a key (subsequent use → 401)", async () => {
    const me = await register();
    const { key, resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    expect((await apiDelete(`/api/v1/api_keys/${resource.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet("/api/v1/accounts/current", bearer(key))).status).toBe(401);
  });
});
