import { Hono } from "hono";
import { getUserById, updateUserDisplayName } from "../data/users";
import { ForbiddenError, NotFoundError } from "../errors";
import { optionalStringOrNull } from "../http/body";
import { resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { serializeUser } from "../serialize/resource";
import { readAttributes } from "./shared";

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
