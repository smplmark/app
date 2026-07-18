"use strict";

// Shared client for the smplmark console: token storage + fetch helpers.
// Auth endpoints (/api/v1/auth/*) speak application/json; the JSON:API resource
// endpoints speak application/vnd.api+json with {data:{type,attributes}} bodies.

const TOKEN_KEY = "smplmark_token";

// ── Stale-while-revalidate cache (sessionStorage) ──
// A tiny, defensive cache for the cheap-to-recompute per-page-load bootstrap data (identity + theme
// settings). Values are stored as { value, ts }; a read returns the value plus its age so the caller
// can decide freshness against a short TTL and always revalidate in the background. Every sessionStorage
// access is wrapped — private mode, quota, or disabled storage degrade to a cache miss, never an error.
// Keys are namespaced so a single clear (on sign-out / token change) removes every cached entry.
const SWR_PREFIX = "smplmark.swr:";

function swrGet(key) {
  try {
    const raw = sessionStorage.getItem(SWR_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts !== "number") return null;
    return { value: parsed.value, age: Date.now() - parsed.ts };
  } catch (_e) {
    return null;
  }
}

function swrSet(key, value) {
  try {
    sessionStorage.setItem(SWR_PREFIX + key, JSON.stringify({ value: value, ts: Date.now() }));
  } catch (_e) {
    /* private mode / quota / disabled storage — skip caching; callers still revalidate from network */
  }
}

// Drop every SWR entry. Called whenever the active credential changes (sign-in, sign-out, account
// switch) so a cached identity/theme can never outlive the token it was scoped to.
function swrClearAll() {
  try {
    const doomed = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf(SWR_PREFIX) === 0) doomed.push(k);
    }
    doomed.forEach((k) => { try { sessionStorage.removeItem(k); } catch (_e) {} });
  } catch (_e) {
    /* ignore — storage unavailable */
  }
}

// A compact, non-cryptographic hash (FNV-1a, 32-bit) of the bearer token. Used only to derive an
// auth-scoped cache key so entries for one token can never be read under another; it is NOT a security
// boundary (the token itself gates the API). A collision is astronomically unlikely for our inputs and,
// if one ever occurred, the background revalidation would correct the view within the TTL.
function hashToken(token) {
  const s = String(token == null ? "" : token);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (_e) {
    return null;
  }
}

function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (_e) {
    /* ignore storage errors */
  }
  // The active credential is changing (login, register, OIDC, account switch, invitation-accept
  // switch). Drop any cached identity/theme so the next page load can't render a prior session's
  // bootstrap — the auth-scoped key already prevents a cross-token read, this also frees the entries.
  swrClearAll();
  writeAuthedCookie(true);
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_e) {
    /* ignore storage errors */
  }
  // Sign-out / 401 / missing-token guard — wipe the cached identity + theme along with the token.
  swrClearAll();
  writeAuthedCookie(false);
}

// A non-sensitive "signed in" hint so the Worker can serve the console (not login) at the root with no
// client-side redirect — the URL stays app.smplmark.org for both signed-in and signed-out visitors.
// The real credential is the localStorage token sent as a Bearer header; this cookie grants nothing on
// its own. A forged cookie only yields the console page, which then finds no valid token and falls
// back to login. Kept in sync with the token here so login/OIDC/logout/401 all update both at once.
function writeAuthedCookie(on) {
  try {
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = on
      ? "sm_authed=1; path=/; max-age=604800; SameSite=Lax" + secure
      : "sm_authed=; path=/; max-age=0; SameSite=Lax" + secure;
  } catch (_e) {
    /* ignore cookie errors */
  }
}

// Clear the session and return to the sign-in view, which lives at the root: the Worker serves login
// at "/" when there's no sm_authed cookie. Used for logout, 401s, the missing-token guard, and auth
// errors, so the URL stays app.smplmark.org with no /login path. Clearing the token + cookie first is
// what keeps "/" showing login instead of bouncing back to the console with a stale cookie.
function signOutToRoot() {
  clearToken();
  location.href = "/";
}

// Escape a value for safe insertion into innerHTML. Use everywhere API/user
// data is rendered as HTML.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c],
  );
}

// Build a JSON:API request body.
function jsonapiBody(type, attributes) {
  return { data: { type, attributes } };
}

// Extract a human-facing message from an error response body.
function errorDetail(doc, fallback) {
  if (doc && Array.isArray(doc.errors) && doc.errors.length) {
    const e = doc.errors[0];
    return e.detail || e.title || fallback;
  }
  return fallback;
}

// Core fetch wrapper.
//   path    — same-origin path, e.g. "/api/v1/benchmarks"
//   options.method   — HTTP verb (default GET)
//   options.body     — object; serialized to JSON
//   options.auth     — attach bearer token (default true)
//   options.json     — use application/json instead of vnd.api+json (default false)
// Throws Error(detail) on non-2xx (after handling 401). Returns parsed JSON,
// or null for 204/empty bodies.
async function apiFetch(path, options) {
  const opts = options || {};
  const method = opts.method || "GET";
  const useJson = opts.json === true;
  const auth = opts.auth !== false;
  const contentType = useJson
    ? "application/json"
    : "application/vnd.api+json";

  const headers = { Accept: contentType };
  if (opts.body !== undefined) headers["Content-Type"] = contentType;

  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }

  const init = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(path, init);

  if (res.status === 401) {
    signOutToRoot();
    throw new Error("Your session has expired. Please sign in again.");
  }

  if (res.status === 204) return null;

  let doc = null;
  const text = await res.text();
  if (text) {
    try {
      doc = JSON.parse(text);
    } catch (_e) {
      doc = null;
    }
  }

  if (!res.ok) {
    throw new Error(errorDetail(doc, "Request failed (HTTP " + res.status + ")"));
  }

  return doc;
}

// Convenience wrapper for the application/json auth endpoints.
function authFetch(path, body, opts) {
  const o = opts || {};
  return apiFetch(path, {
    method: o.method || "POST",
    body,
    json: true,
    auth: o.auth !== false ? o.auth : false,
  });
}

// Return the stored token, or send the visitor to the root sign-in view when there is none.
function requireAuth() {
  const token = getToken();
  if (!token) {
    signOutToRoot();
    return null;
  }
  return token;
}

// Decode the payload of a JWT (no signature verification — client convenience only,
// used to read account_id/user_id without an extra round trip). Returns {} on failure.
function decodeJwt(token) {
  try {
    const part = token.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const json = atob(b64 + pad);
    return JSON.parse(json);
  } catch (_e) {
    return {};
  }
}
