"use strict";

// Subject detail (/account/subjects/detail?id=…) — a conforming detail page: DetailHeader, a Details
// tab (view/edit the subject's typed field values, generated from its subject type), and a Benchmarks
// tab listing the benchmarks this subject is linked to (with unlink for private ones). Depends on
// api.js + shell.js (SM helpers) + subject-form.js (SMSubjectForm).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  const PARAMS = new URLSearchParams(location.search);
  const ID = PARAMS.get("id") || "";
  const NEW = PARAMS.get("new") === "1"; // create mode: no id, a subject_type is supplied instead
  const NEW_TYPE_ID = PARAMS.get("subject_type") || "";
  let TG = null; // the subject resource
  let TYPE = null; // its subject_type resource (for the field defs)
  let CAN_WRITE = false;
  let editing = false;
  let nameDraft = "";

  const TABS = ["details", "benchmarks", "history"];
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }
  let currentRenderedTab = "details";

  function fmtDate(v) { return SM.fmtDateTime(v); }
  function fields() { return ((TYPE && TYPE.attributes && TYPE.attributes.fields) || []); }
  function setMsg(text, kind) {
    const el = $("detail-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    if (NEW) {
      if (!CAN_WRITE) { fail("You don’t have permission to create subjects."); return; }
      loadNew();
    } else {
      load();
    }
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  // ── Create mode (navigated from the Subjects page with a chosen subject_type) ──
  async function loadNew() {
    if (!NEW_TYPE_ID) { fail("No subject type specified."); return; }
    try {
      const td = await apiFetch("/api/v1/subject_types/" + encodeURIComponent(NEW_TYPE_ID));
      TYPE = (td && td.data) || null;
      if (!TYPE) { fail("Subject type not found."); return; }
      renderNew();
    } catch (err) { fail(err.message || "Failed to load subject type."); }
  }

  function renderNew() {
    const typeName = (TYPE && TYPE.attributes && (TYPE.attributes.name || TYPE.attributes.key)) || "subject";
    const fs = fields();
    const actions =
      '<button type="button" class="button buttonSecondary buttonSmall" id="t-cancel">Cancel</button>' +
      '<button type="button" class="button buttonPrimary buttonSmall" id="t-save">Save</button>';
    $("detail-root").innerHTML =
      SM.detailHeader({ name: "New " + typeName, secondaryId: "", actions: actions }) +
      '<div class="detailsTabPanel"><div class="detailGrid"><div class="detailCol">' +
      '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input data-edit="name" type="text" autocomplete="off" /><p class="fieldErrorMessage" hidden></p></div>' +
      '<div class="subjectFormFields" id="detail-fields">' + SMSubjectForm.render(fs, {}) + "</div>" +
      "</div></div></div>" +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = "New subject";
    document.title = "New subject — smplmark";

    const nameEl = $("detail-root").querySelector('[data-edit="name"]');
    nameEl.addEventListener("input", () => SM.clearFieldError(nameEl));
    SMSubjectForm.wire($("detail-fields"));
    $("t-cancel").addEventListener("click", () => { location.href = "/account/subjects"; });
    $("t-save").addEventListener("click", saveNew);
    nameEl.focus();
  }

  async function saveNew() {
    const nameEl = $("detail-root").querySelector('[data-edit="name"]');
    SM.clearFieldError(nameEl);
    let ok = true;
    const name = nameEl.value.trim();
    if (!name) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    const collected = SMSubjectForm.collect($("detail-fields"), fields());
    if (!collected.ok) ok = false;
    if (!ok) return;
    const btn = $("t-save"); btn.disabled = true;
    setMsg("");
    try {
      // The key is omitted — the server auto-generates it from the name.
      const doc = await apiFetch("/api/v1/subjects", {
        method: "POST",
        body: jsonapiBody("subject", { subject_type: NEW_TYPE_ID, name: name, details: collected.values }),
      });
      const created = doc && doc.data;
      location.href = "/account/subjects/detail?id=" + encodeURIComponent(created.id);
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  async function load() {
    if (!ID) { fail("No subject id."); return; }
    try {
      const doc = await apiFetch("/api/v1/subjects/" + encodeURIComponent(ID));
      TG = (doc && doc.data) || null;
      if (!TG) { fail("Subject not found."); return; }
      const typeId = (TG.attributes || {}).subject_type;
      if (typeId) {
        try { const td = await apiFetch("/api/v1/subject_types/" + encodeURIComponent(typeId)); TYPE = (td && td.data) || null; }
        catch (_e) { TYPE = null; }
      }
      render();
    } catch (err) { fail(err.message || "Failed to load subject."); }
  }

  function render() {
    const a = TG.attributes || {};
    const tab = activeTab();
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || a.key || "Subject", secondaryId: a.key || "", actions: "" }) +
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      tabBtn("details", "Details") + tabBtn("benchmarks", "Benchmarks") + tabBtn("history", "History") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div></div>' +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Subject";
    document.title = (a.name || "Subject") + " — smplmark";

    SM.wireCopyButtons($("detail-root"));
    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => switchTab(el.dataset.tab)));
    renderTab();
  }

  function switchTab(key) {
    if (key === activeTab()) return;
    editing = false; // leaving the tab discards an in-progress edit (nothing persisted yet)
    location.hash = key;
    render();
  }
  window.addEventListener("hashchange", () => { if (activeTab() !== currentRenderedTab) render(); });

  function renderTab() {
    currentRenderedTab = activeTab();
    const panel = $("tab-panel");
    $("tab-actions").innerHTML = "";
    if (currentRenderedTab === "details") renderDetails(panel, $("tab-actions"));
    else if (currentRenderedTab === "history") renderHistory(panel);
    else renderBenchmarks(panel);
  }

  // ── History tab — this subject's audit trail (account-visible only). ──
  function eventLabel(t) {
    const labels = { "subject.created": "Created", "subject.edited": "Edited" };
    return labels[t] || t;
  }
  function actorLabel(actor) {
    if (!actor) return "—";
    if (actor.label) return actor.label;
    if (actor.type === "API_KEY") return "an API key";
    return actor.type ? String(actor.type).toLowerCase() : "—";
  }
  async function renderHistory(panel) {
    panel.innerHTML = '<div id="history-table"></div>';
    const table = SM.pagedTable($("history-table"), {
      columns: [
        { key: "when", label: "When", sortable: true, sortValue: (e) => (e.attributes || {}).occurred_at || "", render: (e) => esc(fmtDate((e.attributes || {}).occurred_at) || "—") },
        { key: "event", label: "Event", sortable: true, sortValue: (e) => (e.attributes || {}).event_type || "", render: (e) => esc(eventLabel((e.attributes || {}).event_type)) },
        { key: "description", label: "What happened", sortable: false, render: (e) => esc((e.attributes || {}).description || "") },
        { key: "actor", label: "By", sortable: false, render: (e) => esc(actorLabel((e.attributes || {}).actor)) },
      ],
      rows: [], sort: { key: "when", dir: "desc" }, emptyText: "No history recorded yet.",
    });
    try {
      const doc = await apiFetch("/api/v1/subjects/" + encodeURIComponent(ID) + "/history");
      table.setRows((doc && doc.data) || []);
    } catch (err) {
      $("history-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Details tab (typed field values) ──
  function enterEdit() { editing = true; nameDraft = (TG.attributes || {}).name || ""; renderTab(); }
  function exitEdit() { editing = false; }

  function renderDetails(panel, actions) {
    const a = TG.attributes || {};
    const details = a.details || {};
    const fs = fields();
    const typeName = (TYPE && TYPE.attributes && (TYPE.attributes.name || TYPE.attributes.key)) || "—";

    if (CAN_WRITE) {
      actions.innerHTML = editing
        ? '<button type="button" class="button buttonSecondary buttonSmall" id="t-cancel">Cancel</button>' +
          '<button type="button" class="button buttonPrimary buttonSmall" id="t-save">Save</button>'
        : '<button type="button" class="button buttonSecondary buttonSmall" id="t-edit">Edit</button>' +
          '<button type="button" class="button buttonDanger buttonSmall" id="t-delete">Delete</button>';
    }

    let left;
    if (editing) {
      left = '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input data-edit="name" type="text" value="' + esc(nameDraft) + '" /><p class="fieldErrorMessage" hidden></p></div>' +
        '<div class="subjectFormFields" id="detail-fields">' + SMSubjectForm.render(fs, details) + "</div>";
    } else {
      left = SM.detailField("Name", { value: a.name }) +
        SM.detailField("Subject type", { value: typeName }) +
        fs.map((f) => SM.detailField(f.label, { value: SMSubjectForm.display(f, details[f.name]), emptyText: "—" })).join("");
    }
    const right = SM.detailField("Created", { value: fmtDate(a.created_at) }) + SM.detailField("Updated", { value: fmtDate(a.updated_at) });

    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div></div></div>";

    if (CAN_WRITE && editing) {
      const nameEl = panel.querySelector('[data-edit="name"]');
      nameEl.addEventListener("input", () => { nameDraft = nameEl.value; SM.clearFieldError(nameEl); });
      SMSubjectForm.wire(panel.querySelector("#detail-fields"));
      $("t-cancel").addEventListener("click", () => { exitEdit(); renderTab(); });
      $("t-save").addEventListener("click", save);
      nameEl.focus();
    } else if (CAN_WRITE) {
      $("t-edit").addEventListener("click", enterEdit);
      $("t-delete").addEventListener("click", del);
    }
  }

  async function save() {
    const panel = $("tab-panel");
    const nameEl = panel.querySelector('[data-edit="name"]');
    SM.clearFieldError(nameEl);
    let ok = true;
    if (!nameDraft.trim()) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    const collected = SMSubjectForm.collect(panel.querySelector("#detail-fields"), fields());
    if (!collected.ok) ok = false;
    if (!ok) return;
    const a = TG.attributes || {};
    const btn = $("t-save"); btn.disabled = true;
    setMsg("");
    // Preserve any arbitrary (undefined-by-schema) keys the subject carries — the form only edits the
    // type's defined fields, but this is the open schema, so unseen extra data must round-trip.
    const definedNames = new Set(fields().map((f) => f.name));
    const details = {};
    Object.entries(a.details || {}).forEach(([k, v]) => { if (!definedNames.has(k)) details[k] = v; });
    Object.assign(details, collected.values);
    try {
      // get-mutate-put: key + subject_type are immutable server-side but round-trip harmlessly.
      const doc = await apiFetch("/api/v1/subjects/" + encodeURIComponent(ID), {
        method: "PUT",
        body: jsonapiBody("subject", { key: a.key, name: nameDraft.trim(), subject_type: a.subject_type, details: details }),
      });
      TG = (doc && doc.data) || TG;
      exitEdit();
      render();
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  async function del() {
    const a = TG.attributes || {};
    const okc = await SM.confirm({ title: "Delete subject?", message: "Delete <strong>" + esc(a.name || a.key || "") + "</strong> and its measurements? This can't be undone. A subject linked to a published benchmark can't be deleted.", confirmLabel: "Delete" });
    if (!okc) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/subjects/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/subjects";
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Benchmarks tab (where this subject is linked) ──
  function linkBench(lnk) { return lnk.__bench; }
  function linkStatus(lnk) { const b = linkBench(lnk); return String(((b && b.attributes) || {}).status || "").toUpperCase(); }
  async function renderBenchmarks(panel) {
    panel.innerHTML = '<div id="bm-table"></div>';
    const cols = [
      { key: "benchmark", label: "Benchmark", sortable: true,
        sortValue: (lnk) => { const ba = ((linkBench(lnk) || {}).attributes) || {}; return ba.name || ba.key || (lnk.attributes || {}).benchmark || ""; },
        render: (lnk) => { const la = lnk.attributes || {}; const b = linkBench(lnk); const ba = (b && b.attributes) || {};
          return b ? '<a class="buttonLink" href="/account/benchmarks/detail?id=' + esc(la.benchmark) + '">' + esc(ba.name || ba.key || la.benchmark) + "</a>" : "<code>" + esc(la.benchmark) + "</code>"; } },
      { key: "status", label: "Status", sortable: true, sortValue: linkStatus, render: (lnk) => { const s = linkStatus(lnk); if (!s) return ""; const label = s === "PRIVATE" ? "draft" : s; return SM.statusPill(label, label); } },
    ];
    if (CAN_WRITE) cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (lnk) => {
      if (linkStatus(lnk) !== "PRIVATE") return "";
      const ba = ((linkBench(lnk) || {}).attributes) || {};
      return '<button type="button" class="button buttonDanger buttonSmall unlink" data-id="' + esc(lnk.id) + '" data-name="' + esc(ba.name || ba.key || "") + '">Unlink</button>'; } });
    const table = SM.pagedTable($("bm-table"), {
      columns: cols, rows: [], sort: { key: "benchmark", dir: "asc" },
      emptyText: "Not linked to any benchmark yet. Add it from a benchmark’s Subjects tab.",
      onRender: CAN_WRITE ? (c) => c.querySelectorAll(".unlink").forEach((el) => el.addEventListener("click", () => unlink(el.dataset.id, el.dataset.name))) : undefined,
    });
    try {
      const [linksDoc, benchDoc] = await Promise.all([
        apiFetch("/api/v1/benchmark_subjects?filter[subject]=" + encodeURIComponent(ID)),
        apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent((TG.attributes || {}).account || "")),
      ]);
      const links = (linksDoc && linksDoc.data) || [];
      const byId = {};
      ((benchDoc && benchDoc.data) || []).forEach((b) => { byId[b.id] = b; });
      links.forEach((lnk) => { lnk.__bench = byId[(lnk.attributes || {}).benchmark]; });
      table.setRows(links);
    } catch (err) {
      $("bm-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  async function unlink(linkId, benchName) {
    const ok = await SM.confirm({ title: "Unlink from benchmark?", message: "Remove this subject from <strong>" + esc(benchName) + "</strong> and drop its measurements there? The subject itself is kept.", confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_subjects/" + encodeURIComponent(linkId), { method: "DELETE" });
      renderBenchmarks($("tab-panel"));
    } catch (err) { setMsg(err.message, "error"); }
  }
})();
