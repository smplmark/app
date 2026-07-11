"use strict";

// Targets list (/account/targets) — the account's reusable targets, which can be linked into any of
// its benchmarks (M:N). A conforming list page: search + refresh toolbar, contextual empty state,
// row-click to the target detail page, and a strict create modal. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let CAN_WRITE = false;
  let ALL = [];
  let SEARCH = "";
  let TRUNCATED = false;

  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => { $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>'; });

  function wireTopBar() {
    if (!CAN_WRITE) { SM.setTopBarAction(""); return; }
    SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-target">' + SM.icon("plus", 16) + " New target</button>");
    $("new-target").addEventListener("click", openCreateModal);
  }

  // Page through the account's targets (the API caps page[size] at 1000). Bounded so a claimed
  // ingestion account with tens of thousands of targets can't hang the browser — a note flags it.
  async function load() {
    try {
      ALL = [];
      TRUNCATED = false;
      const SIZE = 1000, MAX_PAGES = 20;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const doc = await apiFetch("/api/v1/targets?page[number]=" + page + "&page[size]=" + SIZE);
        const rows = (doc && doc.data) || [];
        ALL = ALL.concat(rows);
        if (rows.length < SIZE) break;
        if (page === MAX_PAGES) TRUNCATED = true;
      }
      ALL.sort((a, z) => String((a.attributes || {}).key || "").localeCompare(String((z.attributes || {}).key || "")));
      render();
    } catch (err) {
      $("tg-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function filtered() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((t) => {
      const a = t.attributes || {};
      return (a.name || "").toLowerCase().includes(q) || (a.key || "").toLowerCase().includes(q);
    });
  }

  function render() {
    const host = $("tg-content");
    if (!ALL.length && !SEARCH.trim()) {
      SM.setTopBarAction("");
      host.innerHTML =
        '<div class="emptyState"><div class="emptyIcon">' + SM.icon("targets", 44) + "</div>" +
        "<h2>No targets yet</h2><p>A target is a thing you measure — a system, model, or configuration. Create one, then link it into any of your benchmarks.</p>" +
        (CAN_WRITE ? '<button type="button" class="button buttonPrimary" id="empty-create">New target</button>' : "") + "</div>";
      const b = $("empty-create"); if (b) b.addEventListener("click", openCreateModal);
      return;
    }
    wireTopBar();
    host.innerHTML =
      (TRUNCATED ? '<p class="muted" style="margin:0 0 0.6rem;">Showing the first ' + ALL.length + ' targets — search to narrow down.</p>' : "") +
      '<div id="tg-toolbar-mount"></div>' +
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable">' +
      '<thead><tr><th>Key</th><th>Name</th></tr></thead>' +
      '<tbody id="tg-body"></tbody></table></div></div>';
    const bar = SM.toolbar({ placeholder: "Search targets…", onSearch: (v) => { SEARCH = v; renderRows(); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("tg-toolbar-mount").replaceWith(bar);
    renderRows();
  }

  function renderRows() {
    const body = $("tg-body");
    if (!body) return;
    const rows = filtered();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="2" class="dataTableEmpty">No matching targets.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(rowHtml).join("");
    body.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", () => { location.href = "/account/targets/detail?id=" + encodeURIComponent(tr.dataset.id); });
    });
  }

  function rowHtml(t) {
    const a = t.attributes || {};
    return '<tr class="dataTableRowClickable" data-id="' + esc(t.id) + '">' +
      "<td><code>" + esc(a.key || "") + "</code></td>" +
      "<td>" + esc(a.name || "") + "</td></tr>";
  }

  // ── Create modal (strict, per-field validation; details is optional JSON) ──
  function openCreateModal() {
    const bodyHtml =
      '<form class="form" id="create-form">' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Key</span><input name="key" type="text" placeholder="amd-epyc-9754" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="AMD EPYC 9754" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Details (JSON)</span><textarea name="details" rows="3" placeholder=\'{"vendor":"AMD","cores":128}\'></textarea><p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="create-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Create</button></div></form>';
    const m = SM.modal({ title: "Create target", description: "A reusable thing you measure. Link it into benchmarks after creating it.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#create-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = m.panel.querySelector("#create-msg"); msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.key); SM.clearFieldError(f.name); SM.clearFieldError(f.details);
      let ok = true;
      if (!f.key.value.trim()) { SM.setFieldError(f.key, "A key is required."); ok = false; }
      if (!f.name.value.trim()) { SM.setFieldError(f.name, "A name is required."); ok = false; }
      const attrs = { key: f.key.value.trim(), name: f.name.value.trim() };
      const d = f.details.value.trim();
      if (d) {
        try { attrs.details = JSON.parse(d); }
        catch (_e) { SM.setFieldError(f.details, "Details must be valid JSON."); ok = false; }
      }
      if (!ok) return;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/targets", { method: "POST", body: jsonapiBody("target", attrs) });
        m.close();
        const newId = doc && doc.data && doc.data.id;
        if (newId) location.href = "/account/targets/detail?id=" + encodeURIComponent(newId);
        else load();
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
    f.key.addEventListener("input", () => SM.clearFieldError(f.key));
    f.name.addEventListener("input", () => SM.clearFieldError(f.name));
    f.details.addEventListener("input", () => SM.clearFieldError(f.details));
  }
})();
