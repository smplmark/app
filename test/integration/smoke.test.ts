import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Smoke test: proves the Workers pool boots, the D1 binding is present, and the migration
// applied (all tables exist). If this passes, the test harness is sound.
describe("test harness", () => {
  it("has a migrated D1 with the full table set", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' ORDER BY name",
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name);
    expect(tables).toEqual([
      "account",
      "account_user",
      "api_key",
      "benchmark",
      "email_verification",
      "invitation",
      "observation",
      "publisher_domain",
      "publisher_identity",
      "run",
      "session",
      "target",
      "user",
      "user_identity",
    ]);
  });

  it("can insert and read back through the D1 binding", async () => {
    await env.DB.prepare(
      "INSERT INTO account (id, key, name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind("acct-1", "smoke", "Smoke", 1_700_000_000_000)
      .run();
    const row = await env.DB.prepare("SELECT key FROM account WHERE id = ?")
      .bind("acct-1")
      .first<{ key: string }>();
    expect(row?.key).toBe("smoke");
  });
});
