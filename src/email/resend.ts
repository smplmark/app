// Transactional email via Resend's REST API. Best-effort by contract (§15): a send failure never
// wedges the calling operation. When Resend is unconfigured (local/dev/tests), sends are silent
// no-ops returning false. All mail is sent from support@smplmark.org (overridable via RESEND_FROM).
import { SUPPORT_EMAIL, emailConfigured } from "../config";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = `smplmark <${SUPPORT_EMAIL}>`;
const ACCENT = "#4f8cff";
const TEXT = "#1f2328";
const MUTED = "#5b6570";

function fromAddress(env: Env): string {
  return env.RESEND_FROM ?? DEFAULT_FROM;
}

/** Escape a string for safe interpolation into email HTML. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Wrap body HTML in the branded smplmark scaffold. */
function scaffold(bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f8fa;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.55;color:${TEXT}">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d6dce4;border-radius:12px;padding:28px 32px">
<div style="font-weight:800;font-size:18px;letter-spacing:-0.02em;margin-bottom:20px">smpl<span style="color:${ACCENT}">mark</span></div>
${bodyHtml}
<hr style="border:none;border-top:1px solid #d6dce4;margin:24px 0 16px" />
<p style="color:${MUTED};font-size:12px;margin:0">smplmark — a public benchmark host. <a href="https://www.smplmark.org" style="color:${MUTED}">www.smplmark.org</a></p>
</div></body></html>`;
}

function ctaButton(text: string, url: string): string {
  return `<p><a href="${esc(url)}" style="display:inline-block;padding:11px 20px;background:${ACCENT};color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${esc(text)}</a></p>`;
}

/** Low-level send. Returns true on a 2xx, false on any failure / no-op. */
async function sendEmail(
  env: Env,
  input: { to: string; subject: string; html: string; text: string; replyTo?: string },
): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  try {
    const body: Record<string, unknown> = {
      from: fromAddress(env),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    };
    if (input.replyTo) body.reply_to = input.replyTo;
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

export async function sendVerificationEmail(
  env: Env,
  input: { to: string; verifyUrl: string; displayName: string | null },
): Promise<boolean> {
  const greeting = input.displayName ? `Hi ${esc(input.displayName)},` : "Hi,";
  const html = scaffold(
    `<p>${greeting}</p>
<p>Confirm your email to finish setting up your smplmark account and unlock publishing.</p>
${ctaButton("Verify email", input.verifyUrl)}
<p style="color:${MUTED};font-size:13px">Or paste this link into your browser:<br><a href="${esc(input.verifyUrl)}" style="color:${MUTED}">${esc(input.verifyUrl)}</a></p>
<p style="color:${MUTED};font-size:13px">This link expires in 24 hours. If you didn't create a smplmark account, you can ignore this email.</p>`,
  );
  const text = `Confirm your email to finish setting up your smplmark account.\n\n${input.verifyUrl}\n\nThis link expires in 24 hours. If you didn't create a smplmark account, you can ignore this email.`;
  return sendEmail(env, { to: input.to, subject: "Verify your smplmark email", html, text });
}

// ── Invitation ───────────────────────────────────────────────────────────────

export async function sendInvitationEmail(
  env: Env,
  input: {
    to: string;
    acceptUrl: string;
    accountName: string;
    inviterName: string | null;
    role: string;
  },
): Promise<boolean> {
  const inviter = input.inviterName ? esc(input.inviterName) : "Someone";
  const account = esc(input.accountName);
  const role = esc(input.role.toLowerCase());
  const html = scaffold(
    `<p>You've been invited to <strong>${account}</strong> on smplmark.</p>
<p>${inviter} has invited you to join <strong>${account}</strong> as a <strong>${role}</strong>. Sign in (or create an account) with <strong>${esc(input.to)}</strong> to accept.</p>
${ctaButton("Accept invitation", input.acceptUrl)}
<p style="color:${MUTED};font-size:13px">Or paste this link into your browser:<br><a href="${esc(input.acceptUrl)}" style="color:${MUTED}">${esc(input.acceptUrl)}</a></p>
<p style="color:${MUTED};font-size:13px">This invitation expires in 7 days.</p>`,
  );
  const text = `${input.inviterName ?? "Someone"} has invited you to join ${input.accountName} on smplmark as a ${input.role.toLowerCase()}.\n\nSign in with ${input.to} to accept:\n${input.acceptUrl}\n\nThis invitation expires in 7 days.`;
  return sendEmail(env, {
    to: input.to,
    subject: `You've been invited to ${input.accountName} on smplmark`,
    html,
    text,
  });
}

// ── Contact Us (support ticket + user auto-response) ─────────────────────────

export async function sendContactSupportEmail(
  env: Env,
  input: {
    fromUserEmail: string;
    userName: string | null;
    accountName: string;
    accountId: string;
    userId: string | null;
    topicLabel: string;
    message: string;
  },
): Promise<boolean> {
  const rows = [
    ["From", `${input.userName ?? "(no name)"} <${input.fromUserEmail}>`],
    ["Account", input.accountName],
    ["Account ID", input.accountId],
    ["User ID", input.userId ?? "(none)"],
    ["Topic", input.topicLabel],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:${MUTED}">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`,
    )
    .join("");
  const html = scaffold(
    `<p><strong>New contact request</strong></p>
<table style="font-size:14px;border-collapse:collapse;margin-bottom:12px">${rows}</table>
<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #d6dce4;background:#f6f8fa;white-space:pre-wrap">${esc(input.message)}</blockquote>
<p style="color:${MUTED};font-size:13px">Reply to this email to respond directly to the sender.</p>`,
  );
  const text = `New contact request\n\nFrom: ${input.userName ?? "(no name)"} <${input.fromUserEmail}>\nAccount: ${input.accountName} (${input.accountId})\nUser ID: ${input.userId ?? "(none)"}\nTopic: ${input.topicLabel}\n\n${input.message}`;
  return sendEmail(env, {
    to: SUPPORT_EMAIL,
    subject: `${input.accountName} — ${input.topicLabel}`,
    html,
    text,
    replyTo: input.fromUserEmail,
  });
}

export async function sendContactAutoresponse(
  env: Env,
  input: { to: string; firstName: string | null; topicLabel: string; message: string },
): Promise<boolean> {
  const greeting = input.firstName ? `Hi ${esc(input.firstName)},` : "Hi,";
  const html = scaffold(
    `<p>${greeting}</p>
<p>Thanks for reaching out to smplmark. We've received your message and someone will be in touch as soon as possible.</p>
<p>If you need to add anything, just reply to this email.</p>
<p style="color:${MUTED};font-size:13px">— The smplmark team</p>
<hr style="border:none;border-top:1px solid #d6dce4;margin:16px 0" />
<p style="color:${MUTED};font-size:13px;margin:0 0 6px">Your message (${esc(input.topicLabel)}):</p>
<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #d6dce4;background:#f6f8fa;white-space:pre-wrap;color:${MUTED}">${esc(input.message)}</blockquote>`,
  );
  const text = `${input.firstName ? `Hi ${input.firstName},` : "Hi,"}\n\nThanks for reaching out to smplmark. We've received your message and someone will be in touch as soon as possible. If you need to add anything, just reply to this email.\n\n— The smplmark team\n\nYour message (${input.topicLabel}):\n${input.message}`;
  return sendEmail(env, {
    to: input.to,
    subject: `Re: your smplmark message — ${input.topicLabel}`,
    html,
    text,
    replyTo: SUPPORT_EMAIL,
  });
}
