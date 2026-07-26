/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from "cloudflare:test";

// The test-only binding injected by vitest.config.ts (the parsed migrations). Augments the
// Workers `cloudflare:test` env only — the production `Env` type (used in src/) never sees it.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
