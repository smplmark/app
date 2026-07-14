"use strict";

// Run detail (/account/runs/detail?id=…) — a conforming detail page for a single run: a DetailHeader
// with the run's key + status, and two tabs — Details (the run's info) and API Keys (keys scoped to
// this run, for beacon/CI uploads). The API-key scope is implicit here, so creating one never asks the
// user for a scope or id. Runs are managed (End / Invalidate) from the benchmark's Runs tab.
// Depends on api.js + shell.js (SM helpers) + apikeys-panel.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";
  const TABS = ["details", "apikeys"];

  let RUN = null;
  let BENCH = null; // the parent benchmark (for the breadcrumb + a link)
  let CAN_ADMIN = false;

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
      tabBtn("details", "Details") + tabBtn("apikeys", "API Keys") + "</nav>" +
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
      '<p class="detailFieldHelp" style="margin-top:1rem;">Manage this run’s state (End / Invalidate) from its benchmark’s Runs tab.</p></div>';
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
