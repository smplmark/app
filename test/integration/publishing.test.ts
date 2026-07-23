// Publisher identity, domain verification, and the draft/publish workflow (the §2–§5 delta).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepVerifiedDomains } from "../../src/publish/sweep";
import {
  addMember,
  allowPersonalPublish,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  authPost,
  bearer,
  makeAccountSubject,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  makeSubject,
  markReady,
  markVerified,
  mintKey,
  publish,
  register,
  resetDb,
  seedPublishable,
  SKEW_SCHEMA,
  type Registered,
  type Resource,
} from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

/** Stub the DoH resolver so a domain "publishes" the given TXT records. */
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

const publishBody = (publisher?: string) => ({
  data: { type: "benchmark", attributes: publisher ? { publisher } : {} },
});

async function createPublisher(token: string, domain = "acme.com"): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/publishers",
    { data: { type: "publisher", attributes: { domain } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Create + verify a publisher (domain); returns the verified publisher. */
async function verifiedPublisher(token: string, domain = "acme.com"): Promise<Resource> {
  const pub = await createPublisher(token, domain);
  stubTxt([pub.attributes.verification_token as string]);
  const res = await apiPost(`/api/v1/publishers/${pub.id}/actions/verify`, undefined, bearer(token));
  expect(res.status).toBe(200);
  const verified = ((await res.json()) as { data: Resource }).data;
  expect(verified.attributes.status).toBe("VERIFIED");
  expect(verified.attributes.verified).toBe(true);
  vi.unstubAllGlobals();
  return verified;
}

// ── §2 draft edit-lock ────────────────────────────────────────────────────────

describe("draft edit-lock", () => {
  async function readyChainWithData(): Promise<{ me: Registered; benchmark: Resource; subject: Resource; run: Resource }> {
    const me = await register();
    const benchmark = await makeBenchmark(me.token);
    const subject = await makeSubject(me.token, benchmark.id, "t");
    const run = await makeRun(me.token, benchmark.id);
    // ingest one measurement while still cooking (draft=1) — allowed
    const ing = await apiPost(
      "/api/v1/measurements",
      { data: { type: "measurement", attributes: { run: run.id, subject: subject.id, metrics: { skew_ms: 1 } } } },
      bearer(me.token),
    );
    expect(ing.status).toBe(201);
    await markReady(me.token, benchmark.id);
    return { me, benchmark, subject, run };
  }

  it("freezes the whole subtree while marked ready (PRIVATE && draft=0)", async () => {
    const { me, benchmark, subject, run } = await readyChainWithData();
    const tok = bearer(me.token);

    // benchmark edits
    expect(
      (await apiPut(`/api/v1/benchmarks/${benchmark.id}`, { data: { type: "benchmark", attributes: { name: "x", measurement_schema: SKEW_SCHEMA } } }, tok)).status,
    ).toBe(409);
    // membership: linking a new subject into the frozen benchmark is blocked (the account-level subject
    // create itself is fine — a shared subject is not part of the frozen subtree).
    const t2 = await makeAccountSubject(me.token, "t2");
    expect(
      (await apiPost("/api/v1/benchmark_subjects", { data: { type: "benchmark_subject", attributes: { benchmark: benchmark.id, subject: t2.id } } }, tok)).status,
    ).toBe(409);
    // a subject linked to the frozen benchmark can't be edited either (the freeze reaches shared subjects)
    expect(
      (await apiPut(`/api/v1/subjects/${subject.id}`, { data: { type: "subject", attributes: { name: "x" } } }, tok)).status,
    ).toBe(409);
    // create/edit run
    expect(
      (await apiPost("/api/v1/runs", { data: { type: "run", attributes: { benchmark: benchmark.id, key: "r2" } } }, tok)).status,
    ).toBe(409);
    expect(
      (await apiPut(`/api/v1/runs/${run.id}`, { data: { type: "run", attributes: {} } }, tok)).status,
    ).toBe(409);
    // run actions
    expect((await apiPost(`/api/v1/runs/${run.id}/actions/end`, undefined, tok)).status).toBe(409);
    expect((await apiPost(`/api/v1/runs/${run.id}/actions/invalidate`, undefined, tok)).status).toBe(409);
    // ingest
    expect(
      (await apiPost("/api/v1/measurements", { data: { type: "measurement", attributes: { run: run.id, subject: subject.id, metrics: { skew_ms: 2 } } } }, tok)).status,
    ).toBe(409);
    // delete benchmark / subject / run are all blocked (deleting the subject would cascade into the
    // frozen subtree's measurements).
    expect((await apiDelete(`/api/v1/benchmarks/${benchmark.id}`, tok)).status).toBe(409);
    expect((await apiDelete(`/api/v1/subjects/${subject.id}`, tok)).status).toBe(409);
    expect((await apiDelete(`/api/v1/runs/${run.id}`, tok)).status).toBe(409);
  });

  it("unlocks again after return_to_draft (and echoes the reason)", async () => {
    const { me, benchmark, subject } = await readyChainWithData();
    const back = await apiPost(
      `/api/v1/benchmarks/${benchmark.id}/actions/return_to_draft`,
      { data: { type: "benchmark", attributes: { reason: "needs another pass" } } },
      bearer(me.token),
    );
    expect(back.status).toBe(200);
    const body = (await back.json()) as { data: Resource; meta?: { reason?: string } };
    expect(body.data.attributes.draft).toBe(true);
    expect(body.meta?.reason).toBe("needs another pass");

    // edits work again
    expect(
      (await apiPut(`/api/v1/subjects/${subject.id}`, { data: { type: "subject", attributes: { name: "renamed" } } }, bearer(me.token))).status,
    ).toBe(200);
  });
});

// ── §2 mark_ready / return_to_draft authority ─────────────────────────────────

describe("mark_ready / return_to_draft authority", () => {
  it("allows the author (a member) and any admin; blocks a non-author viewer", async () => {
    const owner = await register("owner@example.com");
    const { memberToken: authorToken, user: author } = await addMember(owner.token, owner.account_id, "author@example.com", "MEMBER");
    const { memberToken: viewerToken } = await addMember(owner.token, owner.account_id, "viewer@example.com", "VIEWER");

    // author (member) creates + marks ready
    const bench = await makeBenchmark(authorToken, { key: "authored" });
    expect(bench.attributes.created_by).toBe(author.user_id);
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/mark_ready`, undefined, bearer(authorToken))).status).toBe(200);

    // a non-author viewer can't recall it
    expect(
      (await apiPost(`/api/v1/benchmarks/${bench.id}/actions/return_to_draft`, undefined, bearer(viewerToken))).status,
    ).toBe(403);

    // an admin (the owner) can (admin reject)
    expect(
      (await apiPost(`/api/v1/benchmarks/${bench.id}/actions/return_to_draft`, undefined, bearer(owner.token))).status,
    ).toBe(200);
  });

  it("can't mark ready a published benchmark (409)", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/mark_ready`, undefined, bearer(me.token))).status).toBe(409);
  });
});

// ── §4 publish preconditions + modes ──────────────────────────────────────────

describe("publish preconditions", () => {
  it("is session-only — an API key cannot publish (403)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id); // fully ready, so the 403 is about the key, not readiness
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const { key } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(key));
    expect(res.status).toBe(403);
  });
});

describe("publish readiness gate", () => {
  const READY_PREFIX = "This benchmark isn't ready to publish — it needs at least ";

  async function tryPublish(token: string, benchmarkId: string): Promise<{ status: number; detail?: string }> {
    const res = await apiPost(`/api/v1/benchmarks/${benchmarkId}/actions/publish`, publishBody(), bearer(token));
    if (res.status === 409) {
      const body = (await res.json()) as { errors: { detail?: string }[] };
      return { status: res.status, detail: body.errors[0]?.detail };
    }
    return { status: res.status };
  }

  it("409s an empty benchmark, naming all four missing pieces", async () => {
    const me = await register();
    await markVerified(me.user_id);
    // an empty schema too, so even the metric leg of the gate is unmet
    const b = await makeBenchmark(me.token, { measurement_schema: { metrics: [], derived: [] } });
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const { status, detail } = await tryPublish(me.token, b.id);
    expect(status).toBe(409);
    expect(detail).toBe(`${READY_PREFIX}one subject, one metric, one run and one measurement.`);
  });

  it("names exactly the missing pieces when some are present", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token); // SKEW_SCHEMA → the metric leg is satisfied
    await makeSubject(me.token, b.id, "s1"); // …and so is the subject leg
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const { status, detail } = await tryPublish(me.token, b.id);
    expect(status).toBe(409);
    expect(detail).toBe(`${READY_PREFIX}one run and one measurement.`);
  });

  it("publishes once a subject, metric, run, and measurement all exist (200)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token); // SKEW_SCHEMA supplies the metric
    const s = await makeSubject(me.token, b.id, "s1");
    const run = await makeRun(me.token, b.id);
    await makeMeasurement(me.token, run.id, s.id, { metrics: { skew_ms: 1 } });
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Resource }).data.attributes.status).toBe("PUBLISHED");
  });
});

describe("personal publish", () => {
  it("is gated by the account opt-in", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id); // clear the readiness gate before the marked-ready lock
    await markReady(me.token, b.id);

    // opt-in off → 403
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token))).status).toBe(403);

    // opt-in on → 200, PERSONAL attribution with a stable gravatar hash
    await allowPersonalPublish(b.id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token));
    expect(ok.status).toBe(200);
    const pub = ((await ok.json()) as { data: Resource }).data;
    const badge = pub.attributes.published_as as { kind: string; gravatar_hash: string; display_name: string | null; since: string };
    expect(badge.kind).toBe("PERSONAL");
    expect(badge.display_name).toBe("Test User");
    expect(badge.gravatar_hash).toMatch(/^[0-9a-f]{64}$/);
    // The publisher account's creation date is frozen in for a "publishing since" byline.
    expect(badge.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pub.attributes.published_by).toBe(me.user_id);
  });

  it('accepts the "self" sentinel as an explicit personal publish', async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id);
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody("self"), bearer(me.token));
    expect(ok.status).toBe(200);
    expect((((await ok.json()) as { data: Resource }).data.attributes.published_as as { kind: string }).kind).toBe("PERSONAL");
  });

  it("keeps ingest open after publishing; new measurements join the public record", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    const t = await makeSubject(me.token, b.id, "t");
    const run = await makeRun(me.token, b.id); // live (no ended_at)
    await makeMeasurement(me.token, run.id, t.id, { metrics: { skew_ms: 1 } }); // clears the readiness gate
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token))).status).toBe(200);
    // published → ingest continues; the addition is audited rather than blocked
    const ing = await apiPost(
      "/api/v1/measurements",
      { data: { type: "measurement", attributes: { run: run.id, subject: t.id, metrics: { skew_ms: 5 } } } },
      bearer(me.token),
    );
    expect(ing.status).toBe(201);
    const created = ((await ing.json()) as { data: Resource }).data;
    expect(created.attributes.run).toBe(run.id);
    // Both measurements now stand in the published dataset.
    const list = await apiGet(`/api/v1/measurements?filter[benchmark]=${b.id}`);
    expect(((await list.json()) as { data: Resource[] }).data.length).toBe(2);
  });

  it("lets an author who has since become a viewer no longer mark ready", async () => {
    const owner = await register("demote-owner@example.com");
    const { memberToken: authorAsMember, user: author } = await addMember(owner.token, owner.account_id, "demoted@example.com", "MEMBER");
    const bench = await makeBenchmark(authorAsMember, { key: "demoted-bench" });
    // owner demotes the author to VIEWER
    expect(
      (await apiPut(`/api/v1/account_users/${author.user_id}`, { data: { type: "account_user", attributes: { role: "VIEWER" } } }, bearer(owner.token))).status,
    ).toBe(200);
    // the author re-switches to pick up the new (viewer) role in a fresh token
    const sw = await authPost("/api/v1/auth/switch", { account_id: owner.account_id }, bearer(author.token));
    const viewerToken = ((await sw.json()) as { token: string }).token;
    // still the author (created_by matches) but no longer a writer → can't mark ready
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/mark_ready`, undefined, bearer(viewerToken))).status).toBe(403);
  });

  it("only the author can personally publish, even with the opt-in on", async () => {
    const owner = await register("owner2@example.com");
    await markVerified(owner.user_id);
    const { memberToken: author } = await addMember(owner.token, owner.account_id, "author2@example.com", "MEMBER");
    const bench = await makeBenchmark(author, { key: "theirs" });
    await seedPublishable(author, bench.id);
    await markReady(author, bench.id);
    await allowPersonalPublish(bench.id);
    // the owner is an admin but NOT the author → personal publish 403
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(owner.token))).status).toBe(403);
    // the author can
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(author))).status).toBe(200);
  });
});

describe("organization publish", () => {
  it("requires an admin, a verified publisher, and freezes the snapshot", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const publisher = await verifiedPublisher(me.token);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id);
    await markReady(me.token, b.id);

    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(publisher.id), bearer(me.token));
    expect(ok.status).toBe(200);
    const pub = ((await ok.json()) as { data: Resource }).data;
    const badge = pub.attributes.published_as as { kind: string; domain: string; icon: string; since: string };
    expect(badge.kind).toBe("ORGANIZATION");
    expect(badge.domain).toBe(publisher.attributes.domain);
    expect(badge.icon).toBe("monogram");
    // The publisher account's creation date is frozen in so the public byline can show "publishing
    // since <date>" without a live account lookup.
    expect(badge.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("addresses an organization publish by its verified domain, resolvable via filter[publisher]", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const publisher = await verifiedPublisher(me.token);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id);
    await markReady(me.token, b.id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(publisher.id), bearer(me.token));
    expect(ok.status).toBe(200);
    const pub = ((await ok.json()) as { data: Resource }).data;
    const domain = publisher.attributes.domain as string;

    // The public path is /{verified-domain}/{key} — the org's domain, not the owning account's slug.
    expect(pub.attributes.publisher_slug).toBe(domain);

    // …and it resolves anonymously by that domain slug (the list + single-read paths share the same
    // resolver, so this exercises the public addressing end to end).
    const byDomain = (await (
      await apiGet(`/api/v1/benchmarks?filter[publisher]=${encodeURIComponent(domain)}`)
    ).json()) as { data: Resource[] };
    expect(byDomain.data.map((r) => r.id)).toContain(pub.id);
    for (const r of byDomain.data) expect(r.attributes.publisher_slug).toBe(domain);
  });

  it("blocks org publish when the publisher's domain is not verified (409)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const publisher = await createPublisher(me.token, "unverified.com"); // PENDING, never verified
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id); // isolate the domain gate from the readiness gate
    await markReady(me.token, b.id);
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(publisher.id), bearer(me.token));
    expect(res.status).toBe(409);
    const errors = ((await res.json()) as { errors: { detail?: string }[] }).errors;
    expect(errors[0].detail).toBe("This publisher's domain is not verified.");
  });

  it("404s org publish against an unknown / cross-tenant publisher", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id);
    await markReady(me.token, b.id);
    // unknown publisher id
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody("ghost"), bearer(me.token))).status).toBe(404);
    // another account's publisher
    const other = await register("other-org@example.com");
    const foreign = await createPublisher(other.token);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(foreign.id), bearer(me.token))).status).toBe(404);
  });

  it("a non-admin member cannot org-publish (403)", async () => {
    const owner = await register("orgowner@example.com");
    await markVerified(owner.user_id);
    const publisher = await verifiedPublisher(owner.token);
    const { memberToken: member } = await addMember(owner.token, owner.account_id, "m@example.com", "MEMBER");
    const bench = await makeBenchmark(member, { key: "memberbench" });
    await seedPublishable(member, bench.id);
    await markReady(member, bench.id);
    const res = await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(publisher.id), bearer(member));
    expect(res.status).toBe(403);
  });
});

// ── §4 withdraw authority ─────────────────────────────────────────────────────

describe("withdraw authority mirrors publish", () => {
  const withdrawBody = { data: { type: "benchmark", attributes: { withdrawal_reason: "clock skew" } } };

  it("an org-published benchmark requires an admin to withdraw", async () => {
    const owner = await register("wowner@example.com");
    await markVerified(owner.user_id);
    const publisher = await verifiedPublisher(owner.token);
    const { memberToken: member } = await addMember(owner.token, owner.account_id, "wm@example.com", "MEMBER");
    const bench = await makeBenchmark(member, { key: "orgbench" });
    await seedPublishable(member, bench.id);
    await markReady(member, bench.id);
    // owner (admin) publishes it under the org
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(publisher.id), bearer(owner.token))).status).toBe(200);
    // the member (author, not admin) cannot withdraw an org-attributed benchmark
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(member))).status).toBe(403);
    // the admin can
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(owner.token))).status).toBe(200);
  });

  it("a personally-published benchmark can be withdrawn by the author or an admin, but not an API key", async () => {
    const owner = await register("powner@example.com");
    await markVerified(owner.user_id);
    const { memberToken: author, user: authorUser } = await addMember(owner.token, owner.account_id, "pa@example.com", "MEMBER");
    const bench = await makeBenchmark(author, { key: "personalbench" });
    await seedPublishable(author, bench.id);
    await markReady(author, bench.id);
    await allowPersonalPublish(bench.id);
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(author))).status).toBe(200);
    void authorUser;

    // an account API key can't withdraw (session-only)
    const { key } = await mintKey(owner.token, { scope_type: "ACCOUNT" });
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(key))).status).toBe(403);
    // a different member who is neither the author nor an admin can't withdraw
    const { memberToken: other } = await addMember(owner.token, owner.account_id, "other-member@example.com", "MEMBER");
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(other))).status).toBe(403);
    // the author withdraws
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(author))).status).toBe(200);
  });

  it("an admin (not the author) may withdraw a personally-published benchmark", async () => {
    const owner = await register("padmin@example.com");
    await markVerified(owner.user_id);
    const { memberToken: author } = await addMember(owner.token, owner.account_id, "pauthor@example.com", "MEMBER");
    const bench = await makeBenchmark(author, { key: "adminwithdraw" });
    await seedPublishable(author, bench.id);
    await markReady(author, bench.id);
    await allowPersonalPublish(bench.id);
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(author))).status).toBe(200);
    // the owner (admin, not the author) can withdraw it
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(owner.token))).status).toBe(200);
  });
});

// ── §3/§4 the never-retroactively-strip guarantee ─────────────────────────────

describe("the public record is frozen", () => {
  it("a domain lapse never rewrites a published badge, but blocks new publishes under the publisher", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const publisher = await verifiedPublisher(me.token);

    const b1 = await makeBenchmark(me.token, { key: "first" });
    await seedPublishable(me.token, b1.id);
    await markReady(me.token, b1.id);
    expect((await apiPost(`/api/v1/benchmarks/${b1.id}/actions/publish`, publishBody(publisher.id), bearer(me.token))).status).toBe(200);

    // The cron sweep sees the TXT record gone and lapses the publisher.
    stubTxt([]); // no records
    const swept = await sweepVerifiedDomains(env.DB);
    expect(swept.lapsed).toBe(1);
    vi.unstubAllGlobals();

    // The publisher is now LAPSED…
    const domRow = await env.DB.prepare("SELECT status FROM publisher WHERE id = ?").bind(publisher.id).first<{ status: string }>();
    expect(domRow?.status).toBe("LAPSED");

    // …but the published benchmark's frozen badge is unchanged.
    const read = await apiGet(`/api/v1/benchmarks/${b1.id}`);
    const badge = ((await read.json()) as { data: Resource }).data.attributes.published_as as { domain: string };
    expect(badge.domain).toBe(publisher.attributes.domain);

    // And a NEW publish under the same publisher is now blocked.
    const b2 = await makeBenchmark(me.token, { key: "second" });
    await seedPublishable(me.token, b2.id);
    await markReady(me.token, b2.id);
    expect((await apiPost(`/api/v1/benchmarks/${b2.id}/actions/publish`, publishBody(publisher.id), bearer(me.token))).status).toBe(409);
  });

  it("a publisher can be deleted while a published benchmark references it; the frozen badge survives", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const publisher = await verifiedPublisher(me.token);
    const b = await makeBenchmark(me.token);
    await seedPublishable(me.token, b.id);
    await markReady(me.token, b.id);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(publisher.id), bearer(me.token))).status).toBe(200);

    // deleting the publisher is allowed even though a published benchmark points at it
    expect((await apiDelete(`/api/v1/publishers/${publisher.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/publishers/${publisher.id}`, bearer(me.token))).status).toBe(404);

    // the published benchmark is unchanged: still public, badge intact (frozen domain preserved)
    const read = await apiGet(`/api/v1/benchmarks/${b.id}`);
    const attrs = ((await read.json()) as { data: Resource }).data.attributes;
    expect(attrs.status).toBe("PUBLISHED");
    const badge = attrs.published_as as { kind: string; domain: string; icon: string };
    expect(badge.kind).toBe("ORGANIZATION");
    expect(badge.domain).toBe(publisher.attributes.domain);
    expect(badge.icon).toBe("monogram");
  });

  it("a lapsed publisher can be re-verified", async () => {
    const me = await register();
    const publisher = await verifiedPublisher(me.token);
    // lapse via sweep
    stubTxt([]);
    await sweepVerifiedDomains(env.DB);
    vi.unstubAllGlobals();
    // re-verify via the verify action
    stubTxt([publisher.attributes.verification_token as string]);
    const res = await apiPost(`/api/v1/publishers/${publisher.id}/actions/verify`, undefined, bearer(me.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");
  });
});

// ── cron sweep internals ──────────────────────────────────────────────────────

describe("cron sweep", () => {
  it("re-affirms a still-present record (stays VERIFIED, lapses nothing)", async () => {
    const me = await register();
    const publisher = await verifiedPublisher(me.token);
    stubTxt([publisher.attributes.verification_token as string]);
    const result = await sweepVerifiedDomains(env.DB);
    expect(result).toEqual({ checked: 1, lapsed: 0, truncated: false });
    const row = await env.DB.prepare("SELECT status FROM publisher WHERE id = ?").bind(publisher.id).first<{ status: string }>();
    expect(row?.status).toBe("VERIFIED");
  });

  it("never lapses on a resolver failure (ambiguity ≠ gone)", async () => {
    const me = await register();
    const publisher = await verifiedPublisher(me.token);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("resolver down");
      }),
    );
    const result = await sweepVerifiedDomains(env.DB);
    expect(result.lapsed).toBe(0);
    expect(result.checked).toBe(0); // the check itself failed, so nothing was counted as checked
    const row = await env.DB.prepare("SELECT status FROM publisher WHERE id = ?").bind(publisher.id).first<{ status: string }>();
    expect(row?.status).toBe("VERIFIED");
  });

  it("is a no-op when there are no verified publishers", async () => {
    expect(await sweepVerifiedDomains(env.DB)).toEqual({ checked: 0, lapsed: 0, truncated: false });
  });

  it("paginates across pages and honors the max-pages safety bound", async () => {
    const me = await register();
    for (const d of ["a.com", "b.com", "c.com"]) {
      await verifiedPublisher(me.token, d); // each is created + verified
    }
    // Keep every publisher's TXT record present across both sweeps (afterEach unstubs).
    const listed = (await (await apiGet("/api/v1/publishers", bearer(me.token))).json()) as { data: Resource[] };
    stubTxt(listed.data.map((p) => p.attributes.verification_token as string));

    // multi-page (pageSize 1 → three pages of one, then an empty page)
    const full = await sweepVerifiedDomains(env.DB, { pageSize: 1 });
    expect(full).toEqual({ checked: 3, lapsed: 0, truncated: false });

    // the bound stops early and reports truncation
    const bounded = await sweepVerifiedDomains(env.DB, { pageSize: 1, maxPages: 2 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.checked).toBe(2);
  });
});

// ── §3 DNS verify outcomes ────────────────────────────────────────────────────

describe("domain verify", () => {
  it("stays PENDING on a miss and lapses a previously-verified publisher", async () => {
    const me = await register();
    const pub = await createPublisher(me.token, "acme.com");

    // miss → still PENDING
    stubTxt(["some-other-record"]);
    const miss = await apiPost(`/api/v1/publishers/${pub.id}/actions/verify`, undefined, bearer(me.token));
    expect(((await miss.json()) as { data: Resource }).data.attributes.status).toBe("PENDING");

    // hit → VERIFIED
    stubTxt([pub.attributes.verification_token as string]);
    const hit = await apiPost(`/api/v1/publishers/${pub.id}/actions/verify`, undefined, bearer(me.token));
    expect(((await hit.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");

    // record gone → LAPSED
    stubTxt([]);
    const lapse = await apiPost(`/api/v1/publishers/${pub.id}/actions/verify`, undefined, bearer(me.token));
    expect(((await lapse.json()) as { data: Resource }).data.attributes.status).toBe("LAPSED");
  });

  it("leaves status untouched when the DNS check itself fails", async () => {
    const me = await register();
    const publisher = await verifiedPublisher(me.token);
    // resolver error
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await apiPost(`/api/v1/publishers/${publisher.id}/actions/verify`, undefined, bearer(me.token));
    expect(res.status).toBe(200);
    // still VERIFIED — a transient failure must never lapse a publisher
    expect(((await res.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");
  });
});
