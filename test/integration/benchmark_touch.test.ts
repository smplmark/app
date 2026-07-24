import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiPost,
  apiPut,
  bearer,
  linkSubject,
  makeAccountSubject,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  register,
  resetDb,
  type Registered,
  type Resource,
} from "./helpers";

// A benchmark's public "last updated" (benchmark.updated_at) must move when its CHILD data changes —
// a run, a measurement, or a subject link — not only when its own columns do. Each test stamps the
// benchmark's updated_at to an ancient value, performs one child mutation, and asserts the timestamp
// jumped forward to a real wall-clock `now`. RECENT is far below any Date.now() but far above the
// stamped sentinel, so a real bump is unambiguous and no test races the millisecond clock.
const RECENT = 1_600_000_000_000; // 2020-09-13; every real Date.now() is well past this.

async function benchUpdatedAt(id: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT updated_at FROM benchmark WHERE id = ?")
    .bind(id)
    .first<{ updated_at: number }>();
  if (row === null) throw new Error(`benchmark ${id} not found`);
  return row.updated_at;
}

/** Force a benchmark's updated_at back to a sentinel so any later bump is provable. */
async function stampOld(id: string, value = 1): Promise<void> {
  await env.DB.prepare("UPDATE benchmark SET updated_at = ? WHERE id = ?").bind(value, id).run();
}

interface Fixture {
  owner: Registered;
  bench: Resource;
  subject: Resource;
  run: Resource;
}

/** A PRIVATE draft benchmark with one linked subject and one live run — the editable base state that
 *  every child-mutation path below operates on. */
async function fixture(): Promise<Fixture> {
  const owner = await register();
  const bench = await makeBenchmark(owner.token);
  const subject = await makeAccountSubject(owner.token, "subj-a");
  await linkSubject(owner.token, bench.id, subject.id);
  const run = await makeRun(owner.token, bench.id, { key: "run-a" });
  return { owner, bench, subject, run };
}

beforeEach(resetDb);

describe("runs bump the parent benchmark's updated_at", () => {
  it("create", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await stampOld(bench.id);
    await makeRun(owner.token, bench.id, { key: "run-x" });
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("update (PUT)", async () => {
    const { owner, bench, run } = await fixture();
    await stampOld(bench.id);
    const res = await apiPut(
      `/api/v1/runs/${run.id}`,
      { data: { type: "run", attributes: { name: "Run renamed" } } },
      bearer(owner.token),
    );
    expect(res.status).toBe(200);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("end (action)", async () => {
    const { owner, bench, run } = await fixture();
    await stampOld(bench.id);
    const res = await apiPost(`/api/v1/runs/${run.id}/actions/end`, undefined, bearer(owner.token));
    expect(res.status).toBe(200);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("invalidate (action)", async () => {
    const { owner, bench, run } = await fixture();
    await stampOld(bench.id);
    const res = await apiPost(
      `/api/v1/runs/${run.id}/actions/invalidate`,
      { data: { type: "run", attributes: { invalidation_reason: "bad harness" } } },
      bearer(owner.token),
    );
    expect(res.status).toBe(200);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("delete", async () => {
    const { owner, bench, run } = await fixture();
    await stampOld(bench.id);
    const res = await apiDelete(`/api/v1/runs/${run.id}`, bearer(owner.token));
    expect(res.status).toBe(204);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });
});

describe("measurements bump the parent benchmark's updated_at", () => {
  it("create", async () => {
    const { owner, bench, run, subject } = await fixture();
    await stampOld(bench.id);
    await makeMeasurement(owner.token, run.id, subject.id);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("update (PUT)", async () => {
    const { owner, bench, run, subject } = await fixture();
    const m = await makeMeasurement(owner.token, run.id, subject.id);
    await stampOld(bench.id);
    const res = await apiPut(
      `/api/v1/measurements/${m.id}`,
      { data: { type: "measurement", attributes: { created_at: 2000 } } },
      bearer(owner.token),
    );
    expect(res.status).toBe(200);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("delete", async () => {
    const { owner, bench, run, subject } = await fixture();
    const m = await makeMeasurement(owner.token, run.id, subject.id);
    await stampOld(bench.id);
    const res = await apiDelete(`/api/v1/measurements/${m.id}`, bearer(owner.token));
    expect(res.status).toBe(204);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });
});

describe("subject links bump the parent benchmark's updated_at", () => {
  it("link (POST /benchmark_subjects)", async () => {
    const { owner, bench } = await fixture();
    const other = await makeAccountSubject(owner.token, "subj-b");
    await stampOld(bench.id);
    await linkSubject(owner.token, bench.id, other.id);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });

  it("unlink (DELETE /benchmark_subjects/:id)", async () => {
    const { owner, bench } = await fixture();
    const other = await makeAccountSubject(owner.token, "subj-b");
    const link = await linkSubject(owner.token, bench.id, other.id);
    await stampOld(bench.id);
    const res = await apiDelete(`/api/v1/benchmark_subjects/${link.id}`, bearer(owner.token));
    expect(res.status).toBe(204);
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });
});

// A subject is account-owned and M:N with benchmarks, so editing/deleting the subject ENTITY has no
// single owning benchmark: the change bumps EVERY benchmark it's linked to. (Product-judgment default
// — see the completion summary.)
describe("editing a subject entity bumps every linked benchmark (M:N)", () => {
  it("rename bumps all linked benchmarks with one shared timestamp", async () => {
    const owner = await register();
    const bench1 = await makeBenchmark(owner.token, { key: "bench-1" });
    const bench2 = await makeBenchmark(owner.token, { key: "bench-2" });
    const subject = await makeAccountSubject(owner.token, "shared-subj");
    await linkSubject(owner.token, bench1.id, subject.id);
    await linkSubject(owner.token, bench2.id, subject.id);
    await stampOld(bench1.id);
    await stampOld(bench2.id);

    const res = await apiPut(
      `/api/v1/subjects/${subject.id}`,
      { data: { type: "subject", attributes: { name: "Renamed subject" } } },
      bearer(owner.token),
    );
    expect(res.status).toBe(200);

    const t1 = await benchUpdatedAt(bench1.id);
    const t2 = await benchUpdatedAt(bench2.id);
    expect(t1).toBeGreaterThan(RECENT);
    expect(t2).toBeGreaterThan(RECENT);
    // One batch, one `now` — the fan-out stamps every linked benchmark identically.
    expect(t1).toBe(t2);
  });

  it("delete bumps the linked benchmark before its links are removed", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeAccountSubject(owner.token, "doomed-subj");
    await linkSubject(owner.token, bench.id, subject.id);
    await stampOld(bench.id);

    const res = await apiDelete(`/api/v1/subjects/${subject.id}`, bearer(owner.token));
    expect(res.status).toBe(204);
    // The benchmark survives (only the link and the subject go away) and carries the fresh timestamp.
    expect(await benchUpdatedAt(bench.id)).toBeGreaterThan(RECENT);
  });
});
