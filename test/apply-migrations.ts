import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply the migrations (carried in via the TEST_MIGRATIONS binding) to the isolated test D1.
// Idempotent — records applied migrations in d1_migrations, so re-runs are cheap.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
