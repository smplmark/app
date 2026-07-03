import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { createAccount } from "../../src/data/accounts";
import {
  createPublisherIdentity,
  deletePublisherIdentityCascade,
  getPublisherIdentityById,
  listPublisherIdentities,
  updatePublisherIdentity,
} from "../../src/data/publisher_identities";
import {
  createPublisherDomain,
  deletePublisherDomain,
  getPublisherDomainById,
  listPublisherDomains,
  listVerifiedDomains,
  listVerifiedDomainsPage,
  setPublisherDomainStatus,
} from "../../src/data/publisher_domains";
import type { AccountRow } from "../../src/types";

const TABLES = ["publisher_domain", "publisher_identity", "account"];
beforeEach(async () => {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function account(): Promise<AccountRow> {
  return createAccount(env.DB, { key: `acct-${crypto.randomUUID()}`, name: "Acct" });
}

async function expectConflict(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error("expected a conflict");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(409);
  }
}

describe("publisher_identity data", () => {
  it("creates, reads (null when missing), lists, and filters by key", async () => {
    const a = await account();
    const one = await createPublisherIdentity(env.DB, { account_id: a.id, key: "one", name: "One", logo_url: null });
    await createPublisherIdentity(env.DB, { account_id: a.id, key: "two", name: "Two", logo_url: "u" });

    expect((await getPublisherIdentityById(env.DB, one.id))?.key).toBe("one");
    expect(await getPublisherIdentityById(env.DB, "ghost")).toBeNull();

    expect((await listPublisherIdentities(env.DB, a.id)).map((r) => r.key).sort()).toEqual(["one", "two"]);
    expect((await listPublisherIdentities(env.DB, a.id, { key: "two" })).map((r) => r.key)).toEqual(["two"]);
  });

  it("409s a duplicate key and rethrows a non-unique (FK) error", async () => {
    const a = await account();
    await createPublisherIdentity(env.DB, { account_id: a.id, key: "dup", name: "D", logo_url: null });
    await expectConflict(() =>
      createPublisherIdentity(env.DB, { account_id: a.id, key: "dup", name: "D2", logo_url: null }),
    );
    await expect(
      createPublisherIdentity(env.DB, { account_id: "ghost-account", key: "x", name: "X", logo_url: null }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("updates (null when missing) and 409s an update into a duplicate key", async () => {
    const a = await account();
    const one = await createPublisherIdentity(env.DB, { account_id: a.id, key: "one", name: "One", logo_url: null });
    await createPublisherIdentity(env.DB, { account_id: a.id, key: "two", name: "Two", logo_url: null });

    const updated = await updatePublisherIdentity(env.DB, one.id, { key: "one", name: "Renamed", logo_url: "L" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.logo_url).toBe("L");

    expect(await updatePublisherIdentity(env.DB, "ghost", { key: "z", name: "Z", logo_url: null })).toBeNull();
    await expectConflict(() => updatePublisherIdentity(env.DB, one.id, { key: "two", name: "One", logo_url: null }));
  });

  it("cascades a delete to its domains", async () => {
    const a = await account();
    const id = await createPublisherIdentity(env.DB, { account_id: a.id, key: "brand", name: "Brand", logo_url: null });
    const dom = await createPublisherDomain(env.DB, {
      account_id: a.id,
      publisher_identity_id: id.id,
      domain: "brand.com",
      verification_token: "smplmark-verify=t",
    });
    await deletePublisherIdentityCascade(env.DB, id.id);
    expect(await getPublisherIdentityById(env.DB, id.id)).toBeNull();
    expect(await getPublisherDomainById(env.DB, dom.id)).toBeNull();
  });
});

describe("publisher_domain data", () => {
  it("creates PENDING, reads (null when missing), and filters by identity + status", async () => {
    const a = await account();
    const id1 = await createPublisherIdentity(env.DB, { account_id: a.id, key: "i1", name: "I1", logo_url: null });
    const id2 = await createPublisherIdentity(env.DB, { account_id: a.id, key: "i2", name: "I2", logo_url: null });
    const d1 = await createPublisherDomain(env.DB, { account_id: a.id, publisher_identity_id: id1.id, domain: "a.com", verification_token: "smplmark-verify=1" });
    await createPublisherDomain(env.DB, { account_id: a.id, publisher_identity_id: id2.id, domain: "b.com", verification_token: "smplmark-verify=2" });

    expect((await getPublisherDomainById(env.DB, d1.id))?.domain).toBe("a.com");
    expect(await getPublisherDomainById(env.DB, "ghost")).toBeNull();

    expect((await listPublisherDomains(env.DB, a.id)).length).toBe(2);
    expect((await listPublisherDomains(env.DB, a.id, { publisherIdentityId: id1.id })).map((r) => r.domain)).toEqual(["a.com"]);
    expect((await listPublisherDomains(env.DB, a.id, { status: "PENDING" })).length).toBe(2);
    expect((await listPublisherDomains(env.DB, a.id, { status: "VERIFIED" })).length).toBe(0);
    expect(
      (await listPublisherDomains(env.DB, a.id, { publisherIdentityId: id2.id, status: "PENDING" })).map((r) => r.domain),
    ).toEqual(["b.com"]);
  });

  it("409s a duplicate domain under one identity and rethrows a non-unique (FK) error", async () => {
    const a = await account();
    const id = await createPublisherIdentity(env.DB, { account_id: a.id, key: "i", name: "I", logo_url: null });
    await createPublisherDomain(env.DB, { account_id: a.id, publisher_identity_id: id.id, domain: "dup.com", verification_token: "smplmark-verify=1" });
    await expectConflict(() =>
      createPublisherDomain(env.DB, { account_id: a.id, publisher_identity_id: id.id, domain: "dup.com", verification_token: "smplmark-verify=2" }),
    );
    await expect(
      createPublisherDomain(env.DB, { account_id: a.id, publisher_identity_id: "ghost-identity", domain: "x.com", verification_token: "smplmark-verify=3" }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("records status transitions and surfaces VERIFIED via the verified-domain queries", async () => {
    const a = await account();
    const id = await createPublisherIdentity(env.DB, { account_id: a.id, key: "i", name: "I", logo_url: null });
    const d = await createPublisherDomain(env.DB, { account_id: a.id, publisher_identity_id: id.id, domain: "v.com", verification_token: "smplmark-verify=1" });

    const verified = await setPublisherDomainStatus(env.DB, d.id, { status: "VERIFIED", verified_at: 100, last_checked_at: 100 });
    expect(verified?.status).toBe("VERIFIED");
    expect((await listVerifiedDomains(env.DB, id.id)).map((r) => r.domain)).toEqual(["v.com"]);
    expect((await listVerifiedDomainsPage(env.DB, 10, 0)).length).toBe(1);

    await setPublisherDomainStatus(env.DB, d.id, { status: "LAPSED", verified_at: 100, last_checked_at: 200 });
    expect((await listVerifiedDomains(env.DB, id.id)).length).toBe(0);
    expect((await listVerifiedDomainsPage(env.DB, 10, 0)).length).toBe(0);

    await deletePublisherDomain(env.DB, d.id);
    expect(await getPublisherDomainById(env.DB, d.id)).toBeNull();
  });
});
