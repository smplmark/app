import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeAccountSubject,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  makeSubject,
  publish,
  register,
  resetDb,
  SKEW_SCHEMA,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

function action(kind: string, id: string, name: string, token: string) {
  return apiPost(`/api/v1/${kind}/${id}/actions/${name}`, undefined, bearer(token));
}

/** Await the response, assert 409, and pin the exact error detail. */
async function expectConflict(
  pending: ReturnType<typeof apiPost>,
  detail: string,
): Promise<void> {
  const res = await pending;
  expect(res.status).toBe(409);
  const body = (await res.json()) as { errors: { detail: string }[] };
  expect(body.errors[0].detail).toBe(detail);
}

const SUBJECTS_FROZEN =
  "This benchmark is published; its subjects are frozen and no new ones can be added.";
const RUNS_FROZEN = "This benchmark is published; its runs are frozen and cannot be changed.";
const DATA_FROZEN =
  "This benchmark is published; its data is frozen and no new measurements can be added.";
const METRICS_FROZEN =
  "This benchmark is published; its metrics are frozen and no new ones can be added.";
const INTERPRETATION_FROZEN =
  "A published benchmark's schema is frozen: its metrics, derived expressions, and chart mapping cannot be changed or removed. Only descriptions and unit labels may be edited.";

describe("closed lifecycle — benchmark", () => {
  it("close on a private benchmark blocks new subjects/runs/measurements; reopen restores; doubles 409", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);

    const closed = await action("benchmarks", bench.id, "close", owner.token);
    expect(closed.status).toBe(200);
    const attrs = ((await closed.json()) as { data: Resource }).data.attributes;
    expect(attrs.closed).toBe(true);
    expect(typeof attrs.closed_at).toBe("string");

    // Everything beneath refuses new data. Linking a new subject into the closed benchmark is blocked
    // (the account-level subject create itself is fine — only the membership is refused).
    const t2 = await makeAccountSubject(owner.token, "t2");
    await expectConflict(
      apiPost(
        "/api/v1/benchmark_subjects",
        { data: { type: "benchmark_subject", attributes: { benchmark: bench.id, subject: t2.id } } },
        bearer(owner.token),
      ),
      "This benchmark is closed; no new subjects can be added.",
    );
    await expectConflict(
      apiPost(
        "/api/v1/runs",
        { data: { type: "run", attributes: { benchmark: bench.id, key: "r2" } } },
        bearer(owner.token),
      ),
      "This benchmark is closed; no new runs can be added.",
    );
    await expectConflict(
      apiPost(
        "/api/v1/measurements",
        { data: { type: "measurement", attributes: { run: run.id, subject: subject.id } } },
        bearer(owner.token),
      ),
      "This benchmark is closed; no new measurements can be added.",
    );
    // Double close → 409.
    expect((await action("benchmarks", bench.id, "close", owner.token)).status).toBe(409);

    // Reopen restores appendability (the benchmark is still private — no publish freeze in the way).
    expect((await action("benchmarks", bench.id, "reopen", owner.token)).status).toBe(200);
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, subject: subject.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    expect((await action("benchmarks", bench.id, "reopen", owner.token)).status).toBe(409);
  });

  it("publish freezes subjects/runs/measurements outright; close/reopen still toggle but restore nothing", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    await publish(owner.token, owner.user_id, bench.id);

    // The published freeze takes precedence over the closed gate — the messages name the publish.
    const t2 = await makeAccountSubject(owner.token, "t2");
    const linkT2 = () =>
      apiPost(
        "/api/v1/benchmark_subjects",
        { data: { type: "benchmark_subject", attributes: { benchmark: bench.id, subject: t2.id } } },
        bearer(owner.token),
      );
    const postRun = () =>
      apiPost(
        "/api/v1/runs",
        { data: { type: "run", attributes: { benchmark: bench.id, key: "r2" } } },
        bearer(owner.token),
      );
    const postMeasurement = () =>
      apiPost(
        "/api/v1/measurements",
        { data: { type: "measurement", attributes: { run: run.id, subject: subject.id } } },
        bearer(owner.token),
      );
    await expectConflict(linkT2(), SUBJECTS_FROZEN);
    await expectConflict(postRun(), RUNS_FROZEN);
    await expectConflict(postMeasurement(), DATA_FROZEN);

    // Close and reopen remain available as lifecycle signals…
    expect((await action("benchmarks", bench.id, "close", owner.token)).status).toBe(200);
    expect((await action("benchmarks", bench.id, "reopen", owner.token)).status).toBe(200);
    // …but reopening no longer restores appendability: the publish freeze holds regardless.
    await expectConflict(linkT2(), SUBJECTS_FROZEN);
    await expectConflict(postRun(), RUNS_FROZEN);
    await expectConflict(postMeasurement(), DATA_FROZEN);
  });

  it("close needs author-or-admin authority; the public sees the closed flag", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await publish(owner.token, owner.user_id, bench.id);
    // A VIEWER can't close.
    const { memberToken } = await addMember(
      owner.token,
      owner.account_id,
      `viewer-${Date.now()}@example.com`,
      "VIEWER",
    );
    expect((await action("benchmarks", bench.id, "close", memberToken)).status).toBe(403);
    await action("benchmarks", bench.id, "close", owner.token);
    const pub = (await (await apiGet(`/api/v1/benchmarks/${bench.id}`)).json()) as {
      data: Resource;
    };
    expect(pub.data.attributes.closed).toBe(true);
  });
});

describe("closed lifecycle — ended runs", () => {
  it("an ended run on a private benchmark refuses new measurements; double end 409s", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    expect((await action("runs", run.id, "end", owner.token)).status).toBe(200);
    await expectConflict(
      apiPost(
        "/api/v1/measurements",
        { data: { type: "measurement", attributes: { run: run.id, subject: subject.id } } },
        bearer(owner.token),
      ),
      "This run has ended; no new measurements can be added.",
    );
    await expectConflict(
      action("runs", run.id, "end", owner.token),
      "This run has already ended.",
    );
  });

  it("publishing freezes the end action along with the rest of the runs", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    await makeMeasurement(owner.token, run.id, subject.id);
    await publish(owner.token, owner.user_id, bench.id);
    await expectConflict(action("runs", run.id, "end", owner.token), RUNS_FROZEN);
  });
});

describe("post-publish schema freeze", () => {
  const put = (token: string, bench: Resource, schema: unknown) =>
    apiPut(
      `/api/v1/benchmarks/${bench.id}`,
      {
        data: {
          type: "benchmark",
          attributes: { name: "Scheduler Latency", subject_type: bench.attributes.subject_type, measurement_schema: schema },
        },
      },
      bearer(token),
    );

  it("rejects adding a chart where none existed after publish", async () => {
    const owner = await register();
    const chartless = { metrics: [{ name: "cpu_ms", type: "DECIMAL" }], derived: [], chart: null };
    const bench = await makeBenchmark(owner.token, { key: "chartless", measurement_schema: chartless });
    await publish(owner.token, owner.user_id, bench.id);
    const res = await put(owner.token, bench, { ...chartless, chart: { x: null, y: "cpu_ms", x_kind: "CATEGORY" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: { detail: string }[] }).errors[0].detail).toBe(
      "This benchmark is published; its chart mapping is frozen and cannot be added.",
    );
  });

  it("rejects appends after publish; unchanged round-trips and label edits still pass", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await publish(owner.token, owner.user_id, bench.id);

    // Appending a brand-new stored metric alongside the frozen derived skew_ms → 409. The
    // additive-freeze era is over: publish freezes the metric set outright.
    const grown = {
      ...SKEW_SCHEMA,
      metrics: [{ name: "cpu_ms", type: "number", description: "CPU time per firing." }],
    };
    await expectConflict(put(owner.token, bench, grown), METRICS_FROZEN);

    // Appending a new derived value is refused the same way.
    const grownDerived = {
      ...SKEW_SCHEMA,
      derived: [
        ...SKEW_SCHEMA.derived,
        { name: "skew_s", unit: "s", expr: { "/": [{ var: "skew_ms" }, 1000] } },
      ],
    };
    await expectConflict(put(owner.token, bench, grownDerived), METRICS_FROZEN);

    // Round-tripping the schema unchanged is a cosmetic PUT and still passes.
    expect((await put(owner.token, bench, SKEW_SCHEMA)).status).toBe(200);

    // Descriptions and unit labels inside existing entries remain editable.
    const relabeled = {
      ...SKEW_SCHEMA,
      derived: [
        { ...SKEW_SCHEMA.derived[0], unit: "milliseconds", description: "Wall-clock skew per firing." },
      ],
    };
    expect((await put(owner.token, bench, relabeled)).status).toBe(200);

    // Mutating the existing derived expr → 409.
    const mutated = {
      ...SKEW_SCHEMA,
      derived: [{ name: "skew_ms", unit: "ms", expr: { var: "created_at" } }],
    };
    await expectConflict(put(owner.token, bench, mutated), INTERPRETATION_FROZEN);

    // Removing the frozen derived (and its chart) → 409.
    await expectConflict(put(owner.token, bench, { metrics: [], derived: [] }), INTERPRETATION_FROZEN);

    // Changing the chart → 409.
    const rechart = { ...SKEW_SCHEMA, chart: { x: null, y: "skew_ms", x_kind: "CATEGORY" } };
    await expectConflict(put(owner.token, bench, rechart), INTERPRETATION_FROZEN);
  });
});
