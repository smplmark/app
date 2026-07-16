// System-job triggers (Smpl Jobs) — the shared-secret domain re-check endpoint.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiGet,
  apiPost,
  bearer,
  makeBenchmark,
  markVerified,
  register,
  resetDb,
  type Resource,
  seedPublishable,
} from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  env.JOBS_TRIGGER_SECRET = undefined;
  vi.unstubAllGlobals();
});

const SECRET = "test-jobs-secret";
const RECHECK = "/api/v1/jobs/domain-recheck";

function stubTxt(records: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ Answer: records.map((r) => ({ type: 16, data: `"${r}"` })) }), {
          status: 200,
          headers: { "Content-Type": "application/dns-json" },
        }),
    ),
  );
}

/** Create + verify a publisher (domain) for admin `token`; returns the verified publisher. */
async function verifiedPublisher(token: string): Promise<Resource> {
  const pub = ((await (
    await apiPost(
      "/api/v1/publishers",
      { data: { type: "publisher", attributes: { domain: "acme.com" } } },
      bearer(token),
    )
  ).json()) as { data: Resource }).data;
  stubTxt([pub.attributes.verification_token as string]);
  const res = await apiPost(`/api/v1/publishers/${pub.id}/actions/verify`, undefined, bearer(token));
  expect(((await res.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");
  vi.unstubAllGlobals();
  return pub;
}

describe("domain-recheck job auth", () => {
  it("503s when the trigger secret is not configured", async () => {
    const res = await apiPost(RECHECK, undefined, bearer(SECRET));
    expect(res.status).toBe(503);
  });

  it("401s a missing or wrong secret when configured", async () => {
    env.JOBS_TRIGGER_SECRET = SECRET;
    expect((await apiPost(RECHECK, undefined)).status).toBe(401); // no bearer
    expect((await apiPost(RECHECK, undefined, bearer("wrong"))).status).toBe(401); // wrong bearer
  });

  it("does not accept a normal account credential", async () => {
    env.JOBS_TRIGGER_SECRET = SECRET;
    const me = await register();
    // a session token is not the shared secret → 401
    expect((await apiPost(RECHECK, undefined, bearer(me.token))).status).toBe(401);
  });
});

describe("domain-recheck job run", () => {
  it("runs the sweep and returns counts for a no-op case", async () => {
    env.JOBS_TRIGGER_SECRET = SECRET;
    const res = await apiPost(RECHECK, undefined, bearer(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 0, lapsed: 0, truncated: false });
  });

  it("lapses a domain whose record is gone without touching a published snapshot", async () => {
    env.JOBS_TRIGGER_SECRET = SECRET;
    const me = await register();
    await markVerified(me.user_id);
    const publisher = await verifiedPublisher(me.token);

    // publish a benchmark under that publisher so we can assert the snapshot is untouched
    // (seed a subject/run/measurement first — the readiness gate requires them, and a
    // marked-ready benchmark rejects further writes)
    const bench = await makeBenchmark(me.token, { key: "b", name: "B" });
    await seedPublishable(me.token, bench.id);
    await apiPost(`/api/v1/benchmarks/${bench.id}/actions/mark_ready`, undefined, bearer(me.token));
    const pub = await apiPost(
      `/api/v1/benchmarks/${bench.id}/actions/publish`,
      { data: { type: "benchmark", attributes: { publisher: publisher.id } } },
      bearer(me.token),
    );
    expect(pub.status).toBe(200);
    const badgeBefore = ((await pub.json()) as { data: Resource }).data.attributes.published_as;

    // the TXT record disappears; the job lapses the publisher
    stubTxt([]);
    const res = await apiPost(RECHECK, undefined, bearer(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 1, lapsed: 1, truncated: false });

    const domRow = await env.DB.prepare("SELECT status FROM publisher WHERE id = ?").bind(publisher.id).first<{ status: string }>();
    expect(domRow?.status).toBe("LAPSED");

    // the published benchmark's frozen badge is unchanged
    const read = await apiGet(`/api/v1/benchmarks/${bench.id}`);
    expect(((await read.json()) as { data: Resource }).data.attributes.published_as).toEqual(badgeBefore);
  });
});
