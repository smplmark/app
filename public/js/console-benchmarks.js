"use strict";

// Benchmarks list (/account/benchmarks) — a conforming list page: a search + refresh toolbar above
// the table, a contextual empty state, and row-click to the detail page (where lifecycle, subjects,
// and runs live). Create is a strict modal with per-field validation. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let ACCOUNT_ID = null, CAN_WRITE = false;
  let ALL = [];
  let SEARCH = "";
  let TABLE = null;

  SM.ready.then((id) => {
    ACCOUNT_ID = id.accountId;
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => { $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>'; });

  function wireTopBar() {
    if (!CAN_WRITE) return;
    SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-benchmark">' + SM.icon("plus", 16) + " New benchmark</button>");
    $("new-benchmark").addEventListener("click", openCreateModal);
  }

  async function load() {
    try {
      const doc = await apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent(ACCOUNT_ID));
      ALL = (doc && doc.data) || [];
      ALL.sort((a, z) => String((z.attributes || {}).created_at || "").localeCompare(String((a.attributes || {}).created_at || "")));
      render();
    } catch (err) {
      $("bm-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function filtered() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((b) => { const a = b.attributes || {}; return (a.name || "").toLowerCase().includes(q) || (a.key || "").toLowerCase().includes(q); });
  }

  function render() {
    const host = $("bm-content");
    // Truly-empty first visit: the create-your-first hero stands alone (no toolbar, no top-bar dup).
    if (!ALL.length && !SEARCH.trim()) {
      SM.setTopBarAction("");
      host.innerHTML =
        '<div class="emptyState"><div class="emptyIcon">' + SM.icon("benchmarks", 44) + "</div>" +
        "<h2>No benchmarks yet</h2><p>Create your first benchmark — it stays private until you publish it.</p>" +
        (CAN_WRITE ? '<button type="button" class="button buttonPrimary" id="empty-create">New benchmark</button>' : "") + "</div>";
      const b = $("empty-create"); if (b) b.addEventListener("click", openCreateModal);
      return;
    }
    wireTopBar();
    host.innerHTML = '<div id="bm-toolbar-mount"></div><div id="bm-table"></div>';
    const bar = SM.toolbar({ placeholder: "Search benchmarks…", onSearch: (v) => { SEARCH = v; if (TABLE) TABLE.setRows(filtered()); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("bm-toolbar-mount").replaceWith(bar);
    TABLE = SM.pagedTable($("bm-table"), {
      columns: [
        { key: "key", label: "Key", sortable: true, sortValue: (b) => (b.attributes || {}).key || "", render: (b) => "<code>" + esc((b.attributes || {}).key || "") + "</code>" },
        { key: "name", label: "Name", sortable: true, sortValue: (b) => (b.attributes || {}).name || "", render: (b) => esc((b.attributes || {}).name || "") },
        { key: "status", label: "Status", sortable: true, sortValue: (b) => String((b.attributes || {}).status || ""), render: statusCell },
      ],
      rows: filtered(),
      sort: { key: "key", dir: "asc" },
      emptyText: "No matching benchmarks.",
      onRowClick: (b) => { location.href = "/account/benchmarks/detail?id=" + encodeURIComponent(b.id); },
    });
  }

  function statusCell(b) {
    const a = b.attributes || {};
    const status = String(a.status || "").toUpperCase();
    let s = status === "PRIVATE" ? SM.statusPill("draft", "draft") : SM.statusPill(status, status);
    if (a.closed) s += " " + SM.statusPill("complete", "complete");
    if (status !== "PRIVATE" && a.published_as) {
      const pa = a.published_as;
      const who = pa.kind === "ORGANIZATION" ? (pa.name || "") : pa.kind === "INGESTED" ? (pa.source_name || "ingested") : (pa.display_name || "you");
      s += ' <span class="muted attributionLabel">as ' + esc(who) + "</span>";
    }
    return s;
  }

  // ── Create wizard ── A 3-step modal: (1) name + description, (2) link subjects, (3) link metrics. The
  //    key is auto-generated from the name server-side. Subjects/metrics are optional (one or more, and
  //    always addable later from the benchmark's tabs). Finish creates the benchmark, links the chosen
  //    subjects + metrics, and opens it in view mode.
  function openCreateModal() {
    const data = { name: "", description: "" };
    const subjects = []; // chosen subject resources
    const metrics = [];  // chosen metric resources
    let acctSubjects = null; // account library, loaded lazily on first visit to each step
    let acctMetrics = null;

    const m = SM.modal({ title: "", bodyHtml: '<div id="bw-root"></div>', width: 520 });
    const header = m.panel.querySelector(".modalHeader");
    if (header) header.style.display = "none"; // each step renders its own heading
    const root = m.panel.querySelector("#bw-root");

    function dots(active) {
      let out = '<div class="wzSteps" aria-hidden="true">';
      for (let i = 0; i < 3; i++) out += '<span class="wzDot' + (i === active ? " isActive" : "") + '"></span>';
      return out + "</div>";
    }
    function nav(backFn, nextLabel, nextFn) {
      return '<div class="modalActions">' +
        (backFn ? '<button type="button" class="button buttonSecondary buttonSmall" id="bw-back">Back</button>' : '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>') +
        '<button type="button" class="button buttonPrimary buttonSmall" id="bw-next">' + nextLabel + "</button></div>";
    }

    // A datalist picker that accumulates chosen items into `chosen` (dedup by id). matchKeys(t) lists the
    // strings a typed value can match; optLabel(t)/chipLabel(t) render the option + chip; onChange re-renders.
    function setupPicker(inputSel, listSel, chipsSel, source, chosen, matchKeys, optLabel, chipLabel) {
      const input = root.querySelector(inputSel);
      function fillList() {
        const ids = new Set(chosen.map((c) => c.id));
        root.querySelector(listSel).innerHTML = (source() || []).filter((t) => !ids.has(t.id))
          .map((t) => '<option value="' + esc(matchKeys(t)[0] || "") + '">' + esc(optLabel(t)) + "</option>").join("");
      }
      function renderChips() {
        const host = root.querySelector(chipsSel);
        host.innerHTML = chosen.map((t, i) => '<span class="wzChip">' + esc(chipLabel(t)) + '<button type="button" data-i="' + i + '" title="Remove" aria-label="Remove">×</button></span>').join("");
        host.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { chosen.splice(Number(b.dataset.i), 1); renderChips(); fillList(); }));
      }
      function add() {
        const val = input.value.trim().toLowerCase();
        input.value = "";
        if (!val) return;
        const t = (source() || []).find((x) => matchKeys(x).some((k) => String(k || "").toLowerCase() === val));
        if (t && !chosen.some((c) => c.id === t.id)) { chosen.push(t); renderChips(); fillList(); }
      }
      input.addEventListener("change", add);
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
      renderChips();
      fillList();
      return fillList;
    }

    async function loadList(url, set) {
      try { const doc = await apiFetch(url); set((doc && doc.data) || []); } catch (_e) { set([]); }
    }

    renderName();

    // ── Step 1: name + description ──
    function renderName() {
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHead"><h2 class="wzTitle">Create benchmark</h2><p class="wzText">Give it a name and an optional description. You can publish it when it’s ready.</p></div>' +
        '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input id="bw-name" type="text" placeholder="My Benchmark" autocomplete="off" value="' + esc(data.name) + '" /><p class="fieldErrorMessage" hidden></p></label>' +
        '<label class="field"><span class="detailFieldLabel">Description</span><textarea id="bw-desc" rows="4" placeholder="Description of the benchmark" style="font-family:inherit;">' + esc(data.description) + "</textarea></label>" +
        '<p class="form-status" id="bw-msg"></p>' +
        dots(0) +
        nav(null, "Next", null);
      const nameEl = root.querySelector("#bw-name");
      nameEl.addEventListener("input", () => SM.clearFieldError(nameEl));
      root.querySelector("#bw-next").addEventListener("click", goSubjects);
      nameEl.focus();
    }
    function goSubjects() {
      const nameEl = root.querySelector("#bw-name");
      SM.clearFieldError(nameEl);
      const name = nameEl.value.trim();
      if (!name) { SM.setFieldError(nameEl, "A name is required."); nameEl.focus(); return; }
      data.name = name;
      data.description = root.querySelector("#bw-desc").value.trim();
      renderSubjects();
    }

    // ── Step 2: subjects ──
    function renderSubjects() {
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHead"><h2 class="wzTitle">Add subjects</h2><p class="wzText">Link the subjects this benchmark compares — the things you’re measuring. This is optional: add one or more now, or add them anytime later from the benchmark’s Subjects tab.</p></div>' +
        '<label class="field"><span class="detailFieldLabel">Subject</span><input id="bw-subj" type="text" list="bw-subj-list" autocomplete="off" placeholder="Pick a subject to add" /><datalist id="bw-subj-list"></datalist></label>' +
        '<div class="wzChips" id="bw-subj-chips"></div>' +
        '<p class="form-status" id="bw-msg"></p>' +
        dots(1) +
        nav(renderName, "Next", null);
      const fillList = setupPicker("#bw-subj", "#bw-subj-list", "#bw-subj-chips", () => acctSubjects, subjects,
        (t) => [(t.attributes || {}).key, (t.attributes || {}).name],
        (t) => { const a = t.attributes || {}; return (a.name || "") + (a.key ? " — " + a.key : ""); },
        (t) => (t.attributes || {}).name || (t.attributes || {}).key || "");
      root.querySelector("#bw-back").addEventListener("click", renderName);
      root.querySelector("#bw-next").addEventListener("click", renderMetrics);
      root.querySelector("#bw-subj").focus();
      if (acctSubjects === null) loadList("/api/v1/subjects?page[size]=1000", (rows) => { acctSubjects = rows; fillList(); });
    }

    // ── Step 3: metrics ──
    function renderMetrics() {
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHead"><h2 class="wzTitle">Add metrics</h2><p class="wzText">Link the metrics this benchmark reports. This is optional: add one or more now, or add them anytime later from the benchmark’s Metrics tab.</p></div>' +
        '<label class="field"><span class="detailFieldLabel">Metric</span><input id="bw-metric" type="text" list="bw-metric-list" autocomplete="off" placeholder="Pick a metric to add" /><datalist id="bw-metric-list"></datalist></label>' +
        '<div class="wzChips" id="bw-metric-chips"></div>' +
        '<p class="form-status" id="bw-msg"></p>' +
        dots(2) +
        nav(renderSubjects, "Finish", null);
      const fillList = setupPicker("#bw-metric", "#bw-metric-list", "#bw-metric-chips", () => acctMetrics, metrics,
        (t) => [(t.attributes || {}).name, (t.attributes || {}).label],
        (t) => { const a = t.attributes || {}; return (a.label || "") + (a.name ? " — " + a.name : ""); },
        (t) => (t.attributes || {}).label || (t.attributes || {}).name || "");
      const nextBtn = root.querySelector("#bw-next"); nextBtn.id = "bw-finish";
      root.querySelector("#bw-back").addEventListener("click", renderSubjects);
      nextBtn.addEventListener("click", finish);
      root.querySelector("#bw-metric").focus();
      if (acctMetrics === null) loadList("/api/v1/metrics?page[size]=1000", (rows) => { acctMetrics = rows; fillList(); });
    }

    // ── Finish: create the benchmark, link the chosen subjects + metrics, open it in view mode ──
    async function finish() {
      const msg = root.querySelector("#bw-msg"); msg.textContent = ""; msg.className = "form-status";
      const btn = root.querySelector("#bw-finish"); btn.disabled = true;
      try {
        const attrs = { name: data.name };
        if (data.description) attrs.description = data.description;
        const doc = await apiFetch("/api/v1/benchmarks", { method: "POST", body: jsonapiBody("benchmark", attrs) });
        const id = doc && doc.data && doc.data.id;
        if (!id) throw new Error("The benchmark could not be created.");
        // Link the chosen subjects + metrics (best-effort; the benchmark exists and the rest is addable later).
        const links = subjects.map((s) => apiFetch("/api/v1/benchmark_subjects", { method: "POST", body: jsonapiBody("benchmark_subject", { benchmark: id, subject: s.id }) }))
          .concat(metrics.map((mt) => apiFetch("/api/v1/benchmark_metrics", { method: "POST", body: jsonapiBody("benchmark_metric", { benchmark: id, metric: mt.id }) })));
        await Promise.allSettled(links);
        m.close();
        location.href = "/account/benchmarks/detail?id=" + encodeURIComponent(id);
      } catch (err) { btn.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    }
  }
})();
