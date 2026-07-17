import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  makeSubject,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

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
