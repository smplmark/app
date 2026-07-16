"use strict";

// Metrics list (/account/metrics) — a conforming list page: a search + refresh toolbar above the
// table, a contextual empty state, and row-click to the detail page. Metrics are an account-owned,
// reusable library; a benchmark links the ones it reports. Create opens the shared metric editor
// modal. Depends on api.js + shell.js + metric-form.js (SMMetricForm).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let CAN_WRITE = false;
  let ALL = [];
  let SEARCH = "";
  let TABLE = null;

  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => { $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>'; });

  function wireTopBar() {
    if (!CAN_WRITE) { SM.setTopBarAction(""); return; }
    SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-metric">' + SM.icon("plus", 16) + " New metric</button>");
    $("new-metric").addEventListener("click", openCreate);
  }

  function openCreate() {
    SMMetricForm.openWizard({
      description: "Define a new metric for your library.",
      onDone: (created) => { location.href = "/account/metrics/detail?id=" + encodeURIComponent(created.id); },
    });
  }

  async function load() {
    try {
      const doc = await apiFetch("/api/v1/metrics?page[size]=200");
      ALL = (doc && doc.data) || [];
      ALL.sort((a, z) => String((a.attributes || {}).name || "").localeCompare(String((z.attributes || {}).name || "")));
      render();
    } catch (err) {
      $("mt-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function filtered() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((m) => {
      const a = m.attributes || {};
      return (a.name || "").toLowerCase().includes(q) || (a.label || "").toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q);
    });
  }

  function render() {
    const host = $("mt-content");
    // Truly-empty first visit: the create-your-first hero stands alone (no toolbar, no top-bar dup).
    if (!ALL.length && !SEARCH.trim()) {
      SM.setTopBarAction("");
      host.innerHTML =
        '<div class="emptyState"><div class="emptyIcon">' + SM.icon("activity", 44) + "</div>" +
        "<h2>No metrics yet</h2><p>A metric is a value your benchmarks report — an integer or decimal posted with each measurement, or a formula computed on read. Define your library here, then link metrics from a benchmark.</p>" +
        (CAN_WRITE ? '<button type="button" class="button buttonPrimary" id="empty-create">New metric</button>' : "") + "</div>";
      const b = $("empty-create"); if (b) b.addEventListener("click", openCreate);
      return;
    }
    wireTopBar();
    host.innerHTML = '<div id="mt-toolbar-mount"></div><div id="mt-table"></div>';
    const bar = SM.toolbar({ placeholder: "Search metrics…", onSearch: (v) => { SEARCH = v; if (TABLE) TABLE.setRows(filtered()); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("mt-toolbar-mount").replaceWith(bar);
    TABLE = SM.pagedTable($("mt-table"), {
      columns: [
        { key: "name", label: "Name", sortable: true, sortValue: (m) => (m.attributes || {}).name || "", render: (m) => "<code>" + esc((m.attributes || {}).name || "") + "</code>" },
        { key: "label", label: "Label", sortable: true, sortValue: (m) => (m.attributes || {}).label || "", render: (m) => esc((m.attributes || {}).label || "") },
        { key: "type", label: "Type", sortable: true, sortValue: (m) => (m.attributes || {}).type || "", render: (m) => SMMetricForm.typePillHtml((m.attributes || {}).type) },
      ],
      rows: filtered(),
      sort: { key: "name", dir: "asc" },
      emptyText: "No matching metrics.",
      onRowClick: (m) => { location.href = "/account/metrics/detail?id=" + encodeURIComponent(m.id); },
    });
  }
})();
