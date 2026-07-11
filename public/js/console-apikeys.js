"use strict";

// API Keys (/account/api-keys) — a conforming list page: search + refresh toolbar above the table,
// a contextual empty state, a strict create modal with a one-time key reveal, and inline confirms for
// rotate / revoke. Admins manage keys; everyone can view. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let CAN_ADMIN = false;
  let ALL = [];
  let SEARCH = "";

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function flash(text, kind) { setStatus($("keys-msg"), text, kind || "error"); }

  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    const attrs = (id.user && id.user.attributes) || {};
    if (attrs.verified === false) wireVerifyBanner();
    load();
  }).catch(() => {
    $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  function wireVerifyBanner() {
    const banner = $("verify-banner");
    banner.style.display = "flex";
    const btn = $("resend-verification");
    const msg = $("verify-msg");
    btn.addEventListener("click", async () => {
      setStatus(msg, "");
      btn.disabled = true;
      try {
        await authFetch("/api/v1/auth/resend-verification", undefined, { method: "POST" });
        setStatus(msg, "Verification email sent.", "success");
      } catch (err) { setStatus(msg, err.message, "error"); }
      finally { btn.disabled = false; }
    });
  }

  function wireTopBar() {
    if (!CAN_ADMIN) { SM.setTopBarAction(""); return; }
    SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-key">' + SM.icon("plus", 16) + " Create API key</button>");
    $("new-key").addEventListener("click", openCreateModal);
  }

  async function load() {
    try {
      const doc = await apiFetch("/api/v1/api_keys");
      ALL = (doc && doc.data) || [];
      ALL.sort((a, z) => {
        const aa = a.attributes || {}, za = z.attributes || {};
        if (!!aa.revoked !== !!za.revoked) return aa.revoked ? 1 : -1; // active first
        return String(aa.name || "").localeCompare(String(za.name || ""));
      });
      render();
    } catch (err) {
      $("keys-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function filtered() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((k) => {
      const a = k.attributes || {};
      return (a.name || "").toLowerCase().includes(q) ||
        (a.prefix || "").toLowerCase().includes(q) ||
        (a.scope_type || "").toLowerCase().includes(q) ||
        (a.scope_ref || "").toLowerCase().includes(q);
    });
  }

  function render() {
    const host = $("keys-content");
    // Truly-empty first visit: the create-your-first hero stands alone (no toolbar, no top-bar dup).
    if (!ALL.length && !SEARCH.trim()) {
      SM.setTopBarAction("");
      host.innerHTML =
        '<div class="emptyState"><div class="emptyIcon">' + SM.icon("apikeys", 44) + "</div>" +
        "<h2>No API keys yet</h2><p>Create a key to upload observations from CI or manage your account programmatically.</p>" +
        (CAN_ADMIN ? '<button type="button" class="button buttonPrimary" id="empty-create">Create API key</button>' : "") + "</div>";
      const b = $("empty-create"); if (b) b.addEventListener("click", openCreateModal);
      return;
    }
    wireTopBar();
    host.innerHTML =
      '<div id="keys-toolbar-mount"></div>' +
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable">' +
      '<thead><tr><th>Name</th><th>Key</th><th>Scope</th><th>Status</th><th class="actions"></th></tr></thead>' +
      '<tbody id="keys-body"></tbody></table></div></div>' +
      '<div id="keys-msg" class="form-status"></div>';
    const bar = SM.toolbar({ placeholder: "Search keys…", onSearch: (v) => { SEARCH = v; renderRows(); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("keys-toolbar-mount").replaceWith(bar);
    renderRows();
  }

  function renderRows() {
    const body = $("keys-body");
    if (!body) return;
    const rows = filtered();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="dataTableEmpty">No matching keys.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(rowHtml).join("");
    body.querySelectorAll(".key-rotate").forEach((el) => el.addEventListener("click", () => rotateKey(el.dataset.id, el.dataset.name)));
    body.querySelectorAll(".key-revoke").forEach((el) => el.addEventListener("click", () => revokeKey(el.dataset.id, el.dataset.name)));
  }

  function rowHtml(k) {
    const a = k.attributes || {};
    const id = esc(k.id);
    const name = esc(a.name || "");
    const scope = esc(a.scope_type || "") + (a.scope_ref ? ' <span class="muted">' + esc(a.scope_ref) + "</span>" : "");
    const state = a.revoked ? SM.statusPill("revoked", "revoked") : SM.statusPill("active", "active");
    let acts = "";
    if (!a.revoked && CAN_ADMIN) {
      acts =
        '<button type="button" class="button buttonSecondary buttonSmall key-rotate" data-id="' + id + '" data-name="' + name + '">Rotate</button>' +
        '<button type="button" class="button buttonDanger buttonSmall key-revoke" data-id="' + id + '" data-name="' + name + '">Revoke</button>';
    }
    return (
      "<tr><td><strong>" + name + "</strong></td>" +
      "<td><code>" + esc(a.prefix || "") + "…</code></td>" +
      "<td>" + scope + "</td>" +
      "<td>" + state + "</td>" +
      '<td class="actions">' + acts + "</td></tr>"
    );
  }

  // ── Create modal (strict, per-field validation; on success the key is revealed once) ──
  function openCreateModal() {
    const bodyHtml =
      '<form class="form" id="create-key-form">' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="CI upload key" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Scope type</span><select name="scope_type">' +
      '<option value="ACCOUNT">Account — full access to your account</option>' +
      '<option value="BENCHMARK">Benchmark — one benchmark</option>' +
      '<option value="RUN">Run — one run (beacon uploads)</option>' +
      "</select></label>" +
      '<label class="field"><span class="detailFieldLabel">Scope reference</span><input name="scope_ref" type="text" placeholder="benchmark / run id (optional)" /></label>' +
      '<p class="form-status" id="create-key-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Create key</button></div></form>';
    const m = SM.modal({ title: "Create API key", description: "Generate a new key for uploading observations or managing your account.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#create-key-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = m.panel.querySelector("#create-key-msg"); setStatus(msg, "");
      SM.clearFieldError(f.name);
      if (!f.name.value.trim()) { SM.setFieldError(f.name, "A name is required."); f.name.focus(); return; }
      const attrs = { name: f.name.value.trim(), scope_type: f.scope_type.value };
      const ref = f.scope_ref.value.trim(); if (ref) attrs.scope_ref = ref;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/api_keys", { method: "POST", body: jsonapiBody("api_key", attrs) });
        const created = doc && doc.data && doc.data.attributes;
        await load();
        m.close();
        if (created && created.key) showReveal(created.key, "API key created");
      } catch (err) { submit.disabled = false; setStatus(msg, err.message, "error"); }
    });
    f.name.addEventListener("input", () => SM.clearFieldError(f.name));
  }

  // ── One-time reveal of a plaintext key (from create or rotate) ──
  function showReveal(keyValue, title) {
    const m = SM.modal({
      title: title,
      description: "Copy this key now — it won't be shown again.",
      bodyHtml:
        '<div class="keyReveal"><code id="reveal-code"></code>' +
        '<button type="button" class="button buttonSecondary buttonSmall" id="reveal-copy">Copy</button></div>' +
        '<div class="modalActions" style="margin-top:1rem;"><button type="button" class="button buttonPrimary buttonSmall" data-close>Done</button></div>',
    });
    m.panel.querySelector("#reveal-code").textContent = keyValue;
    const copyBtn = m.panel.querySelector("#reveal-copy");
    copyBtn.addEventListener("click", () => {
      SM.copyText(keyValue).then(() => { copyBtn.textContent = "Copied"; }, () => { copyBtn.textContent = "Copy failed"; });
    });
  }

  async function rotateKey(id, name) {
    const ok = await SM.confirm({
      title: "Rotate this key?",
      message: "The current value for <strong>" + esc(name) + "</strong> stops working immediately and a new value is issued.",
      confirmLabel: "Rotate key",
      danger: false,
    });
    if (!ok) return;
    try {
      const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(id) + "/actions/rotate", { method: "POST" });
      const rotated = doc && doc.data && doc.data.attributes;
      await load();
      if (rotated && rotated.key) showReveal(rotated.key, "Rotated API key");
    } catch (err) { flash(err.message); }
  }

  async function revokeKey(id, name) {
    const ok = await SM.confirm({
      title: "Revoke this key?",
      message: "This permanently disables <strong>" + esc(name) + "</strong>. This cannot be undone.",
      confirmLabel: "Revoke key",
    });
    if (!ok) return;
    try {
      await apiFetch("/api/v1/api_keys/" + encodeURIComponent(id), { method: "DELETE" });
      await load();
    } catch (err) { flash(err.message); }
  }
})();
