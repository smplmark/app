"use strict";

// Publishers list (/account/publishers) — the account's organization publisher identities. A
// conforming list page: search + refresh toolbar, contextual empty state, row-click to the identity
// detail page (where domains are verified). Admin-only. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let CAN_ADMIN = false;
  let ALL = [];
  let SEARCH = "";

  function safeHttpUrl(u) {
    try {
      const p = new URL(u);
      return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
    } catch (_) {
      return null;
    }
  }

  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    if (!CAN_ADMIN) {
      SM.setTopBarAction("");
      $("pub-content").innerHTML =
        '<div class="panel"><p class="muted" style="margin:0;">Only admins can manage publisher identities. Ask an account admin for access.</p></div>';
      return;
    }
    load();
  }).catch(() => { $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>'; });

  function wireTopBar() {
    SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-identity">' + SM.icon("plus", 16) + " New identity</button>");
    $("new-identity").addEventListener("click", openCreateModal);
  }

  async function load() {
    try {
      const doc = await apiFetch("/api/v1/publisher_identities");
      ALL = (doc && doc.data) || [];
      ALL.sort((a, z) => String((a.attributes || {}).key || "").localeCompare(String((z.attributes || {}).key || "")));
      render();
    } catch (err) {
      $("pub-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function filtered() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((i) => {
      const a = i.attributes || {};
      return (a.name || "").toLowerCase().includes(q) || (a.key || "").toLowerCase().includes(q);
    });
  }

  function render() {
    const host = $("pub-content");
    if (!ALL.length && !SEARCH.trim()) {
      SM.setTopBarAction("");
      host.innerHTML =
        '<div class="emptyState"><div class="emptyIcon">' + SM.icon("publishers", 44) + "</div>" +
        "<h2>No publisher identities yet</h2><p>A publisher identity is an organization brand you publish benchmarks under. Create one, then verify a domain by DNS to prove you own the brand.</p>" +
        '<button type="button" class="button buttonPrimary" id="empty-create">New identity</button></div>';
      $("empty-create").addEventListener("click", openCreateModal);
      return;
    }
    wireTopBar();
    host.innerHTML =
      '<div id="pub-toolbar-mount"></div>' +
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable">' +
      '<thead><tr><th></th><th>Name</th><th>Key</th></tr></thead>' +
      '<tbody id="pub-body"></tbody></table></div></div>';
    const bar = SM.toolbar({ placeholder: "Search publishers…", onSearch: (v) => { SEARCH = v; renderRows(); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("pub-toolbar-mount").replaceWith(bar);
    renderRows();
  }

  function renderRows() {
    const body = $("pub-body");
    if (!body) return;
    const rows = filtered();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="3" class="dataTableEmpty">No matching publishers.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(rowHtml).join("");
    body.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", () => { location.href = "/account/publishers/detail?id=" + encodeURIComponent(tr.dataset.id); });
    });
    body.querySelectorAll(".identityLogo").forEach((img) => img.addEventListener("error", () => img.replaceWith(logoFallback())));
  }

  function logoFallback() {
    const span = document.createElement("span");
    span.className = "identityLogoFallback";
    span.innerHTML = SM.icon("publishers", 16);
    return span;
  }

  function rowHtml(i) {
    const a = i.attributes || {};
    const logo = safeHttpUrl(a.logo_url);
    const cell = logo
      ? '<img class="identityLogo" src="' + esc(logo) + '" alt="" />'
      : '<span class="identityLogoFallback">' + SM.icon("publishers", 16) + "</span>";
    return '<tr class="dataTableRowClickable" data-id="' + esc(i.id) + '">' +
      '<td class="identityLogoCell">' + cell + "</td>" +
      "<td>" + esc(a.name || "") + "</td>" +
      "<td><code>" + esc(a.key || "") + "</code></td></tr>";
  }

  // ── Create modal (strict, per-field validation; on success go to the new identity's detail page) ──
  function openCreateModal() {
    const bodyHtml =
      '<form class="form" id="create-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Key</span><input name="key" type="text" placeholder="acme-labs" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="Acme Labs" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Logo URL</span><input name="logo_url" type="url" placeholder="https://acme.example/logo.png" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="create-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Create</button></div></form>';
    const m = SM.modal({ title: "New publisher identity", description: "A brand you publish under. The key is a stable, human-readable handle.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#create-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = m.panel.querySelector("#create-msg"); msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.key); SM.clearFieldError(f.name); SM.clearFieldError(f.logo_url);
      let ok = true;
      if (!f.key.value.trim()) { SM.setFieldError(f.key, "A key is required."); ok = false; }
      if (!f.name.value.trim()) { SM.setFieldError(f.name, "A name is required."); ok = false; }
      const logo = f.logo_url.value.trim();
      if (logo && !safeHttpUrl(logo)) { SM.setFieldError(f.logo_url, "Enter a valid http(s) URL."); ok = false; }
      if (!ok) return;
      const attrs = { key: f.key.value.trim(), name: f.name.value.trim(), logo_url: logo || null };
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/publisher_identities", { method: "POST", body: jsonapiBody("publisher_identity", attrs) });
        m.close();
        const newId = doc && doc.data && doc.data.id;
        if (newId) location.href = "/account/publishers/detail?id=" + encodeURIComponent(newId);
        else load();
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
    f.key.addEventListener("input", () => SM.clearFieldError(f.key));
    f.name.addEventListener("input", () => SM.clearFieldError(f.name));
    f.logo_url.addEventListener("input", () => SM.clearFieldError(f.logo_url));
  }
})();
