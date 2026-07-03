"use strict";

// Publishers (/account/publishers) — manage organization publisher identities and their
// DNS-verified domains. Admin-only (matches the nav gate; the API also admin-gates every write).
// Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  function $(id) { return document.getElementById(id); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    // Toggle the status modifier without clobbering marker classes (e.g. domain-msg), which are
    // used to re-locate per-identity message elements after a render.
    el.classList.remove("is-error", "is-success");
    if (text) el.classList.add("is-" + (kind || "error"));
  }
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, "\\$&");
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }
  function safeHttpUrl(u) {
    try {
      const p = new URL(u);
      return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
    } catch (_) {
      return null;
    }
  }

  // ── Boot ──
  function wireTopBar() {
    SM.setTopBarAction(
      '<button type="button" class="button buttonPrimary buttonTopBar" id="new-identity">' +
      SM.icon("plus", 16) + " New identity</button>",
    );
    $("new-identity").addEventListener("click", () => openIdentityModal(null));
  }

  SM.ready.then((id) => {
    if (!id.canAdmin) {
      SM.setTopBarAction("");
      $("publishers-host").innerHTML =
        '<div class="panel"><p class="muted" style="margin:0;">Only admins can manage publisher identities. Ask an account admin for access.</p></div>';
      return;
    }
    wireTopBar();
    loadIdentities();
  }).catch(() => {
    $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  // ── Identities ──
  async function loadIdentities() {
    const host = $("publishers-host");
    setMsg($("publishers-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/publisher_identities");
      const list = (doc && doc.data) || [];
      if (!list.length) {
        host.innerHTML = '<div class="panel"><p class="muted" style="margin:0;">No publisher identities yet. Use “New identity” to create one.</p></div>';
        return;
      }
      host.innerHTML = list.map(identityCard).join("");
      wireIdentityCards(list);
      list.forEach((i) => loadDomains(i.id));
    } catch (err) {
      host.innerHTML = "";
      setMsg($("publishers-msg"), err.message, "error");
    }
  }

  function identityCard(i) {
    const a = i.attributes || {};
    const id = esc(i.id);
    const logo = safeHttpUrl(a.logo_url);
    const logoImg = logo ? '<img class="identityLogo" src="' + esc(logo) + '" alt="" data-id="' + id + '" />' : "";
    return (
      '<div class="panel identityCard" data-id="' + id + '">' +
      '<div class="sectionHead">' +
      '<div class="identityHead">' + logoImg +
      "<div><h2>" + esc(a.name || "") + '</h2><code class="muted">' + esc(a.key || "") + "</code></div>" +
      "</div>" +
      '<div class="actions">' +
      '<button type="button" class="button buttonSecondary buttonSmall ident-edit" data-id="' + id + '">Edit</button>' +
      '<button type="button" class="button buttonDanger buttonSmall ident-delete" data-id="' + id + '">Delete</button>' +
      "</div></div>" +
      '<div class="identityBody">' +
      '<p class="miniLabel">Domains</p>' +
      '<div class="domains-host" data-identity="' + id + '"><div class="muted">Loading domains…</div></div>' +
      '<form class="inlineForm add-domain-form" data-identity="' + id + '" style="margin-top:0.75rem;">' +
      '<label class="field"><span class="fieldRequired">Domain</span><input name="domain" type="text" placeholder="example.com" required /></label>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add domain</button>' +
      "</form>" +
      '<div class="form-status domain-msg" data-identity="' + id + '"></div>' +
      "</div></div>"
    );
  }

  function wireIdentityCards(list) {
    const byId = {};
    list.forEach((i) => { byId[i.id] = i; });
    const host = $("publishers-host");
    host.querySelectorAll(".ident-edit").forEach((el) => el.addEventListener("click", () => openIdentityModal(byId[el.dataset.id])));
    host.querySelectorAll(".ident-delete").forEach((el) => el.addEventListener("click", () => deleteIdentity(el.dataset.id)));
    host.querySelectorAll(".add-domain-form").forEach((form) => form.addEventListener("submit", (ev) => addDomain(ev, form.dataset.identity)));
    host.querySelectorAll(".identityLogo").forEach((img) => img.addEventListener("error", () => img.remove()));
  }

  async function deleteIdentity(id) {
    if (!window.confirm("Delete this identity? Benchmarks already published under it keep their frozen badge, but you can no longer publish new ones with it.")) return;
    setMsg($("publishers-msg"), "");
    try {
      await apiFetch("/api/v1/publisher_identities/" + encodeURIComponent(id), { method: "DELETE" });
      await loadIdentities();
    } catch (err) { setMsg($("publishers-msg"), err.message, "error"); }
  }

  // ── Identity create/edit modal ──
  const modal = $("identity-modal");
  const form = $("identity-form");
  let editingId = null;

  function openIdentityModal(identity) {
    editingId = identity ? identity.id : null;
    const a = (identity && identity.attributes) || {};
    setMsg($("identity-msg"), "");
    form.reset();
    form.key.value = a.key || "";
    form.name.value = a.name || "";
    form.logo_url.value = a.logo_url || "";
    $("identity-title").textContent = identity ? "Edit publisher identity" : "New publisher identity";
    $("identity-save").textContent = identity ? "Save" : "Create";
    modal.style.display = "grid";
    form.key.focus();
  }
  function closeModal() { modal.style.display = "none"; }
  $("identity-cancel").addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) closeModal(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && modal.style.display !== "none") closeModal(); });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setMsg($("identity-msg"), "");
    const attrs = { key: form.key.value.trim(), name: form.name.value.trim() };
    const logo = form.logo_url.value.trim();
    attrs.logo_url = logo || null; // full-replace: send null to clear
    const save = $("identity-save");
    save.disabled = true;
    try {
      if (editingId) {
        await apiFetch("/api/v1/publisher_identities/" + encodeURIComponent(editingId), { method: "PUT", body: jsonapiBody("publisher_identity", attrs) });
      } else {
        await apiFetch("/api/v1/publisher_identities", { method: "POST", body: jsonapiBody("publisher_identity", attrs) });
      }
      closeModal();
      await loadIdentities();
    } catch (err) {
      setMsg($("identity-msg"), err.message, "error");
    } finally {
      save.disabled = false;
    }
  });

  // ── Domains ──
  async function loadDomains(identityId) {
    const host = document.querySelector('.domains-host[data-identity="' + cssEsc(identityId) + '"]');
    if (!host) return;
    host.innerHTML = '<div class="muted">Loading domains…</div>';
    try {
      const doc = await apiFetch("/api/v1/publisher_domains?filter[publisher_identity]=" + encodeURIComponent(identityId));
      const list = (doc && doc.data) || [];
      if (!list.length) { host.innerHTML = '<div class="muted">No domains yet. Add one to verify ownership.</div>'; return; }
      host.innerHTML = list.map(domainRow).join("");
      wireDomainRows(host, identityId);
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
      detail = '<p class="muted" style="margin:0.3rem 0 0;">Verified' + (a.verified_at ? " on " + esc(fmtDate(a.verified_at)) : "") + ".</p>";
    } else {
      const lapsed = status === "LAPSED"
        ? '<p class="form-status is-error" style="margin:0 0 0.4rem;">This domain lapsed — its TXT record is no longer found. Re-add it and verify again.</p>'
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

  function wireDomainRows(host, identityId) {
    host.querySelectorAll(".dom-verify").forEach((el) => el.addEventListener("click", () => verifyDomain(el.dataset.id, identityId, el)));
    host.querySelectorAll(".dom-remove").forEach((el) => el.addEventListener("click", () => removeDomain(el.dataset.id, identityId)));
    host.querySelectorAll(".txt-copy").forEach((el) => el.addEventListener("click", () => {
      const code = el.parentElement.querySelector(".txtValue");
      const token = (code && code.dataset.token) || "";
      SM.copyText(token).then(() => { el.textContent = "Copied"; setTimeout(() => { el.textContent = "Copy"; }, 1500); }, () => { el.textContent = "Copy failed"; });
    }));
  }

  async function addDomain(ev, identityId) {
    ev.preventDefault();
    const f = ev.target;
    const msg = document.querySelector('.domain-msg[data-identity="' + cssEsc(identityId) + '"]');
    setMsg(msg, "");
    const domain = f.domain.value.trim();
    if (!domain) return;
    const submit = f.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await apiFetch("/api/v1/publisher_domains", {
        method: "POST",
        body: jsonapiBody("publisher_domain", { publisher_identity: identityId, domain }),
      });
      f.reset();
      await loadDomains(identityId);
    } catch (err) {
      setMsg(msg, err.message, "error");
    } finally {
      submit.disabled = false;
    }
  }

  async function verifyDomain(domainId, identityId, btn) {
    const msg = document.querySelector('.domain-msg[data-identity="' + cssEsc(identityId) + '"]');
    setMsg(msg, "");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const doc = await apiFetch("/api/v1/publisher_domains/" + encodeURIComponent(domainId) + "/actions/verify", { method: "POST" });
      const st = String(((doc && doc.data && doc.data.attributes) || {}).status || "").toUpperCase();
      if (st !== "VERIFIED") {
        setMsg(msg, "Still not verified — the TXT record wasn't found. DNS changes can take a while to propagate.", "error");
      }
      await loadDomains(identityId);
    } catch (err) {
      setMsg(msg, err.message, "error");
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function removeDomain(domainId, identityId) {
    if (!window.confirm("Remove this domain claim?")) return;
    const msg = document.querySelector('.domain-msg[data-identity="' + cssEsc(identityId) + '"]');
    setMsg(msg, "");
    try {
      await apiFetch("/api/v1/publisher_domains/" + encodeURIComponent(domainId), { method: "DELETE" });
      await loadDomains(identityId);
    } catch (err) { setMsg(msg, err.message, "error"); }
  }
})();
