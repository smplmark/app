"use strict";

// API key detail (/account/api-keys/detail?id=…) — a conforming detail page: a DetailHeader with the
// key's name + status and Edit / Rotate / Revoke / Delete actions, and a details grid. Edit renames
// the key; Rotate issues a new value (revealed once); Revoke disables it but keeps it listed; Delete
// removes it entirely. Management is admin-only. Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";

  let KEY = null; // the api_key resource; attributes include the revealed `key`
  let CAN_ADMIN = false;
  let editing = false;
  let nameDraft = "";
  let BACK_HREF = "/account/settings#apikeys"; // where this key is managed; set by applyContext()

  function fmtDateTime(iso) { return SM.fmtDateTime(iso) || "—"; }
  function setMsg(text, kind) {
    const el = $("k-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function scopeText(a) {
    const t = a.scope_type || "ACCOUNT";
    return a.scope_ref ? t + " · " + a.scope_ref : t;
  }
  // PUT / revoke responses omit the plaintext; keep the value we already revealed on load.
  function keepKey(next) {
    const prev = (KEY && KEY.attributes && KEY.attributes.key) || null;
    KEY = next || KEY;
    if (prev && KEY.attributes && !KEY.attributes.key) KEY.attributes.key = prev;
  }

  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    load();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!ID) { fail("No key id."); return; }
    try {
      const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(ID));
      KEY = (doc && doc.data) || null;
      if (!KEY) { fail("API key not found."); return; }
      render();
      applyContext(); // scope-aware breadcrumb + sidebar highlight + back destination
    } catch (err) { fail(err.message || "Failed to load the API key."); }
  }

  // A key belongs to a scope (account / a benchmark / a run) — route the breadcrumb, the highlighted
  // nav item, and the post-delete redirect back to where that key is managed.
  async function applyContext() {
    const a = KEY.attributes || {};
    const st = a.scope_type || "ACCOUNT";
    const ref = a.scope_ref || null;
    const keyName = a.name || "API key";
    if (st === "ACCOUNT" || !ref) {
      BACK_HREF = "/account/settings#apikeys";
      SM.setActiveNav("settings");
      SM.setBreadcrumbs([{ label: "Settings", href: "/account/settings" }, { label: "API Keys", href: BACK_HREF }, { label: keyName }]);
      return;
    }
    if (st === "BENCHMARK") {
      let name = ref;
      try { const d = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ref)); const ba = (d && d.data && d.data.attributes) || {}; name = ba.name || ba.key || ref; } catch (_e) {}
      BACK_HREF = "/account/benchmarks/detail?id=" + encodeURIComponent(ref) + "#apikeys";
      SM.setActiveNav("benchmarks");
      SM.setBreadcrumbs([{ label: "Benchmarks", href: "/account/benchmarks" }, { label: name, href: BACK_HREF }, { label: keyName }]);
      return;
    }
    // RUN
    let runKey = ref;
    try { const d = await apiFetch("/api/v1/runs/" + encodeURIComponent(ref)); const ra = (d && d.data && d.data.attributes) || {}; runKey = ra.key || ref; } catch (_e) {}
    BACK_HREF = "/account/runs/detail?id=" + encodeURIComponent(ref) + "#apikeys";
    SM.setActiveNav("benchmarks");
    SM.setBreadcrumbs([{ label: "Benchmarks", href: "/account/benchmarks" }, { label: runKey, href: BACK_HREF }, { label: keyName }]);
  }

  function render() {
    const a = KEY.attributes || {};
    const revoked = a.revoked === true;
    const statusPill = revoked ? SM.statusPill("revoked", "revoked") : SM.statusPill("active", "active");

    let actions = "";
    if (CAN_ADMIN && editing) {
      actions =
        '<button type="button" class="button buttonSecondary buttonSmall" id="k-cancel">Cancel</button>' +
        '<button type="button" class="button buttonPrimary buttonSmall" id="k-save">Save</button>';
    } else if (CAN_ADMIN && revoked) {
      actions =
        '<button type="button" class="button buttonSecondary buttonSmall" id="k-edit">Edit</button>' +
        '<button type="button" class="button buttonDanger buttonSmall" id="k-delete">Delete</button>';
    } else if (CAN_ADMIN) {
      actions =
        '<button type="button" class="button buttonSecondary buttonSmall" id="k-edit">Edit</button>' +
        '<button type="button" class="button buttonSecondary buttonSmall" id="k-rotate">Rotate</button>' +
        '<button type="button" class="button buttonSecondary buttonSmall" id="k-revoke">Revoke</button>' +
        '<button type="button" class="button buttonDanger buttonSmall" id="k-delete">Delete</button>';
    }

    const nameField = editing
      ? '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input id="k-name" type="text" value="' + esc(nameDraft) + '" /><p class="fieldErrorMessage" hidden></p></div>'
      : SM.detailField("Name", { value: a.name });

    const keyField =
      '<div class="field"><span class="detailFieldLabel">Key</span>' +
      '<span class="detailFieldValue isMono">' +
      (a.key ? "<code>" + esc(a.key) + "</code> <button type=\"button\" class=\"buttonLink\" id=\"k-copy\">Copy</button>" : "—") +
      "</span></div>";

    const left = nameField + keyField + SM.detailField("Scope", { value: scopeText(a), mono: true });
    const right =
      SM.detailField("Created by", { value: a.created_by_user || "—", mono: true }) +
      SM.detailField("Created", { value: fmtDateTime(a.created_at) }) +
      SM.detailField("Expires", { value: a.expires_at ? fmtDateTime(a.expires_at) : "Never" }) +
      SM.detailField("Last used", { value: a.last_used_at ? fmtDateTime(a.last_used_at) : "Never" });

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || "API key", decorations: statusPill, actions: actions }) +
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div>" +
      "</div></div>" +
      '<div id="k-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || "API key";
    document.title = (a.name || "API key") + " — smplmark";

    wire();
  }

  function wire() {
    const copy = $("k-copy");
    if (copy) copy.addEventListener("click", () => {
      SM.copyText((KEY.attributes || {}).key || "").then(
        () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1500); },
        () => { copy.textContent = "Copy failed"; },
      );
    });
    const edit = $("k-edit"); if (edit) edit.addEventListener("click", enterEdit);
    const cancel = $("k-cancel"); if (cancel) cancel.addEventListener("click", () => { editing = false; render(); });
    const save = $("k-save"); if (save) save.addEventListener("click", saveRename);
    const nameEl = $("k-name"); if (nameEl) { nameEl.addEventListener("input", () => { nameDraft = nameEl.value; SM.clearFieldError(nameEl); }); nameEl.focus(); nameEl.select(); }
    const rotate = $("k-rotate"); if (rotate) rotate.addEventListener("click", rotateKey);
    const revoke = $("k-revoke"); if (revoke) revoke.addEventListener("click", revokeKey);
    const del = $("k-delete"); if (del) del.addEventListener("click", deleteKey);
  }

  function enterEdit() {
    editing = true;
    nameDraft = (KEY.attributes || {}).name || "";
    render();
  }

  async function saveRename() {
    const nameEl = $("k-name");
    SM.clearFieldError(nameEl);
    const name = nameDraft.trim();
    if (!name) { SM.setFieldError(nameEl, "A name is required."); nameEl.focus(); return; }
    if (name === ((KEY.attributes || {}).name || "")) { editing = false; render(); return; }
    const btn = $("k-save"); btn.disabled = true;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("api_key", { name: name }) });
      keepKey(doc && doc.data);
      editing = false;
      render();
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  async function rotateKey() {
    const ok = await SM.confirm({ title: "Rotate this key?", message: "The current value stops working immediately and a new value is issued.", confirmLabel: "Rotate key", danger: false });
    if (!ok) return;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(ID) + "/actions/rotate", { method: "POST" });
      const rotated = doc && doc.data;
      // Rotate mints a NEW key (new id); reveal the value once, then land on the new key's page.
      if (rotated && rotated.attributes && rotated.attributes.key) {
        showReveal(rotated.attributes.key, "Rotated API key", () => { location.href = "/account/api-keys/detail?id=" + encodeURIComponent(rotated.id); });
      } else { load(); }
    } catch (err) { setMsg(err.message, "error"); }
  }

  async function revokeKey() {
    const ok = await SM.confirm({ title: "Revoke this key?", message: "The key stops working immediately. It stays listed as revoked — use Delete to remove it entirely.", confirmLabel: "Revoke key" });
    if (!ok) return;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(ID) + "/actions/revoke", { method: "POST" });
      keepKey(doc && doc.data);
      render();
    } catch (err) { setMsg(err.message, "error"); }
  }

  async function deleteKey() {
    const a = KEY.attributes || {};
    const ok = await SM.confirm({ title: "Delete this key?", message: "This permanently removes <strong>" + esc(a.name || "") + "</strong>. This cannot be undone.", confirmLabel: "Delete key" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/api_keys/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = BACK_HREF;
    } catch (err) { setMsg(err.message, "error"); }
  }

  function showReveal(keyValue, title, onDone) {
    const m = SM.modal({
      title: title,
      description: "The previous key has stopped working. Copy the new key below, or view it anytime from its details.",
      width: 640,
      onClose: onDone,
      bodyHtml:
        '<div class="keyReveal"><code id="reveal-code"></code>' +
        '<button type="button" class="button buttonSecondary buttonSmall" id="reveal-copy">Copy</button></div>' +
        '<div class="modalActions" style="margin-top:1rem;"><button type="button" class="button buttonPrimary buttonSmall" id="reveal-done">Done</button></div>',
    });
    m.panel.querySelector("#reveal-code").textContent = keyValue;
    const copyBtn = m.panel.querySelector("#reveal-copy");
    copyBtn.addEventListener("click", () => { SM.copyText(keyValue).then(() => { copyBtn.textContent = "Copied"; }, () => { copyBtn.textContent = "Copy failed"; }); });
    m.panel.querySelector("#reveal-done").addEventListener("click", m.close);
  }
})();
