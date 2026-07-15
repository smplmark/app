"use strict";

// Metric detail (/account/metrics/detail?id=…) — a conforming tabbed detail page (same shape as the
// subject / benchmark pages): a DetailHeader (title + Type/Kind pills, no header buttons), a
// .detailsTabHeader with tabs on the left and the actions on the right, and a .detailsTabPanel card per
// tab. Tabs are Details, plus Formula for a DERIVED metric.
//
// With no id it is the CREATE page (the editable form, POST). With an id it shows the metric in VIEW mode
// (Edit / Delete in the tab row); Edit turns the same page into the inline editable form (PUT). The
// editable form (both tabs) is provided by metric-form.js (SMMetricForm); Cancel / Save go in its tab row.
// Depends on api.js + shell.js (SM helpers) + metric-form.js (SMMetricForm).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";
  const isNewPage = !ID; // no id → the create page
  let METRIC = null;
  let CAN_WRITE = false;
  let editing = false;
  let viewTab = "details"; // active tab in VIEW mode

  function setMsg(text, kind) {
    const el = $("m-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    if (isNewPage) {
      if (!CAN_WRITE) { fail("You don’t have permission to create metrics."); return; }
      editing = true;
      renderForm();
    } else {
      load();
    }
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    try {
      const doc = await apiFetch("/api/v1/metrics/" + encodeURIComponent(ID));
      METRIC = (doc && doc.data) || null;
      if (!METRIC) { fail("Metric not found."); return; }
      renderView();
    } catch (err) { fail(err.message || "Failed to load metric."); }
  }

  // ── VIEW mode: a tabbed detail page (Details, plus Formula for a DERIVED metric) ──
  function renderView() {
    const a = METRIC.attributes || {};
    const derived = a.kind === "DERIVED";
    const tabs = derived ? ["details", "formula"] : ["details"];
    if (tabs.indexOf(viewTab) < 0) viewTab = "details";
    const decorations = SMMetricForm.typePillHtml(a.type) + SMMetricForm.kindPillHtml(a.kind);
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (viewTab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (viewTab === key) + '">' + esc(label) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.label || a.name || "Metric", decorations: decorations, secondaryId: a.name || "", actions: "" }) +
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      tabs.map((t) => tabBtn(t, t === "details" ? "Details" : "Formula")).join("") +
      '</nav><div class="detailsTabActions" id="tab-actions"></div></div>' +
      '<div id="tab-panel"></div>' +
      '<div id="m-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.label || a.name || "Metric";
    document.title = (a.label || a.name || "Metric") + " — smplmark";

    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => { if (el.dataset.tab !== viewTab) { viewTab = el.dataset.tab; renderView(); } }));

    if (CAN_WRITE) {
      $("tab-actions").innerHTML =
        '<button type="button" class="button buttonSecondary buttonSmall" id="m-edit">Edit</button>' +
        '<button type="button" class="button buttonDanger buttonSmall" id="m-delete">Delete</button>';
      $("m-edit").addEventListener("click", () => { editing = true; renderForm(); });
      $("m-delete").addEventListener("click", del);
    }

    if (viewTab === "formula") renderFormulaView($("tab-panel"), a);
    else renderDetailsView($("tab-panel"), a);
  }

  function renderDetailsView(panel, a) {
    // A formatted sample shows the effect of unit + format (default pattern per type when none is set).
    const fmtPattern = a.format || (a.type === "INTEGER" ? "#,##0" : "#,##0.###");
    const sample = SM.formatNumber(/%/.test(fmtPattern) ? 0.1234 : 1234.567, fmtPattern) + (a.unit ? " " + a.unit : "");
    const left =
      SM.detailField("Name", { value: a.name, mono: true }) +
      SM.detailField("Label", { value: a.label }) +
      SM.detailField("Description", { value: a.description, emptyText: "—" });
    const right =
      SM.detailField("Type", { value: SMMetricForm.typeLabel(a.type) }) +
      SM.detailField("Unit", { value: a.unit, emptyText: "—" }) +
      SM.detailField("Format", { value: a.format || "Default", mono: true }) +
      SM.detailField("Sample", { value: sample, mono: true }) +
      SM.detailField("Kind", { value: SMMetricForm.kindLabel(a.kind) }) +
      SM.detailField("Created", { value: SM.fmtDateTime(a.created_at) }) +
      SM.detailField("Updated", { value: SM.fmtDateTime(a.updated_at) });
    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div></div></div>";
  }

  function renderFormulaView(panel, a) {
    const readable = SMMetricForm.formulaText(a.formula);
    const exprJson = a.expr ? JSON.stringify(a.expr, null, 2) : null;
    panel.innerHTML =
      '<div class="detailsTabPanel">' +
      SM.detailField("Formula", { value: readable, mono: true }) +
      '<div class="field" style="margin-top:1rem;gap:0.4rem;"><span class="detailFieldLabel">Expression (JSON Logic)</span>' +
      (exprJson ? '<pre class="mfJson"><code></code></pre>' : '<span class="detailFieldValue">—</span>') +
      "</div></div>";
    if (exprJson) panel.querySelector(".mfJson code").textContent = exprJson;
  }

  // ── EDIT / CREATE mode: the tabbed form (Details + Formula), with Cancel / Save in the tab row ──
  function renderForm() {
    const a = (METRIC && METRIC.attributes) || {};
    const title = isNewPage ? "New metric" : (a.label || a.name || "Metric");

    $("detail-root").innerHTML =
      SM.detailHeader({ name: title, secondaryId: isNewPage ? "" : (a.name || ""), actions: "" }) +
      '<form class="form" id="metric-edit-form" novalidate>' +
      SMMetricForm.render(a, { isNew: isNewPage }) + "</form>" +
      '<div id="m-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = title;
    document.title = title + " — smplmark";

    const form = $("metric-edit-form");
    const actions = form.querySelector("#mf-tab-actions");
    if (actions) {
      actions.innerHTML =
        '<button type="button" class="button buttonSecondary buttonSmall" id="m-cancel">Cancel</button>' +
        '<button type="button" class="button buttonPrimary buttonSmall" id="m-save">Save</button>';
    }
    SMMetricForm.wire(form, { isNew: isNewPage, selfName: isNewPage ? null : a.name, initFormula: a.formula });
    $("m-cancel").addEventListener("click", () => {
      if (isNewPage) location.href = "/account/metrics";
      else { editing = false; renderView(); }
    });
    $("m-save").addEventListener("click", save);
    const first = form.querySelector('input[name="' + (isNewPage ? "name" : "label") + '"]');
    if (first) first.focus();
  }

  async function save() {
    const form = $("metric-edit-form");
    const res = SMMetricForm.collect(form, { isNew: isNewPage });
    if (!res.ok) { setMsg(res.message || "", res.message ? "error" : ""); return; }
    const btn = $("m-save"); btn.disabled = true; setMsg("");
    try {
      if (isNewPage) {
        const doc = await apiFetch("/api/v1/metrics", { method: "POST", body: jsonapiBody("metric", res.attrs) });
        const created = doc && doc.data;
        location.href = "/account/metrics/detail?id=" + encodeURIComponent(created.id);
      } else {
        const doc = await apiFetch("/api/v1/metrics/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("metric", res.attrs) });
        METRIC = (doc && doc.data) || METRIC;
        editing = false;
        renderView();
        SM.toast("Metric saved.", { kind: "success" });
      }
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  async function del() {
    const a = METRIC.attributes || {};
    const ok = await SM.confirm({ title: "Delete metric?", message: "Delete <strong>" + esc(a.label || a.name || "") + "</strong> from your metric library? This can’t be undone.", confirmLabel: "Delete metric" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/metrics/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/metrics";
    } catch (err) { setMsg(err.message, "error"); }
  }
})();
