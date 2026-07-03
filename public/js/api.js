"use strict";

// Shared client for the smplmark console: token storage + fetch helpers.
// Auth endpoints (/api/v1/auth/*) speak application/json; the JSON:API resource
// endpoints speak application/vnd.api+json with {data:{type,attributes}} bodies.

const TOKEN_KEY = "smplmark_token";

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
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_e) {
    /* ignore storage errors */
  }
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
    clearToken();
    location.href = "/login";
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

// Redirect to /login if there is no stored token. Returns the token when present.
function requireAuth() {
  const token = getToken();
  if (!token) {
    location.href = "/login";
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
