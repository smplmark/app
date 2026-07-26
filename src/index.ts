import { createApp } from "./app";

// Worker entry. The Hono app handles /api/* and falls through to Static Assets for everything else.
// The periodic publisher-domain re-check is driven externally by Smpl Jobs, which POSTs
// /api/v1/jobs/domain-recheck on a schedule (see src/routes/jobs.ts) — there is no Workers cron.
const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
