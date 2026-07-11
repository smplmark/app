"use strict";

// Publisher identity detail (/account/publishers/detail?id=…) — a conforming detail page: DetailHeader,
// a Details tab (view/edit name + logo), and a Domains tab (DNS-verified ownership). Admin-only.
// Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  const ID = new URLSearchParams(location.search).get("id") || "";
  let PI = null;
  let CAN_ADMIN = false;

  let editing = false;
  let form = { name: "", logo_url: "" };

  const TABS = ["details", "domains"];
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }
  let currentRenderedTab = "details";

  function fmtDate(v) {
    if (!v) return "";
    const d = new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function fmtDay(v) {
    if (!v) return "";
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }
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
    if (!CAN_ADMIN) { $("detail-root").innerHTML = '<div class="panel"><p class="muted" style="margin:0;">Only admins can manage publisher identities.</p></div>'; return; }
    load();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!ID) { fail("No publisher id."); return; }
    try {
      const doc = await apiFetch("/api/v1/publisher_identities/" + encodeURIComponent(ID));
      PI = (doc && doc.data) || null;
      if (!PI) { fail("Publisher identity not found."); return; }
      render();
    } catch (err) { fail(err.message || "Failed to load publisher identity."); }
  }

  function render() {
    const a = PI.attributes || {};
    const tab = activeTab();
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + "</button>";
    const logo = safeHttpUrl(a.logo_url);
    const decorations = logo ? '<img class="detailHeaderLogo" src="' + esc(logo) + '" alt="" />' : "";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || a.key || "Publisher", decorations: decorations, secondaryId: a.key || "", actions: "" }) +
      '<div class="detailsTabHeader">' +
      '<nav class="modalTabBar" role="tablist">' + tabBtn("details", "Details") + tabBtn("domains", "Domains") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div>' +
      "</div>" +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Publisher";
    document.title = (a.name || "Publisher") + " — smplmark";
    const hl = $("detail-root").querySelector(".detailHeaderLogo");
    if (hl) hl.addEventListener("error", () => hl.remove());

    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => switchTab(el.dataset.tab)));
    renderTab();
  }

  function switchTab(key) {
    if (key === activeTab()) return;
    if (editing && isDirty()) {
      SM.confirm({ title: "Discard changes?", message: "You have unsaved edits. Leave and discard them?", confirmLabel: "Discard", cancelLabel: "Keep editing" })
        .then((ok) => { if (ok) { exitEdit(); location.hash = key; render(); } });
      return;
    }
    editing = false;
    location.hash = key;
    render();
  }
  window.addEventListener("hashchange", () => { if (activeTab() !== currentRenderedTab) render(); });

  function renderTab() {
    currentRenderedTab = activeTab();
    const panel = $("tab-panel");
    $("tab-actions").innerHTML = "";
    if (currentRenderedTab === "details") renderDetails(panel, $("tab-actions"));
    else renderDomains(panel);
  }

  // ── Details tab ──
  function isDirty() {
    if (!editing || !PI) return false;
    const a = PI.attributes || {};
    return form.name.trim() !== (a.name || "") || form.logo_url.trim() !== (a.logo_url || "");
  }
  function enterEdit() {
    const a = PI.attributes || {};
    editing = true;
    form = { name: a.name || "", logo_url: a.logo_url || "" };
    renderTab();
  }
  function exitEdit() { editing = false; window.removeEventListener("beforeunload", onBeforeUnload); }
  function onBeforeUnload(e) { if (editing && isDirty()) { e.preventDefault(); e.returnValue = ""; } }

  function renderDetails(panel, actions) {
    const a = PI.attributes || {};
    actions.innerHTML = editing
      ? '<button type="button" class="button buttonSecondary buttonSmall" id="p-cancel">Cancel</button>' +
        '<button type="button" class="button buttonPrimary buttonSmall" id="p-save">Save</button>'
      : '<button type="button" class="button buttonSecondary buttonSmall" id="p-edit">Edit</button>' +
        '<button type="button" class="button buttonDanger buttonSmall" id="p-delete">Delete</button>';

    const left = editing
      ? '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input data-edit="name" type="text" value="' + esc(form.name) + '" /><p class="fieldErrorMessage" hidden></p></div>' +
        '<div class="field"><span class="detailFieldLabel">Logo URL</span><input data-edit="logo_url" type="url" value="' + esc(form.logo_url) + '" placeholder="https://acme.example/logo.png" /><p class="fieldErrorMessage" hidden></p></div>'
      : SM.detailField("Name", { value: a.name }) +
        SM.detailField("Key", { value: a.key, mono: true }) +
        SM.detailField("Logo URL", { value: a.logo_url, mono: true, emptyText: "(none)" });

    const right =
      SM.detailField("Created", { value: fmtDate(a.created_at) }) +
      SM.detailField("Updated", { value: fmtDate(a.updated_at) });

    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div>" +
      "</div></div>";

    if (editing) {
      const nameEl = panel.querySelector('[data-edit="name"]');
      const logoEl = panel.querySelector('[data-edit="logo_url"]');
      nameEl.addEventListener("input", () => { form.name = nameEl.value; SM.clearFieldError(nameEl); });
      logoEl.addEventListener("input", () => { form.logo_url = logoEl.value; SM.clearFieldError(logoEl); });
      $("p-cancel").addEventListener("click", cancelEdit);
      $("p-save").addEventListener("click", save);
      window.addEventListener("beforeunload", onBeforeUnload);
      nameEl.focus();
    } else {
      $("p-edit").addEventListener("click", enterEdit);
      $("p-delete").addEventListener("click", del);
    }
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

  async function save() {
    const panel = $("tab-panel");
    const nameEl = panel.querySelector('[data-edit="name"]');
    const logoEl = panel.querySelector('[data-edit="logo_url"]');
    SM.clearFieldError(nameEl); SM.clearFieldError(logoEl);
    let ok = true;
    if (!form.name.trim()) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    const logo = form.logo_url.trim();
    if (logo && !safeHttpUrl(logo)) { SM.setFieldError(logoEl, "Enter a valid http(s) URL."); ok = false; }
    if (!ok) return;
    const a = PI.attributes || {};
    // get-mutate-put: round-trip the full representation (key is immutable server-side but sent back).
    const attrs = { key: a.key, name: form.name.trim(), logo_url: logo || null };
    const btn = $("p-save"); btn.disabled = true;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/publisher_identities/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("publisher_identity", attrs) });
      PI = (doc && doc.data) || PI;
      exitEdit();
      render();
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  async function del() {
    const a = PI.attributes || {};
    const okc = await SM.confirm({
      title: "Delete this identity?",
      message: "Benchmarks already published under <strong>" + esc(a.name || a.key || "") + "</strong> keep their frozen badge, but you can no longer publish new ones with it.",
      confirmLabel: "Delete identity",
    });
    if (!okc) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/publisher_identities/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/publishers";
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Domains tab ──
  function renderDomains(panel) {
    panel.innerHTML =
      '<form id="domain-form" class="inlineForm" style="margin-bottom:1rem;">' +
      '<label class="field" style="min-width:280px;"><span class="detailFieldLabel fieldRequired">Domain</span><input name="domain" type="text" placeholder="example.com" autocomplete="off" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add domain</button></form>' +
      '<div id="domains-host"><p class="muted">Loading domains…</p></div>';
    const f = $("domain-form");
    f.addEventListener("submit", addDomain);
    f.domain.addEventListener("input", () => SM.clearFieldError(f.domain));
    loadDomains();
  }

  async function loadDomains() {
    const host = $("domains-host");
    if (!host) return;
    try {
      const doc = await apiFetch("/api/v1/publisher_domains?filter[publisher_identity]=" + encodeURIComponent(ID));
      const list = (doc && doc.data) || [];
      if (!list.length) { host.innerHTML = '<p class="muted" style="margin:0;">No domains yet. Add one above to verify ownership of the brand.</p>'; return; }
      host.innerHTML = list.map(domainRow).join("");
      wireDomainRows(host);
    } catch (err) {
      host.innerHTML = '<div class="form-status is-error">' + esc(err.message) + "</div>";
    }
  }

  function domainRow(d) {
    const a = d.attributes || {};
    const id = esc(d.id);
    const status = String(a.status || "").toUpperCase();
    const verified = status === "VERIFIED";
    let detail;
    if (verified) {
      detail = '<p class="muted" style="margin:0.3rem 0 0;">Verified' + (a.verified_at ? " on " + esc(fmtDay(a.verified_at)) : "") + ".</p>";
    } else {
      const lapsed = status === "LAPSED"
        ? '<p class="form-status is-error" style="margin:0 0 0.4rem;">This domain lapsed — its TXT record is no longer found. Verify again once it\'s back.</p>'
        : "";
      detail =
        '<div class="txtRecord">' + lapsed +
        '<p class="muted" style="margin:0 0 0.4rem;">Add this DNS TXT record on <code>' + esc(a.domain || "") + "</code>, then Verify:</p>" +
        '<div class="txtGrid">' +
        '<span class="txtLabel">Type</span><code>TXT</code>' +
        '<span class="txtLabel">Name</span><code>@</code>' +
        '<span class="txtLabel">Value</span>' +
        '<span class="txtValueWrap"><code class="txtValue" data-token="' + esc(a.verification_token || "") + '">' + esc(a.verification_token || "") + "</code>" +
        '<button type="button" class="button buttonSecondary buttonSmall txt-copy" data-id="' + id + '">Copy</button></span>' +
        "</div></div>";
    }
    return (
      '<div class="subPanel domainRow" data-domain="' + id + '" style="margin-bottom:0.6rem;">' +
      '<div class="sectionHead" style="margin-bottom:0;">' +
      "<div><code>" + esc(a.domain || "") + "</code> " + SM.statusPill(status.toLowerCase(), status.toLowerCase()) + "</div>" +
      '<div class="actions">' +
      '<button type="button" class="button buttonSecondary buttonSmall dom-verify" data-id="' + id + '">' + (verified ? "Re-check" : "Verify") + "</button>" +
      '<button type="button" class="button buttonDanger buttonSmall dom-remove" data-id="' + id + '">Remove</button>' +
      "</div></div>" +
      detail +
      "</div>"
    );
  }

  function wireDomainRows(host) {
    host.querySelectorAll(".dom-verify").forEach((el) => el.addEventListener("click", () => verifyDomain(el.dataset.id, el)));
    host.querySelectorAll(".dom-remove").forEach((el) => el.addEventListener("click", () => removeDomain(el.dataset.id)));
    host.querySelectorAll(".txt-copy").forEach((el) => el.addEventListener("click", () => {
      const code = el.parentElement.querySelector(".txtValue");
      const token = (code && code.dataset.token) || "";
      SM.copyText(token).then(() => { el.textContent = "Copied"; setTimeout(() => { el.textContent = "Copy"; }, 1500); }, () => { el.textContent = "Copy failed"; });
    }));
  }

  async function addDomain(ev) {
    ev.preventDefault();
    const f = ev.target;
    SM.clearFieldError(f.domain);
    setMsg("");
    const domain = f.domain.value.trim();
    if (!domain) { SM.setFieldError(f.domain, "A domain is required."); f.domain.focus(); return; }
    const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
    try {
      await apiFetch("/api/v1/publisher_domains", { method: "POST", body: jsonapiBody("publisher_domain", { publisher_identity: ID, domain: domain }) });
      f.reset();
      await loadDomains();
    } catch (err) { SM.setFieldError(f.domain, err.message); }
    finally { submit.disabled = false; }
  }

  async function verifyDomain(domainId, btn) {
    setMsg("");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const doc = await apiFetch("/api/v1/publisher_domains/" + encodeURIComponent(domainId) + "/actions/verify", { method: "POST" });
      const st = String(((doc && doc.data && doc.data.attributes) || {}).status || "").toUpperCase();
      if (st !== "VERIFIED") setMsg("Still not verified — the TXT record wasn't found. DNS changes can take a while to propagate.", "error");
      await loadDomains();
    } catch (err) {
      setMsg(err.message, "error");
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function removeDomain(domainId) {
    const ok = await SM.confirm({ title: "Remove this domain claim?", message: "You'll need to re-add and re-verify the domain to publish under it again.", confirmLabel: "Remove domain" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/publisher_domains/" + encodeURIComponent(domainId), { method: "DELETE" });
      await loadDomains();
    } catch (err) { setMsg(err.message, "error"); }
  }

  function setMsg(text, kind) {
    const el = $("detail-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
})();
