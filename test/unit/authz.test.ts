import { describe, expect, it } from "vitest";
import {
  canMintScope,
  canPublishOrg,
  canPublishPersonal,
  covers,
  isAuthor,
  isPublicStatus,
} from "../../src/authz";
import type { AuthContext, Role, ScopeType } from "../../src/types";

const ctx = (scope_type: ScopeType, scope_ref: string | null = null, account_id = "acc"): AuthContext => ({
  source: "API_KEY",
  account_id,
  scope_type,
  scope_ref,
  user_id: null,
  role: null,
  session_id: null,
});

const session = (role: Role, user_id = "u1", account_id = "acc"): AuthContext => ({
  source: "SESSION",
  account_id,
  scope_type: "ACCOUNT",
  scope_ref: null,
  user_id,
  role,
  session_id: "s1",
});

describe("covers", () => {
  it("enforces the tenant floor", () => {
    expect(covers(ctx("ACCOUNT", null, "acc"), { account_id: "other" })).toBe(false);
  });

  it("ACCOUNT scope covers the whole account", () => {
    expect(covers(ctx("ACCOUNT"), { account_id: "acc", benchmark_id: "b", run_id: "r" })).toBe(true);
  });

  it("BENCHMARK scope covers only its benchmark subtree", () => {
    expect(covers(ctx("BENCHMARK", "b1"), { account_id: "acc", benchmark_id: "b1" })).toBe(true);
    expect(covers(ctx("BENCHMARK", "b1"), { account_id: "acc", benchmark_id: "b2" })).toBe(false);
    expect(covers(ctx("BENCHMARK", "b1"), { account_id: "acc" })).toBe(false); // no benchmark_id
  });

  it("RUN scope covers only its run", () => {
    expect(covers(ctx("RUN", "r1"), { account_id: "acc", benchmark_id: "b", run_id: "r1" })).toBe(true);
    expect(covers(ctx("RUN", "r1"), { account_id: "acc", benchmark_id: "b", run_id: "r2" })).toBe(false);
    expect(covers(ctx("RUN", "r1"), { account_id: "acc", benchmark_id: "b" })).toBe(false); // no run_id
  });
});

describe("isPublicStatus", () => {
  it("is true for PUBLISHED and WITHDRAWN only", () => {
    expect(isPublicStatus("PUBLISHED")).toBe(true);
    expect(isPublicStatus("WITHDRAWN")).toBe(true);
    expect(isPublicStatus("PRIVATE")).toBe(false);
  });
});

describe("canMintScope", () => {
  it("only account authority can mint an account-scope key", () => {
    expect(canMintScope(ctx("ACCOUNT"), { account_id: "acc" })).toBe(true);
    expect(canMintScope(ctx("RUN", "r1"), { account_id: "acc" })).toBe(false);
  });
});

describe("isAuthor", () => {
  it("is true only for the session user who created the benchmark", () => {
    expect(isAuthor(session("MEMBER", "u1"), { created_by_user_id: "u1" })).toBe(true);
    expect(isAuthor(session("MEMBER", "u2"), { created_by_user_id: "u1" })).toBe(false);
    // API keys are never authors (they have no user), even for an account-scoped key.
    expect(isAuthor(ctx("ACCOUNT"), { created_by_user_id: "u1" })).toBe(false);
    // A benchmark created by an API key has no author to match.
    expect(isAuthor(session("MEMBER", "u1"), { created_by_user_id: null })).toBe(false);
  });
});

describe("canPublishOrg", () => {
  it("requires a signed-in admin (API keys never qualify)", () => {
    expect(canPublishOrg(session("ADMIN"))).toBe(true);
    expect(canPublishOrg(session("OWNER"))).toBe(true);
    expect(canPublishOrg(session("MEMBER"))).toBe(false);
    expect(canPublishOrg(session("VIEWER"))).toBe(false);
    expect(canPublishOrg(ctx("ACCOUNT"))).toBe(false); // API key, despite passing role gates elsewhere
  });
});

describe("canPublishPersonal", () => {
  const bench = { created_by_user_id: "u1" };
  it("requires the signed-in author, write authority, and the account opt-in", () => {
    expect(canPublishPersonal(session("MEMBER", "u1"), bench, { allow_personal_publish: 1 })).toBe(true);
    // opt-in off
    expect(canPublishPersonal(session("MEMBER", "u1"), bench, { allow_personal_publish: 0 })).toBe(false);
    // not the author
    expect(canPublishPersonal(session("ADMIN", "u2"), bench, { allow_personal_publish: 1 })).toBe(false);
    // viewers can't write
    expect(canPublishPersonal(session("VIEWER", "u1"), bench, { allow_personal_publish: 1 })).toBe(false);
    // no account
    expect(canPublishPersonal(session("MEMBER", "u1"), bench, null)).toBe(false);
    // API key is never a personal publisher
    expect(canPublishPersonal(ctx("ACCOUNT"), bench, { allow_personal_publish: 1 })).toBe(false);
  });
});
