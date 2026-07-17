"use strict";

// Run detail (/account/runs/detail?id=…) — a conforming detail page for a single run: a DetailHeader
// with the run's key + status, and four tabs — Details (the run's info), Measurements (the run's
// recorded data, addable and correctable; on a published benchmark every change is recorded in the
// history), History (the run's audit trail), and API Keys (keys scoped to this run, for CI uploads).
// The API-key scope is implicit here, so creating one never asks the user for a scope or id. The
// run's fields (name, start/end) are edited from its benchmark's Runs tab.
// Depends on api.js + shell.js (SM helpers) + apikeys-panel.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";
  const TABS = ["details", "measurements", "history", "apikeys"];

  let RUN = null;
  let BENCH = null; // the parent benchmark (breadcrumb, measurement schema, freeze state)
  let CAN_ADMIN = false, CAN_WRITE = false;
  let SUBJECTS = {}; // subject_id → subject resource (measurement labels + the add picker)

  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }
  function fmtDateTime(iso) { return SM.fmtDateTime(iso) || "—"; }
  function statusPill(a) {
    if (a.invalidated || a.invalidated_at) return SM.statusPill("invalidated", "invalidated");
    if (a.ended_at || a.live === false) return SM.statusPill("ended", "ended");
    return SM.statusPill("live", "live");
  }

  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => fail("Failed to load your account."));

  window.addEventListener("hashchange", () => { if (RUN) renderTab(); });

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!ID) { fail("No run id."); return; }
    try {
      const doc = await apiFetch("/api/v1/runs/" + encodeURIComponent(ID));
      RUN = (doc && doc.data) || null;
      if (!RUN) { fail("Run not found."); return; }
      const benchId = (RUN.attributes || {}).benchmark;
      if (benchId) {
        try {
          const bd = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(benchId));
          BENCH = (bd && bd.data) || null;
        } catch (_e) { /* benchmark unreadable — fall back to a generic crumb */ }
      }
      renderShell();
    } catch (err) { fail(err.message || "Failed to load the run."); }
  }

  function renderShell() {
    const a = RUN.attributes || {};
    const tab = activeTab();
    const benchName = (BENCH && BENCH.attributes && (BENCH.attributes.name || BENCH.attributes.key)) || "Benchmark";
    const benchId = a.benchmark || "";

    SM.setBreadcrumbs([
      { label: "Benchmarks", href: "/account/benchmarks" },
      { label: benchName, href: "/account/benchmarks/detail?id=" + encodeURIComponent(benchId) + "#runs" },
      { label: a.key || "Run" },
    ]);
    document.title = (a.key || "Run") + " — smplmark";

    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.key || "Run", decorations: statusPill(a), secondaryId: a.name || "" }) +
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      tabBtn("details", "Details") + tabBtn("measurements", "Measurements") + tabBtn("history", "History") + tabBtn("apikeys", "API Keys") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div></div>' +
      '<div id="tab-panel"></div>';

    $("detail-root").querySelectorAll(".modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => { if (el.dataset.tab !== activeTab()) location.hash = el.dataset.tab; }));

    renderTab();
  }

  function renderTab() {
    const tab = activeTab();
    // keep the tab bar's active state in sync when navigating via hash
    $("detail-root").querySelectorAll(".modalTabBtn").forEach((el) => {
      const on = el.dataset.tab === tab;
      el.classList.toggle("isActive", on);
      el.setAttribute("aria-selected", String(on));
    });
    $("tab-actions").innerHTML = "";
    if (tab === "apikeys") renderApiKeys();
    else if (tab === "measurements") renderMeasurements();
    else if (tab === "history") renderHistory();
    else renderDetails();
  }

  function renderDetails() {
    const a = RUN.attributes || {};
    const benchId = a.benchmark || "";
    const benchName = (BENCH && BENCH.attributes && (BENCH.attributes.name || BENCH.attributes.key)) || benchId;
    const benchmarkField =
      '<div class="field"><span class="detailFieldLabel">Benchmark</span><span class="detailFieldValue">' +
      (benchId ? '<a class="authTextLink" href="/account/benchmarks/detail?id=' + encodeURIComponent(benchId) + '#runs">' + esc(benchName) + "</a>" : "—") +
      "</span></div>";

    const left =
      '<div class="field"><span class="detailFieldLabel">Run ID</span><span class="detailFieldValue isMono">' + esc(a.key || "") + "</span></div>" +
      SM.detailField("Name", { value: a.name, emptyText: "—" }) +
      '<div class="field"><span class="detailFieldLabel">Status</span><span class="detailFieldValue">' + statusPill(a) + "</span></div>" +
      benchmarkField;

    let right =
      SM.detailField("Started", { value: fmtDateTime(a.started_at) }) +
      SM.detailField("Ended", { value: a.ended_at ? fmtDateTime(a.ended_at) : "—" }) +
      SM.detailField("Created", { value: fmtDateTime(a.created_at) });
    if (a.invalidated || a.invalidated_at) {
      right +=
        SM.detailField("Invalidated", { value: fmtDateTime(a.invalidated_at) }) +
        SM.detailField("Reason", { value: a.invalidation_reason, emptyText: "—" });
    }

    $("tab-panel").innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div></div>" +
      '<p class="detailFieldHelp" style="margin-top:1rem;">Edit this run (name, start and end times) from its benchmark’s Runs tab.</p></div>';
  }

  // ── Measurements tab — the run's recorded data. Measurements may be added and corrected at any
  //    lifecycle stage (post-publish changes are recorded in the history; appending to an ended run
  //    gets its own history entry). Deletion is draft-only — published data never silently vanishes.
  //    Only the benchmark's closed signal refuses new data. ──
  function benchAttrs() { return (BENCH && BENCH.attributes) || {}; }
  function measSchema() { return benchAttrs().measurement_schema || { metrics: [], derived: [] }; }
  function schemaMetrics() {
    const s = measSchema();
    return (s.metrics || []).map((m) => ({ name: m.name, derived: false }))
      .concat((s.derived || []).map((d) => ({ name: d.name, derived: true })));
  }
  function fmtNum(v) {
    if (v == null || typeof v !== "number" || !isFinite(v)) return "—";
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  }
  function subjectLabel(id) { const s = SUBJECTS[id]; const a = (s && s.attributes) || {}; return a.name || a.key || id || "—"; }

  async function renderMeasurements() {
    const a = RUN.attributes || {};
    if (!BENCH) {
      // The benchmark supplies the metric columns and the freeze/permission state — without it the
      // tab would silently render wrong (no metric columns, no add/delete). Say so instead.
      $("tab-panel").innerHTML = '<div class="detailsTabPanel"><div class="errorBanner"><p>Couldn’t load this run’s benchmark — measurements can’t be shown. Reload to retry.</p></div></div>';
      return;
    }
    const ba = benchAttrs();
    const priv = String(ba.status || "").toUpperCase() === "PRIVATE";
    const canAdd = CAN_WRITE && !ba.closed;
    const canDel = CAN_WRITE && priv;
    if (canAdd) {
      $("tab-actions").innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-meas-btn">' + SM.icon("plus", 14) + " Add measurement</button>";
      $("add-meas-btn").addEventListener("click", openAddMeasurementModal);
    }
    $("tab-panel").innerHTML = '<div class="detailsTabPanel"><div id="meas-table"></div><div id="meas-msg" class="form-status" style="margin-top:0.5rem;"></div></div>';

    const cols = [
      { key: "subject", label: "Subject", sortable: true, sortValue: (m) => subjectLabel((m.attributes || {}).subject), render: (m) => esc(subjectLabel((m.attributes || {}).subject)) },
    ];
    schemaMetrics().forEach((mc) => cols.push({
      key: "m_" + mc.name, label: mc.name, sortable: true,
      sortValue: (m) => { const v = ((m.attributes || {}).metrics || {})[mc.name]; return typeof v === "number" ? v : ""; },
      render: (m) => esc(fmtNum(((m.attributes || {}).metrics || {})[mc.name])),
    }));
    cols.push({ key: "created_at", label: "Recorded", sortable: true, sortValue: (m) => (m.attributes || {}).created_at || "", render: (m) => esc(SM.fmtDateTime((m.attributes || {}).created_at)) });
    if (canDel) cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (m) =>
      '<button type="button" class="iconBtn meas-del" data-id="' + esc(m.id) + '" title="Delete measurement" aria-label="Delete measurement">' + SM.icon("trash", 15) + "</button>" });
    const table = SM.pagedTable($("meas-table"), {
      columns: cols, rows: [], sort: { key: "created_at", dir: "desc" }, emptyText: "No measurements in this run yet.",
      onRowClick: (m) => openMeasurementModal(m),
      onRender: canDel ? (c) => c.querySelectorAll(".meas-del").forEach((el) => el.addEventListener("click", (ev) => { ev.stopPropagation(); deleteMeasurement(el.dataset.id); })) : undefined,
    });
    try {
      const benchId = (RUN.attributes || {}).benchmark;
      const [measDoc, subjDoc] = await Promise.all([
        apiFetch("/api/v1/measurements?filter[run]=" + encodeURIComponent(ID) + "&page[size]=1000"),
        benchId ? apiFetch("/api/v1/subjects?filter[benchmark]=" + encodeURIComponent(benchId) + "&page[size]=1000") : Promise.resolve(null),
      ]);
      SUBJECTS = {};
      ((subjDoc && subjDoc.data) || []).forEach((su) => { SUBJECTS[su.id] = su; });
      table.setRows((measDoc && measDoc.data) || []);
    } catch (err) {
      $("meas-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Add-measurement modal (pick a subject; enter a value per stored metric — derived are computed) ──
  function openAddMeasurementModal() {
    const stored = measSchema().metrics || [];
    // The pick VALUE is the subject's key (what lands in the input); the label shows "name — key".
    const subjOptions = Object.values(SUBJECTS).map((su) => {
      const sa = su.attributes || {};
      return { value: sa.key || "", label: (sa.name || "") + (sa.key ? " — " + sa.key : "") };
    });
    const metricFields = stored.map((mm) => '<label class="field"><span class="detailFieldLabel">' + esc(mm.name) + '</span><input data-metric="' + esc(mm.name) + '" type="number" step="any" autocomplete="off" placeholder="optional" /></label>').join("");
    const bodyHtml =
      '<form class="form" id="add-meas-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Subject</span><input name="subject" type="text" autocomplete="off" placeholder="Pick a subject to measure" /><p class="fieldErrorMessage" hidden></p></label>' +
      (metricFields ? '<div class="subjectFormFields">' + metricFields + "</div>" : '<p class="detailFieldHelp">This benchmark has no stored metrics yet — add them on its Metrics tab to record values.</p>') +
      '<label class="field"><span class="detailFieldLabel">Recorded at</span><input name="created_at" type="text" autocomplete="off" placeholder="Defaults to now" /></label>' +
      '<p class="form-status" id="add-meas-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add measurement</button></div></form>';
    const m = SM.modal({ title: "Add measurement", description: "Record a measurement for a subject in run " + ((RUN.attributes || {}).key || "") + ".", bodyHtml: bodyHtml, width: 560 });
    const f = m.panel.querySelector("#add-meas-form");
    const msg = m.panel.querySelector("#add-meas-msg");
    SM.combobox(f.subject, { options: () => subjOptions, emptyText: "No matches." });
    f.subject.addEventListener("input", () => SM.clearFieldError(f.subject));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.subject);
      const val = f.subject.value.trim();
      if (!val) { SM.setFieldError(f.subject, "Pick a subject."); return; }
      const lower = val.toLowerCase();
      const list = Object.values(SUBJECTS);
      const match = list.find((su) => String((su.attributes || {}).key || "").toLowerCase() === lower) ||
        list.find((su) => String((su.attributes || {}).name || "").toLowerCase() === lower);
      if (!match) { SM.setFieldError(f.subject, "No such subject in this benchmark. Link it on the benchmark’s Subjects tab first."); return; }
      const metrics = {};
      f.querySelectorAll("[data-metric]").forEach((el) => { const v = el.value.trim(); if (v !== "") { const n = Number(v); if (isFinite(n)) metrics[el.getAttribute("data-metric")] = n; } });
      const attrs = { run: ID, subject: match.id };
      if (Object.keys(metrics).length) attrs.metrics = metrics;
      const c = f.created_at.value.trim(); if (c) attrs.created_at = c;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await apiFetch("/api/v1/measurements", { method: "POST", body: jsonapiBody("measurement", attrs) });
        m.close();
        renderMeasurements();
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  // ── Measurement view modal — values, plus "Correct…" for writers (edit-in-place; on a published
  //    benchmark the correction is recorded in the history with before/after). ──
  function openMeasurementModal(meas) {
    const a = meas.attributes || {};
    const metrics = a.metrics || {};
    const inSchema = new Set(schemaMetrics().map((mc) => mc.name));
    const rows = schemaMetrics().map((mc) =>
      '<div class="field"><span class="detailFieldLabel">' + esc(mc.name) + (mc.derived ? ' <span class="typePill kindDerived">derived</span>' : "") + '</span><span class="detailFieldValue isMono">' + esc(fmtNum(metrics[mc.name])) + "</span></div>").join("");
    const extra = Object.keys(metrics).filter((k) => !inSchema.has(k)).map((k) =>
      '<div class="field"><span class="detailFieldLabel">' + esc(k) + '</span><span class="detailFieldValue isMono">' + esc(fmtNum(metrics[k])) + "</span></div>").join("");
    const metaBlock = (a.meta && Object.keys(a.meta).length)
      ? '<div class="field"><span class="detailFieldLabel">Meta</span><pre style="margin:0;white-space:pre-wrap;font-family:var(--mono);font-size:0.82rem;color:var(--text-muted);">' + esc(JSON.stringify(a.meta, null, 2)) + "</pre></div>"
      : "";
    const bodyHtml =
      '<div class="stack">' +
      '<div class="field"><span class="detailFieldLabel">Subject</span><span class="detailFieldValue">' + esc(subjectLabel(a.subject)) + "</span></div>" +
      '<div class="field"><span class="detailFieldLabel">Recorded at</span><span class="detailFieldValue">' + esc(SM.fmtDateTime(a.created_at)) + "</span></div>" +
      (rows || extra ? '<div class="subjectFormFields">' + rows + extra + "</div>" : "") +
      metaBlock +
      '<div class="modalActions">' +
      (CAN_WRITE ? '<button type="button" class="button buttonSecondary buttonSmall" id="meas-correct" style="margin-right:auto;">Correct…</button>' : "") +
      '<button type="button" class="button buttonPrimary buttonSmall" data-close>Close</button></div></div>';
    const m = SM.modal({ title: "Measurement", description: "Values recorded for this subject in the run.", bodyHtml: bodyHtml, width: 520 });
    const correct = m.panel.querySelector("#meas-correct");
    if (correct) correct.addEventListener("click", () => { m.close(); openCorrectMeasurementModal(meas); });
  }

  // ── Correct-measurement modal — full-replace of stored metric values and the recorded-at time.
  //    Derived values recompute; the run and subject are fixed. ──
  function openCorrectMeasurementModal(meas) {
    const a = meas.attributes || {};
    const metrics = a.metrics || {};
    const priv = String(benchAttrs().status || "").toUpperCase() === "PRIVATE";
    const stored = measSchema().metrics || [];
    const metricFields = stored.map((mm) => {
      const v = metrics[mm.name];
      const val = typeof v === "number" && isFinite(v) ? String(v) : "";
      return '<label class="field"><span class="detailFieldLabel">' + esc(mm.name) + '</span><input data-metric="' + esc(mm.name) + '" type="number" step="any" autocomplete="off" value="' + esc(val) + '" placeholder="optional" /></label>';
    }).join("");
    const bodyHtml =
      '<form class="form" id="correct-meas-form" novalidate>' +
      '<div class="field"><span class="detailFieldLabel">Subject</span><span class="detailFieldValue">' + esc(subjectLabel(a.subject)) + "</span></div>" +
      (metricFields ? '<div class="subjectFormFields">' + metricFields + "</div>" : "") +
      '<label class="field"><span class="detailFieldLabel">Recorded at</span><input name="created_at" type="text" autocomplete="off" value="' + esc(a.created_at || "") + '" /></label>' +
      '<p class="form-status" id="correct-meas-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Save correction</button></div></form>';
    const m = SM.modal({
      title: "Correct measurement",
      description: priv
        ? "Replace this measurement’s values."
        : "Replace this measurement’s values. This benchmark is published, so the correction is recorded in its public history with the values before and after.",
      bodyHtml: bodyHtml,
      width: 560,
    });
    const f = m.panel.querySelector("#correct-meas-form");
    const msg = m.panel.querySelector("#correct-meas-msg");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      // Full-replace PUT: seed with the measurement's out-of-schema stored values first — a
      // metric unlinked after this measurement was recorded leaves its stored value on the row,
      // and a correction must not silently erase it. Derived names are excluded (computed on
      // read, never stored); the schema's stored metrics then come from the form inputs.
      const newMetrics = {};
      const schemaNames = new Set(schemaMetrics().map((mc) => mc.name));
      Object.entries((a.metrics || {})).forEach(([k, v]) => { if (!schemaNames.has(k) && typeof v === "number" && isFinite(v)) newMetrics[k] = v; });
      f.querySelectorAll("[data-metric]").forEach((el) => { const v = el.value.trim(); if (v !== "") { const n = Number(v); if (isFinite(n)) newMetrics[el.getAttribute("data-metric")] = n; } });
      // meta round-trips unchanged; created_at is sent as edited.
      const attrs = {};
      if (Object.keys(newMetrics).length) attrs.metrics = newMetrics;
      if (a.meta && Object.keys(a.meta).length) attrs.meta = a.meta;
      const c = f.created_at.value.trim(); if (c) attrs.created_at = c;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await apiFetch("/api/v1/measurements/" + encodeURIComponent(meas.id), { method: "PUT", body: jsonapiBody("measurement", attrs) });
        m.close();
        SM.toast("Measurement corrected.", { kind: "success" });
        renderMeasurements();
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  // ── History tab — this run's audit trail. ──
  function eventLabel(t) {
    const labels = {
      "run.created": "Created", "run.edited": "Edited", "run.ended": "Ended", "run.reopened": "Reopened",
      "run.appended": "Appended after end", "run.invalidated": "Invalidated",
    };
    return labels[t] || t;
  }
  function actorLabel(actor) {
    if (!actor) return "—";
    if (actor.label) return actor.label;
    if (actor.type === "API_KEY") return "an API key";
    return actor.type ? String(actor.type).toLowerCase() : "—";
  }
  async function renderHistory() {
    $("tab-panel").innerHTML = '<div class="detailsTabPanel"><div id="history-table"></div></div>';
    const table = SM.pagedTable($("history-table"), {
      columns: [
        { key: "when", label: "When", sortable: true, sortValue: (e) => (e.attributes || {}).occurred_at || "", render: (e) => esc(fmtDateTime((e.attributes || {}).occurred_at)) },
        { key: "event", label: "Event", sortable: true, sortValue: (e) => (e.attributes || {}).event_type || "", render: (e) => esc(eventLabel((e.attributes || {}).event_type)) },
        { key: "description", label: "What happened", sortable: false, render: (e) => esc((e.attributes || {}).description || "") },
        { key: "actor", label: "By", sortable: false, render: (e) => esc(actorLabel((e.attributes || {}).actor)) },
      ],
      rows: [], sort: { key: "when", dir: "desc" }, emptyText: "No history recorded yet.",
    });
    try {
      const doc = await apiFetch("/api/v1/runs/" + encodeURIComponent(ID) + "/history");
      table.setRows((doc && doc.data) || []);
    } catch (err) {
      $("history-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  async function deleteMeasurement(measId) {
    const ok = await SM.confirm({ title: "Delete measurement?", message: "Delete this measurement? This can't be undone.", confirmLabel: "Delete" });
    if (!ok) return;
    try { await apiFetch("/api/v1/measurements/" + encodeURIComponent(measId), { method: "DELETE" }); renderMeasurements(); }
    catch (err) { const el = $("meas-msg"); if (el) { el.textContent = err.message; el.className = "form-status is-error"; } }
  }

  function renderApiKeys() {
    SMApiKeys.mount({
      host: $("tab-panel"),
      actions: $("tab-actions"),
      scopeType: "RUN",
      scopeRef: ID,
      canAdmin: CAN_ADMIN,
    });
  }
})();
