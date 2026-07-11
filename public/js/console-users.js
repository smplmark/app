"use strict";

// Members (/account/users) — active members (inline role change / remove) + pending invitations
// (invite / resend / revoke), split across an Active / Invited segmented control with a shared
// search + refresh toolbar. Admin-gated actions. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  let CAN_ADMIN = false;
  let MY_ROLE = null;
  let MY_USER = null;
  let ACTIVE_TAB = "members";
  let SEARCH = "";
  let MEMBERS = [];
  let INVITES = [];
  let INVITES_LOADED = false;

  // ── Toolbar: segmented tabs + search + refresh ──
  const tabs = $("member-tabs");
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".segBtn");
    if (!btn) return;
    tabs.querySelectorAll(".segBtn").forEach((b) => b.classList.toggle("isActive", b === btn));
    ACTIVE_TAB = btn.dataset.tab;
    $("tab-members").style.display = ACTIVE_TAB === "members" ? "" : "none";
    $("tab-invites").style.display = ACTIVE_TAB === "invites" ? "" : "none";
    updateSearchPlaceholder();
    if (ACTIVE_TAB === "invites" && !INVITES_LOADED) loadInvites();
    else if (ACTIVE_TAB === "invites") renderInvites();
    else renderMembers();
  });

  const searchWrap = $("member-search-wrap");
  searchWrap.innerHTML = SM.icon("search", 15) + '<input type="search" aria-label="Search" />';
  const searchInput = searchWrap.querySelector("input");
  updateSearchPlaceholder();
  let searchT = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { SEARCH = searchInput.value; ACTIVE_TAB === "invites" ? renderInvites() : renderMembers(); }, 150);
  });
  function updateSearchPlaceholder() {
    searchInput.placeholder = ACTIVE_TAB === "invites" ? "Search invitations…" : "Search members…";
  }

  const refreshBtn = $("member-refresh");
  refreshBtn.innerHTML = SM.icon("refresh", 16);
  refreshBtn.addEventListener("click", () => { ACTIVE_TAB === "invites" ? loadInvites() : loadMembers(); });

  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    MY_ROLE = id.role;
    MY_USER = id.user && id.user.id;
    if (CAN_ADMIN) {
      SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-invite">' + SM.icon("plus", 16) + " Invite member</button>");
      $("new-invite").addEventListener("click", openInvite);
    }
    loadMembers();
  }).catch(() => {
    $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  // ── Active members ──
  async function loadMembers() {
    setMsg($("members-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/account_users");
      MEMBERS = (doc && doc.data) || [];
      renderMembers();
    } catch (err) {
      $("members-body").innerHTML = '<tr><td colspan="4" class="dataTableEmpty">Failed to load.</td></tr>';
      setMsg($("members-msg"), err.message, "error");
    }
  }

  function filterMembers() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return MEMBERS;
    return MEMBERS.filter((m) => {
      const a = m.attributes || {};
      return (a.display_name || "").toLowerCase().includes(q) ||
        (a.email || "").toLowerCase().includes(q) ||
        (a.role || "").toLowerCase().includes(q);
    });
  }

  function renderMembers() {
    const body = $("members-body");
    const rows = filterMembers();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="dataTableEmpty">' + (SEARCH.trim() ? "No matching members." : "No members yet.") + "</td></tr>";
      return;
    }
    body.innerHTML = rows.map(memberRow).join("");
    wireMemberActions();
  }

  function memberRow(m) {
    const a = m.attributes || {};
    const userId = a.user;
    const isOwnerRow = a.role === "OWNER";
    const isSelf = userId === MY_USER;
    const name = a.display_name || (a.email ? a.email.split("@")[0] : userId);

    let roleCell;
    if (CAN_ADMIN && !isOwnerRow) {
      // Admins can only assign MEMBER/VIEWER; owners can also assign ADMIN.
      const opts = ["ADMIN", "MEMBER", "VIEWER"]
        .filter((r) => MY_ROLE === "OWNER" || r !== "ADMIN")
        .map((r) => '<option value="' + r + '"' + (r === a.role ? " selected" : "") + ">" + r + "</option>")
        .join("");
      roleCell = '<select class="roleSelect role-change" data-user="' + esc(userId) + '" data-prev="' + esc(a.role) + '">' + opts + "</select>";
    } else {
      roleCell = SM.statusPill(a.role, a.role === "OWNER" ? "active" : "private");
    }

    const canRemove = CAN_ADMIN && !isOwnerRow && !isSelf;
    const actions = canRemove
      ? '<button type="button" class="button buttonDanger buttonSmall member-remove" data-user="' + esc(userId) + '" data-name="' + esc(name) + '">Remove</button>'
      : "";
    return (
      "<tr><td><strong>" + esc(name) + "</strong>" + (isSelf ? ' <span class="muted">(you)</span>' : "") + "</td>" +
      "<td>" + esc(a.email || "") + "</td>" +
      "<td>" + roleCell + "</td>" +
      '<td class="actions">' + actions + "</td></tr>"
    );
  }

  function wireMemberActions() {
    const body = $("members-body");
    body.querySelectorAll(".role-change").forEach((el) => el.addEventListener("change", () => changeRole(el)));
    body.querySelectorAll(".member-remove").forEach((el) => el.addEventListener("click", () => removeMember(el.dataset.user, el.dataset.name)));
  }

  async function changeRole(select) {
    const userId = select.dataset.user;
    const role = select.value;
    setMsg($("members-msg"), "");
    try {
      await apiFetch("/api/v1/account_users/" + encodeURIComponent(userId), { method: "PUT", body: jsonapiBody("account_user", { role }) });
      select.dataset.prev = role;
      setMsg($("members-msg"), "Role updated.", "success");
    } catch (err) {
      select.value = select.dataset.prev; // revert
      setMsg($("members-msg"), err.message, "error");
    }
  }

  async function removeMember(userId, name) {
    const ok = await SM.confirm({
      title: "Remove this member?",
      message: "<strong>" + esc(name) + "</strong> loses access to this account immediately.",
      confirmLabel: "Remove member",
    });
    if (!ok) return;
    setMsg($("members-msg"), "");
    try {
      await apiFetch("/api/v1/account_users/" + encodeURIComponent(userId), { method: "DELETE" });
      await loadMembers();
    } catch (err) { setMsg($("members-msg"), err.message, "error"); }
  }

  // ── Invitations ──
  async function loadInvites() {
    setMsg($("invites-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/invitations");
      INVITES = (doc && doc.data) || [];
      INVITES_LOADED = true;
      renderInvites();
    } catch (err) {
      $("invites-body").innerHTML = '<tr><td colspan="5" class="dataTableEmpty">Failed to load.</td></tr>';
      setMsg($("invites-msg"), err.message, "error");
    }
  }

  function filterInvites() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return INVITES;
    return INVITES.filter((inv) => {
      const a = inv.attributes || {};
      return (a.email || "").toLowerCase().includes(q) ||
        (a.role || "").toLowerCase().includes(q) ||
        (a.status || "").toLowerCase().includes(q);
    });
  }

  function renderInvites() {
    const body = $("invites-body");
    const rows = filterInvites();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="dataTableEmpty">' +
        (SEARCH.trim() ? "No matching invitations." : "No invitations. Use “Invite member” to add someone.") + "</td></tr>";
      return;
    }
    body.innerHTML = rows.map(inviteRow).join("");
    wireInviteActions();
  }

  function inviteRow(inv) {
    const a = inv.attributes || {};
    const status = String(a.status || "");
    const pill = SM.statusPill(status, status === "PENDING" ? "live" : status === "ACCEPTED" ? "active" : "revoked");
    let acts = "";
    if (status === "PENDING") {
      acts =
        '<button type="button" class="button buttonSecondary buttonSmall inv-resend" data-id="' + esc(inv.id) + '">Resend</button>' +
        '<button type="button" class="button buttonDanger buttonSmall inv-revoke" data-id="' + esc(inv.id) + '">Revoke</button>';
    }
    return (
      "<tr><td>" + esc(a.email || "") + "</td>" +
      "<td>" + esc(a.role || "") + "</td>" +
      "<td>" + pill + "</td>" +
      "<td>" + fmtDate(a.expires_at) + "</td>" +
      '<td class="actions">' + acts + "</td></tr>"
    );
  }

  function wireInviteActions() {
    const body = $("invites-body");
    body.querySelectorAll(".inv-resend").forEach((el) => el.addEventListener("click", () => resendInvite(el.dataset.id)));
    body.querySelectorAll(".inv-revoke").forEach((el) => el.addEventListener("click", () => revokeInvite(el.dataset.id)));
  }

  async function resendInvite(id) {
    setMsg($("invites-msg"), "");
    try {
      await apiFetch("/api/v1/invitations/" + encodeURIComponent(id) + "/actions/resend", { method: "POST" });
      await loadInvites();
      setMsg($("invites-msg"), "Invitation resent.", "success");
    } catch (err) { setMsg($("invites-msg"), err.message, "error"); }
  }

  async function revokeInvite(id) {
    const ok = await SM.confirm({ title: "Revoke this invitation?", message: "The invite link stops working immediately.", confirmLabel: "Revoke invitation" });
    if (!ok) return;
    setMsg($("invites-msg"), "");
    try {
      await apiFetch("/api/v1/invitations/" + encodeURIComponent(id) + "/actions/revoke", { method: "POST" });
      await loadInvites();
    } catch (err) { setMsg($("invites-msg"), err.message, "error"); }
  }

  // ── Invite modal (strict, per-field validation on email) ──
  function openInvite() {
    const bodyHtml =
      '<form class="form" id="invite-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Email</span><input name="email" type="email" placeholder="teammate@example.com" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Role</span><select name="role">' +
      '<option value="ADMIN">Admin — manage members, keys, settings</option>' +
      '<option value="MEMBER" selected>Member — create &amp; edit benchmarks</option>' +
      '<option value="VIEWER">Viewer — read-only</option>' +
      "</select></label>" +
      '<p class="form-status" id="invite-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Send invitation</button></div></form>';
    const m = SM.modal({ title: "Invite a member", description: "They'll get an email with a link to join this account.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#invite-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = m.panel.querySelector("#invite-msg"); setMsg(msg, "");
      SM.clearFieldError(f.email);
      const email = f.email.value.trim();
      if (!email) { SM.setFieldError(f.email, "An email address is required."); f.email.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { SM.setFieldError(f.email, "Enter a valid email address."); f.email.focus(); return; }
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await apiFetch("/api/v1/invitations", { method: "POST", body: jsonapiBody("invitation", { email: email, role: f.role.value }) });
        m.close();
        INVITES_LOADED = false;
        const invBtn = document.querySelector('.segBtn[data-tab="invites"]');
        if (invBtn) invBtn.click(); // jump to Invited tab, which reloads
      } catch (err) { submit.disabled = false; setMsg(msg, err.message, "error"); }
    });
    f.email.addEventListener("input", () => SM.clearFieldError(f.email));
  }
})();
