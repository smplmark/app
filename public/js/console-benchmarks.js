"use strict";

// Benchmarks list (/account/benchmarks) — a conforming list page: a search + refresh toolbar above
// the table, a contextual empty state, and row-click to the detail page (where lifecycle, targets,
// and runs live). Create is a strict modal with per-field validation. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let ACCOUNT_ID = null, CAN_WRITE = false;
  let ALL = [];
  let SEARCH = "";

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
        "<h2>No benchmarks yet</h2><p>Create your first benchmark — a private workspace you can publish when the data's ready.</p>" +
        (CAN_WRITE ? '<button type="button" class="button buttonPrimary" id="empty-create">New benchmark</button>' : "") + "</div>";
      const b = $("empty-create"); if (b) b.addEventListener("click", openCreateModal);
      return;
    }
    wireTopBar();
    host.innerHTML =
      '<div id="bm-toolbar-mount"></div>' +
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable">' +
      '<thead><tr><th>Key</th><th>Name</th><th>Status</th></tr></thead>' +
      '<tbody id="bm-body"></tbody></table></div></div>';
    const bar = SM.toolbar({ placeholder: "Search benchmarks…", onSearch: (v) => { SEARCH = v; renderRows(); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("bm-toolbar-mount").replaceWith(bar);
    renderRows();
  }

  function renderRows() {
    const body = $("bm-body");
    if (!body) return;
    const rows = filtered();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="3" class="dataTableEmpty">No matching benchmarks.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(rowHtml).join("");
    body.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", () => { location.href = "/account/benchmarks/detail?id=" + encodeURIComponent(tr.dataset.id); });
    });
  }

  function rowHtml(b) {
    const a = b.attributes || {};
    const status = String(a.status || "").toUpperCase();
    const isReady = status === "PRIVATE" && a.draft === false;
    let s = SM.statusPill(status, status);
    if (a.closed) s += " " + SM.statusPill("complete", "complete");
    if (status === "PRIVATE") s += " " + (isReady ? SM.statusPill("ready", "ready") : SM.statusPill("draft", "draft"));
    else if (a.published_as) {
      const pa = a.published_as;
      const who = pa.kind === "ORGANIZATION" ? (pa.name || "") : pa.kind === "INGESTED" ? (pa.source_name || "ingested") : (pa.display_name || "you");
      s += ' <span class="muted attributionLabel">as ' + esc(who) + "</span>";
    }
    return '<tr class="dataTableRowClickable" data-id="' + esc(b.id) + '">' +
      "<td><code>" + esc(a.key || "") + "</code></td>" +
      "<td>" + esc(a.name || "") + "</td>" +
      "<td>" + s + "</td></tr>";
  }

  // ── Create modal (strict, per-field validation; on success go straight to the new detail page) ──
  function openCreateModal() {
    const bodyHtml =
      '<form class="form" id="create-form">' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Key</span><input name="key" type="text" placeholder="my-benchmark" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="My Benchmark" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Description</span><input name="description" type="text" placeholder="One-line summary" /></label>' +
      '<p class="form-status" id="create-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Create</button></div></form>';
    const m = SM.modal({ title: "Create benchmark", description: "Start a private workspace. Publish it when the data is ready.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#create-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = m.panel.querySelector("#create-msg"); msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.key); SM.clearFieldError(f.name);
      let ok = true;
      if (!f.key.value.trim()) { SM.setFieldError(f.key, "A key is required."); ok = false; }
      if (!f.name.value.trim()) { SM.setFieldError(f.name, "A name is required."); ok = false; }
      if (!ok) return;
      const attrs = { key: f.key.value.trim(), name: f.name.value.trim() };
      const d = f.description.value.trim(); if (d) attrs.description = d;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/benchmarks", { method: "POST", body: jsonapiBody("benchmark", attrs) });
        m.close();
        const newId = doc && doc.data && doc.data.id;
        if (newId) location.href = "/account/benchmarks/detail?id=" + encodeURIComponent(newId);
        else load();
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
    f.key.addEventListener("input", () => SM.clearFieldError(f.key));
    f.name.addEventListener("input", () => SM.clearFieldError(f.name));
  }
})();
