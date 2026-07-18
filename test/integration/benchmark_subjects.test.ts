import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  linkSubject,
  makeAccountSubject,
  makeBenchmark,
  makeSubjectType,
  makeMeasurement,
  makeRun,
  markReady,
  publish,
  register,
  resetDb,
  subjectTypeUuid,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

async function link(token: string, benchmarkId: string, subjectId: string) {
  return apiPost(
    "/api/v1/benchmark_subjects",
    { data: { type: "benchmark_subject", attributes: { benchmark: benchmarkId, subject: subjectId } } },
    bearer(token),
  );
}

describe("benchmark_subjects (the M:N link)", () => {
  it("links a subject and rejects a duplicate link", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(me.token, "sys-a");

    const res = await link(me.token, b.id, t.id);
    expect(res.status).toBe(201);
    const linkRes = ((await res.json()) as { data: Resource }).data;
    expect(linkRes.attributes.benchmark).toBe(b.id);
    expect(linkRes.attributes.subject).toBe(t.id);

    // Linking the same pair again → 409.
    expect((await link(me.token, b.id, t.id)).status).toBe(409);
  });

  it("rejects linking a subject from another account (no cross-tenant sharing)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const b = await makeBenchmark(me.token);
    const foreign = await makeAccountSubject(other.token, "foreign");
    expect((await link(me.token, b.id, foreign.id)).status).toBe(409);
  });

  it("rejects linking a non-existent subject (409) and deleting a non-existent link (404)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    expect((await link(me.token, b.id, "ghost-subject")).status).toBe(409);
    expect((await apiDelete("/api/v1/benchmark_subjects/ghost-link", bearer(me.token))).status).toBe(404);
  });

  it("blocks unlinking while a benchmark is marked ready", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(me.token, "t");
    const linkRes = ((await (await link(me.token, b.id, t.id)).json()) as { data: Resource }).data;
    await markReady(me.token, b.id);
    expect((await apiDelete(`/api/v1/benchmark_subjects/${linkRes.id}`, bearer(me.token))).status).toBe(409);
  });

  it("rejects linking into a benchmark the caller can't cover (404, no leak)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(other.token, "t");
    // other tries to link into me's benchmark → indistinguishable 404.
    expect((await link(other.token, b.id, t.id)).status).toBe(404);
  });

  it("lists links by benchmark and by subject", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(me.token, "t");
    await linkSubject(me.token, b.id, t.id);

    const byBench = await apiGet(`/api/v1/benchmark_subjects?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await byBench.json()) as { data: Resource[] }).data.length).toBe(1);
    const bySubject = await apiGet(`/api/v1/benchmark_subjects?filter[subject]=${t.id}`, bearer(me.token));
    expect(((await bySubject.json()) as { data: Resource[] }).data.length).toBe(1);

    // A scope is required.
    expect((await apiGet("/api/v1/benchmark_subjects", bearer(me.token))).status).toBe(404);
  });

  it("unlinks a subject from a private benchmark and drops its measurements there", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(me.token, "t");
    const linkRes = ((await (await link(me.token, b.id, t.id)).json()) as { data: Resource }).data;

    // Removing the link succeeds while private; the subject row survives.
    expect((await apiDelete(`/api/v1/benchmark_subjects/${linkRes.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/subjects/${t.id}`, bearer(me.token))).status).toBe(200);
    const remaining = await apiGet(`/api/v1/subjects?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await remaining.json()) as { data: Resource[] }).data.length).toBe(0);
  });

  it("blocks linking while marked ready; post-publish linking stays open but unlinking is blocked", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(me.token, "t");
    const linkRes = ((await (await link(me.token, b.id, t.id)).json()) as { data: Resource }).data;
    // Satisfy the publish readiness gate up front — a marked-ready benchmark rejects writes,
    // so the run + measurement must exist before mark_ready.
    const run = await makeRun(me.token, b.id);
    await makeMeasurement(me.token, run.id, t.id);

    const t2 = await makeAccountSubject(me.token, "t2");
    await markReady(me.token, b.id);
    // Marked-ready freezes the subtree → linking is blocked.
    expect((await link(me.token, b.id, t2.id)).status).toBe(409);

    await publish(me.token, me.user_id, b.id);
    // Post-publish, linking a new subject is an append to the public record → 201.
    expect((await link(me.token, b.id, t2.id)).status).toBe(201);
    // Unlinking would cascade away the subject's published measurements → still blocked.
    const unlink = await apiDelete(`/api/v1/benchmark_subjects/${linkRes.id}`, bearer(me.token));
    expect(unlink.status).toBe(409);
    expect(((await unlink.json()) as { errors: { detail: string }[] }).errors[0].detail).toBe(
      "A published benchmark's subjects can't be unlinked — that would delete their published measurements. Invalidate the affected runs instead.",
    );
  });

  // A shared subject may span a private and a public benchmark; filter[subject] must not leak the
  // private benchmark's id to callers who can't cover it.
  it("filter[subject] hides a private benchmark's link from anonymous callers", async () => {
    const me = await register();
    const t = await makeAccountSubject(me.token, "shared");
    const priv = await makeBenchmark(me.token, { key: "priv" });
    await linkSubject(me.token, priv.id, t.id);
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await linkSubject(me.token, pub.id, t.id);
    // Create the readiness content (run + measurement) explicitly so publish's auto-seeding stays a
    // no-op and this test controls exactly which links exist.
    const runPub = await makeRun(me.token, pub.id);
    await makeMeasurement(me.token, runPub.id, t.id);
    await publish(me.token, me.user_id, pub.id);

    const anon = await apiGet(`/api/v1/benchmark_subjects?filter[subject]=${t.id}`);
    expect(anon.status).toBe(200);
    const anonLinks = ((await anon.json()) as { data: Resource[] }).data;
    expect(anonLinks.length).toBe(1);
    expect(anonLinks[0].attributes.benchmark).toBe(pub.id); // never the private benchmark id
    // The owner sees both links.
    const owner = await apiGet(`/api/v1/benchmark_subjects?filter[subject]=${t.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(2);
  });
});

describe("measurements filter[subject] visibility across a shared subject's benchmarks", () => {
  it("hides a private sibling benchmark's measurements from anonymous callers", async () => {
    const me = await register();
    const t = await makeAccountSubject(me.token, "shared");
    // A PRIVATE benchmark with a measurement of the shared subject (must stay hidden).
    const priv = await makeBenchmark(me.token, { key: "priv" });
    await linkSubject(me.token, priv.id, t.id);
    // Distinct run keys: an ACCOUNT-scoped caller ingesting by run key needs an unambiguous key, and
    // these two runs live in different benchmarks of the same account.
    const runPriv = await makeRun(me.token, priv.id, { key: "run-priv" });
    await makeMeasurement(me.token, runPriv.id, t.id, { metrics: { skew_ms: 999 } });
    // A PUBLISHED benchmark with a measurement of the same subject (public).
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await linkSubject(me.token, pub.id, t.id);
    const runPub = await makeRun(me.token, pub.id, { key: "run-pub" });
    await makeMeasurement(me.token, runPub.id, t.id, { metrics: { skew_ms: 1 } });
    await publish(me.token, me.user_id, pub.id);

    // Anonymous filter[subject]: only the published run's measurement, never the private one.
    const anon = await apiGet(`/api/v1/measurements?filter[subject]=${t.id}`);
    expect(anon.status).toBe(200);
    const anonRows = ((await anon.json()) as { data: Resource[] }).data;
    expect(anonRows.length).toBe(1);
    expect(anonRows[0].attributes.run).toBe(runPub.id); // the public run, not the private one
    // The owner sees both.
    const owner = await apiGet(`/api/v1/measurements?filter[subject]=${t.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(2);
  });
});

describe("benchmark_subject — type conformance", () => {
  it("rejects linking a subject of a different type (like against like)", async () => {
    const me = await register();
    // The subject type's public id is now its key; benchmark create still references it by internal
    // UUID (benchmark slice pending), while subject create accepts the key — so feed each accordingly.
    const stCpu = await makeSubjectType(me.token, { name: "CPU" });
    const stGpu = await makeSubjectType(me.token, { name: "GPU" });
    const b = await makeBenchmark(me.token, { subject_type: await subjectTypeUuid(stCpu) });

    const gpu = await makeAccountSubject(me.token, "gpu-1", { subject_type: stGpu.id });
    expect((await link(me.token, b.id, gpu.id)).status).toBe(409);

    const cpu = await makeAccountSubject(me.token, "cpu-1", { subject_type: stCpu.id });
    expect((await link(me.token, b.id, cpu.id)).status).toBe(201);
  });
});
