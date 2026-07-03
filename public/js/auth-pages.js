"use strict";

// Logic for /login, /signup, /auth/callback, /verify-email, and /accept-invitation. Each page
// includes this file; behavior is chosen by which elements are present.
// Depends on api.js (getToken/setToken/clearToken/apiFetch/authFetch/esc/jsonapiBody).

const INVITE_KEY = "smplmark_invite";

function showFormError(msg) {
  const box = document.getElementById("form-error");
  if (box) {
    box.textContent = msg || "";
    box.style.display = msg ? "block" : "none";
  }
}

// ── Pending-invitation token (survives the OIDC round-trip via localStorage) ──
function storeInviteToken() {
  const t = new URLSearchParams(location.search).get("invitation_token");
  if (t) { try { localStorage.setItem(INVITE_KEY, t); } catch (_e) {} }
}
function getInviteToken() {
  const url = new URLSearchParams(location.search).get("invitation_token");
  if (url) return url;
  try { return localStorage.getItem(INVITE_KEY); } catch (_e) { return null; }
}
function clearInviteToken() {
  try { localStorage.removeItem(INVITE_KEY); } catch (_e) {}
}

// After auth, go complete a pending invitation, else the dashboard.
function postAuthDest() {
  const t = getInviteToken();
  return t ? "/accept-invitation?token=" + encodeURIComponent(t) : "/account";
}
function goDashboard() {
  location.href = postAuthDest();
}

// ── OIDC full-page navigation (NOT fetch) ──
function wireOidcButtons() {
  const g = document.getElementById("oidc-google");
  if (g) g.addEventListener("click", () => { storeInviteToken(); location.href = "/api/v1/auth/oidc/google"; });
  const m = document.getElementById("oidc-microsoft");
  if (m) m.addEventListener("click", () => { storeInviteToken(); location.href = "/api/v1/auth/oidc/microsoft"; });
}

// ── Password reveal toggles ──
function wireRevealToggles() {
  document.querySelectorAll(".fieldRevealToggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.reveal);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
    });
  });
}

// ── Password strength meter (signup) ──
function passwordStrength(password) {
  if (!password) return { level: "weak", label: "" };
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (score <= 2) return { level: "weak", label: "Weak" };
  if (score <= 4) return { level: "medium", label: "Medium" };
  return { level: "strong", label: "Strong" };
}
function wireStrengthMeter() {
  const wrap = document.getElementById("password-strength");
  const fill = document.getElementById("strength-fill");
  const label = document.getElementById("strength-label");
  const input = document.getElementById("password");
  if (!wrap || !fill || !label || !input) return;
  input.addEventListener("input", () => {
    const pw = input.value;
    if (!pw) { wrap.style.display = "none"; return; }
    wrap.style.display = "flex";
    const s = passwordStrength(pw);
    fill.className = "passwordStrengthFill is-" + s.level;
    label.className = "passwordStrengthLabel is-" + s.level;
    label.textContent = s.label;
  });
}

// ── Invitation preview banner (login/signup) ──
async function wireInvitationPreview() {
  const card = document.querySelector(".authCard");
  const token = new URLSearchParams(location.search).get("invitation_token");
  if (!card || !token) return;
  storeInviteToken();
  let inv;
  try {
    const doc = await apiFetch(
      "/api/v1/invitations?filter[token]=" + encodeURIComponent(token),
      { auth: false },
    );
    inv = doc && doc.data && doc.data[0] && doc.data[0].attributes;
  } catch (_e) { return; }
  if (!inv) return;

  const banner = document.createElement("div");
  banner.className = "authBanner";
  const status = String(inv.status || "");
  if (status === "PENDING") {
    const inviter = inv.invited_by_name || "Someone";
    const account = inv.account_name || "an account";
    banner.innerHTML =
      "<strong>" + esc(inviter) + "</strong> invited <strong>" + esc(inv.email) +
      "</strong> to join <strong>" + esc(account) + "</strong> as a <strong>" +
      esc(String(inv.role).toLowerCase()) + "</strong>. Sign in as <strong>" + esc(inv.email) +
      "</strong> to accept.";
  } else {
    banner.className = "authBanner is-stale";
    banner.textContent =
      status === "ACCEPTED" ? "This invitation has already been accepted."
        : status === "REVOKED" ? "This invitation has been revoked."
          : status === "EXPIRED" ? "This invitation has expired."
            : "This invitation is no longer valid.";
    clearInviteToken();
  }
  const header = card.querySelector(".authCardHeader");
  if (header && header.nextSibling) card.insertBefore(banner, header.nextSibling);
  else card.appendChild(banner);
}

// ── Login page ──
function wireLogin() {
  const form = document.getElementById("login-form");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showFormError("");
    const btn = form.querySelector('button[type="submit"]');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (btn) btn.disabled = true;
    try {
      const doc = await authFetch("/api/v1/auth/login", { email, password });
      if (!doc || !doc.token) throw new Error("No session token returned.");
      setToken(doc.token);
      goDashboard();
    } catch (err) {
      showFormError(err.message);
      if (btn) btn.disabled = false;
    }
  });
}

// ── Signup page ──
function wireSignup() {
  const form = document.getElementById("signup-form");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showFormError("");
    const btn = form.querySelector('button[type="submit"]');
    const email = form.email.value.trim();
    const password = form.password.value;
    const displayName = form.display_name.value.trim();
    const body = { email, password };
    if (displayName) body.display_name = displayName;
    if (btn) btn.disabled = true;
    try {
      const doc = await authFetch("/api/v1/auth/register", body);
      if (!doc || !doc.token) throw new Error("No session token returned.");
      setToken(doc.token);
      goDashboard();
    } catch (err) {
      showFormError(err.message);
      if (btn) btn.disabled = false;
    }
  });
}

// ── OIDC callback page (/auth/callback) ──
function handleCallback() {
  const root = document.getElementById("callback-root");
  if (!root) return;
  const hash = (location.hash || "").replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  if (token) {
    setToken(token);
    location.href = postAuthDest();
  } else {
    location.href = "/login";
  }
}

// ── Verify-email page (/verify-email?token=...) ──
async function handleVerifyEmail() {
  const root = document.getElementById("verify-root");
  if (!root) return;
  const title = document.getElementById("verify-title");
  const body = document.getElementById("verify-body");
  const cta = document.getElementById("verify-cta");
  const token = new URLSearchParams(location.search).get("token");
  if (!token) {
    title.textContent = "Invalid link";
    body.textContent = "This verification link is missing its token.";
    return;
  }
  try {
    await authFetch("/api/v1/auth/verify-email", { token });
    title.textContent = "Email verified";
    body.textContent = "Thanks — your email is confirmed. You can now publish benchmarks.";
    cta.href = getToken() ? "/account" : "/login";
    cta.textContent = getToken() ? "Go to dashboard" : "Sign in";
    cta.style.display = "";
  } catch (err) {
    title.textContent = "Verification failed";
    body.textContent = err.message || "This link is invalid or has expired. Request a new one from your dashboard.";
    cta.href = "/account";
    cta.textContent = "Go to dashboard";
    cta.style.display = getToken() ? "" : "none";
  }
}

// ── Accept-invitation page (/accept-invitation?token=...) ──
async function handleAcceptInvitation() {
  const root = document.getElementById("accept-root");
  if (!root) return;
  const title = document.getElementById("accept-title");
  const body = document.getElementById("accept-body");
  const cta = document.getElementById("accept-cta");
  const token = new URLSearchParams(location.search).get("token");
  if (!token) {
    title.textContent = "Invalid link";
    body.textContent = "This invitation link is missing its token.";
    return;
  }
  // Not signed in → route through login carrying the token.
  if (!getToken()) {
    location.href = "/login?invitation_token=" + encodeURIComponent(token);
    return;
  }
  try {
    const doc = await apiFetch("/api/v1/invitations/accept", {
      method: "POST",
      body: jsonapiBody("invitation", { token }),
    });
    const accountId = doc && doc.data && doc.data.attributes && doc.data.attributes.account;
    if (accountId) {
      try {
        const s = await authFetch("/api/v1/auth/switch", { account_id: accountId });
        if (s && s.token) setToken(s.token);
      } catch (_e) { /* stay on current session if switch fails */ }
    }
    clearInviteToken();
    title.textContent = "You're in!";
    body.textContent = "You've joined the account.";
    cta.style.display = "";
  } catch (err) {
    title.textContent = "Couldn't accept invitation";
    body.innerHTML = esc(err.message) +
      ' <a class="authTextLink" href="/login?invitation_token=' + encodeURIComponent(token) + '">Sign in as a different user</a>.';
  }
}

document.addEventListener("DOMContentLoaded", function () {
  // If already signed in, skip login/signup (unless completing an invitation).
  if ((document.getElementById("login-form") || document.getElementById("signup-form")) && getToken() && !getInviteToken()) {
    goDashboard();
    return;
  }
  wireOidcButtons();
  wireRevealToggles();
  wireStrengthMeter();
  wireInvitationPreview();
  wireLogin();
  wireSignup();
  handleCallback();
  handleVerifyEmail();
  handleAcceptInvitation();
});
