import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  makeRun,
  makeSubject,
  mintKey,
  register,
  resetDb,
  runUuid,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const measurement = (runId: string, subjectId: string) => ({
  data: { type: "measurement", attributes: { run: runId, subject: subjectId } },
});

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
    const r = await makeRun(me.token, b.id);
    // A run is referenced by its customer-facing key (the run resource's public id), never the
    // internal id — scope a RUN key by the run's key.
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
    const t = await makeSubject(me.token, b.id);
    const r1 = await makeRun(me.token, b.id);
    const r2 = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: b.id, key: "second" } } },
      bearer(me.token),
    );
    const run2 = ((await r2.json()) as { data: Resource }).data;
    const { key: runKey } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r1.id });

    // Its own run (referenced by key), naming a valid same-benchmark subject → 201; another run's key
    // resolves within the RUN scope to a non-matching run → 404 (out of scope).
    expect((await apiPost("/api/v1/measurements", measurement(r1.id, t.id), bearer(runKey))).status).toBe(201);
    expect((await apiPost("/api/v1/measurements", measurement(run2.id, t.id), bearer(runKey))).status).toBe(404);
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

  it("a BENCHMARK key writes measurements for many subjects under one run, but not another benchmark's run", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const subjectA = await makeSubject(me.token, b.id, "sched-a");
    const subjectB = await makeSubject(me.token, b.id, "sched-b");
    const r = await makeRun(me.token, b.id);
    const { key: benchKey } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });

    // One run, multiple subjects in the same benchmark — all covered by the benchmark scope.
    expect((await apiPost("/api/v1/measurements", measurement(r.id, subjectA.id), bearer(benchKey))).status).toBe(201);
    expect((await apiPost("/api/v1/measurements", measurement(r.id, subjectB.id), bearer(benchKey))).status).toBe(201);

    // A run in a different benchmark is out of the key's scope → 404. Referenced by the foreign run's
    // internal id so it resolves to that run (its key would resolve within b's scope, not other's).
    const other = await makeBenchmark(me.token, { key: "other-benchmark", name: "Other" });
    const otherSubject = await makeSubject(me.token, other.id, "other-a");
    const otherRun = await makeRun(me.token, other.id);
    expect(
      (await apiPost("/api/v1/measurements", measurement(await runUuid(otherRun), otherSubject.id), bearer(benchKey))).status,
    ).toBe(404);
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

  it("renames a key (only the name is mutable)", async () => {
    const me = await register();
    const { resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const put = await apiPut(
      `/api/v1/api_keys/${resource.id}`,
      { data: { type: "api_key", attributes: { name: "Renamed" } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("Renamed");
  });

  it("revoke disables a key but keeps it listed as revoked", async () => {
    const me = await register();
    const { key, resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const rev = await apiPost(`/api/v1/api_keys/${resource.id}/actions/revoke`, undefined, bearer(me.token));
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as { data: Resource }).data.attributes.revoked).toBe(true);
    // Stops authenticating…
    expect((await apiGet("/api/v1/accounts/current", bearer(key))).status).toBe(401);
    // …but the row remains, still fetchable and marked revoked.
    const got = await apiGet(`/api/v1/api_keys/${resource.id}`, bearer(me.token));
    expect(got.status).toBe(200);
    expect(((await got.json()) as { data: Resource }).data.attributes.revoked).toBe(true);
  });

  it("delete removes a key entirely (subsequent use → 401, and it's gone)", async () => {
    const me = await register();
    const { key, resource } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    expect((await apiDelete(`/api/v1/api_keys/${resource.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet("/api/v1/accounts/current", bearer(key))).status).toBe(401);
    expect((await apiGet(`/api/v1/api_keys/${resource.id}`, bearer(me.token))).status).toBe(404);
  });
});

describe("list scope filter", () => {
  it("filters by scope_type + scope_ref so each tab sees only its own keys", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const r = await makeRun(me.token, b.id);
    const rKey = r.id; // a run is referenced by its customer-facing key (its public id)
    const acct = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const bench = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });
    const run = await mintKey(me.token, { scope_type: "RUN", scope_ref: rKey });

    const ids = async (qs: string) => {
      const res = await apiGet("/api/v1/api_keys" + qs, bearer(me.token));
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Resource[] }).data.map((k) => k.id).sort();
    };

    expect(await ids("")).toEqual([acct.resource.id, bench.resource.id, run.resource.id].sort());
    expect(await ids("?filter[scope_type]=ACCOUNT")).toEqual([acct.resource.id]);
    expect(await ids(`?filter[scope_type]=BENCHMARK&filter[scope_ref]=${b.id}`)).toEqual([bench.resource.id]);
    expect(await ids(`?filter[scope_type]=RUN&filter[scope_ref]=${rKey}`)).toEqual([run.resource.id]);

    // A different benchmark's filter returns nothing; an invalid scope_type is a 400.
    const b2 = await makeBenchmark(me.token, { key: "second", name: "Second" });
    expect(await ids(`?filter[scope_type]=BENCHMARK&filter[scope_ref]=${b2.id}`)).toEqual([]);
    expect((await apiGet("/api/v1/api_keys?filter[scope_type]=BOGUS", bearer(me.token))).status).toBe(400);
  });
});

describe("RUN scope is referenced by the run's key, never its internal id", () => {
  const mintRun = (token: string, scopeRef: string) =>
    apiPost(
      "/api/v1/api_keys",
      { data: { type: "api_key", attributes: { name: "ci", scope_type: "RUN", scope_ref: scopeRef } } },
      bearer(token),
    );

  it("mints + lists by the run's key; the internal id is rejected (404)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const r = await makeRun(me.token, b.id, { key: "final" });

    // The customer-facing key mints the run-scoped key; the internal id (never surfaced) does not.
    const ok = await mintRun(me.token, r.id);
    expect(ok.status).toBe(201);
    expect((await mintRun(me.token, await runUuid(r))).status).toBe(404);

    // The Console's API Keys tab lists by the same key and finds the key it just created.
    const listed = await apiGet(
      `/api/v1/api_keys?filter[scope_type]=RUN&filter[scope_ref]=${encodeURIComponent(r.id)}`,
      bearer(me.token),
    );
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { data: Resource[] }).data;
    expect(rows).toHaveLength(1);
    // The internal id filters nothing (it is not a run key in this account) — an empty list, not a leak.
    const byId = await apiGet(
      `/api/v1/api_keys?filter[scope_type]=RUN&filter[scope_ref]=${encodeURIComponent(await runUuid(r))}`,
      bearer(me.token),
    );
    expect(((await byId.json()) as { data: Resource[] }).data).toHaveLength(0);
  });

  it("a shared run key resolves only within the caller's own tenant, never another's run", async () => {
    // Two accounts each own a run keyed "final"; A's key must scope to A's run, never B's.
    const a = await register("a@example.com");
    const bA = await makeBenchmark(a.token, { key: "a-bench" });
    const aRun = await makeRun(a.token, bA.id, { key: "final" });

    const other = await register("b@example.com");
    const bB = await makeBenchmark(other.token, { key: "b-bench" });
    await makeRun(other.token, bB.id, { key: "final" });

    // A's admin naming the bare key "final" resolves only within A's account — B's run is invisible.
    const res = await mintRun(a.token, "final");
    expect(res.status).toBe(201);
    const scopeRef = ((await res.json()) as { data: Resource }).data.attributes.scope_ref;
    expect(scopeRef).toBe(await runUuid(aRun)); // scoped to A's own run, never B's
  });

  it("409s when a bare run key is ambiguous across the account's benchmarks", async () => {
    const me = await register();
    const b1 = await makeBenchmark(me.token, { key: "bench-one" });
    const b2 = await makeBenchmark(me.token, { key: "bench-two" });
    await makeRun(me.token, b1.id, { key: "dup" });
    await makeRun(me.token, b2.id, { key: "dup" });
    // "dup" names a run in two of the account's benchmarks — the account-wide lookup can't disambiguate.
    expect((await mintRun(me.token, "dup")).status).toBe(409);
  });
});
