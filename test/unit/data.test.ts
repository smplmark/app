import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { createAccount, updateAccount } from "../../src/data/accounts";
import { getPrimaryMembershipForUser } from "../../src/data/account_users";
import { createBenchmark, updateBenchmark } from "../../src/data/benchmarks";
import { createSubject, updateSubject } from "../../src/data/subjects";
import { createSubjectType } from "../../src/data/subject_types";
import { createRun, endRun, invalidateRun, updateRun } from "../../src/data/runs";
import { insertMeasurement, listMeasurements } from "../../src/data/measurements";
import { createApiKey, listApiKeys } from "../../src/data/api_keys";
import { createUser } from "../../src/data/users";
import { parseDateRange } from "../../src/query/daterange";
import { consumeVerification, createVerification } from "../../src/data/verifications";
import type { AccountRow, BenchmarkRow, RunRow, MeasurementSchema, SubjectRow } from "../../src/types";

// D1 (miniflare) enforces foreign keys, so every child needs a real parent row.
const TABLES = ["measurement", "run", "subject", "benchmark", "subject_type", "publisher", "api_key", "email_verification", "account_user", "account", "user"];
beforeEach(async () => {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const schema: MeasurementSchema = { metrics: [], derived: [] };
const sort = { field: "created_at", desc: false };

async function chain(): Promise<{ account: AccountRow; benchmark: BenchmarkRow; subject: SubjectRow; run: RunRow }> {
  const account = await createAccount(env.DB, { key: `host-${crypto.randomUUID()}`, name: "Host" });
  const subjectType = await createSubjectType(env.DB, { account_id: account.id, key: "st", name: "ST", fields: [] });
  const benchmark = await createBenchmark(env.DB, {
    account_id: account.id, key: "b", name: "B", description: null, about: null, methodology: null, subject_type: subjectType.id, measurement_schema: schema, category: "OTHER", created_by_user_id: null,
  });
  const subject = await createSubject(env.DB, { account_id: account.id, subject_type_id: subjectType.id, key: "t", name: "T", details: null });
  const run = await createRun(env.DB, { benchmark_id: benchmark.id, key: "r", name: null, details: null, started_at: null, ended_at: null });
  return { account, benchmark, subject, run };
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

describe("unique-violation → 409 on create", () => {
  it("accounts, benchmarks, subjects, runs all reject duplicate keys", async () => {
    const { account, benchmark, subject } = await chain();
    await expectConflict(() => createAccount(env.DB, { key: account.key, name: "B" }));
    await expectConflict(() =>
      createBenchmark(env.DB, { account_id: account.id, key: "b", name: "B2", description: null, about: null, methodology: null, subject_type: subject.subject_type_id as string, measurement_schema: schema, category: "OTHER", created_by_user_id: null }),
    );
    await expectConflict(() => createSubject(env.DB, { account_id: account.id, subject_type_id: subject.subject_type_id as string, key: "t", name: "T2", details: null }));
    await expectConflict(() => createRun(env.DB, { benchmark_id: benchmark.id, key: "r", name: null, details: null, started_at: null, ended_at: null }));
  });
});

describe("non-unique DB errors are rethrown (not swallowed as 409)", () => {
  it("rethrows a foreign-key violation on create", async () => {
    await expect(
      createBenchmark(env.DB, { account_id: "ghost-account", key: "x", name: "X", description: null, about: null, methodology: null, subject_type: "ghost-type", measurement_schema: schema, category: "OTHER", created_by_user_id: null }),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      createSubject(env.DB, { account_id: "ghost-account", subject_type_id: "ghost-type", key: "x", name: "X", details: null }),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      createRun(env.DB, { benchmark_id: "ghost-benchmark", key: "x", name: null, details: null, started_at: null, ended_at: null }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("createUser rejects a duplicate email with 409", async () => {
    await createUser(env.DB, { email: "dupe@example.com", display_name: null, email_verified: false });
    await expectConflict(() => createUser(env.DB, { email: "DUPE@example.com", display_name: null, email_verified: false }));
  });
});

describe("listMeasurements with a date range", () => {
  it("applies the created_at predicate", async () => {
    const { run, subject } = await chain();
    await insertMeasurement(env.DB, { run_id: run.id, subject_id: subject.id, created_at: 1000, metrics: null, meta: null, client_ip: null });
    await insertMeasurement(env.DB, { run_id: run.id, subject_id: subject.id, created_at: 5000, metrics: null, meta: null, client_ip: null });
    const res = await listMeasurements(env.DB, {
      scope: { run: run.id },
      range: { start: 2000, startInclusive: true, end: null, endInclusive: false },
      sort, limit: 100, offset: 0, includeTotal: false,
    });
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].created_at).toBe(5000);

    // An open range produces no predicate fragment (exercises the empty-sql branch).
    const open = await listMeasurements(env.DB, {
      scope: { run: run.id }, range: parseDateRange("(*,*)"), sort, limit: 100, offset: 0, includeTotal: false,
    });
    expect(open.rows.length).toBe(2);
  });
});

describe("update / lookup not-found paths return null", () => {
  it("updates of missing rows and missing membership return null", async () => {
    expect(await updateAccount(env.DB, "nope", { name: "x", description: null, allow_personal_publish: 0 })).toBeNull();
    expect(await updateBenchmark(env.DB, "nope", { name: "x", description: null, about: null, methodology: null, subject_type: "st", measurement_schema: schema, category: "OTHER" })).toBeNull();
    expect(await updateSubject(env.DB, "nope", { name: "x", details: null })).toBeNull();
    expect(await updateRun(env.DB, "nope", { name: "x", details: null, started_at: null, ended_at: null })).toBeNull();
    expect(await getPrimaryMembershipForUser(env.DB, "no-user")).toBeNull();
  });
});

describe("run actions round-trip through getRunById", () => {
  it("endRun and invalidateRun return the updated row", async () => {
    const { run } = await chain();
    const ended = await endRun(env.DB, run.id, 123);
    expect(ended?.ended_at).toBe(123);
    const inv = await invalidateRun(env.DB, run.id, 456, "why", null);
    expect(inv?.invalidated_at).toBe(456);
    expect(inv?.invalidation_reason).toBe("why");
  });
});

describe("email verification consume", () => {
  it("consumes once, then returns null for reuse and for expired", async () => {
    const u = await createUser(env.DB, { email: "v@example.com", display_name: null, email_verified: false });
    await createVerification(env.DB, { user_id: u.id, token_hash: "h1", expires_at: Date.now() + 10_000 });
    expect(await consumeVerification(env.DB, "h1", Date.now())).toBe(u.id);
    expect(await consumeVerification(env.DB, "h1", Date.now())).toBeNull(); // consumed
    await createVerification(env.DB, { user_id: u.id, token_hash: "h2", expires_at: 1000 });
    expect(await consumeVerification(env.DB, "h2", 2000)).toBeNull(); // expired
  });
});

describe("listApiKeys with total", () => {
  it("returns the total count when requested", async () => {
    const account = await createAccount(env.DB, { key: `k-${crypto.randomUUID()}`, name: "K" });
    await createApiKey(env.DB, {
      account_id: account.id, name: "k1", scope_type: "ACCOUNT", scope_ref: null,
      key_hash: "h", key_encrypted: "e", prefix: "sm_api_xxxxxxxx", expires_at: null, created_by_user_id: null,
    });
    const res = await listApiKeys(env.DB, {
      account_id: account.id, sort: { field: "created_at", desc: true }, limit: 10, offset: 0, includeTotal: true,
    });
    expect(res.rows.length).toBe(1);
    expect(res.total).toBe(1);
  });
});

describe("listMeasurements scopes + total", () => {
  it("lists by subject and by benchmark with a total count", async () => {
    const { benchmark, subject, run } = await chain();
    await insertMeasurement(env.DB, { run_id: run.id, subject_id: subject.id, created_at: 1000, metrics: null, meta: null, client_ip: null });

    const bySubject = await listMeasurements(env.DB, {
      scope: { subject: subject.id }, sort, limit: 100, offset: 0, includeTotal: true,
    });
    expect(bySubject.rows.length).toBe(1);
    expect(bySubject.total).toBe(1);

    const byBenchmark = await listMeasurements(env.DB, {
      scope: { benchmark: benchmark.id }, sort, limit: 100, offset: 0, includeTotal: false,
    });
    expect(byBenchmark.rows.length).toBe(1);
  });
});
