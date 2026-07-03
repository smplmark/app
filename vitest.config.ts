import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

// Read and pre-split the D1 migrations at config time (Node context). They ride in as a
// test-only `TEST_MIGRATIONS` binding and are applied to each isolated test D1 in
// test/apply-migrations.ts. Bindings (DB, ASSETS, ADMIN_TOKEN) come from wrangler.jsonc.
const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Auth secrets for tests (never real). KEY_ENCRYPTION_SECRET is base64 of 32 bytes.
          APP_AUTH_SECRET: "test-app-auth-secret-do-not-use-in-prod",
          KEY_ENCRYPTION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          APP_URL: "http://smplmark.test",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "**/*.d.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        // Pure modules carry no runtime excuse — hold them to 100%.
        "src/query/**/*.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        "src/logic/**/*.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        "src/serialize/**/*.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        "src/auth/crypto.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
