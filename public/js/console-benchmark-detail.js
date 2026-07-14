"use strict";

// Benchmark detail (/account/benchmarks/detail?id=…) — a conforming detail page: DetailHeader with
// the lifecycle actions, Details (view/edit 2-column form), Subjects, and Runs tabs. Runs and subjects
// are both benchmark children now. Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  const ID = new URLSearchParams(location.search).get("id") || "";
  let BM = null;
  let CAN_WRITE = false, CAN_ADMIN = false, USER_ID = null, ALLOW_PERSONAL = false;
  // Per-tab counts shown as badges; null until first loaded, then kept in sync as each tab's data loads.
  const COUNTS = { subjects: null, metrics: null, runs: null, apikeys: null };

  // Edit-mode state for the Details tab.
  let editing = false;
  let form = { name: "", description: "", about: "", methodology: "" };

  const TABS = ["details", "subjects", "metrics", "runs", "apikeys"];
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }

  function fmtDate(v) { return SM.fmtDateTime(v); }
  function whoLabel(uid) {
    if (!uid) return "an API key";
    if (USER_ID && uid === USER_ID) return "you";
    return "another member";
  }
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, "\\$&");
  }

  // ── Boot ──
  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    CAN_ADMIN = id.canAdmin;
    USER_ID = (id.user && id.user.id) || null;
    ALLOW_PERSONAL = !!(id.account && id.account.attributes && id.account.attributes.allow_personal_publish);
    loadBenchmark();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) {
    $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>";
  }

  async function loadBenchmark() {
    if (!ID) { fail("No benchmark id."); return; }
    try {
      const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID));
      BM = (doc && doc.data) || null;
      if (!BM) { fail("Benchmark not found."); return; }
      render();
      loadCounts();
    } catch (err) {
      fail(err.message || "Failed to load benchmark.");
    }
  }

  // Fetch each tab's count once (count-only via meta[total]); badges then stay in sync as tabs load.
  async function loadCounts() {
    const total = (url) => apiFetch(url + "&meta[total]=true&page[size]=1")
      .then((d) => (d && d.meta && d.meta.pagination && d.meta.pagination.total) || 0)
      .catch(() => null);
    const eid = encodeURIComponent(ID);
    const [s, mt, r, k] = await Promise.all([
      total("/api/v1/benchmark_subjects?filter[benchmark]=" + eid),
      total("/api/v1/benchmark_metrics?filter[benchmark]=" + eid),
      total("/api/v1/runs?filter[benchmark]=" + eid),
      total("/api/v1/api_keys?filter[scope_type]=BENCHMARK&filter[scope_ref]=" + eid),
    ]);
    COUNTS.subjects = s; COUNTS.metrics = mt; COUNTS.runs = r; COUNTS.apikeys = k;
    updateTabBadges();
  }

  // A count badge for a tab (shown once the count is known, including 0). Patched in place afterward.
  function badgeHtml(key) {
    const n = COUNTS[key];
    return typeof n === "number" ? '<span class="tabBadge">' + n + "</span>" : "";
  }
  function updateTabBadges() {
    ["subjects", "metrics", "runs", "apikeys"].forEach((key) => {
      const btn = $("detail-root").querySelector('.modalTabBtn[data-tab="' + key + '"]');
      if (!btn) return;
      let badge = btn.querySelector(".tabBadge");
      const n = COUNTS[key];
      if (typeof n === "number") {
        if (!badge) { badge = document.createElement("span"); badge.className = "tabBadge"; btn.appendChild(badge); }
        badge.textContent = String(n);
      } else if (badge) {
        badge.remove();
      }
    });
  }
  function setCount(key, n) { COUNTS[key] = n; updateTabBadges(); }

  // Reload the benchmark then re-render (after a lifecycle action).
  async function refresh() {
    const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID));
    BM = (doc && doc.data) || BM;
    render();
  }

  // ── Status decorations (lifecycle pill + draft/ready + closed + attribution) ──
  function statusInfo() {
    const a = BM.attributes || {};
    const status = String(a.status || "").toUpperCase();
    return { a, status };
  }
  // A benchmark is either a draft (PRIVATE) or published; a draft shows a single "draft" pill.
  function decorations() {
    const { a, status } = statusInfo();
    let html = status === "PRIVATE" ? SM.statusPill("draft", "draft") : SM.statusPill(status, status);
    if (a.closed) html += " " + SM.statusPill("complete", "complete");
    return html;
  }

  // ── Header lifecycle actions (by status) ── Two stages: a draft publishes directly (no ready step).
  function headerActions() {
    if (!CAN_WRITE) {
      const { a, status } = statusInfo();
      return status === "PRIVATE" ? "" : viewLink(a.key);
    }
    const { a, status } = statusInfo();
    const b = (label, act, kind) =>
      '<button type="button" class="button button' + (kind || "Secondary") + ' buttonSmall" data-act="' + act + '">' + esc(label) + "</button>";
    if (status === "PRIVATE") {
      return b("Publish…", "publish", "Primary");
    }
    if (status === "PUBLISHED") {
      return viewLink(a.key) + (a.closed ? b("Reopen", "reopen") : b("Close", "close")) + b("Withdraw", "withdraw", "Danger");
    }
    return viewLink(a.key);
  }
  function viewLink(key) {
    return '<a class="button buttonSecondary buttonSmall" href="/benchmarks/' + encodeURIComponent(key || "") + '" target="_blank" rel="noopener">View</a>';
  }

  // ── Render ──
  function render() {
    const a = BM.attributes || {};
    const tab = activeTab();
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + badgeHtml(key) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || a.key || "Benchmark", decorations: decorations(), secondaryId: a.key || "", actions: "" }) +
      '<div class="detailsTabHeader">' +
      '<nav class="modalTabBar" role="tablist">' + tabBtn("details", "Details") + tabBtn("subjects", "Subjects") + tabBtn("metrics", "Metrics") + tabBtn("runs", "Runs") + tabBtn("apikeys", "API Keys") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div>' +
      "</div>" +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    // Breadcrumb current label
    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Benchmark";
    document.title = (a.name || "Benchmark") + " — smplmark";

    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => switchTab(el.dataset.tab)));

    renderTab();
  }

  function switchTab(key) {
    if (key === activeTab()) return;
    if (editing && isDirty()) {
      SM.confirm({ title: "Discard changes?", message: "You have unsaved edits. Leave the Details tab and discard them?", confirmLabel: "Discard", cancelLabel: "Keep editing" })
        .then((ok) => { if (ok) { exitEdit(); location.hash = key; render(); } });
      return;
    }
    editing = false;
    location.hash = key;
    render();
  }
  window.addEventListener("hashchange", () => { if (activeTab() !== currentRenderedTab) render(); });
  let currentRenderedTab = "details";

  function renderTab() {
    currentRenderedTab = activeTab();
    const panel = $("tab-panel");
    const actions = $("tab-actions");
    actions.innerHTML = "";
    if (currentRenderedTab === "details") { renderDetails(panel, actions); }
    else if (currentRenderedTab === "subjects") { renderSubjects(panel, actions); }
    else if (currentRenderedTab === "metrics") { renderMetrics(panel, actions); }
    else if (currentRenderedTab === "apikeys") { renderApiKeys(panel, actions); }
    else { renderRuns(panel, actions); }
  }

  // ── API Keys tab ── keys scoped to this benchmark (scope implicit; no id typing). ──
  function renderApiKeys(panel, actions) {
    SMApiKeys.mount({ host: panel, actions: actions, scopeType: "BENCHMARK", scopeRef: ID, canAdmin: CAN_ADMIN });
    // Refresh the API-keys badge on tab entry (the panel owns its own list; recount independently).
    apiFetch("/api/v1/api_keys?filter[scope_type]=BENCHMARK&filter[scope_ref]=" + encodeURIComponent(ID) + "&meta[total]=true&page[size]=1")
      .then((d) => setCount("apikeys", (d && d.meta && d.meta.pagination && d.meta.pagination.total) || 0)).catch(() => {});
  }

  // ── Details tab (view / edit) ──
  function isDirty() {
    if (!editing || !BM) return false;
    const a = BM.attributes || {};
    return (
      form.name.trim() !== (a.name || "") ||
      form.description !== (a.description || "") ||
      form.about !== (a.about || "") ||
      form.methodology !== (a.methodology || "")
    );
  }
  function enterEdit() {
    const a = BM.attributes || {};
    editing = true;
    form = { name: a.name || "", description: a.description || "", about: a.about || "", methodology: a.methodology || "" };
    renderTab();
  }
  function exitEdit() { editing = false; window.removeEventListener("beforeunload", onBeforeUnload); }
  function onBeforeUnload(e) { if (editing && isDirty()) { e.preventDefault(); e.returnValue = ""; } }

  function renderDetails(panel, actions) {
    const a = BM.attributes || {};
    const canEdit = CAN_WRITE;
    const { status } = statusInfo();

    // Tab actions. In edit mode: [Cancel] [Save]. Otherwise the benchmark-level actions live here — the
    // lifecycle buttons (Mark ready / Publish… / Withdraw / View, by status) followed by [Edit] (+ Delete
    // when private). Lifecycle buttons carry data-act and are wired below.
    if (editing && canEdit) {
      actions.innerHTML =
        '<button type="button" class="button buttonSecondary buttonSmall" id="d-cancel">Cancel</button>' +
        '<button type="button" class="button buttonPrimary buttonSmall" id="d-save">Save</button>';
    } else {
      const editDelete = canEdit
        ? '<button type="button" class="button buttonSecondary buttonSmall" id="d-edit">Edit</button>' +
          (status === "PRIVATE" ? '<button type="button" class="button buttonDanger buttonSmall" id="d-delete">Delete</button>' : "")
        : "";
      actions.innerHTML = headerActions() + editDelete;
      actions.querySelectorAll("[data-act]").forEach((el) =>
        el.addEventListener("click", () => lifecycle(el.dataset.act)));
    }

    const left = editing ? editFields() : viewFields(a);
    const right =
      SM.detailField("Created", { value: fmtDate(a.created_at) }) +
      SM.detailField("Updated", { value: fmtDate(a.updated_at) }) +
      '<div class="field"><span class="detailFieldLabel">Status</span><span>' + decorations() + "</span></div>" +
      SM.detailField("Created by", { value: whoLabel(a.created_by) }) +
      (a.published_by ? SM.detailField("Published by", { value: publishedByLabel(a) }) : "");

    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div>" +
      "</div></div>";

    if (canEdit && editing) {
      const p = panel;
      const bind = (name) => {
        const el = p.querySelector('[data-edit="' + name + '"]');
        if (el) el.addEventListener("input", () => { form[name] = el.value; SM.clearFieldError(el); });
      };
      ["name", "description", "about", "methodology"].forEach(bind);
      $("d-cancel").addEventListener("click", cancelEdit);
      $("d-save").addEventListener("click", saveDetails);
      window.addEventListener("beforeunload", onBeforeUnload);
      const nameEl = p.querySelector('[data-edit="name"]'); if (nameEl) nameEl.focus();
    } else if (canEdit) {
      $("d-edit").addEventListener("click", enterEdit);
      const del = $("d-delete"); if (del) del.addEventListener("click", () => lifecycle("delete"));
    }
  }

  function viewFields(a) {
    return (
      SM.detailField("Name", { value: a.name }) +
      SM.detailField("Description", { value: a.description, emptyText: "(none)" }) +
      SM.detailField("About", { value: a.about, multiline: true, emptyText: "(none)" }) +
      SM.detailField("Methodology", { value: a.methodology, multiline: true, emptyText: "(none)" })
    );
  }
  function editFields() {
    const f = (label, name, opts) => {
      opts = opts || {};
      const input = opts.textarea
        ? '<textarea data-edit="' + name + '" rows="' + (opts.rows || 4) + '">' + esc(form[name]) + "</textarea>"
        : '<input data-edit="' + name + '" type="text" value="' + esc(form[name]) + '" />';
      return '<div class="field"><span class="detailFieldLabel' + (opts.required ? " fieldRequired" : "") + '">' + esc(label) + "</span>" + input +
        '<p class="fieldErrorMessage" hidden></p></div>';
    };
    return (
      f("Name", "name", { required: true }) +
      f("Description", "description") +
      f("About", "about", { textarea: true, rows: 4 }) +
      f("Methodology", "methodology", { textarea: true, rows: 5 })
    );
  }

  function cancelEdit() {
    if (isDirty()) {
      SM.confirm({ title: "Discard changes?", message: "Discard your unsaved edits?", confirmLabel: "Discard", cancelLabel: "Keep editing" })
        .then((ok) => { if (ok) { exitEdit(); renderTab(); } });
      return;
    }
    exitEdit();
    renderTab();
  }

  async function saveDetails() {
    const panel = $("tab-panel");
    const nameEl = panel.querySelector('[data-edit="name"]');
    let ok = true;
    if (!form.name.trim()) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    if (!ok) { nameEl.focus(); return; }
    const a = BM.attributes || {};
    // get-mutate-put: round-trip the full representation, changing only the edited fields.
    const attrs = {
      key: a.key,
      name: form.name.trim(),
      description: form.description.trim() || null,
      about: form.about.trim() || null,
      methodology: form.methodology.trim() || null,
    };
    const save = $("d-save"); save.disabled = true;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("benchmark", attrs) });
      BM = (doc && doc.data) || BM;
      exitEdit();
      render();
    } catch (err) {
      save.disabled = false;
      setMsg(err.message, "error");
    }
  }

  function publishedByLabel(a) {
    const pa = a.published_as;
    let s = whoLabel(a.published_by);
    if (pa) {
      if (pa.kind === "ORGANIZATION") s += " as " + (pa.domain || "");
      else if (pa.kind === "INGESTED") s += " from " + (pa.source_name || "an ingested source");
      else s += " personally";
    }
    return s;
  }

  function setMsg(text, kind) {
    const el = $("detail-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  // ── Subjects tab (M:N: link existing account subjects) ── "Add subject" (top-right) opens a picker
  //    modal; each linked row has a trash icon that unlinks it.
  function slugify(s) {
    const out = String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/, "");
    return out || "subject";
  }

  async function renderSubjects(panel, actions) {
    if (CAN_WRITE && actions) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-subject-btn">' + SM.icon("plus", 14) + " Add subject</button>";
      $("add-subject-btn").addEventListener("click", openAddSubjectModal);
    }
    panel.innerHTML = '<div id="subjects-table"></div>';
    const cols = [
      { key: "key", label: "Key", sortable: true, sortValue: (t) => (t.attributes || {}).key || "", render: (t) => "<code>" + esc((t.attributes || {}).key || "") + "</code>" },
      { key: "name", label: "Name", sortable: true, sortValue: (t) => (t.attributes || {}).name || "", render: (t) => esc((t.attributes || {}).name || "") },
    ];
    if (CAN_WRITE) cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (t) =>
      '<button type="button" class="iconBtn unlink-subject" data-link="' + esc(t.__linkId || "") + '" data-name="' + esc((t.attributes || {}).name || (t.attributes || {}).key || "") + '" title="Unlink subject" aria-label="Unlink subject">' + SM.icon("trash", 15) + "</button>" });
    const table = SM.pagedTable($("subjects-table"), {
      columns: cols, rows: [], sort: { key: "key", dir: "asc" }, emptyText: "No subjects linked yet.",
      onRender: CAN_WRITE ? (c) => c.querySelectorAll(".unlink-subject").forEach((el) => el.addEventListener("click", () => unlinkSubject(el.dataset.link, el.dataset.name))) : undefined,
    });
    try {
      const [linkedDoc, linksDoc] = await Promise.all([
        apiFetch("/api/v1/subjects?filter[benchmark]=" + encodeURIComponent(ID)),
        apiFetch("/api/v1/benchmark_subjects?filter[benchmark]=" + encodeURIComponent(ID)),
      ]);
      const linked = (linkedDoc && linkedDoc.data) || [];
      const linkIdBySubject = {};
      ((linksDoc && linksDoc.data) || []).forEach((l) => { linkIdBySubject[(l.attributes || {}).subject] = l.id; });
      linked.forEach((t) => { t.__linkId = linkIdBySubject[t.id] || ""; });
      table.setRows(linked);
      setCount("subjects", linked.length);
    } catch (err) {
      $("subjects-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Add-subject modal (pick an existing account subject to link) ──
  async function openAddSubjectModal() {
    const bodyHtml =
      '<form class="form" id="add-subject-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Subject</span>' +
      '<input name="q" type="text" list="modal-acct-subjects" autocomplete="off" placeholder="Pick a subject to link" />' +
      '<datalist id="modal-acct-subjects"></datalist>' +
      '<p class="detailFieldHelp">Subjects are created on the Subjects page (choosing their type), then linked here.</p>' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="add-subject-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add subject</button></div></form>';
    const m = SM.modal({ title: "Add subject", description: "Link an existing subject to this benchmark.", bodyHtml: bodyHtml, width: 520 });
    const f = m.panel.querySelector("#add-subject-form");
    const msg = m.panel.querySelector("#add-subject-msg");
    let acct = [];
    // Fill the picker with the account's subjects that aren't already linked to this benchmark.
    try {
      const [acctDoc, linksDoc] = await Promise.all([
        apiFetch("/api/v1/subjects"),
        apiFetch("/api/v1/benchmark_subjects?filter[benchmark]=" + encodeURIComponent(ID)),
      ]);
      acct = (acctDoc && acctDoc.data) || [];
      const linkedIds = new Set(((linksDoc && linksDoc.data) || []).map((l) => (l.attributes || {}).subject));
      // The option VALUE is the unique key (what lands in the input on pick); the label shows "name — key".
      m.panel.querySelector("#modal-acct-subjects").innerHTML = acct.filter((t) => !linkedIds.has(t.id)).map((t) => {
        const a = t.attributes || {};
        return '<option value="' + esc(a.key || "") + '">' + esc((a.name || "") + (a.key ? " — " + a.key : "")) + "</option>";
      }).join("");
    } catch (_e) { /* leave the picker empty; server resolution by exact key still works */ }
    f.q.addEventListener("input", () => SM.clearFieldError(f.q));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.q);
      const val = f.q.value.trim();
      if (!val) { SM.setFieldError(f.q, "Pick a subject."); return; }
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const lower = val.toLowerCase();
        const match =
          acct.find((t) => String((t.attributes || {}).key || "").toLowerCase() === lower) ||
          acct.find((t) => String((t.attributes || {}).name || "").toLowerCase() === lower);
        let subjectId = match ? match.id : null;
        if (!subjectId) {
          const existing = await apiFetch("/api/v1/subjects?filter[key]=" + encodeURIComponent(slugify(val)));
          const found = existing && existing.data && existing.data[0];
          subjectId = found ? found.id : null;
        }
        if (!subjectId) { submit.disabled = false; SM.setFieldError(f.q, "No such subject. Create it on the Subjects page (choosing its type) first."); return; }
        await apiFetch("/api/v1/benchmark_subjects", { method: "POST", body: jsonapiBody("benchmark_subject", { benchmark: ID, subject: subjectId }) });
        m.close();
        renderSubjects($("tab-panel"), $("tab-actions"));
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  async function unlinkSubject(linkId, name) {
    if (!linkId) { setMsg("Couldn't resolve the link to remove — refresh and try again.", "error"); return; }
    const ok = await SM.confirm({ title: "Unlink subject?", message: "Remove <strong>" + esc(name) + "</strong> from this benchmark and drop its measurements here? The subject itself is kept in your account.", confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_subjects/" + encodeURIComponent(linkId), { method: "DELETE" });
      renderSubjects($("tab-panel"), $("tab-actions"));
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Metrics tab (the values this benchmark reports) ──
  // Metrics are an account-owned library; linking one snapshots its definition into this benchmark's
  // measurement schema. The table is driven by the link rows joined to the account library (which
  // supplies each metric's name/label/type/kind); unlink removes the snapshot (draft benchmarks only).
  async function renderMetrics(panel, actions) {
    if (CAN_WRITE && actions) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-metric-btn">' + SM.icon("plus", 14) + " Add metric</button>";
      $("add-metric-btn").addEventListener("click", openAddMetricModal);
    }
    panel.innerHTML = '<div id="metrics-table"></div>';
    const cols = [
      { key: "name", label: "Name", sortable: true, sortValue: (t) => (t.attributes || {}).name || "", render: (t) => "<code>" + esc((t.attributes || {}).name || "") + "</code>" },
      { key: "label", label: "Label", sortable: true, sortValue: (t) => (t.attributes || {}).label || "", render: (t) => esc((t.attributes || {}).label || "") },
      { key: "type", label: "Type", sortable: true, sortValue: (t) => (t.attributes || {}).type || "", render: (t) => SMMetricForm.typePillHtml((t.attributes || {}).type) },
      { key: "kind", label: "Kind", sortable: true, sortValue: (t) => (t.attributes || {}).kind || "", render: (t) => SMMetricForm.kindPillHtml((t.attributes || {}).kind) },
    ];
    if (CAN_WRITE) cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (t) =>
      '<button type="button" class="iconBtn unlink-metric" data-link="' + esc(t.__linkId || "") + '" data-name="' + esc((t.attributes || {}).label || (t.attributes || {}).name || "") + '" title="Unlink metric" aria-label="Unlink metric">' + SM.icon("trash", 15) + "</button>" });
    const table = SM.pagedTable($("metrics-table"), {
      columns: cols, rows: [], sort: { key: "name", dir: "asc" }, emptyText: "No metrics linked yet.",
      onRowClick: (t) => { location.href = "/account/metrics/detail?id=" + encodeURIComponent(t.id); },
      onRender: CAN_WRITE ? (c) => c.querySelectorAll(".unlink-metric").forEach((el) => el.addEventListener("click", (ev) => { ev.stopPropagation(); unlinkMetric(el.dataset.link, el.dataset.name); })) : undefined,
    });
    try {
      const [linksDoc, libDoc] = await Promise.all([
        apiFetch("/api/v1/benchmark_metrics?filter[benchmark]=" + encodeURIComponent(ID)),
        apiFetch("/api/v1/metrics?page[size]=1000"),
      ]);
      const byId = {};
      ((libDoc && libDoc.data) || []).forEach((m) => { byId[m.id] = m; });
      const rows = [];
      ((linksDoc && linksDoc.data) || []).forEach((l) => {
        const m = byId[(l.attributes || {}).metric];
        if (m) rows.push(Object.assign({}, m, { __linkId: l.id }));
      });
      table.setRows(rows);
      setCount("metrics", rows.length);
    } catch (err) {
      $("metrics-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Add-metric modal (pick a library metric to link) ──
  async function openAddMetricModal() {
    const bodyHtml =
      '<form class="form" id="add-metric-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Metric</span>' +
      '<input name="q" type="text" list="modal-acct-metrics" autocomplete="off" placeholder="Pick a metric to link" />' +
      '<datalist id="modal-acct-metrics"></datalist>' +
      '<p class="detailFieldHelp">Metrics are defined on the Metrics page, then linked here. Linking copies the metric’s definition into this benchmark.</p>' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="add-metric-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add metric</button></div></form>';
    const m = SM.modal({ title: "Add metric", description: "Link a metric from your library to this benchmark.", bodyHtml: bodyHtml, width: 520 });
    const f = m.panel.querySelector("#add-metric-form");
    const msg = m.panel.querySelector("#add-metric-msg");
    let lib = [];
    // Fill the picker with the account's metrics that aren't already linked to this benchmark.
    try {
      const [libDoc, linksDoc] = await Promise.all([
        apiFetch("/api/v1/metrics?page[size]=1000"),
        apiFetch("/api/v1/benchmark_metrics?filter[benchmark]=" + encodeURIComponent(ID)),
      ]);
      lib = (libDoc && libDoc.data) || [];
      const linkedIds = new Set(((linksDoc && linksDoc.data) || []).map((l) => (l.attributes || {}).metric));
      // The option VALUE is the unique name (what lands in the input on pick); the label shows "label — name".
      m.panel.querySelector("#modal-acct-metrics").innerHTML = lib.filter((t) => !linkedIds.has(t.id)).map((t) => {
        const a = t.attributes || {};
        return '<option value="' + esc(a.name || "") + '">' + esc((a.label || "") + (a.name ? " — " + a.name : "")) + "</option>";
      }).join("");
    } catch (_e) { /* leave the picker empty; server resolution by exact name still works */ }
    f.q.addEventListener("input", () => SM.clearFieldError(f.q));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.q);
      const val = f.q.value.trim();
      if (!val) { SM.setFieldError(f.q, "Pick a metric."); return; }
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const lower = val.toLowerCase();
        const match =
          lib.find((t) => String((t.attributes || {}).name || "").toLowerCase() === lower) ||
          lib.find((t) => String((t.attributes || {}).label || "").toLowerCase() === lower);
        if (!match) { submit.disabled = false; SM.setFieldError(f.q, "No such metric. Create it on the Metrics page first."); return; }
        await apiFetch("/api/v1/benchmark_metrics", { method: "POST", body: jsonapiBody("benchmark_metric", { benchmark: ID, metric: match.id }) });
        m.close();
        renderMetrics($("tab-panel"), $("tab-actions"));
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  async function unlinkMetric(linkId, name) {
    if (!linkId) { setMsg("Couldn't resolve the link to remove — refresh and try again.", "error"); return; }
    const ok = await SM.confirm({ title: "Unlink metric?", message: "Remove <strong>" + esc(name) + "</strong> from this benchmark’s reported metrics? Existing measurement data is kept, but this metric is no longer part of the benchmark. The metric stays in your library.", confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_metrics/" + encodeURIComponent(linkId), { method: "DELETE" });
      renderMetrics($("tab-panel"), $("tab-actions"));
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Runs tab (master-detail: a run picker on the left, the selected run's measurements on the right) ──
  let SEL_RUN = null;      // selected run id (persists across re-renders within the tab)
  let RUNS = [];           // the benchmark's runs
  let MEAS_SUBJECTS = {};  // subject_id → subject resource (name resolution + the add-measurement picker)

  function runFlags(a) { return { invalidated: !!(a.invalidated || a.invalidated_at || a.invalidation_reason), ended: !!(a.ended_at || a.live === false) }; }
  function runStateSort(r) { const f = runFlags(r.attributes || {}); return f.invalidated ? "invalidated" : f.ended ? "ended" : "live"; }
  function runStatePill(r) { return SM.statusPill(runStateSort(r), runStateSort(r)); }
  function measSchema() { return (BM.attributes || {}).measurement_schema || { metrics: [], derived: [] }; }
  // The measurement's metric columns, in schema order: stored first, then derived (flagged for the view modal).
  function schemaMetrics() {
    const s = measSchema();
    return (s.metrics || []).map((m) => ({ name: m.name, derived: false }))
      .concat((s.derived || []).map((d) => ({ name: d.name, derived: true })));
  }
  function fmtNum(v) {
    if (v == null || typeof v !== "number" || !isFinite(v)) return "—";
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  }
  function subjectLabel(id) { const s = MEAS_SUBJECTS[id]; const a = (s && s.attributes) || {}; return a.name || a.key || id || "—"; }
  function selectedRun() { return RUNS.find((r) => r.id === SEL_RUN) || null; }

  async function renderRuns(panel, actions) {
    if (CAN_WRITE && actions) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-run-btn">' + SM.icon("plus", 14) + " Add run</button>";
      $("add-run-btn").addEventListener("click", openAddRunModal);
    }
    panel.innerHTML =
      '<div class="runsLayout">' +
      '<aside class="runsPane"><div class="runsPaneHead"><span class="runsPaneTitle">Runs</span></div>' +
      '<div class="runsList" id="runs-list"><p class="measEmpty" style="padding:0.75rem;">Loading…</p></div></aside>' +
      '<section class="runsMain" id="runs-main"></section></div>';
    try {
      const [runsDoc, subjDoc] = await Promise.all([
        apiFetch("/api/v1/runs?filter[benchmark]=" + encodeURIComponent(ID) + "&page[size]=1000"),
        apiFetch("/api/v1/subjects?filter[benchmark]=" + encodeURIComponent(ID) + "&page[size]=1000"),
      ]);
      RUNS = ((runsDoc && runsDoc.data) || []).slice().sort((a, z) => String((a.attributes || {}).key || "").localeCompare(String((z.attributes || {}).key || "")));
      MEAS_SUBJECTS = {};
      ((subjDoc && subjDoc.data) || []).forEach((s) => { MEAS_SUBJECTS[s.id] = s; });
      setCount("runs", RUNS.length);
      setCount("subjects", Object.keys(MEAS_SUBJECTS).length);
      if (!RUNS.some((r) => r.id === SEL_RUN)) SEL_RUN = RUNS.length ? RUNS[0].id : null;
      renderRunList();
      renderMeasurementsPane();
    } catch (err) {
      $("runs-main").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function renderRunList() {
    const host = $("runs-list");
    if (!host) return;
    if (!RUNS.length) { host.innerHTML = '<p class="measEmpty" style="padding:0.75rem;">No runs yet.</p>'; return; }
    host.innerHTML = RUNS.map((r) => {
      const a = r.attributes || {};
      const on = r.id === SEL_RUN;
      return '<button type="button" class="runItem' + (on ? " isActive" : "") + '" data-id="' + esc(r.id) + '">' +
        '<span class="runItemName">' + esc(a.key || "") + "</span>" + runStatePill(r) + "</button>";
    }).join("");
    host.querySelectorAll(".runItem").forEach((el) => el.addEventListener("click", () => selectRun(el.dataset.id)));
  }

  function selectRun(id) {
    if (id === SEL_RUN) return;
    SEL_RUN = id;
    renderRunList();
    renderMeasurementsPane();
  }

  // Right pane: the selected run's header (state + run actions + Add measurement) and its measurements table.
  async function renderMeasurementsPane() {
    const host = $("runs-main");
    if (!host) return;
    const r = selectedRun();
    if (!r) {
      host.innerHTML = '<p class="measEmpty">' + (RUNS.length ? "Select a run to see its measurements." : "Add a run to start recording measurements.") + "</p>";
      return;
    }
    const a = r.attributes || {};
    const f = runFlags(a);
    const priv = statusInfo().status === "PRIVATE";
    const benchClosed = !!statusInfo().a.closed;
    let runActs = "";
    if (CAN_WRITE) {
      if (!f.ended && !f.invalidated) runActs += '<button type="button" class="button buttonSecondary buttonSmall" id="r-end">End</button>';
      if (!priv && !f.invalidated) runActs += '<button type="button" class="button buttonSecondary buttonSmall" id="r-invalidate">Invalidate</button>';
      runActs += '<button type="button" class="button buttonDanger buttonSmall" id="r-delete">Delete run</button>';
    }
    const canAddMeas = CAN_WRITE && !f.ended && !benchClosed;
    const addMeas = canAddMeas ? '<button type="button" class="button buttonPrimary buttonSmall" id="add-meas-btn">' + SM.icon("plus", 14) + " Add measurement</button>" : "";
    const openRun = '<a class="button buttonSecondary buttonSmall" href="/account/runs/detail?id=' + encodeURIComponent(r.id) + '">Open run</a>';
    host.innerHTML =
      '<div class="measHead"><div class="measHeadText"><h2>' + esc(a.key || "Run") + "</h2>" + runStatePill(r) + "</div>" +
      '<div class="measHeadActions">' + runActs + openRun + addMeas + "</div></div>" +
      '<div id="meas-table"></div>' +
      '<div id="meas-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    if (CAN_WRITE) {
      const end = $("r-end"); if (end) end.addEventListener("click", () => endRun(r.id));
      const inv = $("r-invalidate"); if (inv) inv.addEventListener("click", () => invalidateRun(r.id));
      const del = $("r-delete"); if (del) del.addEventListener("click", () => deleteRun(r.id, a.key));
      const addb = $("add-meas-btn"); if (addb) addb.addEventListener("click", openAddMeasurementModal);
    }

    const cols = [
      { key: "subject", label: "Subject", sortable: true, sortValue: (m) => subjectLabel((m.attributes || {}).subject), render: (m) => esc(subjectLabel((m.attributes || {}).subject)) },
    ];
    schemaMetrics().forEach((mc) => cols.push({
      key: "m_" + mc.name, label: mc.name, sortable: true,
      sortValue: (m) => { const v = ((m.attributes || {}).metrics || {})[mc.name]; return typeof v === "number" ? v : ""; },
      render: (m) => esc(fmtNum(((m.attributes || {}).metrics || {})[mc.name])),
    }));
    cols.push({ key: "created_at", label: "Recorded", sortable: true, sortValue: (m) => (m.attributes || {}).created_at || "", render: (m) => esc(SM.fmtDateTime((m.attributes || {}).created_at)) });
    const canDelMeas = CAN_WRITE && priv; // measurements are append-only once published
    if (canDelMeas) cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (m) =>
      '<button type="button" class="iconBtn meas-del" data-id="' + esc(m.id) + '" title="Delete measurement" aria-label="Delete measurement">' + SM.icon("trash", 15) + "</button>" });
    const table = SM.pagedTable($("meas-table"), {
      columns: cols, rows: [], sort: { key: "created_at", dir: "desc" }, emptyText: "No measurements in this run yet.",
      onRowClick: (m) => openMeasurementModal(m),
      onRender: canDelMeas ? (c) => c.querySelectorAll(".meas-del").forEach((el) => el.addEventListener("click", (ev) => { ev.stopPropagation(); deleteMeasurement(el.dataset.id); })) : undefined,
    });
    try {
      const doc = await apiFetch("/api/v1/measurements?filter[run]=" + encodeURIComponent(r.id) + "&page[size]=1000");
      table.setRows((doc && doc.data) || []);
    } catch (err) {
      $("meas-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Add-measurement modal (pick a subject; enter a value for each stored metric — derived are computed) ──
  async function openAddMeasurementModal() {
    const r = selectedRun(); if (!r) return;
    const stored = measSchema().metrics || [];
    const subjOptions = Object.values(MEAS_SUBJECTS).map((s) => { const a = s.attributes || {}; return '<option value="' + esc(a.key || "") + '">' + esc((a.name || "") + (a.key ? " — " + a.key : "")) + "</option>"; }).join("");
    const metricFields = stored.map((m) => '<label class="field"><span class="detailFieldLabel">' + esc(m.name) + '</span><input data-metric="' + esc(m.name) + '" type="number" step="any" autocomplete="off" placeholder="optional" /></label>').join("");
    const bodyHtml =
      '<form class="form" id="add-meas-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Subject</span><input name="subject" type="text" list="meas-subjects" autocomplete="off" placeholder="Pick a subject to measure" /><datalist id="meas-subjects">' + subjOptions + '</datalist><p class="fieldErrorMessage" hidden></p></label>' +
      (metricFields ? '<div class="subjectFormFields">' + metricFields + "</div>" : '<p class="detailFieldHelp">This benchmark has no stored metrics yet — add them on the Metrics tab to record values.</p>') +
      '<label class="field"><span class="detailFieldLabel">Recorded at</span><input name="created_at" type="text" autocomplete="off" placeholder="Defaults to now" /></label>' +
      '<p class="form-status" id="add-meas-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add measurement</button></div></form>';
    const m = SM.modal({ title: "Add measurement", description: "Record a measurement for a subject in run " + (r.attributes || {}).key + ".", bodyHtml: bodyHtml, width: 560 });
    const f = m.panel.querySelector("#add-meas-form");
    const msg = m.panel.querySelector("#add-meas-msg");
    f.subject.addEventListener("input", () => SM.clearFieldError(f.subject));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.subject);
      const val = f.subject.value.trim();
      if (!val) { SM.setFieldError(f.subject, "Pick a subject."); return; }
      const lower = val.toLowerCase();
      const list = Object.values(MEAS_SUBJECTS);
      const match = list.find((s) => String((s.attributes || {}).key || "").toLowerCase() === lower) ||
        list.find((s) => String((s.attributes || {}).name || "").toLowerCase() === lower);
      if (!match) { SM.setFieldError(f.subject, "No such subject in this benchmark. Link it on the Subjects tab first."); return; }
      const metrics = {};
      f.querySelectorAll("[data-metric]").forEach((el) => { const v = el.value.trim(); if (v !== "") { const n = Number(v); if (isFinite(n)) metrics[el.getAttribute("data-metric")] = n; } });
      const attrs = { run: r.id, subject: match.id };
      if (Object.keys(metrics).length) attrs.metrics = metrics;
      const c = f.created_at.value.trim(); if (c) attrs.created_at = c;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await apiFetch("/api/v1/measurements", { method: "POST", body: jsonapiBody("measurement", attrs) });
        m.close();
        renderMeasurementsPane();
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  // ── Measurement view modal (read-only — measurements are append-only; edit is delete + re-add) ──
  function openMeasurementModal(meas) {
    const a = meas.attributes || {};
    const metrics = a.metrics || {};
    const inSchema = new Set(schemaMetrics().map((mc) => mc.name));
    const rows = schemaMetrics().map((mc) =>
      '<div class="field"><span class="detailFieldLabel">' + esc(mc.name) + (mc.derived ? ' <span class="typePill kindDerived">derived</span>' : "") + '</span><span class="detailFieldValue isMono">' + esc(fmtNum(metrics[mc.name])) + "</span></div>").join("");
    // Any metric keys present but not declared in the schema (open data) are shown too.
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
      '<div class="modalActions"><button type="button" class="button buttonPrimary buttonSmall" data-close>Close</button></div></div>';
    SM.modal({ title: "Measurement", description: "Values recorded for this subject in the run.", bodyHtml: bodyHtml, width: 520 });
  }

  async function deleteMeasurement(measId) {
    const ok = await SM.confirm({ title: "Delete measurement?", message: "Delete this measurement? This can't be undone.", confirmLabel: "Delete" });
    if (!ok) return;
    try { await apiFetch("/api/v1/measurements/" + encodeURIComponent(measId), { method: "DELETE" }); renderMeasurementsPane(); }
    catch (err) { const el = $("meas-msg"); if (el) { el.textContent = err.message; el.className = "form-status is-error"; } }
  }

  // ── Add-run modal (Run ID + Started at are optional; the server auto-generates / defaults them) ──
  async function openAddRunModal() {
    const bodyHtml =
      '<form class="form" id="add-run-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel">Run ID</span><input name="key" type="text" autocomplete="off" placeholder="Auto-generated if left blank" /><p class="detailFieldHelp">A unique identifier for this run within the benchmark. Leave blank to auto-generate one.</p></label>' +
      '<label class="field"><span class="detailFieldLabel">Name</span><input name="name" type="text" autocomplete="off" placeholder="Optional — a label for this run" /></label>' +
      '<label class="field"><span class="detailFieldLabel">Started at</span><input name="started_at" type="text" autocomplete="off" placeholder="Defaults to now" /><p class="detailFieldHelp">When the run started, e.g. 2026-01-01T00:00:00Z. Defaults to now if left blank.</p></label>' +
      '<p class="form-status" id="add-run-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add run</button></div></form>';
    const m = SM.modal({ title: "Add run", description: "Record a new run for this benchmark.", bodyHtml: bodyHtml, width: 520 });
    const f = m.panel.querySelector("#add-run-form");
    const msg = m.panel.querySelector("#add-run-msg");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      const attrs = { benchmark: ID };
      const k = f.key.value.trim(); if (k) attrs.key = k;
      const n = f.name.value.trim(); if (n) attrs.name = n;
      const s = f.started_at.value.trim(); if (s) attrs.started_at = s;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await apiFetch("/api/v1/runs", { method: "POST", body: jsonapiBody("run", attrs) });
        m.close();
        renderRuns($("tab-panel"), $("tab-actions"));
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }
  async function endRun(id) {
    setMsg("");
    try { await apiFetch("/api/v1/runs/" + encodeURIComponent(id) + "/actions/end", { method: "POST" }); renderRuns($("tab-panel"), $("tab-actions")); }
    catch (err) { setMsg(err.message, "error"); }
  }
  async function invalidateRun(id) {
    const reason = await SM.confirm({ title: "Invalidate run?", message: "Invalidated runs stay visible but are flagged. This can't be undone.", confirmLabel: "Invalidate", reason: { label: "Reason (optional)", placeholder: "Why is this run invalid?" } });
    if (reason === null) return;
    setMsg("");
    const attrs = {};
    if (reason) attrs.invalidation_reason = reason;
    try { await apiFetch("/api/v1/runs/" + encodeURIComponent(id) + "/actions/invalidate", { method: "POST", body: jsonapiBody("run", attrs) }); renderRuns($("tab-panel"), $("tab-actions")); }
    catch (err) { setMsg(err.message, "error"); }
  }
  async function deleteRun(id, key) {
    const ok = await SM.confirm({ title: "Delete run?", message: "Delete run <strong>" + esc(key || "") + "</strong> and its measurements? This can't be undone. A published benchmark only lets you delete a run that has no measurements — otherwise invalidate it.", confirmLabel: "Delete" });
    if (!ok) return;
    setMsg("");
    try { await apiFetch("/api/v1/runs/" + encodeURIComponent(id), { method: "DELETE" }); renderRuns($("tab-panel"), $("tab-actions")); }
    catch (err) { setMsg(err.message, "error"); }
  }

  // ── Lifecycle actions ──
  async function lifecycle(act) {
    if (act === "publish") { openPublishModal(); return; }
    if (act === "delete") { doDelete(); return; }
    if (act === "withdraw") { doWithdraw(); return; }
    if (act === "close") { await post("close"); return; }
    if (act === "reopen") { await post("reopen"); return; }
  }
  async function post(action, body) {
    setMsg("");
    try { await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID) + "/actions/" + action, { method: "POST", body }); await refresh(); }
    catch (err) { setMsg(err.message, "error"); }
  }
  async function doWithdraw() {
    const reason = await SM.confirm({ title: "Withdraw benchmark?", message: "Withdrawing keeps the data public for the record but marks it retracted.", confirmLabel: "Withdraw", reason: { label: "Reason", placeholder: "Why is it being withdrawn?", required: true, textarea: true } });
    if (reason === null) return;
    await post("withdraw", jsonapiBody("benchmark", { withdrawal_reason: reason }));
  }
  async function doDelete() {
    const a = BM.attributes || {};
    const ok = await SM.confirm({ title: "Delete benchmark?", message: "Delete <strong>" + esc(a.name || a.key || "") + "</strong>? This can't be undone.", confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/benchmarks";
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Publish modal (attribution) ──
  // The verified publishers (domains) the benchmark can be attributed to.
  async function loadVerifiedPublishers() {
    const doc = await apiFetch("/api/v1/publishers?filter[status]=VERIFIED");
    return ((doc && doc.data) || []).map((p) => ({ id: p.id, domain: p.attributes.domain, icon: p.attributes.icon }));
  }
  function optionRow(value, title, enabled, detail) {
    return '<label class="publishOption' + (enabled ? "" : " isDisabled") + '">' +
      '<input type="radio" name="attribution" value="' + esc(value) + '"' + (enabled ? "" : " disabled") + " />" +
      '<span class="publishOptionBody"><span class="publishOptionTitle">' + esc(title) + "</span>" +
      (detail ? '<span class="publishOptionDetail">' + esc(detail) + "</span>" : "") + "</span></label>";
  }
  function openPublishModal() {
    const a = BM.attributes || {};
    const m = SM.modal({
      title: "Publish “" + (a.name || a.key || "") + "”",
      description: "Publishing is a one-way step and freezes the benchmark. Choose how it's attributed.",
      bodyHtml:
        '<form class="form" id="publish-form">' +
        '<div id="publish-options"><p class="muted">Loading publishing options…</p></div>' +
        '<p id="publish-msg" class="form-status"></p>' +
        '<div class="modalActions">' +
        '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
        '<button type="submit" class="button buttonPrimary buttonSmall" id="publish-submit" disabled>Publish</button>' +
        "</div></form>",
    });
    m.panel.querySelector("#publish-form").addEventListener("submit", (ev) => { ev.preventDefault(); submitPublish(m); });
    buildPublishOptions(m);
  }
  async function buildPublishOptions(m) {
    const panel = m.panel;
    const a = BM.attributes || {};
    const host = panel.querySelector("#publish-options");
    const submit = panel.querySelector("#publish-submit");
    const isAuthor = !!(USER_ID && a.created_by === USER_ID);

    // Only admins can attribute to a verified publisher (domain).
    let verifiedPubs = [];
    let orgError = null;
    if (CAN_ADMIN) {
      try { verifiedPubs = await loadVerifiedPublishers(); }
      catch (err) { orgError = err; }
    }

    // Dead end: personal publishing is off (an owner's choice) and there's no verified publisher to
    // attribute to — so there's nothing to publish under. Say so plainly rather than showing disabled
    // options, and never mention personal publishing when the owner has turned it off.
    if (!ALLOW_PERSONAL && verifiedPubs.length === 0) {
      showNoPublisherMessage(m);
      return;
    }

    const rows = [];
    if (ALLOW_PERSONAL) {
      rows.push(optionRow("personal", "Publish personally", isAuthor, isAuthor ? "Attributed to you." : "Only the benchmark's author can publish it personally."));
    }
    if (CAN_ADMIN) {
      if (orgError) {
        host.innerHTML = rows.join("") + '<p class="form-status is-error" style="margin-top:0.4rem;">Couldn\'t load publishers: ' + esc(orgError.message) + "</p>";
        wireOptions(host, submit); return;
      }
      if (verifiedPubs.length) {
        verifiedPubs.forEach((p) => {
          rows.push(optionRow("org:" + p.id, p.domain, true, "Verified domain."));
        });
      } else if (ALLOW_PERSONAL) {
        rows.push('<p class="muted" style="margin:0.5rem 0 0;">No verified publishers yet. <a href="/account/settings#publishers">Add a domain</a> to publish under it.</p>');
      }
    }
    host.innerHTML = rows.join("");
    wireOptions(host, submit);
  }
  // Replace the publish modal with a plain "you can't publish yet" message (no options, no Publish).
  function showNoPublisherMessage(m) {
    const panel = m.panel;
    const header = panel.querySelector(".modalHeader");
    if (header) {
      header.innerHTML =
        '<h2 class="modalTitle">No verified publishers</h2>' +
        '<p class="modalDescription">A benchmark can only be published under a verified publisher, and this account doesn\'t have one yet.</p>';
    }
    const form = panel.querySelector("#publish-form");
    form.innerHTML =
      '<p class="muted" style="margin:0 0 1.1rem;">' +
      (CAN_ADMIN
        ? 'Create a publisher and verify a domain under <a class="authTextLink" href="/account/settings#publishers">Publishers</a>, then publish this benchmark.'
        : "Ask an administrator or account owner to set up and verify a publisher first.") +
      "</p>" +
      '<div class="modalActions"><button type="button" class="button buttonPrimary buttonSmall" data-close>Close</button></div>';
    form.querySelector("[data-close]").addEventListener("click", m.close);
  }
  function wireOptions(host, submit) {
    host.querySelectorAll('input[name="attribution"]').forEach((r) => r.addEventListener("change", () => { submit.disabled = false; }));
  }
  async function submitPublish(m) {
    const sel = m.panel.querySelector('input[name="attribution"]:checked');
    if (!sel) return;
    const msg = m.panel.querySelector("#publish-msg");
    msg.textContent = ""; msg.className = "form-status";
    const submit = m.panel.querySelector("#publish-submit"); submit.disabled = true;
    let body;
    if (sel.value !== "personal") body = jsonapiBody("benchmark", { publisher: sel.value.slice(4) });
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID) + "/actions/publish", { method: "POST", body });
      m.close();
      await refresh();
    } catch (err) { msg.textContent = err.message; msg.className = "form-status is-error"; submit.disabled = false; }
  }
})();
