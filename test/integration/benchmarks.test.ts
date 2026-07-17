import { beforeEach, describe, expect, it } from "vitest";
import {
  allowPersonalPublish,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  linkSubject,
  makeAccountSubject,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  makeSubject,
  markReady,
  markVerified,
  publish,
  register,
  resetDb,
  seedPublishable,
  SKEW_SCHEMA,
  type Resource,
  makeSubjectType,
} from "./helpers";

beforeEach(resetDb);

const putBody = (attrs: Record<string, unknown>) => ({
  data: { type: "benchmark", attributes: attrs },
});

describe("benchmark create + read", () => {
  it("creates a PRIVATE benchmark owned by the caller's account", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    expect(b.attributes.status).toBe("PRIVATE");
    expect(b.attributes.account).toBe(me.account_id);
    expect(b.attributes.published_at).toBeNull();
  });

  it("auto-generates the key from the name when omitted (unique within the account)", async () => {
    const me = await register();
    const st = (await makeSubjectType(me.token)).id;
    const mk = (name: string) => apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { name, subject_type: st } } },
      bearer(me.token),
    );
    const first = ((await (await mk("CPU Throughput 2026")).json()) as { data: Resource }).data;
    expect(first.attributes.key).toBe("cpu-throughput-2026");
    // A second benchmark with the same name gets a numeric suffix.
    const second = ((await (await mk("CPU Throughput 2026")).json()) as { data: Resource }).data;
    expect(second.attributes.key).toBe("cpu-throughput-2026-2");
    // An explicit key is still honored.
    const explicit = ((await (await apiPost("/api/v1/benchmarks", { data: { type: "benchmark", attributes: { key: "my-key", name: "Whatever", subject_type: st } } }, bearer(me.token))).json()) as { data: Resource }).data;
    expect(explicit.attributes.key).toBe("my-key");
  });

  it("defaults to an empty measurement_schema when none is supplied, as a draft", async () => {
    const me = await register();
    const st = (await makeSubjectType(me.token)).id;
    const res = await apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { key: "no-schema", name: "No Schema", subject_type: st } } },
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const b = ((await res.json()) as { data: Resource }).data;
    expect(b.attributes.measurement_schema).toEqual({ metrics: [], derived: [] });
    expect(b.attributes.draft).toBe(true);
    expect(b.attributes.created_by).toBe(me.user_id);
  });

  it("hides a PRIVATE benchmark from anonymous reads (404) but shows it to the owner", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    expect((await apiGet(`/api/v1/benchmarks/${b.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/benchmarks/${b.id}`, bearer(me.token))).status).toBe(200);
  });

  it("lists public benchmarks anonymously; owner sees their private ones via filter[account]", async () => {
    const me = await register();
    const priv = await makeBenchmark(me.token, { key: "priv" });
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await publish(me.token, me.user_id, pub.id);

    const anon = (await (await apiGet("/api/v1/benchmarks")).json()) as { data: Resource[] };
    const anonKeys = anon.data.map((r) => r.attributes.key);
    expect(anonKeys).toContain("pub");
    expect(anonKeys).not.toContain("priv");

    const owner = (await (
      await apiGet(`/api/v1/benchmarks?filter[account]=${me.account_id}`, bearer(me.token))
    ).json()) as { data: Resource[] };
    expect(owner.data.map((r) => r.attributes.key).sort()).toEqual(["priv", "pub"]);
    void priv;
  });

  it("exposes publisher_slug and narrows the list by it via filter[publisher]", async () => {
    const me = await register();
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await publish(me.token, me.user_id, pub.id);

    // The owning account's key rides on the (create/read) benchmark payload.
    const slug = pub.attributes.publisher_slug as string;
    expect(typeof slug).toBe("string");
    expect(slug.length).toBeGreaterThan(0);

    const byPublisher = (await (
      await apiGet(`/api/v1/benchmarks?filter[publisher]=${encodeURIComponent(slug)}`)
    ).json()) as { data: Resource[] };
    expect(byPublisher.data.map((r) => r.attributes.key)).toContain("pub");
    for (const r of byPublisher.data) expect(r.attributes.publisher_slug).toBe(slug);

    // An unknown slug matches nothing rather than erroring.
    const none = (await (
      await apiGet("/api/v1/benchmarks?filter[publisher]=no-such-publisher")
    ).json()) as { data: Resource[] };
    expect(none.data).toEqual([]);
  });
});

describe("publish gate + lifecycle", () => {
  it("blocks publishing until the owner's email is verified", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id); // clear the readiness gate; must precede mark_ready
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const blocked = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(blocked.status).toBe(403);

    await markVerified(me.user_id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(ok.status).toBe(200);
    const published = ((await ok.json()) as { data: Resource }).data;
    expect(published.attributes.status).toBe("PUBLISHED");
    expect(published.attributes.draft).toBe(false);
    expect((published.attributes.published_as as { kind: string }).kind).toBe("PERSONAL");
  });

  it("publishes directly from a draft (no separate ready step)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id); // clear the readiness gate
    await allowPersonalPublish(b.id);
    // A benchmark is created as a draft; publishing it directly succeeds (two-stage lifecycle).
    expect(b.attributes.draft).toBe(true);
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(res.status).toBe(200);
    const published = ((await res.json()) as { data: Resource }).data;
    expect(published.attributes.status).toBe("PUBLISHED");
    expect(published.attributes.draft).toBe(false);
  });

  it("refuses to publish an empty benchmark, listing every missing piece", async () => {
    const me = await register();
    await markVerified(me.user_id);
    // Empty measurement_schema → even the metric requirement is unmet.
    const b = await makeBenchmark(me.token, { measurement_schema: { metrics: [], derived: [] } });
    await allowPersonalPublish(b.id);
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { errors: { detail: string }[] };
    expect(body.errors[0].detail).toBe(
      "This benchmark isn't ready to publish — it needs at least one subject, one metric, one run and one measurement.",
    );
  });

  it("publishes only once a subject, run, and measurement all exist (readiness gate)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token); // SKEW_SCHEMA satisfies the metric requirement
    await allowPersonalPublish(b.id);
    const subject = await makeSubject(me.token, b.id); // create + link
    const run = await makeRun(me.token, b.id);

    const blocked = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { errors: { detail: string }[] };
    expect(body.errors[0].detail).toBe(
      "This benchmark isn't ready to publish — it needs at least one measurement.",
    );

    await makeMeasurement(me.token, run.id, subject.id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(ok.status).toBe(200);
  });

  it("publish is a one-way door (re-publish → 409)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);
    const again = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, undefined, bearer(me.token));
    expect(again.status).toBe(409);
  });

  it("withdraws a published benchmark (reason required) and keeps it world-visible", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);

    const noReason = await apiPost(`/api/v1/benchmarks/${b.id}/actions/withdraw`, { data: { type: "benchmark", attributes: {} } }, bearer(me.token));
    expect(noReason.status).toBe(400);

    const w = await apiPost(
      `/api/v1/benchmarks/${b.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "bad clock" } } },
      bearer(me.token),
    );
    expect(w.status).toBe(200);
    const anon = await apiGet(`/api/v1/benchmarks/${b.id}`);
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { data: Resource }).data.attributes.status).toBe("WITHDRAWN");
  });

  it("cannot withdraw a benchmark that was never published", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const w = await apiPost(
      `/api/v1/benchmarks/${b.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "x" } } },
      bearer(me.token),
    );
    expect(w.status).toBe(409);
  });
});

describe("post-publish edits (auditable record, not frozen)", () => {
  it("allows cosmetic and semantic-core edits after publish", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const st = b.attributes.subject_type as string;
    await publish(me.token, me.user_id, b.id);

    // Cosmetic prose edit is allowed.
    const ok = await apiPut(
      `/api/v1/benchmarks/${b.id}`,
      putBody({ name: "Renamed", description: "new tagline", subject_type: st, measurement_schema: SKEW_SCHEMA }),
      bearer(me.token),
    );
    expect(ok.status).toBe(200);

    // Changing a derived expression is allowed too — the semantic-core change is audited, not blocked.
    const semantic = await apiPut(
      `/api/v1/benchmarks/${b.id}`,
      putBody({
        name: "Renamed",
        subject_type: st,
        measurement_schema: {
          metrics: [],
          derived: [{ name: "skew_ms", expr: { "+": [1, 1] } }],
          chart: { x: "created_at", y: "skew_ms", x_kind: "TIME" },
        },
      }),
      bearer(me.token),
    );
    expect(semantic.status).toBe(200);

    // Appending a new metric lands as well, and the schema grows.
    const appended = await apiPut(
      `/api/v1/benchmarks/${b.id}`,
      putBody({
        name: "Renamed",
        subject_type: st,
        measurement_schema: {
          ...SKEW_SCHEMA,
          derived: [...SKEW_SCHEMA.derived, { name: "extra_ms", unit: "ms", expr: { "+": [1, 1] } }],
        },
      }),
      bearer(me.token),
    );
    expect(appended.status).toBe(200);
    const schema = ((await appended.json()) as { data: Resource }).data.attributes
      .measurement_schema as { derived: { name: string }[] };
    expect(schema.derived.map((d) => d.name)).toEqual(["skew_ms", "extra_ms"]);
  });

  it("forbids deleting a published benchmark but allows deleting a private one", async () => {
    const me = await register();
    const priv = await makeBenchmark(me.token, { key: "priv" });
    expect((await apiDelete(`/api/v1/benchmarks/${priv.id}`, bearer(me.token))).status).toBe(204);

    // Deleting is the one mutation an audit trail can't cover — the public record must not vanish.
    const pub = await makeBenchmark(me.token, { key: "pub" });
    await publish(me.token, me.user_id, pub.id);
    const del = await apiDelete(`/api/v1/benchmarks/${pub.id}`, bearer(me.token));
    expect(del.status).toBe(409);
    expect(((await del.json()) as { errors: { detail: string }[] }).errors[0].detail).toBe(
      "A published benchmark can't be deleted — the public record must not vanish. Withdraw it instead, or request a takedown for true removal.",
    );
  });
});

describe("benchmark subject_type (like against like)", () => {
  it("requires a valid subject_type in the caller's account on create", async () => {
    const me = await register();
    const post = (attrs: Record<string, unknown>) =>
      apiPost("/api/v1/benchmarks", { data: { type: "benchmark", attributes: { name: "X", ...attrs } } }, bearer(me.token));
    expect((await post({})).status).toBe(400); // missing
    expect((await post({ subject_type: "ghost" })).status).toBe(400); // unknown
    const other = await register("other-st@example.com");
    const foreign = (await makeSubjectType(other.token)).id;
    expect((await post({ subject_type: foreign })).status).toBe(400); // another account's type

    const st = (await makeSubjectType(me.token, { name: "CPU" })).id;
    const b = await makeBenchmark(me.token, { subject_type: st });
    expect(b.attributes.subject_type).toBe(st);
  });

  it("locks subject_type while subjects are linked; editable again once unlinked", async () => {
    const me = await register();
    const st1 = (await makeSubjectType(me.token, { name: "CPU" })).id;
    const st2 = (await makeSubjectType(me.token, { name: "GPU" })).id;
    const b = await makeBenchmark(me.token, { subject_type: st1 });
    const subject = await makeAccountSubject(me.token, "cpu-1", { subject_type: st1 });
    const link = await linkSubject(me.token, b.id, subject.id);
    const put = (stx: string) =>
      apiPut(`/api/v1/benchmarks/${b.id}`, putBody({ name: "Scheduler Latency", subject_type: stx, measurement_schema: SKEW_SCHEMA }), bearer(me.token));
    expect((await put(st2)).status).toBe(409); // linked → locked
    expect((await put(st1)).status).toBe(200); // same value round-trips (get-mutate-put)
    await apiDelete(`/api/v1/benchmark_subjects/${link.id}`, bearer(me.token));
    expect((await put(st2)).status).toBe(200); // unlinked → change allowed
  });
});

describe("tenant isolation", () => {
  it("returns 404 (not 403) when another account touches a private benchmark", async () => {
    const a = await register("a@example.com");
    const bench = await makeBenchmark(a.token);
    const b = await register("b@example.com");
    expect((await apiGet(`/api/v1/benchmarks/${bench.id}`, bearer(b.token))).status).toBe(404);
    expect(
      (await apiPut(`/api/v1/benchmarks/${bench.id}`, putBody({ name: "x", measurement_schema: SKEW_SCHEMA }), bearer(b.token))).status,
    ).toBe(404);
    expect((await apiDelete(`/api/v1/benchmarks/${bench.id}`, bearer(b.token))).status).toBe(404);
  });
});
