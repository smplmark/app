// Contact Us. A signed-in member submits a topic + message; we email a support ticket to
// support@smplmark.org (reply-to the sender) and an auto-response to the sender. Nothing is
// persisted — the id is a per-request correlation id. Mirrors smplkit's POST /emails.
import { Hono } from "hono";
import { emailConfigured } from "../config";
import { getAccountById } from "../data/accounts";
import { getUserById } from "../data/users";
import { sendContactAutoresponse, sendContactSupportEmail } from "../email/resend";
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from "../errors";
import { requireString } from "../http/body";
import { resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { rateLimit } from "../http/ratelimit";
import { readAttributes } from "./shared";

const TOPICS: Record<string, string> = {
  technical: "Technical support",
  account: "Account question",
  feature_request: "Feature request",
  other: "Other",
};

const MAX_BODY = 10_000;

export const emails = new Hono<AppBindings>();

emails.post("/", requireAuth, rateLimit((e) => e.RL_SENSITIVE), async (c) => {
  const auth = getAuth(c);
  if (!auth.user_id) {
    throw new ForbiddenError("Contacting support requires a session credential.");
  }
  const attrs = await readAttributes(c);
  const topic = typeof attrs.topic === "string" && attrs.topic in TOPICS ? attrs.topic : "other";
  const message = requireString(attrs, "body");
  if (message.length > MAX_BODY) {
    throw new BadRequestError(`body must be at most ${MAX_BODY} characters.`, {
      pointer: "/data/attributes/body",
    });
  }
  if (!emailConfigured(c.env)) {
    throw new ServiceUnavailableError(
      "Messaging is not available right now. Please email support@smplmark.org directly.",
    );
  }

  const user = await getUserById(c.env.DB, auth.user_id);
  const account = await getAccountById(c.env.DB, auth.account_id);
  const topicLabel = TOPICS[topic];

  await sendContactSupportEmail(c.env, {
    fromUserEmail: user ? user.email : "unknown",
    userName: user ? user.display_name : null,
    accountName: account ? account.name : "unknown",
    accountId: auth.account_id,
    userId: auth.user_id,
    topicLabel,
    message,
  });
  await sendContactAutoresponse(c.env, {
    to: user ? user.email : "unknown",
    firstName: user && user.display_name ? user.display_name.split(/\s+/)[0] : null,
    topicLabel,
    message,
  });

  return resourceResponse(
    {
      type: "email",
      id: crypto.randomUUID(),
      attributes: { topic, sent_at: new Date().toISOString() },
    },
    { status: 201 },
  );
});
