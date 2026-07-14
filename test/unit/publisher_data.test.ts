import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { createAccount } from "../../src/data/accounts";
import {
  createPublisher,
  deletePublisher,
  getPublisherById,
  listPublishers,
  listVerifiedPublishersPage,
  setPublisherStatus,
  updatePublisherIcon,
} from "../../src/data/publishers";
import type { AccountRow } from "../../src/types";

const TABLES = ["publisher", "account"];
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

describe("publisher data", () => {
  it("creates PENDING with a monogram default, reads (null when missing), lists, and filters by status", async () => {
    const a = await account();
    const one = await createPublisher(env.DB, { account_id: a.id, domain: "a.com", verification_token: "smplmark-verify=1" });
    await createPublisher(env.DB, { account_id: a.id, domain: "b.com", verification_token: "smplmark-verify=2" });

    expect(one.status).toBe("PENDING");
    expect(one.icon).toBe("monogram");
    expect((await getPublisherById(env.DB, one.id))?.domain).toBe("a.com");
    expect(await getPublisherById(env.DB, "ghost")).toBeNull();

    expect((await listPublishers(env.DB, a.id)).map((r) => r.domain).sort()).toEqual(["a.com", "b.com"]);
    expect((await listPublishers(env.DB, a.id, { status: "PENDING" })).length).toBe(2);
    expect((await listPublishers(env.DB, a.id, { status: "VERIFIED" })).length).toBe(0);
  });

  it("409s a duplicate domain per account and rethrows a non-unique (FK) error", async () => {
    const a = await account();
    await createPublisher(env.DB, { account_id: a.id, domain: "dup.com", verification_token: "smplmark-verify=1" });
    await expectConflict(() =>
      createPublisher(env.DB, { account_id: a.id, domain: "dup.com", verification_token: "smplmark-verify=2" }),
    );
    await expect(
      createPublisher(env.DB, { account_id: "ghost-account", domain: "x.com", verification_token: "smplmark-verify=3" }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("records status transitions, updates the icon, surfaces VERIFIED to the sweep, and deletes", async () => {
    const a = await account();
    const p = await createPublisher(env.DB, { account_id: a.id, domain: "v.com", verification_token: "smplmark-verify=1" });

    const verified = await setPublisherStatus(env.DB, p.id, { status: "VERIFIED", verified_at: 100, last_checked_at: 100 });
    expect(verified?.status).toBe("VERIFIED");
    expect((await listVerifiedPublishersPage(env.DB, 10, 0)).map((r) => r.domain)).toEqual(["v.com"]);

    const iconed = await updatePublisherIcon(env.DB, p.id, "favicon");
    expect(iconed?.icon).toBe("favicon");

    await setPublisherStatus(env.DB, p.id, { status: "LAPSED", verified_at: 100, last_checked_at: 200 });
    expect((await listVerifiedPublishersPage(env.DB, 10, 0)).length).toBe(0);

    await deletePublisher(env.DB, p.id);
    expect(await getPublisherById(env.DB, p.id)).toBeNull();
  });
});
