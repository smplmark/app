"use strict";

// Benchmark detail (/account/benchmarks/detail?id=…) — a conforming detail page: DetailHeader with
// the lifecycle actions, Details (view/edit 2-column form), Subjects, and Runs tabs. Runs and subjects
// are both benchmark children now. Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  // Pretty route /benchmarks/{key}; ?id= is kept as a fallback (old links). ID resolves to the
  // benchmark's uuid once loaded (from the key when pretty-routed) and everything downstream uses it.
  const PATH_KEY = (function () {
    const m = /^\/benchmarks\/([^/]+)\/?$/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : "";
  })();
  const QUERY_ID = new URLSearchParams(location.search).get("id") || "";
  let ID = QUERY_ID;
  let ACCOUNT_ID = null;
  let BM = null;
  let CAN_WRITE = false, CAN_ADMIN = false, USER_ID = null, ALLOW_PERSONAL = false;
  let USER_EMAIL = "", USER_NAME = "";
  // Per-tab counts shown as badges; null until first loaded, then kept in sync as each tab's data loads.
  const COUNTS = { subjects: null, metrics: null, runs: null, apikeys: null };

  // Edit-mode state for the Details tab.
  let editing = false;
  let form = { name: "", description: "", about: "", methodology: "", subject_type: "" };

  const TABS = ["details", "subjects", "metrics", "runs", "history", "apikeys"];
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
    ACCOUNT_ID = id.accountId;
    CAN_WRITE = id.canWrite;
    CAN_ADMIN = id.canAdmin;
    USER_ID = (id.user && id.user.id) || null;
    USER_EMAIL = (id.user && id.user.attributes && id.user.attributes.email) || "";
    USER_NAME = (id.user && id.user.attributes && id.user.attributes.display_name) || "";
    ALLOW_PERSONAL = !!(id.account && id.account.attributes && id.account.attributes.allow_personal_publish);
    loadBenchmark();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) {
    $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>";
  }

  // The account's subject types — the benchmark's own type displays by name, and the Details edit
  // form offers the list. Loaded once alongside the benchmark.
  let SUBJECT_TYPES = null;
  function typeName(id) {
    const t = (SUBJECT_TYPES || []).find((x) => x.id === id);
    const a = (t && t.attributes) || {};
    return a.name || a.key || (id ? id : null);
  }

  // Resolve the benchmark from either the pretty key (own account, any status) or the ?id= fallback.
  async function resolveBenchmark() {
    if (QUERY_ID) return (await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(QUERY_ID))).data || null;
    if (PATH_KEY) {
      const list = await apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent(ACCOUNT_ID) + "&filter[key]=" + encodeURIComponent(PATH_KEY));
      return (list && list.data && list.data[0]) || null;
    }
    return null;
  }

  async function loadBenchmark() {
    if (!QUERY_ID && !PATH_KEY) { fail("No benchmark specified."); return; }
    try {
      const [row, typesDoc] = await Promise.all([
        resolveBenchmark(),
        apiFetch("/api/v1/subject_types?page[size]=1000").catch(() => null),
      ]);
      SUBJECT_TYPES = (typesDoc && typesDoc.data) || [];
      BM = row || null;
      if (!BM) { fail("Benchmark not found."); return; }
      ID = BM.id; // everything downstream (subresource queries, links) keys off the uuid
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

  // Reload the benchmark then re-render (after a lifecycle action or a child link/unlink). Metric
  // link/unlink rewrites measurement_schema server-side, so BM must be re-fetched after them — a stale
  // copy would omit a just-linked metric from the Add-measurement form (and misrepresent the schema
  // anywhere else BM is read).
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
      return viewLink(a.key) + (a.closed ? b("Reopen", "reopen") : b("Close", "close")) + b("Request takedown", "takedown") + b("Withdraw", "withdraw", "Danger");
    }
    // WITHDRAWN: the record stays public; the remaining affordance is asking operators to remove it.
    return viewLink(a.key) + b("Request takedown", "takedown");
  }
  // "View" opens the PUBLIC page on the website: /benchmarks/{publisher}/{key} (two segments). The
  // app host redirects that shape to www; the one-segment /benchmarks/{key} is the console page here.
  function viewLink(key) {
    const slug = (BM && BM.attributes && BM.attributes.publisher_slug) || "";
    const href = "/benchmarks/" + encodeURIComponent(slug) + "/" + encodeURIComponent(key || "");
    return '<a class="button buttonSecondary buttonSmall" href="' + href + '" target="_blank" rel="noopener">View</a>';
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
      '<nav class="modalTabBar" role="tablist">' + tabBtn("details", "Details") + tabBtn("subjects", "Subjects") + tabBtn("metrics", "Metrics") + tabBtn("runs", "Runs") + tabBtn("history", "History") + tabBtn("apikeys", "API Keys") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div>' +
      "</div>" +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    // Breadcrumb current label
    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Benchmark";
    document.title = (a.name || "Benchmark") + " — smplmark";

    SM.wireCopyButtons($("detail-root"));
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
    else if (currentRenderedTab === "history") { renderHistory(panel, actions); }
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
      form.methodology !== (a.methodology || "") ||
      form.subject_type !== (a.subject_type || "")
    );
  }
  function enterEdit() {
    const a = BM.attributes || {};
    editing = true;
    form = { name: a.name || "", description: a.description || "", about: a.about || "", methodology: a.methodology || "", subject_type: a.subject_type || "" };
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
      const stSel = p.querySelector('[data-edit="subject_type"]');
      if (stSel) stSel.addEventListener("change", () => { form.subject_type = stSel.value; SM.clearFieldError(stSel); });
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
      SM.detailField("Subject type", { value: typeName(a.subject_type) }) +
      SM.detailField("Description", { value: a.description }) +
      SM.detailField("About", { value: a.about, multiline: true }) +
      SM.detailField("Methodology", { value: a.methodology, multiline: true })
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
    // The subject type is fixed while subjects are linked (they conform to it) — shown disabled then.
    // An unknown count (still loading, or the count fetch failed) also locks: better a disabled select
    // than offering a change the server will 409.
    const locked = COUNTS.subjects === null || COUNTS.subjects > 0;
    const typeOpts = (SUBJECT_TYPES || []).map((t) => {
      const ta = t.attributes || {};
      return '<option value="' + esc(t.id) + '"' + (t.id === form.subject_type ? " selected" : "") + ">" + esc(ta.name || ta.key || t.id) + "</option>";
    }).join("");
    const typeField =
      '<div class="field"><span class="detailFieldLabel fieldRequired">Subject type</span>' +
      '<select data-edit="subject_type"' + (locked ? " disabled" : "") + '><option value="">Pick a subject type…</option>' + typeOpts + "</select>" +
      '<p class="detailFieldHelp">' + (locked ? "Fixed while subjects are linked — unlink them to change it." : "The type every linked subject must conform to.") + "</p>" +
      '<p class="fieldErrorMessage" hidden></p></div>';
    return (
      f("Name", "name", { required: true }) +
      typeField +
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
    const stSel = panel.querySelector('[data-edit="subject_type"]');
    let ok = true;
    if (!form.name.trim()) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    if (!form.subject_type) { SM.setFieldError(stSel, "Pick the type of subject this benchmark compares."); ok = false; }
    if (!ok) { (form.name.trim() ? stSel : nameEl).focus(); return; }
    const save = $("d-save"); save.disabled = true;
    setMsg("");
    try {
      // get-mutate-put: round-trip the FULL representation, changing only the edited fields — PUT is
      // full-replace, so omitting measurement_schema / tags / category would reset them. GET first:
      // the copy from page load can be stale (metric link/unlink rewrites the schema server-side),
      // and a stale round-trip drops or resurrects snapshots — or 409s against the freeze once
      // published.
      const freshDoc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID));
      BM = (freshDoc && freshDoc.data) || BM;
      const a = BM.attributes || {};
      const attrs = {
        key: a.key,
        name: form.name.trim(),
        description: form.description.trim() || null,
        about: form.about.trim() || null,
        methodology: form.methodology.trim() || null,
        subject_type: form.subject_type,
        measurement_schema: a.measurement_schema,
        tags: a.tags || [],
        category: a.category,
      };
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
    const a = BM.attributes || {};
    const priv = statusInfo().status === "PRIVATE"; // unlink is draft-only (it deletes measurements)
    // Linking is additive and allowed even when published (recorded in the history); closed blocks it.
    if (CAN_WRITE && !a.closed && actions) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-subject-btn">' + SM.icon("plus", 14) + " Add subject</button>";
      $("add-subject-btn").addEventListener("click", openAddSubjectModal);
    }
    panel.innerHTML = '<div id="subjects-table"></div>';
    const cols = [
      { key: "key", label: "ID", sortable: true, sortValue: (t) => (t.attributes || {}).key || "", render: (t) => "<code>" + esc((t.attributes || {}).key || "") + "</code>" },
      { key: "name", label: "Name", sortable: true, sortValue: (t) => (t.attributes || {}).name || "", render: (t) => esc((t.attributes || {}).name || "") },
    ];
    if (CAN_WRITE && priv) cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (t) =>
      '<button type="button" class="iconBtn unlink-subject" data-link="' + esc(t.__linkId || "") + '" data-name="' + esc((t.attributes || {}).name || (t.attributes || {}).key || "") + '" title="Unlink subject" aria-label="Unlink subject">' + SM.icon("trash", 15) + "</button>" });
    const table = SM.pagedTable($("subjects-table"), {
      columns: cols, rows: [], sort: { key: "key", dir: "asc" }, emptyText: "No subjects linked yet.",
      onRender: CAN_WRITE && priv ? (c) => c.querySelectorAll(".unlink-subject").forEach((el) => el.addEventListener("click", () => unlinkSubject(el.dataset.link, el.dataset.name))) : undefined,
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

  // ── Add-subject modal (pick an existing subject of the benchmark's type, or create one inline) ──
  async function openAddSubjectModal() {
    const stId = (BM.attributes || {}).subject_type;
    const stName = typeName(stId) || "subject";
    const bodyHtml =
      '<form class="form" id="add-subject-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Subject</span>' +
      '<input name="q" type="text" autocomplete="off" placeholder="Pick a subject to link" />' +
      '<p class="detailFieldHelp">This benchmark compares ' + esc(stName) + ' subjects — only those can link. Don’t see it? Create it right here.</p>' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="add-subject-msg"></p>' +
      '<div class="modalActions"><button type="button" class="buttonLink" id="as-new" style="margin-right:auto;">+ New ' + esc(stName) + "</button>" +
      '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add subject</button></div></form>';
    const m = SM.modal({ title: "Add subject", description: "Link an existing subject to this benchmark.", bodyHtml: bodyHtml, width: 520 });
    const f = m.panel.querySelector("#add-subject-form");
    const msg = m.panel.querySelector("#add-subject-msg");
    m.panel.querySelector("#as-new").addEventListener("click", () => { m.close(); openNewSubjectModal(); });
    let acct = [];
    // The picker offers the account's subjects OF THE BENCHMARK'S TYPE that aren't already linked. The
    // pick VALUE is the unique key (what lands in the input); the label shows "name — key". `pickable`
    // is null until the fetch lands so the popup says "Loading…" rather than a false "No matches."
    let pickable = null;
    const combo = SM.combobox(f.q, { options: () => pickable || [], emptyText: () => (pickable ? "No matches — create it below." : "Loading…") });
    try {
      const [acctDoc, linksDoc] = await Promise.all([
        apiFetch("/api/v1/subjects"),
        apiFetch("/api/v1/benchmark_subjects?filter[benchmark]=" + encodeURIComponent(ID)),
      ]);
      acct = (acctDoc && acctDoc.data) || [];
      const linkedIds = new Set(((linksDoc && linksDoc.data) || []).map((l) => (l.attributes || {}).subject));
      pickable = acct.filter((t) => !linkedIds.has(t.id) && (t.attributes || {}).subject_type === stId).map((t) => {
        const a = t.attributes || {};
        return { value: a.key || "", label: (a.name || "") + (a.key ? " — " + a.key : "") };
      });
      combo.refresh();
    } catch (_e) { pickable = []; combo.refresh(); /* picker empty; server resolution by exact key still works */ }
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
        refresh().catch((err2) => setMsg(err2.message, "error")); // modal is closed — report on the page
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  // ── New-subject modal: create a subject of the benchmark's type (typed fields included) and link
  //    it — no detour through the Subjects page. ──
  async function openNewSubjectModal() {
    const stId = (BM.attributes || {}).subject_type;
    let TYPE = null;
    try {
      const d = await apiFetch("/api/v1/subject_types/" + encodeURIComponent(stId));
      TYPE = (d && d.data) || null;
    } catch (_e) { /* fall through to the guard below */ }
    if (!TYPE) { SM.toast("Set the benchmark's subject type first (Details tab).", { kind: "error" }); return; }
    const ta = TYPE.attributes || {};
    const stName = ta.name || ta.key || "subject";
    const fields = ta.fields || [];
    const bodyHtml =
      '<form class="form" id="new-subject-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" autocomplete="off" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<div class="subjectFormFields" id="new-subject-fields">' + SMSubjectForm.render(fields, {}) + "</div>" +
      '<p class="form-status" id="new-subject-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Create &amp; link</button></div></form>';
    const m = SM.modal({ title: "New " + stName, description: "Create a " + stName + " and link it to this benchmark.", bodyHtml: bodyHtml, width: 560 });
    const f = m.panel.querySelector("#new-subject-form");
    const msg = m.panel.querySelector("#new-subject-msg");
    const nameEl = f.querySelector('[name="name"]');
    let createdSubject = null; // survives a failed link so a retry doesn't mint a duplicate
    SMSubjectForm.wire(m.panel.querySelector("#new-subject-fields"));
    nameEl.addEventListener("input", () => SM.clearFieldError(nameEl));
    nameEl.focus();
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(nameEl);
      let ok = true;
      const name = nameEl.value.trim();
      if (!name) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
      const collected = SMSubjectForm.collect(m.panel.querySelector("#new-subject-fields"), fields);
      if (!collected.ok) ok = false;
      if (!ok) return;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        // Create the subject (key auto-generated server-side), then link it here. The created id is
        // retained across retries so a failed LINK never re-creates the subject (no duplicate mints).
        if (!createdSubject) {
          const doc = await apiFetch("/api/v1/subjects", { method: "POST", body: jsonapiBody("subject", { subject_type: stId, name: name, details: collected.values }) });
          createdSubject = doc && doc.data;
        }
        await apiFetch("/api/v1/benchmark_subjects", { method: "POST", body: jsonapiBody("benchmark_subject", { benchmark: ID, subject: createdSubject.id }) });
        m.close();
        SM.toast("Subject created and linked.", { kind: "success" });
        refresh().catch((err2) => setMsg(err2.message, "error")); // modal is closed — report on the page
      } catch (err) {
        submit.disabled = false;
        const note = createdSubject ? " The subject was created — retrying will only retry the link." : "";
        msg.textContent = err.message + note; msg.className = "form-status is-error";
      }
    });
  }

  async function unlinkSubject(linkId, name) {
    if (!linkId) { setMsg("Couldn't resolve the link to remove — refresh and try again.", "error"); return; }
    const ok = await SM.confirm({ title: "Unlink subject?", message: "Remove <strong>" + esc(name) + "</strong> from this benchmark and drop its measurements here? The subject itself is kept in your account.", confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_subjects/" + encodeURIComponent(linkId), { method: "DELETE" });
      await refresh();
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Metrics tab (the values this benchmark reports) ──
  // Metrics are an account-owned library; linking one snapshots its definition into this benchmark's
  // measurement schema. The table is driven by the link rows joined to the account library (which
  // supplies each metric's name/label/type); unlink removes the snapshot (draft benchmarks only).
  async function renderMetrics(panel, actions) {
    const a = BM.attributes || {};
    // Linking and unlinking are allowed even when published (recorded in the history as a
    // semantic-core change); only the closed signal blocks additions.
    if (CAN_WRITE && !a.closed && actions) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-metric-btn">' + SM.icon("plus", 14) + " Add metric</button>";
      $("add-metric-btn").addEventListener("click", openAddMetricModal);
    }
    panel.innerHTML = '<div id="metrics-table"></div>';
    const cols = [
      { key: "name", label: "Name", sortable: true, sortValue: (t) => (t.attributes || {}).name || "", render: (t) => "<code>" + esc((t.attributes || {}).name || "") + "</code>" },
      { key: "label", label: "Label", sortable: true, sortValue: (t) => (t.attributes || {}).label || "", render: (t) => esc((t.attributes || {}).label || "") },
      { key: "type", label: "Type", sortable: true, sortValue: (t) => (t.attributes || {}).type || "", render: (t) => SMMetricForm.typePillHtml((t.attributes || {}).type) },
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
      '<input name="q" type="text" autocomplete="off" placeholder="Pick a metric to link" />' +
      '<p class="detailFieldHelp">Linking copies the metric’s definition into this benchmark. Don’t see the metric you need? Define it right here.</p>' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="add-metric-msg"></p>' +
      '<div class="modalActions"><button type="button" class="buttonLink" id="am-new" style="margin-right:auto;">+ New metric</button>' +
      '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add metric</button></div></form>';
    const m = SM.modal({ title: "Add metric", description: "Link a metric from your library to this benchmark.", bodyHtml: bodyHtml, width: 520 });
    const f = m.panel.querySelector("#add-metric-form");
    const msg = m.panel.querySelector("#add-metric-msg");
    m.panel.querySelector("#am-new").addEventListener("click", () => { m.close(); openNewMetricModal(); });
    let lib = [];
    // The picker offers the account's metrics that aren't already linked to this benchmark. The pick
    // VALUE is the unique name (what lands in the input); the label shows "label — name". `pickable` is
    // null until the fetch lands so the popup says "Loading…" rather than a false "No matches."
    let pickable = null;
    const combo = SM.combobox(f.q, { options: () => pickable || [], emptyText: () => (pickable ? "No matches." : "Loading…") });
    try {
      const [libDoc, linksDoc] = await Promise.all([
        apiFetch("/api/v1/metrics?page[size]=1000"),
        apiFetch("/api/v1/benchmark_metrics?filter[benchmark]=" + encodeURIComponent(ID)),
      ]);
      lib = (libDoc && libDoc.data) || [];
      const linkedIds = new Set(((linksDoc && linksDoc.data) || []).map((l) => (l.attributes || {}).metric));
      pickable = lib.filter((t) => !linkedIds.has(t.id)).map((t) => {
        const a = t.attributes || {};
        return { value: a.name || "", label: (a.label || "") + (a.name ? " — " + a.name : "") };
      });
      combo.refresh();
    } catch (_e) { pickable = []; combo.refresh(); /* picker empty; server resolution by exact name still works */ }
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
        refresh().catch((err2) => setMsg(err2.message, "error")); // modal is closed — report on the page
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  // ── New-metric wizard: define a metric on the fly (2-3 pages — identity, display, formula) and
  //    link it to this benchmark without leaving the page. The wizard retains the created metric
  //    across retries, so a failed link never mints a duplicate. ──
  function openNewMetricModal() {
    SMMetricForm.openWizard({
      description: "Define a new metric and link it to this benchmark.",
      submitLabel: "Create & link",
      onDone: async (created) => {
        await apiFetch("/api/v1/benchmark_metrics", { method: "POST", body: jsonapiBody("benchmark_metric", { benchmark: ID, metric: created.id }) });
        SM.toast("Metric created and linked.", { kind: "success" });
        // Not awaited: the link succeeded, so a refresh failure must not keep the wizard open — its
        // retry would re-POST the link and 409. Surface it on the page instead.
        refresh().catch((err) => setMsg(err.message, "error"));
      },
    });
  }

  async function unlinkMetric(linkId, name) {
    if (!linkId) { setMsg("Couldn't resolve the link to remove — refresh and try again.", "error"); return; }
    const published = statusInfo().status !== "PRIVATE";
    const ok = await SM.confirm({ title: "Unlink metric?", message: "Remove <strong>" + esc(name) + "</strong> from this benchmark’s reported metrics? Existing measurement data is kept, but this metric is no longer part of the benchmark. The metric stays in your library." + (published ? " This benchmark is published, so the change is recorded in its public history." : ""), confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_metrics/" + encodeURIComponent(linkId), { method: "DELETE" });
      await refresh();
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Runs tab — a standard table of runs (measurements live on each run's page). Row click opens
  //    the edit modal: name + start/end times are directly editable while the benchmark is a draft
  //    (no End button — ending a run IS setting its end time), plus the run's API keys. ──
  let RUNS = [];

  function runFlags(a) { return { invalidated: !!(a.invalidated || a.invalidated_at || a.invalidation_reason), ended: !!(a.ended_at || a.live === false) }; }
  function runStateSort(r) { const f = runFlags(r.attributes || {}); return f.invalidated ? "invalidated" : f.ended ? "ended" : "live"; }
  function runStatePill(r) { return SM.statusPill(runStateSort(r), runStateSort(r)); }
  // The run's own detail page: /benchmarks/{benchmarkKey}/runs/{runKey}.
  function runHref(r) {
    const bkey = (BM && BM.attributes && BM.attributes.key) || ID;
    return "/benchmarks/" + encodeURIComponent(bkey) + "/runs/" + encodeURIComponent((r.attributes || {}).key || r.id);
  }

  // datetime-local <-> ISO: the picker works in the viewer's local time; the API stores UTC.
  function dtLocalValue(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function dtLocalToIso(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  async function renderRuns(panel, actions) {
    const a = BM.attributes || {};
    // Runs may be added and edited even when published (recorded in the history); closed blocks adds.
    if (CAN_WRITE && !a.closed && actions) {
      actions.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall" id="add-run-btn">' + SM.icon("plus", 14) + " Add run</button>";
      $("add-run-btn").addEventListener("click", openAddRunModal);
    }
    panel.innerHTML = '<div id="runs-table"></div><div id="runs-msg" class="form-status" style="margin-top:0.5rem;"></div>';
    const table = SM.pagedTable($("runs-table"), {
      columns: [
        { key: "key", label: "Run ID", sortable: true, sortValue: (r) => (r.attributes || {}).key || "", render: (r) => "<code>" + esc((r.attributes || {}).key || "") + "</code>" },
        { key: "name", label: "Name", sortable: true, sortValue: (r) => (r.attributes || {}).name || "", render: (r) => esc((r.attributes || {}).name || "—") },
        { key: "state", label: "Status", sortable: true, sortValue: runStateSort, render: runStatePill },
        { key: "started", label: "Started", sortable: true, sortValue: (r) => (r.attributes || {}).started_at || "", render: (r) => esc(SM.fmtDateTime((r.attributes || {}).started_at) || "—") },
        { key: "ended", label: "Ended", sortable: true, sortValue: (r) => (r.attributes || {}).ended_at || "", render: (r) => esc(SM.fmtDateTime((r.attributes || {}).ended_at) || "—") },
      ],
      rows: [], sort: { key: "started", dir: "desc" }, emptyText: "No runs yet.",
      // Selecting a run opens its own detail page (edit, measurements, keys, API reference live there).
      onRowClick: (r) => { location.href = runHref(r); },
    });
    try {
      const doc = await apiFetch("/api/v1/runs?filter[benchmark]=" + encodeURIComponent(ID) + "&page[size]=1000");
      RUNS = (doc && doc.data) || [];
      table.setRows(RUNS);
      setCount("runs", RUNS.length);
    } catch (err) {
      $("runs-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Add-run modal — started/ended stacked so the datetime pickers never run off the modal.
  //    Run-scoped API keys are an advanced concern — create them from the run's API Keys tab. ──
  async function openAddRunModal() {
    const bodyHtml =
      '<form class="form" id="add-run-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel">Run ID</span><input name="key" type="text" autocomplete="off" placeholder="Auto-generated if left blank" /><p class="detailFieldHelp">A unique identifier for this run within the benchmark. Leave blank to auto-generate one.</p></label>' +
      '<label class="field"><span class="detailFieldLabel">Name</span><input name="name" type="text" autocomplete="off" placeholder="Optional — a label for this run" /></label>' +
      '<label class="field"><span class="detailFieldLabel">Started at</span><input name="started_at" type="datetime-local" /><p class="detailFieldHelp">Defaults to now if left blank.</p></label>' +
      '<label class="field"><span class="detailFieldLabel">Ended at</span><input name="ended_at" type="datetime-local" /><p class="detailFieldHelp">Leave blank while the run is still live.</p></label>' +
      '<p class="form-status" id="add-run-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add run</button></div></form>';
    let createdRun = null; // survives a failed re-submit so a retry doesn't duplicate the run
    let finished = false;  // distinguishes success-close from abandoning after the run was created
    const m = SM.modal({
      title: "Add run", description: "Record a new run for this benchmark.", bodyHtml: bodyHtml, width: 560,
      onClose: () => { if (createdRun && !finished) renderRuns($("tab-panel"), $("tab-actions")); },
    });
    const f = m.panel.querySelector("#add-run-form");
    const msg = m.panel.querySelector("#add-run-msg");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      const started = dtLocalToIso(f.started_at.value);
      const ended = dtLocalToIso(f.ended_at.value);
      if (started === undefined || ended === undefined) { msg.textContent = "Enter valid dates."; msg.className = "form-status is-error"; return; }
      if (ended && !started) { msg.textContent = "Set Started at when recording an end time — a blank start defaults to now."; msg.className = "form-status is-error"; return; }
      if (started && ended && new Date(ended) < new Date(started)) { msg.textContent = "Ended at must not be earlier than Started at."; msg.className = "form-status is-error"; return; }
      const attrs = { benchmark: ID };
      const k = f.key.value.trim(); if (k) attrs.key = k;
      const n = f.name.value.trim(); if (n) attrs.name = n;
      if (started) attrs.started_at = started;
      if (ended) attrs.ended_at = ended;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        if (!createdRun) {
          const doc = await apiFetch("/api/v1/runs", { method: "POST", body: jsonapiBody("run", attrs) });
          createdRun = doc && doc.data;
        }
        finished = true;
        m.close();
        renderRuns($("tab-panel"), $("tab-actions"));
      } catch (err) {
        submit.disabled = false;
        msg.textContent = err.message; msg.className = "form-status is-error";
      }
    });
  }

  // ── History tab — the benchmark's audit trail (its own events plus its runs/measurements). ──
  function eventLabel(t) {
    const labels = {
      "benchmark.created": "Created",
      "benchmark.edited": "Edited",
      "benchmark.published": "Published",
      "benchmark.closed": "Closed",
      "benchmark.reopened": "Reopened",
      "benchmark.withdrawn": "Withdrawn",
      "benchmark.taken_down": "Taken down",
      "benchmark.takedown_requested": "Takedown requested",
      "run.created": "Run created",
      "run.edited": "Run edited",
      "run.ended": "Run ended",
      "run.reopened": "Run reopened",
      "run.appended": "Run appended",
      "run.invalidated": "Run invalidated",
      "measurement.created": "Measurement recorded",
      "measurement.corrected": "Measurement corrected",
      "measurement.deleted": "Measurement deleted",
      "subject.created": "Subject created",
      "subject.edited": "Subject edited",
    };
    return labels[t] || t;
  }
  function actorLabel(actor) {
    if (!actor) return "—";
    if (actor.label) return actor.label;
    if (actor.type === "API_KEY") return "an API key";
    if (actor.type === "USER") return whoLabel(actor.id);
    return actor.type ? String(actor.type).toLowerCase() : "—";
  }
  function historyColumns() {
    return [
      { key: "when", label: "When", sortable: true, sortValue: (e) => (e.attributes || {}).occurred_at || "", render: (e) => esc(fmtDate((e.attributes || {}).occurred_at) || "—") },
      { key: "event", label: "Event", sortable: true, sortValue: (e) => (e.attributes || {}).event_type || "", render: (e) => {
        const a = e.attributes || {};
        return esc(eventLabel(a.event_type)) + (a.semantic_core ? ' <span class="tabBadge" title="Changed how the numbers are computed or read">semantic</span>' : "");
      } },
      { key: "description", label: "What happened", sortable: false, render: (e) => esc((e.attributes || {}).description || "") },
      { key: "actor", label: "By", sortable: false, render: (e) => esc(actorLabel((e.attributes || {}).actor)) },
    ];
  }
  function openHistoryEventModal(e) {
    const a = e.attributes || {};
    const changes = a.changes ? '<p class="detailFieldLabel" style="margin-top:0.8rem;">Changes (before → after)</p><pre style="margin:0;white-space:pre-wrap;font-family:var(--mono);font-size:0.82rem;color:var(--text-muted);max-height:320px;overflow:auto;">' + esc(JSON.stringify(a.changes, null, 2)) + "</pre>" : "";
    SM.modal({
      title: eventLabel(a.event_type),
      description: fmtDate(a.occurred_at) + " — " + actorLabel(a.actor),
      bodyHtml: '<p>' + esc(a.description || "") + "</p>" + changes +
        '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Close</button></div>',
      width: 620,
    });
  }
  async function renderHistory(panel, actions) {
    panel.innerHTML = '<p class="muted" style="margin:0 0 0.6rem;">Every change to this benchmark and its runs and measurements, newest first. Visitors see the post-publish events on the public page, attributed to the publisher.</p><div id="history-table"></div>';
    const table = SM.pagedTable($("history-table"), {
      columns: historyColumns(), rows: [], sort: { key: "when", dir: "desc" },
      emptyText: "No history recorded yet.",
      onRowClick: openHistoryEventModal,
    });
    try {
      const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID) + "/history");
      table.setRows((doc && doc.data) || []);
    } catch (err) {
      $("history-table").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Request-takedown modal — files a request for OPERATOR review; it never deletes anything. ──
  function openTakedownModal() {
    const a = BM.attributes || {};
    const bodyHtml =
      '<form class="form" id="takedown-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Your name</span><input name="tname" type="text" autocomplete="name" value="' + esc(USER_NAME) + '" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Your email</span><input name="temail" type="email" autocomplete="email" value="' + esc(USER_EMAIL) + '" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Why should it be removed?</span><textarea name="treason" rows="4" placeholder="e.g. it contains personal data that must be removed"></textarea><p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="takedown-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Send request</button></div></form>';
    const m = SM.modal({
      title: "Request takedown",
      description: "Asks smplmark operators to remove “" + (a.name || a.key || "") + "” entirely. This files a request for review — nothing is deleted until an operator acts on it. To retract the benchmark yourself while keeping the record, use Withdraw instead.",
      bodyHtml: bodyHtml,
      width: 560,
    });
    const f = m.panel.querySelector("#takedown-form");
    const msg = m.panel.querySelector("#takedown-msg");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      let ok = true;
      [["tname", "Your name is required."], ["temail", "Your email is required."], ["treason", "A reason is required."]].forEach(([name, err]) => {
        const el = f[name]; SM.clearFieldError(el);
        if (!el.value.trim()) { SM.setFieldError(el, err); ok = false; }
      });
      if (!ok) return;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await apiFetch("/api/v1/takedown_requests", { method: "POST", body: jsonapiBody("takedown_request", {
          benchmark: ID,
          requester_name: f.tname.value.trim(),
          requester_email: f.temail.value.trim(),
          reason: f.treason.value.trim(),
        }) });
        m.close();
        SM.toast("Takedown request sent — smplmark operators will review it.", { kind: "success" });
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  // ── Lifecycle actions ──
  async function lifecycle(act) {
    if (act === "publish") { openPublishModal(); return; }
    if (act === "delete") { doDelete(); return; }
    if (act === "withdraw") { doWithdraw(); return; }
    if (act === "takedown") { openTakedownModal(); return; }
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
      location.href = "/benchmarks";
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
      description: "Publishing makes the benchmark public. It stays editable, but every later change is recorded in its public history. Choose how it's attributed.",
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
