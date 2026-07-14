"use strict";

// Account settings (/account/settings) — a tabbed page: "Details" (account fields + danger zone) and
// "Publishers" (the account's publisher domains). Tab state lives in the URL hash (#details |
// #publishers). Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const TABS = ["details", "publishers", "apikeys"];

  let ACCOUNT = null, ROLE = null, CAN_ADMIN = false, IS_OWNER = false;
  let editing = false;
  let form = { name: "", description: "", allow_personal_publish: false };
  let PUBLISHERS = null;

  function attrs() { return (ACCOUNT && ACCOUNT.attributes) || {}; }
  function fmtDate(iso) { return SM.fmtDate(iso) || "—"; }
  function setMsg(text, kind) {
    const el = $("settings-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }

  SM.ready.then((id) => {
    ACCOUNT = id.account; ROLE = id.role; CAN_ADMIN = id.canAdmin; IS_OWNER = id.isOwner;
    renderShell();
  }).catch(() => {
    $("settings-root").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  window.addEventListener("hashchange", () => { editing = false; renderShell(); });

  // ── Shell: header + tab bar + tab content ──
  function renderShell() {
    const a = attrs();
    const tab = activeTab();
    const TAB_LABEL = { publishers: "Publishers", apikeys: "API Keys" };
    SM.setBreadcrumbs(TAB_LABEL[tab]
      ? [{ label: "Settings", href: "/account/settings" }, { label: TAB_LABEL[tab] }]
      : [{ label: "Settings" }]);
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + label + "</button>";
    $("settings-root").innerHTML =
      '<div class="detailHeader"><div class="detailHeaderLeft">' +
        '<div class="detailHeaderTitleRow"><h1>' + esc(a.name || "Account") + "</h1></div>" +
        (a.key ? '<div class="detailHeaderSecondary">' + esc(a.key) + "</div>" : "") +
      "</div></div>" +
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      tabBtn("details", "Details") + tabBtn("publishers", "Publishers") + tabBtn("apikeys", "API Keys") + "</nav>" +
      '<div class="detailsTabActions" id="settings-tab-actions"></div></div>' +
      '<div id="settings-tab"></div>';
    $("settings-root").querySelectorAll(".modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => { if (el.dataset.tab !== activeTab()) location.hash = el.dataset.tab; }));
    renderTab();
  }

  function renderTab() {
    const tab = activeTab();
    if (tab === "publishers") renderPublishers();
    else if (tab === "apikeys") renderApiKeys();
    else renderDetails();
  }

  // ── API Keys tab ── account-scoped keys, via the shared panel (scope is implicit here).
  function renderApiKeys() {
    SMApiKeys.mount({
      host: $("settings-tab"),
      actions: $("settings-tab-actions"),
      scopeType: "ACCOUNT",
      scopeRef: null,
      canAdmin: CAN_ADMIN,
    });
  }

  // ── Details tab ──
  function renderDetails() {
    const a = attrs();
    $("settings-tab-actions").innerHTML = editing
      ? '<button type="button" class="button buttonSecondary buttonSmall" id="s-cancel">Cancel</button>' +
        '<button type="button" class="button buttonPrimary buttonSmall" id="s-save">Save</button>'
      : (CAN_ADMIN ? '<button type="button" class="button buttonSecondary buttonSmall" id="s-edit">Edit</button>' : "");

    const leftCol = editing ? editFields() : viewFields(a);
    const rightCol =
      SM.detailField("Your role", { value: ROLE || "—" }) +
      SM.detailField("Created", { value: fmtDate(a.created_at) });

    $("settings-tab").innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
        '<div class="detailCol">' + leftCol + "</div>" +
        '<div class="detailCol">' + rightCol + "</div>" +
      "</div>" +
      '<p id="settings-msg" class="form-status"></p>' +
      (CAN_ADMIN ? "" : '<p class="profilePicHelp">Only admins can change account settings.</p>') +
      "</div>" +
      (!editing && IS_OWNER
        ? '<div class="panel dangerZone" style="margin-top:1.25rem;"><div class="dangerZoneHeader">Danger zone</div>' +
          '<div class="dangerZoneRow"><div><strong>Delete account</strong>' +
          '<p class="muted">Permanently delete this account and everything in it. This cannot be undone.</p></div>' +
          '<button type="button" class="button buttonDanger" id="s-delete-account">Delete account…</button></div></div>'
        : "");

    if (editing) wireEdit(); else wireDetailsView();
  }

  function publishingText(on) {
    return on ? "On — members can publish under their own name" : "Off — publishing goes through a verified publisher only";
  }
  function viewFields(a) {
    return (
      SM.detailField("Name", { value: a.name }) +
      SM.detailField("Description", { value: a.description, emptyText: "—" }) +
      SM.detailField("Personal publishing", { value: publishingText(a.allow_personal_publish === true) })
    );
  }
  function editFields() {
    return (
      '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span>' +
        '<input id="s-name" type="text" value="' + esc(form.name) + '" placeholder="Account name" />' +
        '<p class="fieldErrorMessage" hidden></p></div>' +
      '<div class="field"><span class="detailFieldLabel">Description</span>' +
        '<input id="s-description" type="text" value="' + esc(form.description) + '" placeholder="A short description of your account" /></div>' +
      '<div class="field"><span class="detailFieldLabel">Personal publishing</span>' +
        '<label class="switchRow"><input type="checkbox" id="s-publish"' + (form.allow_personal_publish ? " checked" : "") + " />" +
        '<span class="switchState" id="s-publish-state">' + (form.allow_personal_publish ? "On" : "Off") + "</span></label>" +
        '<p class="detailFieldHelp">Let members publish their own benchmarks attributed to themselves (name + avatar), instead of only under a verified publisher.</p></div>'
    );
  }
  function wireDetailsView() {
    const e = $("s-edit"); if (e) e.addEventListener("click", enterEdit);
    const del = $("s-delete-account"); if (del) del.addEventListener("click", openDeleteModal);
  }
  function wireEdit() {
    const name = $("s-name");
    name.addEventListener("input", () => { form.name = name.value; SM.clearFieldError(name); });
    $("s-description").addEventListener("input", () => { form.description = $("s-description").value; });
    const pub = $("s-publish");
    pub.addEventListener("change", () => { form.allow_personal_publish = pub.checked; $("s-publish-state").textContent = pub.checked ? "On" : "Off"; });
    $("s-cancel").addEventListener("click", cancelEdit);
    $("s-save").addEventListener("click", save);
    name.focus(); name.select();
  }
  function enterEdit() {
    const a = attrs();
    editing = true;
    form = { name: a.name || "", description: a.description || "", allow_personal_publish: a.allow_personal_publish === true };
    renderShell();
  }
  function cancelEdit() { editing = false; renderShell(); }
  async function save() {
    const nameEl = $("s-name");
    SM.clearFieldError(nameEl);
    const name = form.name.trim();
    if (!name) { SM.setFieldError(nameEl, "An account name is required."); return; }
    const btn = $("s-save"); btn.disabled = true;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/accounts/current", {
        method: "PUT",
        body: jsonapiBody("account", {
          name: name,
          description: form.description.trim() || null,
          allow_personal_publish: form.allow_personal_publish,
        }),
      });
      if (doc && doc.data) ACCOUNT = doc.data;
      editing = false;
      renderShell();
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  // Delete account — type-the-name confirmation, then soft-delete + sign out.
  function openDeleteModal() {
    const name = attrs().name || "this account";
    const bodyHtml =
      '<p class="muted" style="margin:0 0 1rem;">This permanently deletes <strong>' + esc(name) +
      '</strong> and everything in it. This cannot be undone.</p>' +
      '<label class="field"><span class="detailFieldLabel">Type <strong>' + esc(name) + '</strong> to confirm</span>' +
      '<input id="del-confirm" type="text" autocomplete="off" /></label>' +
      '<p class="form-status" id="del-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="button" class="button buttonDanger buttonSmall" id="del-go" disabled>Delete account</button></div>';
    const m = SM.modal({ title: "Delete account?", bodyHtml: bodyHtml });
    const input = m.panel.querySelector("#del-confirm");
    const go = m.panel.querySelector("#del-go");
    input.addEventListener("input", () => { go.disabled = input.value.trim() !== name; });
    go.addEventListener("click", async () => {
      if (input.value.trim() !== name) return;
      go.disabled = true;
      try {
        await apiFetch("/api/v1/accounts/current", { method: "DELETE" });
        signOutToRoot();
      } catch (err) {
        const msg = m.panel.querySelector("#del-msg");
        msg.textContent = err.message; msg.className = "form-status is-error";
        go.disabled = false;
      }
    });
  }

  // ── Publishers tab ──
  function renderPublishers() {
    $("settings-tab-actions").innerHTML = CAN_ADMIN
      ? '<button type="button" class="button buttonPrimary buttonSmall" id="pub-add">Add publisher</button>'
      : "";
    const add = $("pub-add"); if (add) add.addEventListener("click", openAddPublisher);
    const panel = $("settings-tab");
    if (!CAN_ADMIN) {
      panel.innerHTML = '<div class="detailsTabPanel"><p class="muted" style="margin:0;">Only admins can manage publishers.</p></div>';
      return;
    }
    panel.innerHTML = '<div id="pub-host"><p class="muted">Loading…</p></div>';
    loadPublishers();
  }
  async function loadPublishers() {
    const host = $("pub-host"); if (!host) return;
    try {
      const doc = await apiFetch("/api/v1/publishers");
      PUBLISHERS = ((doc && doc.data) || []).sort((a, z) =>
        String((a.attributes || {}).domain || "").localeCompare(String((z.attributes || {}).domain || "")));
      renderPublisherTable(host);
    } catch (err) { host.innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>"; }
  }
  function pubStatusPill(status) {
    const s = String(status || "").toUpperCase();
    return SM.statusPill(s.toLowerCase(), s === "VERIFIED" ? "active" : s === "LAPSED" ? "revoked" : "live");
  }
  function renderPublisherTable(host) {
    if (!PUBLISHERS.length) {
      host.innerHTML =
        '<div class="detailsTabPanel"><p class="muted" style="margin:0;">No publishers yet. A publisher is a domain you publish benchmarks under — add one, then verify it by DNS. Benchmarks are then attributed to that domain.</p></div>';
      return;
    }
    SM.pagedTable(host, {
      columns: [
        { key: "icon", label: "", sortable: false, tdClass: "identityLogoCell", render: (p) => { const a = p.attributes || {}; return SM.publisherIcon(a.domain, a.icon, 28); } },
        { key: "domain", label: "Domain", sortable: true, sortValue: (p) => (p.attributes || {}).domain || "", render: (p) => "<code>" + esc((p.attributes || {}).domain || "") + "</code>" },
        { key: "status", label: "Status", sortable: true, sortValue: (p) => String((p.attributes || {}).status || ""), render: (p) => pubStatusPill((p.attributes || {}).status) },
      ],
      rows: PUBLISHERS,
      sort: { key: "domain", dir: "asc" },
      emptyText: "No publishers yet.",
      onRowClick: (p) => { location.href = "/account/publishers/detail?id=" + encodeURIComponent(p.id); },
      onRender: (c) => SM.wirePublisherIcons(c),
    });
  }
  function openAddPublisher() {
    const bodyHtml =
      '<form class="form" id="add-pub-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Domain</span><input name="domain" type="text" placeholder="acme.com" autocomplete="off" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add publisher</button></div></form>';
    const m = SM.modal({ title: "Add a publisher", description: "A publisher is a domain you publish under. You'll verify it by DNS next.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#add-pub-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      SM.clearFieldError(f.domain);
      const domain = f.domain.value.trim();
      if (!domain) { SM.setFieldError(f.domain, "A domain is required."); f.domain.focus(); return; }
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/publishers", { method: "POST", body: jsonapiBody("publisher", { domain }) });
        m.close();
        const newId = doc && doc.data && doc.data.id;
        if (newId) location.href = "/account/publishers/detail?id=" + encodeURIComponent(newId);
        else loadPublishers();
      } catch (err) { submit.disabled = false; SM.setFieldError(f.domain, err.message); }
    });
    f.domain.addEventListener("input", () => SM.clearFieldError(f.domain));
  }
})();
