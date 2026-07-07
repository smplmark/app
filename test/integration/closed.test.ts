import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
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
  SKEW_SCHEMA,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

function action(kind: string, id: string, name: string, token: string) {
  return apiPost(`/api/v1/${kind}/${id}/actions/${name}`, undefined, bearer(token));
}

describe("closed lifecycle — benchmark", () => {
  it("close blocks new targets/runs/observations; reopen restores; doubles 409", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const target = await makeTarget(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    await publish(owner.token, owner.user_id, bench.id);

    const closed = await action("benchmarks", bench.id, "close", owner.token);
    expect(closed.status).toBe(200);
    const attrs = ((await closed.json()) as { data: Resource }).data.attributes;
    expect(attrs.closed).toBe(true);
    expect(typeof attrs.closed_at).toBe("string");

    // Everything beneath refuses new data.
    expect(
      (
        await apiPost(
          "/api/v1/targets",
          { data: { type: "target", attributes: { benchmark: bench.id, key: "t2", name: "T2" } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await apiPost(
          "/api/v1/runs",
          { data: { type: "run", attributes: { benchmark: bench.id, key: "r2" } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, target: target.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(409);
    // Double close → 409.
    expect((await action("benchmarks", bench.id, "close", owner.token)).status).toBe(409);

    // Reopen restores appendability.
    expect((await action("benchmarks", bench.id, "reopen", owner.token)).status).toBe(200);
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, target: target.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    expect((await action("benchmarks", bench.id, "reopen", owner.token)).status).toBe(409);
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

describe("closed lifecycle — target + ended runs", () => {
  it("a closed target blocks new measurements naming it only", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const t1 = await makeTarget(owner.token, bench.id, "t1");
    const t2 = await makeTarget(owner.token, bench.id, "t2");
    // A run spans the whole benchmark (both targets), not a single target.
    const run = await makeRun(owner.token, bench.id);
    await publish(owner.token, owner.user_id, bench.id);

    expect((await action("targets", t1.id, "close", owner.token)).status).toBe(200);
    // A measurement naming the closed target is refused.
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, target: t1.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(409);
    // A measurement naming the still-open sibling target succeeds.
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, target: t2.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    // Runs are benchmark children, so a closed target does not block creating a run.
    expect(
      (
        await apiPost(
          "/api/v1/runs",
          { data: { type: "run", attributes: { benchmark: bench.id, key: "r2" } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(201);
    expect((await action("targets", t1.id, "reopen", owner.token)).status).toBe(200);
    expect((await action("targets", t1.id, "reopen", owner.token)).status).toBe(409);
  });

  it("an ended run actually refuses new measurements", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const target = await makeTarget(owner.token, bench.id);
    const run = await makeRun(owner.token, bench.id);
    await publish(owner.token, owner.user_id, bench.id);
    expect((await action("runs", run.id, "end", owner.token)).status).toBe(200);
    expect(
      (
        await apiPost(
          "/api/v1/measurements",
          { data: { type: "measurement", attributes: { run: run.id, target: target.id } } },
          bearer(owner.token),
        )
      ).status,
    ).toBe(409);
  });
});

describe("additive schema freeze", () => {
  const put = (token: string, id: string, schema: unknown) =>
    apiPut(
      `/api/v1/benchmarks/${id}`,
      {
        data: {
          type: "benchmark",
          attributes: { name: "Scheduler Latency", observation_schema: schema },
        },
      },
      bearer(token),
    );

  it("allows appending new metrics/derived after publish; rejects mutation/removal", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await publish(owner.token, owner.user_id, bench.id);

    // Additive: a brand-new stored metric alongside the frozen derived skew_ms.
    const grown = {
      ...SKEW_SCHEMA,
      metrics: [{ name: "cpu_ms", type: "number", description: "CPU time per firing." }],
    };
    expect((await put(owner.token, bench.id, grown)).status).toBe(200);

    // Mutating the existing derived expr → 409.
    const mutated = {
      ...grown,
      derived: [{ name: "skew_ms", unit: "ms", expr: { var: "created_at" } }],
    };
    expect((await put(owner.token, bench.id, mutated)).status).toBe(409);

    // Removing a now-frozen metric → 409 (the additive PUT above froze cpu_ms too).
    expect((await put(owner.token, bench.id, SKEW_SCHEMA)).status).toBe(409);

    // Changing the chart → 409.
    const rechart = { ...grown, chart: { x: null, y: "cpu_ms", x_kind: "CATEGORY" } };
    expect((await put(owner.token, bench.id, rechart)).status).toBe(409);
  });
});
