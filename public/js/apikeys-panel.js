"use strict";

// Shared API-keys panel — one component rendered wherever keys are managed: Settings › API Keys
// (ACCOUNT scope), a benchmark's API Keys tab (BENCHMARK scope), and a run's API Keys tab (RUN scope).
// The scope is fixed by where the panel is mounted, so creating a key never asks the user to pick a
// scope or type an id — it's implicit. Depends on api.js + shell.js (SM helpers).
//
// Usage: SMApiKeys.mount({ host, actions, scopeType, scopeRef, canAdmin })
//   host      — element the list/table renders into
//   actions   — element the "Create key" button renders into (e.g. a tab-actions bar); optional
//   scopeType — "ACCOUNT" | "BENCHMARK" | "RUN"
//   scopeRef  — the benchmark/run id (null for ACCOUNT)
//   canAdmin  — whether create/manage affordances show

(function () {
  const esc = SM.esc;
  const PAGE_SIZE = 20;

  const COPY = {
    ACCOUNT: {
      empty: "Create a key to upload measurements from CI or manage your account programmatically.",
      createDesc: "This key has full access to your account.",
    },
    BENCHMARK: {
      empty: "Create a key scoped to this benchmark — it can read and write this benchmark and its runs.",
      createDesc: "This key is scoped to this benchmark and its runs — nothing else in your account.",
    },
    RUN: {
      empty: "Create a key scoped to this run.",
      createDesc: "This key is scoped to this run — it can upload measurements here and nothing else.",
    },
  };

  function fmtDate(iso) { return SM.fmtDate(iso) || "—"; }
  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  // ── Plaintext reveal after create/rotate (the key stays viewable anytime from its details page) ──
  function showReveal(keyValue) {
    const m = SM.modal({
      title: "API key created",
      description: "Copy it below, or view it anytime from the key’s details.",
      width: 640,
      bodyHtml:
        '<div class="keyReveal"><code id="apikeys-reveal-code"></code>' +
        '<button type="button" class="button buttonSecondary buttonSmall" id="apikeys-reveal-copy">Copy</button></div>' +
        '<div class="modalActions" style="margin-top:1rem;"><button type="button" class="button buttonPrimary buttonSmall" data-close>Done</button></div>',
    });
    m.panel.querySelector("#apikeys-reveal-code").textContent = keyValue;
    const copyBtn = m.panel.querySelector("#apikeys-reveal-copy");
    copyBtn.addEventListener("click", () => SM.copyText(keyValue).then(() => { copyBtn.textContent = "Copied"; }, () => { copyBtn.textContent = "Copy failed"; }));
  }

  function mount(opts) {
    const host = opts.host;
    const actionsEl = opts.actions || null;
    const scopeType = opts.scopeType;
    const scopeRef = opts.scopeRef || null;
    const canAdmin = opts.canAdmin === true;
    const compact = opts.compact === true; // inside a modal: plain-line empty state, no hero block
    const copy = COPY[scopeType] || COPY.ACCOUNT;

    let ALL = [];
    let PAGE = 1;

    const listUrl =
      "/api/v1/api_keys?filter[scope_type]=" + encodeURIComponent(scopeType) +
      (scopeRef ? "&filter[scope_ref]=" + encodeURIComponent(scopeRef) : "");

    if (actionsEl) actionsEl.innerHTML = "";
    host.innerHTML = '<p class="muted">Loading…</p>';
    load();

    async function load() {
      try {
        const doc = await apiFetch(listUrl);
        ALL = ((doc && doc.data) || []).slice().sort((a, z) => {
          const aa = a.attributes || {}, za = z.attributes || {};
          if (!!aa.revoked !== !!za.revoked) return aa.revoked ? 1 : -1; // active first
          return String(aa.name || "").localeCompare(String(za.name || ""));
        });
        render();
      } catch (err) {
        host.innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
      }
    }

    function renderCreateAction() {
      if (!actionsEl) return;
      actionsEl.innerHTML = canAdmin
        ? '<button type="button" class="button buttonPrimary buttonSmall" data-apikeys-create>Create key</button>'
        : "";
      const b = actionsEl.querySelector("[data-apikeys-create]");
      if (b) b.addEventListener("click", openCreateModal);
    }

    function render() {
      renderCreateAction();
      if (!ALL.length) {
        host.innerHTML = compact
          ? '<p class="muted" style="margin:0.25rem 0 0;">No API keys yet. ' + esc(copy.empty) + "</p>"
          : '<div class="emptyState"><div class="emptyIcon">' + SM.icon("apikeys", 40) + "</div>" +
            "<h2>No API keys yet</h2><p>" + esc(copy.empty) + "</p>" +
            (canAdmin ? '<button type="button" class="button buttonPrimary" data-apikeys-create-empty>Create key</button>' : "") + "</div>";
        const b = host.querySelector("[data-apikeys-create-empty]");
        if (b) b.addEventListener("click", openCreateModal);
        return;
      }
      host.innerHTML =
        '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable">' +
        '<thead><tr><th>Name</th><th>Key</th><th>Status</th><th>Created</th>' + (canAdmin ? '<th class="actions"></th>' : "") + "</tr></thead>" +
        '<tbody data-apikeys-body></tbody></table></div><div data-apikeys-footer></div></div>';
      renderRows();
    }

    function renderRows() {
      const body = host.querySelector("[data-apikeys-body]");
      if (!body) return;
      const rows = ALL;
      const total = rows.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      PAGE = Math.min(Math.max(1, PAGE), pages);
      const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);
      body.innerHTML = total ? pageRows.map(rowHtml).join("") : '<tr><td colspan="' + (canAdmin ? 5 : 4) + '" class="dataTableEmpty">No keys.</td></tr>';

      body.querySelectorAll("tr.dataTableRowClickable").forEach((tr) => {
        tr.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-key-copy]") || ev.target.closest(".ak-row-del")) return;
          openKeyModal(tr.dataset.id);
        });
      });
      body.querySelectorAll("[data-key-copy]").forEach((el) =>
        el.addEventListener("click", (ev) => { ev.stopPropagation(); copyKey(el.dataset.id, el); }));
      body.querySelectorAll(".ak-row-del").forEach((el) =>
        el.addEventListener("click", (ev) => { ev.stopPropagation(); deleteKeyRow(el.dataset.id, el.dataset.name); }));

      const start = total === 0 ? 0 : (PAGE - 1) * PAGE_SIZE + 1;
      const end = Math.min(total, PAGE * PAGE_SIZE);
      host.querySelector("[data-apikeys-footer]").innerHTML =
        '<div class="dataTableFooter"><span class="dataTableCount">Showing ' + start + "–" + end + " of " + total + "</span>" +
        '<div class="dataTablePager">' +
        '<button type="button" class="button buttonSecondary buttonSmall" data-page="prev"' + (PAGE <= 1 ? " disabled" : "") + ">Previous</button>" +
        '<button type="button" class="button buttonSecondary buttonSmall" data-page="next"' + (PAGE >= pages ? " disabled" : "") + ">Next</button></div></div>";
      const prev = host.querySelector('[data-page="prev"]');
      const next = host.querySelector('[data-page="next"]');
      if (prev) prev.addEventListener("click", () => { PAGE--; renderRows(); });
      if (next) next.addEventListener("click", () => { PAGE++; renderRows(); });
    }

    function rowHtml(k) {
      const a = k.attributes || {};
      const id = esc(k.id);
      const status = a.revoked ? SM.statusPill("revoked", "revoked") : SM.statusPill("active", "active");
      return (
        '<tr class="dataTableRowClickable" data-id="' + id + '">' +
        "<td><strong>" + esc(a.name || "") + "</strong></td>" +
        '<td class="keyCell"><code>' + esc(a.prefix || "") + "…</code>" +
        '<button type="button" class="buttonLink" data-key-copy data-id="' + id + '">Copy</button></td>' +
        "<td>" + status + "</td><td>" + esc(fmtDate(a.created_at)) + "</td>" +
        (canAdmin ? '<td class="actions"><button type="button" class="iconBtn ak-row-del" data-id="' + id + '" data-name="' + esc(a.name || "") + '" title="Delete key" aria-label="Delete key">' + SM.icon("trash", 15) + "</button></td>" : "") +
        "</tr>"
      );
    }

    async function deleteKeyRow(id, name) {
      const ok = await SM.confirm({ title: "Delete this key?", message: "This permanently removes <strong>" + esc(name || "") + "</strong>. This cannot be undone.", confirmLabel: "Delete key" });
      if (!ok) return;
      try { await apiFetch("/api/v1/api_keys/" + encodeURIComponent(id), { method: "DELETE" }); load(); }
      catch (err) { SM.toast(err.message, { kind: "error" }); }
    }

    async function copyKey(id, btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(id));
        const key = doc && doc.data && doc.data.attributes && doc.data.attributes.key;
        if (!key) throw new Error("Key unavailable");
        await SM.copyText(key);
        btn.textContent = "Copied";
      } catch (_e) { btn.textContent = "Copy failed"; }
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }

    // ── Create modal — name only; scope is implicit from where this panel is mounted. ──
    function openCreateModal() {
      const bodyHtml =
        '<form class="form" id="apikeys-create-form" novalidate>' +
        '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="CI upload key" autocomplete="off" /><p class="fieldErrorMessage" hidden></p></label>' +
        '<p class="form-status" id="apikeys-create-msg"></p>' +
        '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
        '<button type="submit" class="button buttonPrimary buttonSmall">Create key</button></div></form>';
      const m = SM.modal({ title: "Create API key", description: copy.createDesc, bodyHtml: bodyHtml });
      const f = m.panel.querySelector("#apikeys-create-form");
      f.name.addEventListener("input", () => SM.clearFieldError(f.name));
      f.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const msg = m.panel.querySelector("#apikeys-create-msg"); setStatus(msg, "");
        SM.clearFieldError(f.name);
        if (!f.name.value.trim()) { SM.setFieldError(f.name, "A name is required."); f.name.focus(); return; }
        const attrs = { name: f.name.value.trim(), scope_type: scopeType };
        if (scopeRef) attrs.scope_ref = scopeRef;
        const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
        try {
          const doc = await apiFetch("/api/v1/api_keys", { method: "POST", body: jsonapiBody("api_key", attrs) });
          const created = doc && doc.data && doc.data.attributes;
          await load();
          m.close();
          if (created && created.key) showReveal(created.key);
        } catch (err) { submit.disabled = false; setStatus(msg, err.message, "error"); }
      });
    }

    // ── Key detail + management modal (opened from a table row) ── view the key, rename, rotate, revoke,
    //    delete. The full plaintext key is fetched once and shown; PUT/revoke responses omit it, so it's
    //    carried across re-paints. Admin-only affordances gate on canAdmin.
    async function openKeyModal(keyId) {
      let key;
      try { const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(keyId)); key = (doc && doc.data) || null; }
      catch (err) { SM.toast(err.message, { kind: "error" }); return; }
      if (!key) return;

      const m = SM.modal({ title: "", bodyHtml: '<div id="ak-modal"></div>', width: 620 });
      const hdr = m.panel.querySelector(".modalHeader"); if (hdr) hdr.style.display = "none";
      const root = m.panel.querySelector("#ak-modal");

      const fmtDT = (iso) => SM.fmtDateTime(iso) || "—";
      const scopeText = (a) => { const t = a.scope_type || "ACCOUNT"; return a.scope_ref ? t + " · " + a.scope_ref : t; };
      const df = (label, value, mono) => '<div class="field"><span class="detailFieldLabel">' + esc(label) + '</span><span class="detailFieldValue' + (mono ? " isMono" : "") + '">' + esc(value == null || value === "" ? "—" : value) + "</span></div>";
      function msg(t, kind) { setStatus(root.querySelector("#ak-msg"), t, kind); }
      // Save / revoke responses omit the plaintext key; keep the value we already revealed.
      function keepPlaintext(next) { const prev = key && key.attributes && key.attributes.key; const k = next || key; if (prev && k.attributes && !k.attributes.key) k.attributes.key = prev; return k; }

      paint();

      // The form opens editable (name input). Actions sit at the bottom: Revoke | Rotate | Save (Save only
      // for a revoked key). Delete lives on the table row; the modal closes via the X.
      function paint() {
        const a = key.attributes || {};
        const revoked = a.revoked === true;
        const statusPill = revoked ? SM.statusPill("revoked", "revoked") : SM.statusPill("active", "active");
        const nameField = canAdmin
          ? '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input id="ak-name" type="text" autocomplete="off" value="' + esc(a.name || "") + '" /><p class="fieldErrorMessage" hidden></p></div>'
          : df("Name", a.name);
        const keyBox = '<div class="keyReveal" style="margin-bottom:1rem;"><code>' + (a.key ? esc(a.key) : "—") + "</code>" +
          (a.key ? SM.copyButton(a.key, { title: "Copy key", size: 15 }) : "") + "</div>";
        const bottom = canAdmin
          ? (revoked ? "" : '<button type="button" class="button buttonSecondary buttonSmall" id="ak-revoke">Revoke</button><button type="button" class="button buttonSecondary buttonSmall" id="ak-rotate">Rotate</button>') +
            '<button type="button" class="button buttonPrimary buttonSmall" id="ak-save">Save</button>'
          : "";
        root.innerHTML =
          '<div style="margin-bottom:0.75rem;">' + statusPill + "</div>" +
          nameField +
          keyBox +
          '<div class="detailGrid">' +
          '<div class="detailCol">' + df("Scope", scopeText(a), true) + df("Created", fmtDT(a.created_at)) + "</div>" +
          '<div class="detailCol">' + df("Expires", a.expires_at ? fmtDT(a.expires_at) : "Never") + df("Last used", a.last_used_at ? fmtDT(a.last_used_at) : "Never") + "</div>" +
          "</div>" +
          '<p class="form-status" id="ak-msg" style="margin-top:0.5rem;"></p>' +
          (bottom ? '<div class="modalActions">' + bottom + "</div>" : "");
        SM.wireCopyButtons(root);
        wire();
      }

      function wire() {
        const nameEl = root.querySelector("#ak-name"); if (nameEl) nameEl.addEventListener("input", () => SM.clearFieldError(nameEl));
        const save = root.querySelector("#ak-save"); if (save) save.addEventListener("click", saveRename);
        const rot = root.querySelector("#ak-rotate"); if (rot) rot.addEventListener("click", rotate);
        const rev = root.querySelector("#ak-revoke"); if (rev) rev.addEventListener("click", revoke);
      }

      async function saveRename() {
        const nameEl = root.querySelector("#ak-name"); SM.clearFieldError(nameEl);
        const name = nameEl.value.trim();
        if (!name) { SM.setFieldError(nameEl, "A name is required."); return; }
        msg("");
        try {
          const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(key.id), { method: "PUT", body: jsonapiBody("api_key", { name: name }) });
          key = keepPlaintext(doc && doc.data); paint(); load();
          SM.toast("Key saved.", { kind: "success" });
        } catch (err) { msg(err.message, "error"); }
      }
      async function rotate() {
        const ok = await SM.confirm({ title: "Rotate this key?", message: "The current value stops working immediately and a new value is issued.", confirmLabel: "Rotate key", danger: false });
        if (!ok) return;
        msg("");
        try {
          const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(key.id) + "/actions/rotate", { method: "POST" });
          const rotated = doc && doc.data;
          m.close(); await load();
          if (rotated && rotated.attributes && rotated.attributes.key) showReveal(rotated.attributes.key);
        } catch (err) { msg(err.message, "error"); }
      }
      async function revoke() {
        const ok = await SM.confirm({ title: "Revoke this key?", message: "The key stops working immediately. It stays listed as revoked — delete it from the table to remove it entirely.", confirmLabel: "Revoke key" });
        if (!ok) return;
        msg("");
        try {
          const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(key.id) + "/actions/revoke", { method: "POST" });
          key = keepPlaintext(doc && doc.data); paint(); load();
        } catch (err) { msg(err.message, "error"); }
      }
    }
  }

  window.SMApiKeys = { mount: mount, reveal: showReveal };
})();
