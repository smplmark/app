import type { Context, MiddlewareHandler } from "hono";
import { resolveApiKey } from "../auth/apikey";
import { verifySessionToken } from "../auth/jwt";
import { API_KEY_PREFIX } from "../config";
import { touchLastUsed } from "../data/api_keys";
import { UnauthorizedError } from "../errors";
import type { AuthContext } from "../types";
import { parseBearer } from "./body";

export interface AppBindings {
  Bindings: Env;
  Variables: { auth?: AuthContext };
}

type AppContext = Context<AppBindings>;

const MISSING =
  "Provide an API key or session token as `Authorization: Bearer <token>`.";

/** Resolve a bearer token (either credential type) to an auth context. Throws on any failure. */
async function resolve(c: AppContext, token: string): Promise<AuthContext> {
  if (token.startsWith(API_KEY_PREFIX)) {
    const { ctx, keyId } = await resolveApiKey(c.env.DB, token, Date.now());
    // Best-effort last-used stamp, off the hot path.
    try {
      c.executionCtx.waitUntil(touchLastUsed(c.env.DB, keyId, Date.now()));
    } catch {
      // no execution context (e.g. some test harnesses) — skip silently.
    }
    return ctx;
  }
  const claims = await verifySessionToken(c.env, token);
  return {
    source: "SESSION",
    account_id: claims.account_id,
    scope_type: "ACCOUNT",
    scope_ref: null,
    user_id: claims.sub,
    role: claims.role,
    session_id: claims.jti,
  };
}

/** Require a valid credential. Sets `auth` on the context. */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = parseBearer(c.req.header("Authorization"));
  if (token === null) throw new UnauthorizedError(MISSING);
  c.set("auth", await resolve(c, token));
  await next();
};

/**
 * Optional credential: anonymous (no header) proceeds with no `auth`; a *present* token must be
 * valid (a bad token is still a 401 — we don't silently ignore it).
 */
export const optionalAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = parseBearer(c.req.header("Authorization"));
  if (token !== null) {
    c.set("auth", await resolve(c, token));
  }
  await next();
};

/** The authenticated context, or throw 401 (for handlers behind requireAuth). */
export function getAuth(c: AppContext): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw new UnauthorizedError(MISSING);
  return auth;
}

/** The authenticated context if present, else undefined (for handlers behind optionalAuth). */
export function getOptionalAuth(c: AppContext): AuthContext | undefined {
  return c.get("auth");
}
