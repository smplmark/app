import { Hono } from "hono";
import { getMembershipSettings, putMembershipSettings } from "../data/account_users";
import { getUserById, updateUserDisplayName } from "../data/users";
import { ForbiddenError, NotFoundError } from "../errors";
import { optionalStringOrNull } from "../http/body";
import { resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { serializeUser } from "../serialize/resource";
import { readAttributes, readJsonObject } from "./shared";

export const users = new Hono<AppBindings>();

/** These endpoints require a session credential (an API key has no user). */
function requireUser(userId: string | null): string {
  if (userId === null) {
    throw new ForbiddenError("This endpoint requires a session credential, not an API key.");
  }
  return userId;
}

users.get("/current", requireAuth, async (c) => {
  const userId = requireUser(getAuth(c).user_id);
  const row = await getUserById(c.env.DB, userId);
  if (!row) throw new NotFoundError();
  return resourceResponse(serializeUser(row));
});

users.put("/current", requireAuth, async (c) => {
  const userId = requireUser(getAuth(c).user_id);
  const attrs = await readAttributes(c);
  const displayName = optionalStringOrNull(attrs, "display_name") ?? null;
  await updateUserDisplayName(c.env.DB, userId, displayName);
  const row = await getUserById(c.env.DB, userId);
  if (!row) throw new NotFoundError();
  return resourceResponse(serializeUser(row));
});

// ── Settings ── the current user's per-account UI preferences (e.g. console theme). An opaque JSON
// bag the client owns, stored on the account_user membership. Plain application/json (not JSON:API):
// there is no id/type here, just a preferences object. Requires a session credential (an API key has
// no user, so no personal preferences).
users.get("/current/settings", requireAuth, async (c) => {
  const auth = getAuth(c);
  const userId = requireUser(auth.user_id);
  return c.json(await getMembershipSettings(c.env.DB, auth.account_id, userId));
});

users.put("/current/settings", requireAuth, async (c) => {
  const auth = getAuth(c);
  const userId = requireUser(auth.user_id);
  const body = await readJsonObject(c);
  return c.json(await putMembershipSettings(c.env.DB, auth.account_id, userId, body));
});
