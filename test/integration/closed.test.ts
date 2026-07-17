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

  it("publishing keeps subjects/runs/measurements open; close still blocks them and reopen restores", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    await publish(owner.token, owner.user_id, bench.id);

    // Publishing doesn't freeze ingest — additions land as part of the (audited) public record.
    const t2 = await makeAccountSubject(owner.token, "t2");
    expect(
      (
        await apiPost(
          "/api/v1/benchmark_subjects",
          { data: { type: "benchmark_subject", attributes: { benchmark: bench.id, subject: t2.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await apiPost(
          "/api/v1/runs",
          { data: { type: "run", attributes: { benchmark: bench.id, key: "r2" } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    const postMeasurement = () =>
      apiPost(
        "/api/v1/measurements",
        { data: { type: "measurement", attributes: { run: run.id, subject: subject.id } } },
        bearer(owner.token),
      );
    expect((await postMeasurement()).status).toBe(201);

    // The closed gate is the one signal that refuses new data, published or not.
    expect((await action("benchmarks", bench.id, "close", owner.token)).status).toBe(200);
    const t3 = await makeAccountSubject(owner.token, "t3");
    await expectConflict(
      apiPost(
        "/api/v1/benchmark_subjects",
        { data: { type: "benchmark_subject", attributes: { benchmark: bench.id, subject: t3.id } } },
        bearer(owner.token),
      ),
      "This benchmark is closed; no new subjects can be added.",
    );
    await expectConflict(
      apiPost(
        "/api/v1/runs",
        { data: { type: "run", attributes: { benchmark: bench.id, key: "r3" } } },
        bearer(owner.token),
      ),
      "This benchmark is closed; no new runs can be added.",
    );
    await expectConflict(
      postMeasurement(),
      "This benchmark is closed; no new measurements can be added.",
    );

    // Reopen restores appendability even on a published benchmark.
    expect((await action("benchmarks", bench.id, "reopen", owner.token)).status).toBe(200);
    expect((await postMeasurement()).status).toBe(201);
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
  it("an ended run still accepts new measurements (a late append is audited, not blocked); double end 409s", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    expect((await action("runs", run.id, "end", owner.token)).status).toBe(200);
    // Ending a run is a lifecycle signal, not an ingest gate: appending afterwards succeeds and
    // simply shows up in the run's history as a late addition.
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, subject: subject.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    await expectConflict(
      action("runs", run.id, "end", owner.token),
      "This run has already ended.",
    );
  });

  it("publishing keeps the end action open; the run ends as part of the public record", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const subject = await makeSubject(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    await makeMeasurement(owner.token, run.id, subject.id);
    await publish(owner.token, owner.user_id, bench.id);
    const ended = await action("runs", run.id, "end", owner.token);
    expect(ended.status).toBe(200);
    expect(((await ended.json()) as { data: Resource }).data.attributes.live).toBe(false);
  });
});

describe("post-publish schema edits", () => {
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

  it("adds a chart where none existed after publish", async () => {
    const owner = await register();
    const chartless = { metrics: [{ name: "cpu_ms", type: "DECIMAL" }], derived: [], chart: null };
    const bench = await makeBenchmark(owner.token, { key: "chartless", measurement_schema: chartless });
    await publish(owner.token, owner.user_id, bench.id);
    const res = await put(owner.token, bench, { ...chartless, chart: { x: null, y: "cpu_ms", x_kind: "CATEGORY" } });
    expect(res.status).toBe(200);
    const schema = ((await res.json()) as { data: Resource }).data.attributes
      .measurement_schema as { chart?: unknown };
    expect(schema.chart).toEqual({ x: null, y: "cpu_ms", x_kind: "CATEGORY" });
  });

  it("accepts appends, expression changes, chart changes, and removals after publish", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await publish(owner.token, owner.user_id, bench.id);

    // Appending a brand-new stored metric alongside the derived skew_ms lands — publishing no
    // longer freezes the metric set; the semantic-core change is audited instead.
    const grown = {
      ...SKEW_SCHEMA,
      metrics: [{ name: "cpu_ms", type: "number", description: "CPU time per firing." }],
    };
    expect((await put(owner.token, bench, grown)).status).toBe(200);

    // Appending a new derived value is accepted the same way.
    const grownDerived = {
      ...SKEW_SCHEMA,
      derived: [
        ...SKEW_SCHEMA.derived,
        { name: "skew_s", unit: "s", expr: { "/": [{ var: "skew_ms" }, 1000] } },
      ],
    };
    expect((await put(owner.token, bench, grownDerived)).status).toBe(200);

    // Round-tripping the original schema back is a full-replace like any other → 200.
    expect((await put(owner.token, bench, SKEW_SCHEMA)).status).toBe(200);

    // Descriptions and unit labels inside existing entries remain editable.
    const relabeled = {
      ...SKEW_SCHEMA,
      derived: [
        { ...SKEW_SCHEMA.derived[0], unit: "milliseconds", description: "Wall-clock skew per firing." },
      ],
    };
    expect((await put(owner.token, bench, relabeled)).status).toBe(200);

    // Mutating the existing derived expr → 200 (a semantic-core change, flagged in the History).
    const mutated = {
      ...SKEW_SCHEMA,
      derived: [{ name: "skew_ms", unit: "ms", expr: { var: "created_at" } }],
    };
    expect((await put(owner.token, bench, mutated)).status).toBe(200);

    // Changing the chart → 200.
    const rechart = { ...SKEW_SCHEMA, chart: { x: null, y: "skew_ms", x_kind: "CATEGORY" } };
    expect((await put(owner.token, bench, rechart)).status).toBe(200);

    // Removing the derived (and its chart) → 200; the schema really is empty afterwards.
    expect((await put(owner.token, bench, { metrics: [], derived: [] })).status).toBe(200);
    const readBack = (await (await apiGet(`/api/v1/benchmarks/${bench.id}`, bearer(owner.token))).json()) as {
      data: Resource;
    };
    expect(readBack.data.attributes.measurement_schema).toEqual({ metrics: [], derived: [] });
  });
});
