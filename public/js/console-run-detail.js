"use strict";

// Run detail (/benchmarks/{benchmarkKey}/runs/{runKey}) — a conforming detail page for a single run:
// a DetailHeader with the run's key + status, and five tabs — Details (info + Edit / Delete /
// Invalidate), Measurements (add / correct / delete the run's recorded data), History (the run's
// audit trail), API Keys (keys scoped to this run, for CI uploads), and API Reference (how to POST
// measurements to this run). The legacy ?id= run-uuid form is still accepted (old links).
// Depends on api.js + shell.js (SM helpers) + apikeys-panel.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  // Pretty route /benchmarks/{bkey}/runs/{runKey}; ?id= (the run's uuid) is kept as a fallback.
  const PATH = (function () {
    const m = /^\/benchmarks\/([^/]+)\/runs\/([^/]+)\/?$/.exec(location.pathname);
    return m ? { bkey: decodeURIComponent(m[1]), runKey: decodeURIComponent(m[2]) } : null;
  })();
  const QUERY_ID = new URLSearchParams(location.search).get("id") || "";
  let ID = QUERY_ID;  // the run's uuid, resolved on load (from the keys when pretty-routed)
  let ACCOUNT_ID = null;
  const TABS = ["details", "measurements", "history", "apikeys", "apireference"];

  let RUN = null;
  let BENCH = null; // the parent benchmark (breadcrumb, measurement schema, freeze state)
  let CAN_ADMIN = false, CAN_WRITE = false;
  let SUBJECTS = {}; // subject_id → subject resource (measurement labels + the add picker)

  // Measurements tab — fetched once per tab entry (measurements + the benchmark's subjects), then
  // filtered client-side by subject and time window. A trashcan does an optimistic remove with a
  // deferred delete (the DELETE fires when the Undo window closes; Undo cancels it).
  let MEAS_ALL = [];             // the run's measurement resources (the master list to filter from)
  let MEAS_TABLE = null;         // the pagedTable handle (setRows re-renders on any filter change)
  let MEAS_SUBJECT_SHOWN = null; // Set<subjectKey> currently checked/shown; null before the first load
  let MEAS_RANGE = "all";        // active time-window key; persists across tab re-entry

  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }
  function fmtDateTime(iso) { return SM.fmtDateTime(iso) || "—"; }
  function benchKey() { return (BENCH && BENCH.attributes && (BENCH.attributes.key)) || ""; }
  function benchHref() { return "/benchmarks/" + encodeURIComponent(benchKey()); }
  function statusPill(a) {
    if (a.invalidated || a.invalidated_at) return SM.statusPill("invalidated", "invalidated");
    if (a.ended_at || a.live === false) return SM.statusPill("ended", "ended");
    return SM.statusPill("live", "live");
  }

  SM.ready.then((id) => {
    ACCOUNT_ID = id.accountId;
    CAN_ADMIN = id.canAdmin;
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => fail("Failed to load your account."));

  window.addEventListener("hashchange", () => { if (RUN) renderTab(); });

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!QUERY_ID && !PATH) { fail("No run specified."); return; }
    try {
      if (QUERY_ID) {
        RUN = (await apiFetch("/api/v1/runs/" + encodeURIComponent(QUERY_ID))).data || null;
      } else {
        // Resolve the benchmark by key first (own account, any status), then the run by its key.
        const bl = await apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent(ACCOUNT_ID) + "&filter[key]=" + encodeURIComponent(PATH.bkey));
        BENCH = (bl && bl.data && bl.data[0]) || null;
        if (!BENCH) { fail("Benchmark not found."); return; }
        const rl = await apiFetch("/api/v1/runs?filter[benchmark]=" + encodeURIComponent(BENCH.id) + "&filter[key]=" + encodeURIComponent(PATH.runKey));
        RUN = (rl && rl.data && rl.data[0]) || null;
      }
      if (!RUN) { fail("Run not found."); return; }
      ID = RUN.id;
      if (!BENCH) {
        const benchId = (RUN.attributes || {}).benchmark;
        if (benchId) {
          try { BENCH = (await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(benchId))).data || null; } catch (_e) { /* generic crumb */ }
        }
      }
      renderShell();
    } catch (err) { fail(err.message || "Failed to load the run."); }
  }

  function renderShell() {
    const a = RUN.attributes || {};
    const tab = activeTab();
    const benchName = (BENCH && BENCH.attributes && (BENCH.attributes.name || BENCH.attributes.key)) || "Benchmark";
    const benchId = a.benchmark || "";

    // Benchmarks / <benchmark> / Runs / <run key>.
    SM.setBreadcrumbs([
      { label: "Benchmarks", href: "/benchmarks" },
      { label: benchName, href: benchHref() },
      { label: "Runs", href: benchHref() + "#runs" },
      { label: a.key || "Run" },
    ]);
    document.title = (a.key || "Run") + " — smplmark";

    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.key || "Run", decorations: statusPill(a), secondaryId: a.name || "" }) +
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      tabBtn("details", "Details") + tabBtn("measurements", "Measurements") + tabBtn("history", "History") + tabBtn("apikeys", "API Keys") + tabBtn("apireference", "API Reference") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div></div>' +
      '<div id="tab-panel"></div>';

    SM.wireCopyButtons($("detail-root"));
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
    else if (tab === "apireference") renderApiReference();
    else renderDetails();
  }

  function renderDetails() {
    const a = RUN.attributes || {};
    const benchName = (BENCH && BENCH.attributes && (BENCH.attributes.name || BENCH.attributes.key)) || (a.benchmark || "");
    const priv = String(benchAttrs().status || "").toUpperCase() === "PRIVATE";
    const invalidated = !!(a.invalidated || a.invalidated_at);
    const benchmarkField =
      '<div class="field"><span class="detailFieldLabel">Benchmark</span><span class="detailFieldValue">' +
      (benchKey() ? '<a class="authTextLink" href="' + benchHref() + '#runs">' + esc(benchName) + "</a>" : esc(benchName || "—")) +
      "</span></div>";

    // Actions in the tab row (the standard for detail pages): Edit, then Delete on a draft benchmark
    // or Invalidate on a published one (a published run is never deleted — the record must not vanish).
    if (CAN_WRITE) {
      const b = (label, id, kind) => '<button type="button" class="button button' + (kind || "Secondary") + ' buttonSmall" id="' + id + '">' + esc(label) + "</button>";
      $("tab-actions").innerHTML = b("Edit", "run-edit") +
        (priv ? b("Delete", "run-delete", "Danger") : (!invalidated ? b("Invalidate", "run-invalidate", "Danger") : ""));
    }

    const left =
      '<div class="field"><span class="detailFieldLabel">Run ID</span><span class="detailFieldValue isMono">' + esc(a.key || "") + "</span></div>" +
      SM.detailField("Name", { value: a.name, emptyText: "—" }) +
      '<div class="field"><span class="detailFieldLabel">Status</span><span class="detailFieldValue">' + statusPill(a) + "</span></div>" +
      benchmarkField;

    let right =
      SM.detailField("Started", { value: fmtDateTime(a.started_at) }) +
      SM.detailField("Ended", { value: a.ended_at ? fmtDateTime(a.ended_at) : "—" }) +
      SM.detailField("Created", { value: fmtDateTime(a.created_at) });
    if (invalidated) {
      right +=
        SM.detailField("Invalidated", { value: fmtDateTime(a.invalidated_at) }) +
        SM.detailField("Reason", { value: a.invalidation_reason, emptyText: "—" });
    }

    $("tab-panel").innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div></div>" +
      '<div id="run-msg" class="form-status" style="margin-top:0.75rem;"></div></div>';

    const editBtn = $("run-edit"); if (editBtn) editBtn.addEventListener("click", openEditRunModal);
    const delBtn = $("run-delete"); if (delBtn) delBtn.addEventListener("click", doDeleteRun);
    const invBtn = $("run-invalidate"); if (invBtn) invBtn.addEventListener("click", doInvalidateRun);
  }

  function runMsg(text, kind) {
    const el = $("run-msg");
    if (el) { el.textContent = text || ""; el.className = "form-status" + (text ? " is-" + (kind || "error") : ""); }
  }

  // datetime-local <-> ISO: the picker works in the viewer's local time; the API stores UTC.
  function dtLocalValue(v) {
    if (!v) return "";
    const d = new Date(v); if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function dtLocalToIso(v) {
    if (!v) return null;
    const d = new Date(v); return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  // ── Edit-run modal — name + start/end (the run ID is fixed at creation). On a published benchmark
  //    the edit is recorded in the run's history; clearing "Ended at" returns the run to live. ──
  function openEditRunModal() {
    const a = RUN.attributes || {};
    const priv = String(benchAttrs().status || "").toUpperCase() === "PRIVATE";
    const bodyHtml =
      '<form class="form" id="run-edit-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel">Run ID</span><input type="text" value="' + esc(a.key || "") + '" disabled /><p class="detailFieldHelp">Fixed once the run is created.</p></label>' +
      '<label class="field"><span class="detailFieldLabel">Name</span><input name="name" type="text" autocomplete="off" placeholder="Optional — a label for this run" value="' + esc(a.name || "") + '" /></label>' +
      '<label class="field"><span class="detailFieldLabel">Started at</span><input name="started_at" type="datetime-local" value="' + esc(dtLocalValue(a.started_at)) + '" /></label>' +
      '<label class="field"><span class="detailFieldLabel">Ended at</span><input name="ended_at" type="datetime-local" value="' + esc(dtLocalValue(a.ended_at)) + '" /><p class="detailFieldHelp">Leave blank while the run is still live.</p></label>' +
      '<p class="form-status" id="run-edit-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Save</button></div></form>';
    const m = SM.modal({
      title: "Edit run " + (a.key || ""),
      description: priv ? "Edit this run’s name and times." : "Edit this run — this benchmark is published, so changes are recorded in its public history.",
      bodyHtml: bodyHtml, width: 560,
    });
    const f = m.panel.querySelector("#run-edit-form");
    const msg = (t, k) => { const el = m.panel.querySelector("#run-edit-msg"); el.textContent = t || ""; el.className = "form-status" + (t ? " is-" + (k || "error") : ""); };
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg("");
      const started = dtLocalToIso(f.started_at.value);
      const ended = dtLocalToIso(f.ended_at.value);
      if (started === undefined || ended === undefined) { msg("Enter valid dates."); return; }
      if (started && ended && new Date(ended) < new Date(started)) { msg("Ended at must not be earlier than Started at."); return; }
      // Full-replace PUT: name/details are replaced (details round-trips from the resource). Timestamps
      // are sent only when the picker value actually changed — the picker is minute-precision, so
      // re-sending an untouched value would truncate stored seconds.
      const attrs = { name: f.name.value.trim() || null, details: a.details ?? null };
      if (f.started_at.value !== dtLocalValue(a.started_at)) attrs.started_at = started;
      if (f.ended_at.value !== dtLocalValue(a.ended_at)) attrs.ended_at = ended;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        RUN = (await apiFetch("/api/v1/runs/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("run", attrs) })).data || RUN;
        m.close();
        SM.toast("Run saved.", { kind: "success" });
        renderShell();
      } catch (err) { submit.disabled = false; msg(err.message); }
    });
  }

  async function doInvalidateRun() {
    const reason = await SM.confirm({ title: "Invalidate run?", message: "Invalidated runs stay visible but are flagged and excluded from published results. This can’t be undone.", confirmLabel: "Invalidate", reason: { label: "Reason (optional)", placeholder: "Why is this run invalid?" } });
    if (reason === null) return;
    const attrs = {};
    if (reason) attrs.invalidation_reason = reason;
    try {
      RUN = (await apiFetch("/api/v1/runs/" + encodeURIComponent(ID) + "/actions/invalidate", { method: "POST", body: jsonapiBody("run", attrs) })).data || RUN;
      renderShell();
    } catch (err) { runMsg(err.message, "error"); }
  }

  async function doDeleteRun() {
    const a = RUN.attributes || {};
    let count = null;
    try {
      const d = await apiFetch("/api/v1/measurements?filter[run]=" + encodeURIComponent(ID) + "&meta[total]=true&page[size]=1");
      count = (d && d.meta && d.meta.pagination && d.meta.pagination.total) || 0;
    } catch (_e) { /* count unavailable — warn generically */ }
    const message = count > 0
      ? "Run <strong>" + esc(a.key || "") + "</strong> contains <strong>" + count + " measurement" + (count === 1 ? "" : "s") + "</strong>. Deleting the run permanently deletes them too. This can’t be undone."
      : "Delete run <strong>" + esc(a.key || "") + "</strong>? This can’t be undone.";
    const ok = await SM.confirm({ title: "Delete run?", message: message, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await apiFetch("/api/v1/runs/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = benchHref() + "#runs";
    } catch (err) { runMsg(err.message, "error"); }
  }

  // ── Measurements tab — the run's recorded data, with a subject-filter rail (left) and a
  //    range/refresh toolbar over the table (right). Measurements may be added and corrected at any
  //    lifecycle stage (post-publish changes are recorded in the history; appending to an ended run
  //    gets its own history entry). Deletion is now allowed at any stage too (owner-approved policy):
  //    the trashcan removes the row optimistically and defers the DELETE until the Undo window closes,
  //    so a published removal is still audited server-side. Only the benchmark's closed signal refuses
  //    NEW data. ──
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

  // Time-window presets (mirror the public viewer): a preset is "the last N as of now", or all time.
  const MEAS_RANGES = [
    { key: "all", label: "All time", seconds: null },
    { key: "24h", label: "Last 24 hours", seconds: 86400 },
    { key: "7d", label: "Last 7 days", seconds: 7 * 86400 },
    { key: "30d", label: "Last 30 days", seconds: 30 * 86400 },
  ];

  async function renderMeasurements() {
    if (!BENCH) {
      // The benchmark supplies the metric columns and the freeze/permission state — without it the
      // tab would silently render wrong (no metric columns, no add/delete). Say so instead.
      $("tab-panel").innerHTML = '<div class="detailsTabPanel"><div class="errorBanner"><p>Couldn’t load this run’s benchmark — measurements can’t be shown. Reload to retry.</p></div></div>';
      return;
    }
    // Fresh entry: drop any prior tab's data so the first paint is a clean "Loading…" (the range
    // selection persists — it's module state read back into the dropdown below).
    MEAS_ALL = [];
    MEAS_SUBJECT_SHOWN = null;
    const ba = benchAttrs();
    const canAdd = CAN_WRITE && !ba.closed;
    // Deletion is no longer draft-only (Part A): a writer may delete at any publish stage, and the
    // removal is audited server-side. The marked-ready freeze still refuses the write (409), which
    // the deferred-delete's failure path surfaces.
    const canDel = CAN_WRITE;
    if (canAdd) {
      $("tab-actions").innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-meas-btn">' + SM.icon("plus", 14) + " Add measurement</button>";
      $("add-meas-btn").addEventListener("click", openAddMeasurementModal);
    }

    // A range/refresh toolbar over a two-pane body: the subject filter rail (left) + the table (right).
    const rangeSel = '<label class="measRange">Range' +
      '<select id="meas-range">' +
      MEAS_RANGES.map((r) => '<option value="' + esc(r.key) + '"' + (r.key === MEAS_RANGE ? " selected" : "") + ">" + esc(r.label) + "</option>").join("") +
      "</select></label>";
    $("tab-panel").innerHTML =
      '<div id="meas-toolbar"></div>' +
      '<div class="measLayout">' +
      '<aside class="measFilter" id="meas-subjects"></aside>' +
      '<div class="measMain"><div id="meas-table"></div></div></div>' +
      '<div id="meas-msg" class="form-status" style="margin-top:0.5rem;"></div>';
    const bar = SM.toolbar({ search: false, extraRight: rangeSel, onRefresh: reloadMeasurements });
    $("meas-toolbar").appendChild(bar);
    const rangeEl = bar.querySelector("#meas-range");
    if (rangeEl) rangeEl.addEventListener("change", () => { MEAS_RANGE = rangeEl.value; applyMeasFilters(); });

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
    MEAS_TABLE = SM.pagedTable($("meas-table"), {
      columns: cols, rows: [], sort: { key: "created_at", dir: "desc" }, emptyText: "No measurements in this run yet.",
      // A writer clicks a row to correct the measurement; a read-only viewer just sees its values.
      onRowClick: (m) => (CAN_WRITE ? openCorrectMeasurementModal(m) : openMeasurementModal(m)),
      onRender: canDel ? (c) => c.querySelectorAll(".meas-del").forEach((el) => el.addEventListener("click", (ev) => { ev.stopPropagation(); deleteMeasurementDeferred(el.dataset.id); })) : undefined,
    });

    renderSubjectFilter(); // renders "Loading…" until the fetch lands, then re-renders with subjects
    await loadMeasurements();
  }

  // Fetch the run's measurements + the benchmark's subjects (once per tab entry). Seeds the master
  // list and the subject-filter set (all checked), then applies the active filters to the table.
  async function loadMeasurements() {
    if (!MEAS_TABLE) return;
    try {
      const benchId = (RUN.attributes || {}).benchmark;
      const [measDoc, subjDoc] = await Promise.all([
        apiFetch("/api/v1/measurements?filter[run]=" + encodeURIComponent(ID) + "&page[size]=1000"),
        benchId ? apiFetch("/api/v1/subjects?filter[benchmark]=" + encodeURIComponent(benchId) + "&page[size]=1000") : Promise.resolve(null),
      ]);
      SUBJECTS = {};
      ((subjDoc && subjDoc.data) || []).forEach((su) => { SUBJECTS[su.id] = su; });
      MEAS_ALL = (measDoc && measDoc.data) || [];
      MEAS_SUBJECT_SHOWN = new Set(measSubjectEntries().map((e) => e.key)); // default: every subject shown
      renderSubjectFilter();
      applyMeasFilters();
    } catch (err) {
      MEAS_ALL = [];
      MEAS_SUBJECT_SHOWN = new Set(); // settle the rail out of its "Loading…" state (the table shows the error)
      renderSubjectFilter();
      $("meas-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // The refresh button re-fetches from the server. The time-window stays as selected (module state);
  // the subject checkboxes reset to all-shown, since the subject set may have changed under us.
  async function reloadMeasurements() { await loadMeasurements(); }

  // The subjects offered in the filter rail: the benchmark's linked subjects plus any subject a
  // measurement references (so every row is representable), sorted by their display label.
  function measSubjectEntries() {
    const keys = new Set(Object.keys(SUBJECTS));
    MEAS_ALL.forEach((m) => { const k = (m.attributes || {}).subject; if (k) keys.add(k); });
    return Array.from(keys)
      .map((k) => ({ key: k, label: subjectLabel(k) }))
      .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true, sensitivity: "base" }));
  }

  // Re-derive the visible rows from the master list under the current subject + time-window filters.
  function applyMeasFilters() {
    if (!MEAS_TABLE) return;
    const rangeSec = (MEAS_RANGES.find((r) => r.key === MEAS_RANGE) || {}).seconds;
    const minTs = rangeSec ? Date.now() - rangeSec * 1000 : null;
    const shown = MEAS_SUBJECT_SHOWN;
    const rows = MEAS_ALL.filter((m) => {
      const a = m.attributes || {};
      if (shown && !shown.has(a.subject)) return false;
      if (minTs !== null) { const t = new Date(a.created_at).getTime(); if (!isFinite(t) || t < minTs) return false; }
      return true;
    });
    MEAS_TABLE.setRows(rows);
  }

  // ── Subject filter rail — one checkbox per subject (all checked by default), each with a hover
  //    "Only" quick-pick that narrows to just that subject; an "All" reset appears when narrowed. ──
  function setSubjectShown(key, on) {
    if (!MEAS_SUBJECT_SHOWN) MEAS_SUBJECT_SHOWN = new Set(measSubjectEntries().map((e) => e.key));
    if (on) MEAS_SUBJECT_SHOWN.add(key); else MEAS_SUBJECT_SHOWN.delete(key);
    renderSubjectFilter();
    applyMeasFilters();
  }
  function onlySubject(key) {
    MEAS_SUBJECT_SHOWN = new Set([key]);
    renderSubjectFilter();
    applyMeasFilters();
  }
  function showAllSubjects() {
    MEAS_SUBJECT_SHOWN = new Set(measSubjectEntries().map((e) => e.key));
    renderSubjectFilter();
    applyMeasFilters();
  }
  function renderSubjectFilter() {
    const host = $("meas-subjects");
    if (!host) return;
    const entries = measSubjectEntries();
    const shown = MEAS_SUBJECT_SHOWN;
    const loading = shown === null;
    const allShown = !loading && entries.length > 0 && entries.every((e) => shown.has(e.key));
    let html = '<div class="measFilterHead"><span class="measFilterTitle">Subjects</span>' +
      (!loading && !allShown ? '<button type="button" class="measFilterAll" id="meas-subj-all">All</button>' : "") + "</div>";
    if (loading) {
      html += '<p class="measFilterEmpty">Loading…</p>';
    } else if (entries.length === 0) {
      html += '<p class="measFilterEmpty">No subjects in this run.</p>';
    } else {
      html += '<div class="measFilterList">' + entries.map((e) => {
        const on = shown.has(e.key);
        return '<div class="measFilterRow">' +
          '<label class="measFilterCheck"><input type="checkbox" data-subj="' + esc(e.key) + '"' + (on ? " checked" : "") + " /> " +
          '<span class="measFilterName" title="' + esc(e.label) + '">' + esc(e.label) + "</span></label>" +
          '<button type="button" class="measFilterOnly" data-only="' + esc(e.key) + '" title="Show only this subject">Only</button>' +
          "</div>";
      }).join("") + "</div>";
    }
    host.innerHTML = html;
    host.querySelectorAll("input[data-subj]").forEach((cb) =>
      cb.addEventListener("change", () => setSubjectShown(cb.getAttribute("data-subj"), cb.checked)));
    host.querySelectorAll(".measFilterOnly").forEach((b) =>
      b.addEventListener("click", () => onlySubject(b.getAttribute("data-only"))));
    const allBtn = $("meas-subj-all");
    if (allBtn) allBtn.addEventListener("click", showAllSubjects);
  }

  // ── Per-row delete — optimistic remove + deferred DELETE with an Undo window. The row leaves the
  //    table immediately; the actual DELETE fires only when the Undo toast dismisses (~5s). Undo puts
  //    the row back and sends no request; a failed deferred DELETE restores the row + an error toast. ──
  function deleteMeasurementDeferred(measId) {
    const idx = MEAS_ALL.findIndex((m) => String(m.id) === String(measId));
    if (idx < 0) return;
    const removed = MEAS_ALL[idx];
    MEAS_ALL.splice(idx, 1); // optimistic remove — the table re-sorts, so exact position is cosmetic
    applyMeasFilters();
    SM.toast("Measurement deleted", {
      kind: "info",
      duration: 5000,
      action: { label: "Undo", onClick: () => { MEAS_ALL.splice(Math.min(idx, MEAS_ALL.length), 0, removed); applyMeasFilters(); } },
      onDismiss: () => commitMeasurementDelete(measId, removed, idx),
    });
  }
  async function commitMeasurementDelete(measId, removed, idx) {
    try {
      await apiFetch("/api/v1/measurements/" + encodeURIComponent(measId), { method: "DELETE" });
    } catch (err) {
      // The delete didn't happen — put the row back (if it isn't already) and surface the failure.
      if (!MEAS_ALL.some((m) => String(m.id) === String(measId))) MEAS_ALL.splice(Math.min(idx, MEAS_ALL.length), 0, removed);
      applyMeasFilters();
      SM.toast(err.message || "Couldn’t delete the measurement.", { kind: "error" });
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
    $("tab-panel").innerHTML = '<div id="history-table"></div>';
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

  // ── API Reference tab — everything needed to POST measurements to this run from CI: the HTTP
  //    method, the endpoint URL, the headers (a run-scoped API key + JSON:API content type), and an
  //    example request body pre-filled with this run's id and its benchmark's stored metrics. ──
  function codeBlock(id, text) {
    return '<div class="apiRefBlock"><button type="button" class="apiRefCopy" data-copy="' + id + '" title="Copy">' + SM.icon("copy", 14) + " Copy</button>" +
      '<pre id="' + id + '" class="apiRefPre">' + esc(text) + "</pre></div>";
  }
  async function renderApiReference() {
    const url = location.origin + "/api/v1/measurements";
    const stored = measSchema().metrics || [];
    let subjectId = "<subject-id>";
    let subjectNote = "";
    try {
      const benchId = (RUN.attributes || {}).benchmark;
      const sd = benchId ? await apiFetch("/api/v1/subjects?filter[benchmark]=" + encodeURIComponent(benchId) + "&page[size]=1") : null;
      const s0 = sd && sd.data && sd.data[0];
      if (s0) subjectId = s0.id;
      else subjectNote = "This benchmark has no subjects yet — link one on the benchmark’s Subjects tab, then use its id as “subject” below.";
    } catch (_e) { /* fall back to the placeholder id */ }

    const metricsExample = {};
    stored.forEach((mm, i) => { metricsExample[mm.name] = i === 0 ? 123.4 : 42; });
    const payload = { data: { type: "measurement", attributes: { run: ID, subject: subjectId, metrics: metricsExample } } };
    const payloadStr = JSON.stringify(payload, null, 2);
    const curl =
      "curl -X POST '" + url + "' \\\n" +
      "  -H 'Authorization: Bearer <run-scoped-api-key>' \\\n" +
      "  -H 'Content-Type: application/vnd.api+json' \\\n" +
      "  -d '" + JSON.stringify(payload) + "'";

    const headersRows = [
      ["Authorization", "Bearer &lt;run-scoped-api-key&gt;"],
      ["Content-Type", "application/vnd.api+json"],
    ].map(([k, v]) => '<tr><td class="apiRefHKey">' + esc(k) + '</td><td class="apiRefHVal">' + v + "</td></tr>").join("");

    $("tab-panel").innerHTML =
      '<div class="detailsTabPanel apiRef">' +
      '<p class="muted" style="margin:0 0 1rem;">Record measurements for this run from anywhere (CI, a script) by POSTing to the measurements endpoint. Authenticate with an API key scoped to this run — create one on the <a class="authTextLink" href="#apikeys">API Keys</a> tab.</p>' +
      '<div class="apiRefRow"><span class="apiRefMethod">POST</span><code class="apiRefUrl">' + esc(url) + "</code></div>" +
      '<h3 class="apiRefH">Headers</h3><table class="apiRefHeaders">' + headersRows + "</table>" +
      '<h3 class="apiRefH">Request body</h3>' +
      (subjectNote ? '<p class="detailFieldHelp" style="margin:0 0 0.5rem;">' + esc(subjectNote) + "</p>" : "") +
      codeBlock("apiref-body", payloadStr) +
      '<h3 class="apiRefH">Example (curl)</h3>' +
      codeBlock("apiref-curl", curl) +
      "</div>";

    // Deep-link the API Keys tab, and wire the copy buttons.
    $("tab-panel").querySelectorAll('a[href="#apikeys"]').forEach((el) => el.addEventListener("click", (ev) => { ev.preventDefault(); location.hash = "apikeys"; }));
    $("tab-panel").querySelectorAll(".apiRefCopy").forEach((btn) => btn.addEventListener("click", () => {
      const pre = $(btn.dataset.copy);
      if (pre && navigator.clipboard) navigator.clipboard.writeText(pre.textContent).then(() => SM.toast("Copied.", { kind: "success" })).catch(() => {});
    }));
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
