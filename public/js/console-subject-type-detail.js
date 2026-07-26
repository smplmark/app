"use strict";

// Subject type detail (/account/subject-types/detail?id=…) — a tabbed detail page. The two tabs are
// INDEPENDENT: the Details tab has its own Edit → Cancel/Save for the type's name; the Fields tab is a
// self-contained field manager — an "Add field" button, and a table whose rows open a single-field
// modal. Each field add / edit / remove persists on its own (a full-representation PUT). Delete (of the
// whole type) is blocked server-side (409) while any subject uses it. Depends on api.js + shell.js +
// subject-type-form.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";
  const HINT_FLAG = "subject_type_fields_hint_dismissed"; // per-user "don't show the fields hint again"
  let TYPE = null;
  let CAN_WRITE = false;
  let editingName = false; // Details-tab name edit only
  let nameDraft = "";

  const TABS = ["details", "fields"];
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }
  let currentRenderedTab = "details";

  function fields() { return SMSubjectTypeForm.fieldsOf(TYPE); }
  function setMsg(text, kind) {
    const el = $("detail-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  SM.ready.then((id) => { CAN_WRITE = id.canWrite; load(); }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!ID) { fail("No subject type id."); return; }
    try {
      const doc = await apiFetch("/api/v1/subject_types/" + encodeURIComponent(ID));
      TYPE = (doc && doc.data) || null;
      if (!TYPE) { fail("Subject type not found."); return; }
      render();
      maybeShowFieldsHint();
    } catch (err) { fail(err.message || "Failed to load subject type."); }
  }

  // Right after a type is created we land on its Fields tab (?new=1). Explain that this is where its
  // schema is defined — once, unless the user has ticked "don't show this again" (stored per-user).
  async function maybeShowFieldsHint() {
    if (!CAN_WRITE) return;
    const params = new URLSearchParams(location.search);
    if (params.get("new") !== "1") return;
    // Drop ?new=1 so a refresh doesn't re-trigger the hint (keep the id + the #fields hash).
    params.delete("new");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    let settings = {};
    try { settings = (await apiFetch("/api/v1/users/current/settings", { json: true })) || {}; } catch (_e) { /* best-effort */ }
    if (settings[HINT_FLAG] === true) return;
    showFieldsHintModal(settings);
  }

  function showFieldsHintModal(settings) {
    const bodyHtml =
      '<p class="detailFieldHelp" style="margin:0;font-size:0.95rem;color:var(--text);">A subject type is a schema — it describes the fields that subjects of this type carry. Use <strong>Add field</strong> to define the fields subjects of this type should have (a name, a data type, whether it’s required, and so on). You can change them anytime.</p>' +
      '<label style="display:flex;align-items:center;gap:0.5rem;font-size:0.9rem;color:var(--text-muted);cursor:pointer;margin-top:0.25rem;"><input type="checkbox" id="hint-dismiss" /> Don’t show this again</label>' +
      '<div class="modalActions"><button type="button" class="button buttonPrimary buttonSmall" id="hint-ok">Got it</button></div>';
    const m = SM.modal({
      title: "Define this type’s fields",
      description: "This is where you set up the schema for subjects of this type.",
      bodyHtml: bodyHtml,
      width: 460,
      onClose: () => {
        const cb = m.panel.querySelector("#hint-dismiss");
        if (cb && cb.checked) persistHintDismissed(settings);
      },
    });
    m.panel.querySelector("#hint-ok").addEventListener("click", m.close);
  }

  // get-mutate-put on the per-user settings bag, preserving any other preferences. Best-effort.
  async function persistHintDismissed(settings) {
    try {
      const next = Object.assign({}, settings, { [HINT_FLAG]: true });
      await apiFetch("/api/v1/users/current/settings", { method: "PUT", json: true, body: next });
    } catch (_e) { /* a failed write just means the hint may reappear next time */ }
  }

  function render() {
    const a = TYPE.attributes || {};
    const tab = activeTab();
    const tabBtn = (key, label, badge) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' +
      esc(label) + (badge != null ? '<span class="tabBadge">' + badge + "</span>" : "") + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || a.key || "Subject type", secondaryId: a.key || "", actions: "" }) +
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      tabBtn("details", "Details") + tabBtn("fields", "Fields", fields().length) + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div></div>' +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Subject type";
    document.title = (a.name || "Subject type") + " — smplmark";

    SM.wireCopyButtons($("detail-root"));
    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => switchTab(el.dataset.tab)));
    renderTab();
  }

  // Leaving the Details tab discards an in-progress (unsaved) name edit.
  function switchTab(key) {
    if (key === activeTab()) return;
    editingName = false;
    location.hash = key;
    render();
  }
  window.addEventListener("hashchange", () => { if (activeTab() !== currentRenderedTab) render(); });

  function renderTab() {
    currentRenderedTab = activeTab();
    const panel = $("tab-panel");
    $("tab-actions").innerHTML = "";
    if (currentRenderedTab === "details") renderDetails(panel, $("tab-actions"));
    else renderFields(panel, $("tab-actions"));
  }

  // ── Details tab (name + timestamps; key is in the header, field count is a badge on the Fields tab) ──
  function renderDetails(panel, actions) {
    const a = TYPE.attributes || {};
    if (CAN_WRITE) {
      actions.innerHTML = editingName
        ? '<button type="button" class="button buttonSecondary buttonSmall" id="t-cancel">Cancel</button>' +
          '<button type="button" class="button buttonPrimary buttonSmall" id="t-save">Save</button>'
        : '<button type="button" class="button buttonSecondary buttonSmall" id="t-edit">Edit</button>' +
          '<button type="button" class="button buttonDanger buttonSmall" id="t-delete">Delete</button>';
    }

    const left = editingName
      ? '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input data-edit="name" type="text" value="' + esc(nameDraft) + '" /><p class="fieldErrorMessage" hidden></p></div>'
      : SM.detailField("Name", { value: a.name });
    const right = SM.detailField("Created", { value: SM.fmtDateTime(a.created_at) }) + SM.detailField("Updated", { value: SM.fmtDateTime(a.updated_at) });

    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div></div></div>";

    if (CAN_WRITE && editingName) {
      const nameEl = panel.querySelector('[data-edit="name"]');
      nameEl.addEventListener("input", () => { nameDraft = nameEl.value; SM.clearFieldError(nameEl); });
      $("t-cancel").addEventListener("click", () => { editingName = false; setMsg(""); renderTab(); });
      $("t-save").addEventListener("click", saveName);
      nameEl.focus();
    } else if (CAN_WRITE) {
      $("t-edit").addEventListener("click", () => { editingName = true; nameDraft = a.name || ""; setMsg(""); renderTab(); });
      $("t-delete").addEventListener("click", del);
    }
  }

  async function saveName() {
    if (!nameDraft.trim()) {
      const el = $("tab-panel").querySelector('[data-edit="name"]');
      if (el) SM.setFieldError(el, "A name is required.");
      return;
    }
    const btn = $("t-save"); if (btn) btn.disabled = true;
    setMsg("");
    try {
      await persistFields(fields(), nameDraft.trim());
      editingName = false;
      render();
      SM.toast("Subject type saved.", { kind: "success" });
    } catch (err) { if (btn) btn.disabled = false; setMsg(err.message, "error"); }
  }

  // ── Fields tab (an independent field manager: "Add field" + a table of clickable rows that persist
  //    each add/edit/remove immediately) ──
  function renderFields(panel, actions) {
    if (CAN_WRITE) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="t-add-field">' + SM.icon("plus", 14) + " Add field</button>";
      $("t-add-field").addEventListener("click", () => openFieldEditor(null));
    }
    panel.innerHTML = '<div id="fields-table"></div>';
    SM.pagedTable($("fields-table"), {
      columns: SMSubjectTypeForm.fieldColumns({ editable: CAN_WRITE }),
      rows: fields(),
      sort: { key: "name", dir: "asc" },
      emptyText: CAN_WRITE ? "No fields yet — use “Add field” above." : "No fields — subjects of this type carry just a key and name.",
      onRowClick: CAN_WRITE ? (f) => openFieldEditor(f) : undefined,
      onRender: CAN_WRITE ? (c) => {
        c.querySelectorAll(".fieldTrash").forEach((b) => b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const f = fields().find((x) => x.name === b.getAttribute("data-field-name"));
          if (f) removeField(f);
        }));
      } : undefined,
    });
  }

  // Open the single-field modal. `field` null → add; otherwise edit that field. Save persists.
  function openFieldEditor(field) {
    SMSubjectTypeForm.openFieldModal({
      field: field || null,
      onSave: async (def) => {
        const current = fields();
        let next;
        if (field) { const i = current.indexOf(field); next = current.slice(); if (i >= 0) next[i] = def; else next.push(def); }
        else next = current.concat([def]);
        await persistFields(next);
        render();
        SM.toast("Field saved.", { kind: "success" });
      },
    });
  }

  async function removeField(field) {
    const ok = await SM.confirm({ title: "Remove field?", message: "Remove <strong>" + esc(field.label || field.name) + "</strong> from this type? It just stops being validated — existing subjects keep the value they stored, and subjects can still include <code>" + esc(field.name) + "</code> as free-form data.", confirmLabel: "Remove field" });
    if (!ok) return;
    setMsg("");
    try {
      await persistFields(fields().filter((x) => x !== field));
      render();
      SM.toast("Field removed.", { kind: "success" });
    } catch (err) { setMsg(err.message, "error"); }
  }

  // get-mutate-put: PUT the full representation. `name` defaults to the type's current name (field ops
  // only change fields); the key is immutable server-side. Updates TYPE; the caller re-renders.
  async function persistFields(nextFields, name) {
    const a = TYPE.attributes || {};
    const doc = await apiFetch("/api/v1/subject_types/" + encodeURIComponent(ID), {
      method: "PUT",
      body: jsonapiBody("subject_type", { name: name != null ? name : a.name, fields: nextFields }),
    });
    TYPE = (doc && doc.data) || TYPE;
  }

  async function del() {
    const a = TYPE.attributes || {};
    const ok = await SM.confirm({ title: "Delete subject type?", message: "Delete <strong>" + esc(a.name || a.key) + "</strong>? A type still used by subjects can't be deleted.", confirmLabel: "Delete type" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/subject_types/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/subject-types";
    } catch (err) { setMsg(err.message, "error"); }
  }
})();
