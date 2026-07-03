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
  makeBenchmark,
  makeRun,
  makeTarget,
  markReady,
  markVerified,
  mintKey,
  publish,
  register,
  resetDb,
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

const publishBody = (identity?: string) => ({
  data: { type: "benchmark", attributes: identity ? { publisher_identity: identity } : {} },
});

async function createIdentity(token: string, key = "acme"): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/publisher_identities",
    { data: { type: "publisher_identity", attributes: { key, name: "Acme Corp" } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

async function addDomain(token: string, identityId: string, domain: string): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/publisher_domains",
    { data: { type: "publisher_domain", attributes: { publisher_identity: identityId, domain } } },
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Create + verify a domain under a fresh identity; returns the identity + verified domain. */
async function verifiedIdentity(
  token: string,
  domain = "acme.com",
): Promise<{ identity: Resource; domain: Resource }> {
  const identity = await createIdentity(token);
  const dom = await addDomain(token, identity.id, domain);
  stubTxt([dom.attributes.verification_token as string]);
  const res = await apiPost(`/api/v1/publisher_domains/${dom.id}/actions/verify`, undefined, bearer(token));
  expect(res.status).toBe(200);
  const verified = ((await res.json()) as { data: Resource }).data;
  expect(verified.attributes.status).toBe("VERIFIED");
  expect(verified.attributes.verified).toBe(true);
  vi.unstubAllGlobals();
  return { identity, domain: verified };
}

// ── §2 draft edit-lock ────────────────────────────────────────────────────────

describe("draft edit-lock", () => {
  async function readyChainWithData(): Promise<{ me: Registered; benchmark: Resource; target: Resource; run: Resource }> {
    const me = await register();
    const benchmark = await makeBenchmark(me.token);
    const target = await makeTarget(me.token, benchmark.id, "t");
    const run = await makeRun(me.token, target.id);
    // ingest one observation while still cooking (draft=1) — allowed
    const ing = await apiPost(
      "/api/v1/observations",
      { data: { type: "observation", attributes: { run: run.id, metrics: { skew_ms: 1 } } } },
      bearer(me.token),
    );
    expect(ing.status).toBe(201);
    await markReady(me.token, benchmark.id);
    return { me, benchmark, target, run };
  }

  it("freezes the whole subtree while marked ready (PRIVATE && draft=0)", async () => {
    const { me, benchmark, target, run } = await readyChainWithData();
    const tok = bearer(me.token);

    // benchmark edits
    expect(
      (await apiPut(`/api/v1/benchmarks/${benchmark.id}`, { data: { type: "benchmark", attributes: { name: "x", sample_schema: SKEW_SCHEMA } } }, tok)).status,
    ).toBe(409);
    // create/edit target
    expect(
      (await apiPost("/api/v1/targets", { data: { type: "target", attributes: { benchmark: benchmark.id, key: "t2", name: "t2" } } }, tok)).status,
    ).toBe(409);
    expect(
      (await apiPut(`/api/v1/targets/${target.id}`, { data: { type: "target", attributes: { name: "x" } } }, tok)).status,
    ).toBe(409);
    // create/edit run
    expect(
      (await apiPost("/api/v1/runs", { data: { type: "run", attributes: { target: target.id, key: "r2" } } }, tok)).status,
    ).toBe(409);
    expect(
      (await apiPut(`/api/v1/runs/${run.id}`, { data: { type: "run", attributes: {} } }, tok)).status,
    ).toBe(409);
    // run actions
    expect((await apiPost(`/api/v1/runs/${run.id}/actions/end`, undefined, tok)).status).toBe(409);
    expect((await apiPost(`/api/v1/runs/${run.id}/actions/invalidate`, undefined, tok)).status).toBe(409);
    // ingest
    expect(
      (await apiPost("/api/v1/observations", { data: { type: "observation", attributes: { run: run.id, metrics: { skew_ms: 2 } } } }, tok)).status,
    ).toBe(409);
    // delete benchmark / target / run are all blocked too
    expect((await apiDelete(`/api/v1/benchmarks/${benchmark.id}`, tok)).status).toBe(409);
    expect((await apiDelete(`/api/v1/targets/${target.id}`, tok)).status).toBe(409);
    expect((await apiDelete(`/api/v1/runs/${run.id}`, tok)).status).toBe(409);
  });

  it("unlocks again after return_to_draft (and echoes the reason)", async () => {
    const { me, benchmark, target } = await readyChainWithData();
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
      (await apiPut(`/api/v1/targets/${target.id}`, { data: { type: "target", attributes: { name: "renamed" } } }, bearer(me.token))).status,
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
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const { key } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(key));
    expect(res.status).toBe(403);
  });
});

describe("personal publish", () => {
  it("is gated by the account opt-in", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);

    // opt-in off → 403
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token))).status).toBe(403);

    // opt-in on → 200, PERSONAL attribution with a stable gravatar hash
    await allowPersonalPublish(b.id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token));
    expect(ok.status).toBe(200);
    const pub = ((await ok.json()) as { data: Resource }).data;
    const badge = pub.attributes.published_as as { kind: string; gravatar_hash: string; display_name: string | null };
    expect(badge.kind).toBe("PERSONAL");
    expect(badge.display_name).toBe("Test User");
    expect(badge.gravatar_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pub.attributes.published_by).toBe(me.user_id);
  });

  it('accepts the "self" sentinel as an explicit personal publish', async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody("self"), bearer(me.token));
    expect(ok.status).toBe(200);
    expect((((await ok.json()) as { data: Resource }).data.attributes.published_as as { kind: string }).kind).toBe("PERSONAL");
  });

  it("resumes append-only ingest after publishing (a live run keeps accepting observations)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    const t = await makeTarget(me.token, b.id, "t");
    const run = await makeRun(me.token, t.id); // live (no ended_at)
    await markReady(me.token, b.id);
    await allowPersonalPublish(b.id);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(), bearer(me.token))).status).toBe(200);
    // published + append-only resumed → ingest to the live run works again
    const ing = await apiPost(
      "/api/v1/observations",
      { data: { type: "observation", attributes: { run: run.id, metrics: { skew_ms: 5 } } } },
      bearer(me.token),
    );
    expect(ing.status).toBe(201);
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
    await markReady(author, bench.id);
    await allowPersonalPublish(bench.id);
    // the owner is an admin but NOT the author → personal publish 403
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(owner.token))).status).toBe(403);
    // the author can
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(author))).status).toBe(200);
  });
});

describe("organization publish", () => {
  it("requires an admin, a verified domain, and freezes the snapshot", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const { identity, domain } = await verifiedIdentity(me.token);
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);

    const ok = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(identity.id), bearer(me.token));
    expect(ok.status).toBe(200);
    const pub = ((await ok.json()) as { data: Resource }).data;
    const badge = pub.attributes.published_as as { kind: string; identity: string; name: string; verified_domains: string[] };
    expect(badge.kind).toBe("ORGANIZATION");
    expect(badge.identity).toBe(identity.id);
    expect(badge.name).toBe("Acme Corp");
    expect(badge.verified_domains).toEqual([domain.attributes.domain]);
  });

  it("blocks org publish when the identity has no verified domain (409)", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const identity = await createIdentity(me.token);
    await addDomain(me.token, identity.id, "unverified.com"); // PENDING, never verified
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);
    const res = await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(identity.id), bearer(me.token));
    expect(res.status).toBe(409);
  });

  it("404s org publish against an unknown / cross-tenant identity", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);
    // unknown identity id
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody("ghost"), bearer(me.token))).status).toBe(404);
    // another account's identity
    const other = await register("other-org@example.com");
    const foreign = await createIdentity(other.token);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(foreign.id), bearer(me.token))).status).toBe(404);
  });

  it("a non-admin member cannot org-publish (403)", async () => {
    const owner = await register("orgowner@example.com");
    await markVerified(owner.user_id);
    const { identity } = await verifiedIdentity(owner.token);
    const { memberToken: member } = await addMember(owner.token, owner.account_id, "m@example.com", "MEMBER");
    const bench = await makeBenchmark(member, { key: "memberbench" });
    await markReady(member, bench.id);
    const res = await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(identity.id), bearer(member));
    expect(res.status).toBe(403);
  });
});

// ── §4 withdraw authority ─────────────────────────────────────────────────────

describe("withdraw authority mirrors publish", () => {
  const withdrawBody = { data: { type: "benchmark", attributes: { withdrawal_reason: "clock skew" } } };

  it("an org-published benchmark requires an admin to withdraw", async () => {
    const owner = await register("wowner@example.com");
    await markVerified(owner.user_id);
    const { identity } = await verifiedIdentity(owner.token);
    const { memberToken: member } = await addMember(owner.token, owner.account_id, "wm@example.com", "MEMBER");
    const bench = await makeBenchmark(member, { key: "orgbench" });
    await markReady(member, bench.id);
    // owner (admin) publishes it under the org
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(identity.id), bearer(owner.token))).status).toBe(200);
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
    await markReady(author, bench.id);
    await allowPersonalPublish(bench.id);
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/publish`, publishBody(), bearer(author))).status).toBe(200);
    // the owner (admin, not the author) can withdraw it
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/withdraw`, withdrawBody, bearer(owner.token))).status).toBe(200);
  });
});

// ── §3/§4 the never-retroactively-strip guarantee ─────────────────────────────

describe("the public record is frozen", () => {
  it("a domain lapse never rewrites a published badge, but blocks new publishes under the identity", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const { identity, domain } = await verifiedIdentity(me.token);

    const b1 = await makeBenchmark(me.token, { key: "first" });
    await markReady(me.token, b1.id);
    expect((await apiPost(`/api/v1/benchmarks/${b1.id}/actions/publish`, publishBody(identity.id), bearer(me.token))).status).toBe(200);

    // The cron sweep sees the TXT record gone and lapses the domain.
    stubTxt([]); // no records
    const swept = await sweepVerifiedDomains(env.DB);
    expect(swept.lapsed).toBe(1);
    vi.unstubAllGlobals();

    // The domain is now LAPSED…
    const domRow = await env.DB.prepare("SELECT status FROM publisher_domain WHERE id = ?").bind(domain.id).first<{ status: string }>();
    expect(domRow?.status).toBe("LAPSED");

    // …but the published benchmark's frozen badge is unchanged.
    const read = await apiGet(`/api/v1/benchmarks/${b1.id}`);
    const badge = ((await read.json()) as { data: Resource }).data.attributes.published_as as { verified_domains: string[] };
    expect(badge.verified_domains).toEqual([domain.attributes.domain]);

    // And a NEW publish under the same identity is now blocked.
    const b2 = await makeBenchmark(me.token, { key: "second" });
    await markReady(me.token, b2.id);
    expect((await apiPost(`/api/v1/benchmarks/${b2.id}/actions/publish`, publishBody(identity.id), bearer(me.token))).status).toBe(409);
  });

  it("an identity can be deleted while a published benchmark references it; the frozen badge survives", async () => {
    const me = await register();
    await markVerified(me.user_id);
    const { identity, domain } = await verifiedIdentity(me.token);
    const b = await makeBenchmark(me.token);
    await markReady(me.token, b.id);
    expect((await apiPost(`/api/v1/benchmarks/${b.id}/actions/publish`, publishBody(identity.id), bearer(me.token))).status).toBe(200);

    // deleting the identity is allowed even though a published benchmark points at it
    expect((await apiDelete(`/api/v1/publisher_identities/${identity.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/publisher_identities/${identity.id}`, bearer(me.token))).status).toBe(404);

    // the published benchmark is unchanged: still public, badge intact (soft identity ref preserved)
    const read = await apiGet(`/api/v1/benchmarks/${b.id}`);
    const attrs = ((await read.json()) as { data: Resource }).data.attributes;
    expect(attrs.status).toBe("PUBLISHED");
    const badge = attrs.published_as as { kind: string; identity: string; name: string; verified_domains: string[] };
    expect(badge.kind).toBe("ORGANIZATION");
    expect(badge.identity).toBe(identity.id); // dangling but preserved from the snapshot era
    expect(badge.name).toBe("Acme Corp");
    expect(badge.verified_domains).toEqual([domain.attributes.domain]);
  });

  it("a lapsed domain can be re-verified", async () => {
    const me = await register();
    const { domain } = await verifiedIdentity(me.token);
    // lapse via sweep
    stubTxt([]);
    await sweepVerifiedDomains(env.DB);
    vi.unstubAllGlobals();
    // re-verify via the verify action
    stubTxt([domain.attributes.verification_token as string]);
    const res = await apiPost(`/api/v1/publisher_domains/${domain.id}/actions/verify`, undefined, bearer(me.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");
  });
});

// ── cron sweep internals ──────────────────────────────────────────────────────

describe("cron sweep", () => {
  it("re-affirms a still-present record (stays VERIFIED, lapses nothing)", async () => {
    const me = await register();
    const { domain } = await verifiedIdentity(me.token);
    stubTxt([domain.attributes.verification_token as string]);
    const result = await sweepVerifiedDomains(env.DB);
    expect(result).toEqual({ checked: 1, lapsed: 0, truncated: false });
    const row = await env.DB.prepare("SELECT status FROM publisher_domain WHERE id = ?").bind(domain.id).first<{ status: string }>();
    expect(row?.status).toBe("VERIFIED");
  });

  it("never lapses on a resolver failure (ambiguity ≠ gone)", async () => {
    const me = await register();
    const { domain } = await verifiedIdentity(me.token);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("resolver down");
      }),
    );
    const result = await sweepVerifiedDomains(env.DB);
    expect(result.lapsed).toBe(0);
    expect(result.checked).toBe(0); // the check itself failed, so nothing was counted as checked
    const row = await env.DB.prepare("SELECT status FROM publisher_domain WHERE id = ?").bind(domain.id).first<{ status: string }>();
    expect(row?.status).toBe("VERIFIED");
  });

  it("is a no-op when there are no verified domains", async () => {
    expect(await sweepVerifiedDomains(env.DB)).toEqual({ checked: 0, lapsed: 0, truncated: false });
  });

  it("paginates across pages and honors the max-pages safety bound", async () => {
    const me = await register();
    const identity = await createIdentity(me.token);
    const tokens: string[] = [];
    for (const d of ["a.com", "b.com", "c.com"]) {
      const dom = await addDomain(me.token, identity.id, d);
      tokens.push(dom.attributes.verification_token as string);
    }
    // verify all three (all tokens present)
    stubTxt(tokens);
    const listed = (await (
      await apiGet(`/api/v1/publisher_domains?filter[publisher_identity]=${identity.id}`, bearer(me.token))
    ).json()) as { data: Resource[] };
    for (const d of listed.data) {
      await apiPost(`/api/v1/publisher_domains/${d.id}/actions/verify`, undefined, bearer(me.token));
    }

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
  it("stays PENDING on a miss and lapses a previously-verified domain", async () => {
    const me = await register();
    const identity = await createIdentity(me.token);
    const dom = await addDomain(me.token, identity.id, "acme.com");

    // miss → still PENDING
    stubTxt(["some-other-record"]);
    const miss = await apiPost(`/api/v1/publisher_domains/${dom.id}/actions/verify`, undefined, bearer(me.token));
    expect(((await miss.json()) as { data: Resource }).data.attributes.status).toBe("PENDING");

    // hit → VERIFIED
    stubTxt([dom.attributes.verification_token as string]);
    const hit = await apiPost(`/api/v1/publisher_domains/${dom.id}/actions/verify`, undefined, bearer(me.token));
    expect(((await hit.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");

    // record gone → LAPSED
    stubTxt([]);
    const lapse = await apiPost(`/api/v1/publisher_domains/${dom.id}/actions/verify`, undefined, bearer(me.token));
    expect(((await lapse.json()) as { data: Resource }).data.attributes.status).toBe("LAPSED");
  });

  it("leaves status untouched when the DNS check itself fails", async () => {
    const me = await register();
    const { domain } = await verifiedIdentity(me.token);
    // resolver error
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await apiPost(`/api/v1/publisher_domains/${domain.id}/actions/verify`, undefined, bearer(me.token));
    expect(res.status).toBe(200);
    // still VERIFIED — a transient failure must never lapse a domain
    expect(((await res.json()) as { data: Resource }).data.attributes.status).toBe("VERIFIED");
  });
});
