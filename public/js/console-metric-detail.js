"use strict";

// Metric detail (/account/metrics/detail?id=…) — a conforming detail page. With no id it is the CREATE
// page: the form renders inline in edit mode and Save POSTs a new metric, then lands on its detail. With
// an id it shows the metric (header + details grid); Edit turns the same page into the inline edit form
// (no modal); Save PUTs. A derived metric also shows its formula and the compiled JSON Logic it
// evaluates on read. Depends on api.js + shell.js (SM helpers) + metric-form.js (SMMetricForm).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";
  const isNewPage = !ID; // no id → the create page
  let METRIC = null;
  let CAN_WRITE = false;
  let editing = false;

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
      render();
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
      render();
    } catch (err) { fail(err.message || "Failed to load metric."); }
  }

  function render() {
    if (isNewPage || editing) renderForm();
    else renderView();
  }

  // ── Read view (details grid + Edit / Delete) ──
  function renderView() {
    const a = METRIC.attributes || {};
    const derived = a.kind === "DERIVED";
    const decorations = SMMetricForm.typePillHtml(a.type) + SMMetricForm.kindPillHtml(a.kind);
    const actions = CAN_WRITE
      ? '<button type="button" class="button buttonSecondary buttonSmall" id="m-edit">Edit</button>' +
        '<button type="button" class="button buttonDanger buttonSmall" id="m-delete">Delete</button>'
      : "";

    const left =
      SM.detailField("Name", { value: a.name, mono: true }) +
      SM.detailField("Label", { value: a.label }) +
      SM.detailField("Description", { value: a.description, emptyText: "—" }) +
      (derived
        ? SM.detailField("Formula", { value: SMMetricForm.formulaText(a.formula) }) +
          SM.detailField("Expression", { value: a.expr ? JSON.stringify(a.expr) : "—", mono: true })
        : "");
    const fmtPattern = a.format || (a.type === "INTEGER" ? "#,##0" : "#,##0.###");
    const sample = SM.formatNumber(/%/.test(fmtPattern) ? 0.1234 : 1234.567, fmtPattern) + (a.unit ? " " + a.unit : "");
    const right =
      SM.detailField("Type", { value: SMMetricForm.typeLabel(a.type) }) +
      SM.detailField("Unit", { value: a.unit, emptyText: "—" }) +
      SM.detailField("Format", { value: a.format || "Default", mono: true }) +
      SM.detailField("Sample", { value: sample, mono: true }) +
      SM.detailField("Kind", { value: SMMetricForm.kindLabel(a.kind) }) +
      SM.detailField("Created", { value: SM.fmtDateTime(a.created_at) }) +
      SM.detailField("Updated", { value: SM.fmtDateTime(a.updated_at) });

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.label || a.name || "Metric", decorations: decorations, secondaryId: a.name || "", actions: actions }) +
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div></div></div>" +
      '<div id="m-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.label || a.name || "Metric";
    document.title = (a.label || a.name || "Metric") + " — smplmark";

    if (CAN_WRITE) {
      $("m-edit").addEventListener("click", () => { editing = true; render(); });
      $("m-delete").addEventListener("click", del);
    }
  }

  // ── Inline edit / create form ──
  function renderForm() {
    const a = (METRIC && METRIC.attributes) || {};
    const title = isNewPage ? "New metric" : (a.label || a.name || "Metric");
    const actions =
      '<button type="button" class="button buttonSecondary buttonSmall" id="m-cancel">Cancel</button>' +
      '<button type="button" class="button buttonPrimary buttonSmall" id="m-save">Save</button>';

    $("detail-root").innerHTML =
      SM.detailHeader({ name: title, secondaryId: isNewPage ? "" : (a.name || ""), actions: actions }) +
      '<div class="detailsTabPanel"><form class="form" id="metric-edit-form" novalidate>' +
      SMMetricForm.render(a, { isNew: isNewPage }) + "</form></div>" +
      '<div id="m-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = title;
    document.title = title + " — smplmark";

    const form = $("metric-edit-form");
    SMMetricForm.wire(form, { isNew: isNewPage, selfName: isNewPage ? null : a.name, initFormula: a.formula });
    $("m-cancel").addEventListener("click", () => {
      if (isNewPage) location.href = "/account/metrics";
      else { editing = false; render(); }
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
        render();
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
