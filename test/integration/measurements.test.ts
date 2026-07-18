import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  makeAccountSubject,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  makeSubject,
  mintKey,
  publish,
  register,
  resetDb,
  runUuid,
  type Resource,
} from "./helpers";

/** The internal UUID behind a subject key — never surfaced by the API, read straight from D1 so a
 *  test can exercise the legacy-UUID resolution path. */
async function subjectUuid(key: string): Promise<string> {
  const r = await env.DB.prepare("SELECT id FROM subject WHERE key = ?").bind(key).first<{ id: string }>();
  return r!.id;
}

beforeEach(resetDb);

const measurement = (attrs: Record<string, unknown>) => ({
  data: { type: "measurement", attributes: attrs },
});

async function scaffold(token: string) {
  const b = await makeBenchmark(token);
  const t = await makeSubject(token, b.id);
  const r = await makeRun(token, b.id);
  return { b, t, r };
}

describe("POST /measurements", () => {
  it("creates a bare measurement and computes skew_ms on read", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const created = Date.UTC(2026, 6, 1, 10, 0, 0) + 87;
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: created }),
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { data: Resource }).data;
    expect(body.attributes.run).toBe(r.id);
    expect(body.attributes.subject).toBe(t.id);
    expect((body.attributes.metrics as Record<string, number>).skew_ms).toBe(87);
  });

  it("accepts the subject by key or by UUID, emits the key, and 409s an unlinked subject", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token); // t.id is the subject key, linked to the run's benchmark

    // By key (the migrated wire form): 201, and the response references the subject by its key.
    const byKey = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(me.token),
    );
    expect(byKey.status).toBe(201);
    expect(((await byKey.json()) as { data: Resource }).data.attributes.subject).toBe(t.id);

    // By the internal UUID (legacy path still accepted): 201, and the response still emits the key.
    const uuid = await subjectUuid(t.id as string);
    const byUuid = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: uuid }),
      bearer(me.token),
    );
    expect(byUuid.status).toBe(201);
    expect(((await byUuid.json()) as { data: Resource }).data.attributes.subject).toBe(t.id);

    // A subject that exists in the account but is not linked to the run's benchmark → 409 (unchanged).
    const unlinked = await makeAccountSubject(me.token, "unlinked");
    const bad = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: unlinked.id }),
      bearer(me.token),
    );
    expect(bad.status).toBe(409);
  });

  it("a measurement names a run and a subject", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { data: Resource }).data;
    expect(body.attributes.run).toBe(r.id);
    expect(body.attributes.subject).toBe(t.id);
  });

  it("rejects a measurement whose run and subject are in different benchmarks", async () => {
    const me = await register();
    // Benchmark A gets a run and a subject; benchmark B contributes a foreign subject.
    const bA = await makeBenchmark(me.token, { key: "bench-a" });
    const subjectA = await makeSubject(me.token, bA.id, "subject-a");
    const runA = await makeRun(me.token, bA.id);
    const bB = await makeBenchmark(me.token, { key: "bench-b" });
    const subjectB = await makeSubject(me.token, bB.id, "subject-b");

    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: runA.id, subject: subjectB.id }),
      bearer(me.token),
    );
    expect(res.status).toBe(409);

    // Same-benchmark pairing still succeeds.
    const ok = await apiPost(
      "/api/v1/measurements",
      measurement({ run: runA.id, subject: subjectA.id }),
      bearer(me.token),
    );
    expect(ok.status).toBe(201);
  });

  it("stores numeric metrics and rejects a non-numeric metric value", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const ok = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, metrics: { p95_ms: 12.5 } }),
      bearer(me.token),
    );
    expect(ok.status).toBe(201);
    const bad = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, metrics: { p95_ms: "slow" } }),
      bearer(me.token),
    );
    expect(bad.status).toBe(400);
  });

  it("rejects appending to a run in another account (404)", async () => {
    const a = await register("a@example.com");
    const { t, r } = await scaffold(a.token);
    const b = await register("b@example.com");
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(b.token),
    );
    expect(res.status).toBe(404);
  });

  it("computes elapsed_ms from run.started_at (widened context)", async () => {
    const me = await register();
    const started = Date.UTC(2026, 6, 1, 12, 0, 0);
    const b = await makeBenchmark(me.token, {
      measurement_schema: {
        metrics: [],
        derived: [{ name: "elapsed_ms", expr: { "-": [{ var: "created_at" }, { var: "run.started_at" }] } }],
        chart: { x: "elapsed_ms", y: "elapsed_ms", x_kind: "NUMBER" },
      },
    });
    const t = await makeSubject(me.token, b.id);
    const r = await makeRun(me.token, b.id, { started_at: started });
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: started + 5000 }),
      bearer(me.token),
    );
    const body = ((await res.json()) as { data: Resource }).data;
    expect((body.attributes.metrics as Record<string, number>).elapsed_ms).toBe(5000);
  });
});

describe("GET /measurements", () => {
  it("requires exactly one scope filter", async () => {
    const me = await register();
    const { b, r } = await scaffold(me.token);
    expect((await apiGet("/api/v1/measurements", bearer(me.token))).status).toBe(400);
    expect(
      (await apiGet(`/api/v1/measurements?filter[run]=${r.id}&filter[benchmark]=${b.id}`, bearer(me.token))).status,
    ).toBe(400);
  });

  it("reads measurements scoped to a run and honors visibility", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: Date.UTC(2026, 6, 1, 10, 0, 0) }),
      bearer(me.token),
    );

    // Private → anonymous 404, owner 200.
    expect((await apiGet(`/api/v1/measurements?filter[run]=${r.id}`)).status).toBe(404);
    const owner = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token));
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(1);

    // After publish, anonymous can read by benchmark/subject too.
    await publish(me.token, me.user_id, b.id);
    expect((await apiGet(`/api/v1/measurements?filter[benchmark]=${b.id}`)).status).toBe(200);
    expect((await apiGet(`/api/v1/measurements?filter[subject]=${t.id}`)).status).toBe(200);
  });

  it("serves CSV via the Accept header", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: Date.UTC(2026, 6, 1, 10, 0, 0) }),
      bearer(me.token),
    );
    const res = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, {
      ...bearer(me.token),
      Accept: "text/csv",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(await res.text()).toContain("id,created_at,run,subject");
  });
});

describe("run reference by key (key-as-id migration)", () => {
  it("POST accepts the run by key or UUID (account session), emits the run key, and 404s a foreign run", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token); // r.id is the run key, linked to the run's benchmark

    // By key (the migrated wire form): 201, and the response references the run by its key.
    const byKey = await apiPost("/api/v1/measurements", measurement({ run: r.id, subject: t.id }), bearer(me.token));
    expect(byKey.status).toBe(201);
    expect(((await byKey.json()) as { data: Resource }).data.attributes.run).toBe(r.id);

    // By the internal UUID (legacy path still accepted): 201, and the response still emits the key.
    const byUuid = await apiPost("/api/v1/measurements", measurement({ run: await runUuid(r), subject: t.id }), bearer(me.token));
    expect(byUuid.status).toBe(201);
    expect(((await byUuid.json()) as { data: Resource }).data.attributes.run).toBe(r.id);

    // A run owned by another account → 404 (no-leak). Referenced by its UUID so it resolves to that
    // foreign run and fails coverage (its key would resolve to the caller's own same-keyed run).
    const other = await register("other@example.com");
    const foreign = await scaffold(other.token);
    const foreignRun = await apiPost(
      "/api/v1/measurements",
      measurement({ run: await runUuid(foreign.r), subject: t.id }),
      bearer(me.token),
    );
    expect(foreignRun.status).toBe(404);
  });

  it("POST accepts the run by key with a RUN-scoped and a BENCHMARK-scoped API key", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);

    // A RUN-scoped key references its own run by key; the scope resolves the key to its run.
    const { key: runKey } = await mintKey(me.token, { scope_type: "RUN", scope_ref: await runUuid(r) });
    expect((await apiPost("/api/v1/measurements", measurement({ run: r.id, subject: t.id }), bearer(runKey))).status).toBe(201);

    // A BENCHMARK-scoped key resolves the run key within its scoped benchmark.
    const { key: benchKey } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });
    expect((await apiPost("/api/v1/measurements", measurement({ run: r.id, subject: t.id }), bearer(benchKey))).status).toBe(201);
  });

  it("an ACCOUNT-scoped caller gets a 409 when a run key is ambiguous across benchmarks", async () => {
    const me = await register();
    // Two benchmarks in the same account, each with a run sharing the key "shared".
    const b1 = await makeBenchmark(me.token, { key: "bench-1" });
    const t1 = await makeSubject(me.token, b1.id, "s1");
    await makeRun(me.token, b1.id, { key: "shared" });
    const b2 = await makeBenchmark(me.token, { key: "bench-2" });
    await makeRun(me.token, b2.id, { key: "shared" });

    const res = await apiPost("/api/v1/measurements", measurement({ run: "shared", subject: t1.id }), bearer(me.token));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: { detail: string }[] }).errors[0].detail).toBe(
      "Ambiguous run key across benchmarks; scope the API key to the benchmark.",
    );
  });

  it("filter[run] accepts the run key (and the UUID)", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: Date.UTC(2026, 6, 1, 10, 0, 0) }),
      bearer(me.token),
    );

    const byKey = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token));
    expect(byKey.status).toBe(200);
    expect(((await byKey.json()) as { data: Resource[] }).data.length).toBe(1);

    const byUuid = await apiGet(`/api/v1/measurements?filter[run]=${await runUuid(r)}`, bearer(me.token));
    expect(byUuid.status).toBe(200);
    expect(((await byUuid.json()) as { data: Resource[] }).data.length).toBe(1);
  });
});

describe("DELETE /measurements/:id", () => {
  it("deletes a measurement on a draft benchmark, but not once published", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    const m1 = await makeMeasurement(me.token, r.id, t.id, { metrics: { skew_ms: 1 } });
    const m2 = await makeMeasurement(me.token, r.id, t.id, { metrics: { skew_ms: 2 } });

    // Draft: a measurement is freely deletable.
    expect((await apiDelete(`/api/v1/measurements/${m1.id}`, bearer(me.token))).status).toBe(204);
    const after = (await (await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(after.data.map((x) => x.id)).toEqual([m2.id]);

    // Once published, a measurement must never silently vanish → 409 (correct or invalidate instead).
    await publish(me.token, me.user_id, b.id);
    const del = await apiDelete(`/api/v1/measurements/${m2.id}`, bearer(me.token));
    expect(del.status).toBe(409);
    expect(((await del.json()) as { errors: { detail: string }[] }).errors[0].detail).toBe(
      "A published measurement can't be deleted — the public record must not vanish. Correct it in place or invalidate its run instead.",
    );
  });

  it("404s an unknown id and isolates tenants", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const { t, r } = await scaffold(me.token);
    const m = await makeMeasurement(me.token, r.id, t.id, { metrics: { skew_ms: 1 } });

    expect((await apiDelete("/api/v1/measurements/999999", bearer(me.token))).status).toBe(404);
    expect((await apiDelete("/api/v1/measurements/not-a-number", bearer(me.token))).status).toBe(404);
    // Another account can't see or delete it.
    expect((await apiDelete(`/api/v1/measurements/${m.id}`, bearer(other.token))).status).toBe(404);
  });
});
