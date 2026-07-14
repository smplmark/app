"use strict";

// Users (/account/users) — active users (inline role change / remove) + pending invitations
// (invite / resend / revoke), across an Active / Invited segmented control that shares a search box,
// a role filter, and refresh. Client-side sort (by name) and pagination. Admin-gated actions.
// Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 20;

  let CAN_ADMIN = false, MY_ROLE = null, MY_USER = null;
  let TAB = "users"; // "users" | "invites"
  let SEARCH = "", ROLE_FILTER = "", SORT_DIR = "asc";
  const PAGE = { users: 1, invites: 1 };
  let USERS = [], INVITES = [], INVITES_LOADED = false;

  function setMsg(text, kind) {
    const el = $("users-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function fmtDate(iso) { return SM.fmtDate(iso) || "—"; }
  function displayName(a) { return a.display_name || (a.email ? a.email.split("@")[0] : (a.user || "")); }

  // ── Toolbar ──
  const searchWrap = $("user-search-wrap");
  searchWrap.innerHTML = SM.icon("search", 15) + '<input type="search" aria-label="Search" />';
  const searchInput = searchWrap.querySelector("input");
  updatePlaceholder();
  let searchT = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { SEARCH = searchInput.value; PAGE[TAB] = 1; render(); }, 150);
  });
  function updatePlaceholder() { searchInput.placeholder = TAB === "invites" ? "Search invitations…" : "Search users…"; }

  const tabs = $("user-tabs");
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".segBtn");
    if (btn) switchTab(btn.dataset.tab);
  });
  function selectTab(tab) {
    TAB = tab;
    tabs.querySelectorAll(".segBtn").forEach((b) => b.classList.toggle("isActive", b.dataset.tab === tab));
    updatePlaceholder();
  }
  function switchTab(tab) {
    if (tab === TAB) return;
    selectTab(tab);
    if (TAB === "invites" && !INVITES_LOADED) loadInvites();
    else render();
  }

  $("role-filter").addEventListener("change", (ev) => { ROLE_FILTER = ev.target.value; PAGE[TAB] = 1; render(); });

  const refreshBtn = $("user-refresh");
  refreshBtn.innerHTML = SM.icon("refresh", 16);
  refreshBtn.addEventListener("click", () => { TAB === "invites" ? loadInvites() : loadUsers(); });

  // ── Boot ──
  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin; MY_ROLE = id.role; MY_USER = id.user && id.user.id;
    if (CAN_ADMIN) {
      SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-invite">' + SM.icon("plus", 16) + " Invite users</button>");
      $("new-invite").addEventListener("click", openInvite);
    }
    loadUsers();
  }).catch(() => {
    $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  // ── Data ──
  async function loadUsers() {
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/account_users");
      USERS = (doc && doc.data) || [];
      render();
    } catch (err) {
      USERS = [];
      $("user-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }
  async function loadInvites() {
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/invitations");
      INVITES = (doc && doc.data) || [];
      INVITES_LOADED = true;
      render();
    } catch (err) {
      INVITES = [];
      $("user-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  // ── Filter / sort / paginate ──
  function matchesRole(role) { return !ROLE_FILTER || String(role || "").toUpperCase() === ROLE_FILTER; }
  function filteredUsers() {
    const q = SEARCH.trim().toLowerCase();
    const rows = USERS.filter((m) => {
      const a = m.attributes || {};
      if (!matchesRole(a.role)) return false;
      if (!q) return true;
      return displayName(a).toLowerCase().includes(q) || (a.email || "").toLowerCase().includes(q) || (a.role || "").toLowerCase().includes(q);
    });
    rows.sort((x, y) => {
      const nx = displayName(x.attributes || {}).toLowerCase();
      const ny = displayName(y.attributes || {}).toLowerCase();
      return SORT_DIR === "asc" ? nx.localeCompare(ny) : ny.localeCompare(nx);
    });
    return rows;
  }
  function filteredInvites() {
    const q = SEARCH.trim().toLowerCase();
    return INVITES.filter((inv) => {
      const a = inv.attributes || {};
      if (!matchesRole(a.role)) return false;
      if (!q) return true;
      return (a.email || "").toLowerCase().includes(q) || (a.role || "").toLowerCase().includes(q) || (a.status || "").toLowerCase().includes(q);
    });
  }
  function clampPage(total) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    PAGE[TAB] = Math.min(Math.max(1, PAGE[TAB]), pages);
    return PAGE[TAB];
  }
  function footerHtml(total) {
    const page = PAGE[TAB];
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(total, page * PAGE_SIZE);
    return (
      '<div class="dataTableFooter">' +
      '<span class="dataTableCount">Showing ' + start + "–" + end + " of " + total + "</span>" +
      '<div class="dataTablePager">' +
      '<button type="button" class="button buttonSecondary buttonSmall" data-page="prev"' + (page <= 1 ? " disabled" : "") + ">Previous</button>" +
      '<button type="button" class="button buttonSecondary buttonSmall" data-page="next"' + (page >= pages ? " disabled" : "") + ">Next</button>" +
      "</div></div>"
    );
  }
  function wirePager() {
    const c = $("user-content");
    const prev = c.querySelector('[data-page="prev"]');
    const next = c.querySelector('[data-page="next"]');
    if (prev) prev.addEventListener("click", () => { PAGE[TAB]--; render(); });
    if (next) next.addEventListener("click", () => { PAGE[TAB]++; render(); });
  }
  function hydrateAvatars() {
    $("user-content").querySelectorAll("[data-avatar]").forEach((ph) => {
      ph.replaceWith(SM.avatar(30, ph.getAttribute("data-email") || "", ph.getAttribute("data-name") || ""));
    });
  }

  // ── Render ──
  function render() {
    if (TAB === "invites") renderInvites(); else renderUsers();
  }

  function renderUsers() {
    const rows = filteredUsers();
    const total = rows.length;
    const page = clampPage(total);
    const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const caret = SORT_DIR === "asc" ? "▲" : "▼";
    const body = total
      ? pageRows.map(userRow).join("")
      : '<tr><td colspan="4" class="dataTableEmpty">' + (SEARCH.trim() || ROLE_FILTER ? "No matching users." : "No users yet.") + "</td></tr>";
    $("user-content").innerHTML =
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable"><thead><tr>' +
      '<th class="isSortable" data-sort="name">Name <span class="sortCaret">' + caret + "</span></th>" +
      '<th>Email</th><th>Role</th><th class="actions"></th>' +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      footerHtml(total) + "</div>";
    const sortTh = $("user-content").querySelector('[data-sort="name"]');
    if (sortTh) sortTh.addEventListener("click", () => { SORT_DIR = SORT_DIR === "asc" ? "desc" : "asc"; render(); });
    $("user-content").querySelectorAll(".role-change").forEach((el) => el.addEventListener("change", () => changeRole(el)));
    $("user-content").querySelectorAll(".user-remove").forEach((el) => el.addEventListener("click", () => removeUser(el.dataset.user, el.dataset.name)));
    wirePager();
    hydrateAvatars();
  }

  function userRow(m) {
    const a = m.attributes || {};
    const userId = a.user;
    const isOwner = a.role === "OWNER";
    const isSelf = userId === MY_USER;
    const name = displayName(a);
    let roleCell;
    if (CAN_ADMIN && !isOwner) {
      const opts = ["ADMIN", "MEMBER", "VIEWER"].filter((r) => MY_ROLE === "OWNER" || r !== "ADMIN")
        .map((r) => '<option value="' + r + '"' + (r === a.role ? " selected" : "") + ">" + r + "</option>").join("");
      roleCell = '<select class="roleSelect role-change" data-user="' + esc(userId) + '" data-prev="' + esc(a.role) + '">' + opts + "</select>";
    } else {
      roleCell = SM.statusPill(a.role, a.role === "OWNER" ? "active" : "private");
    }
    const canRemove = CAN_ADMIN && !isOwner && !isSelf;
    const actions = canRemove
      ? '<button type="button" class="button buttonDanger buttonSmall user-remove" data-user="' + esc(userId) + '" data-name="' + esc(name) + '">Remove</button>'
      : "";
    return (
      '<tr><td><span class="cellUser"><span data-avatar data-email="' + esc(a.email || "") + '" data-name="' + esc(a.display_name || "") + '"></span>' +
      '<span class="cellUserName">' + esc(name) + (isSelf ? ' <span class="muted">(you)</span>' : "") + "</span></span></td>" +
      "<td>" + esc(a.email || "") + "</td>" +
      "<td>" + roleCell + "</td>" +
      '<td class="actions">' + actions + "</td></tr>"
    );
  }

  function renderInvites() {
    const rows = filteredInvites();
    const total = rows.length;
    const page = clampPage(total);
    const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const body = total
      ? pageRows.map(inviteRow).join("")
      : '<tr><td colspan="5" class="dataTableEmpty">' + (SEARCH.trim() || ROLE_FILTER ? "No matching invitations." : "No invitations yet. Use “Invite users” to add people.") + "</td></tr>";
    $("user-content").innerHTML =
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable"><thead><tr>' +
      '<th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th class="actions"></th>' +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      footerHtml(total) + "</div>";
    $("user-content").querySelectorAll(".inv-resend").forEach((el) => el.addEventListener("click", () => resendInvite(el.dataset.id)));
    $("user-content").querySelectorAll(".inv-revoke").forEach((el) => el.addEventListener("click", () => revokeInvite(el.dataset.id)));
    wirePager();
  }

  function inviteRow(inv) {
    const a = inv.attributes || {};
    const status = String(a.status || "");
    const pill = SM.statusPill(status, status === "PENDING" ? "live" : status === "ACCEPTED" ? "active" : "revoked");
    const acts = status === "PENDING"
      ? '<button type="button" class="button buttonSecondary buttonSmall inv-resend" data-id="' + esc(inv.id) + '">Resend</button>' +
        '<button type="button" class="button buttonDanger buttonSmall inv-revoke" data-id="' + esc(inv.id) + '">Revoke</button>'
      : "";
    return (
      "<tr><td>" + esc(a.email || "") + "</td>" +
      "<td>" + esc(a.role || "") + "</td>" +
      "<td>" + pill + "</td>" +
      "<td>" + fmtDate(a.expires_at) + "</td>" +
      '<td class="actions">' + acts + "</td></tr>"
    );
  }

  // ── User actions ──
  async function changeRole(select) {
    const userId = select.dataset.user;
    const role = select.value;
    setMsg("");
    try {
      await apiFetch("/api/v1/account_users/" + encodeURIComponent(userId), { method: "PUT", body: jsonapiBody("account_user", { role }) });
      select.dataset.prev = role;
      setMsg("Role updated.", "success");
    } catch (err) {
      select.value = select.dataset.prev;
      setMsg(err.message, "error");
    }
  }
  async function removeUser(userId, name) {
    const ok = await SM.confirm({ title: "Remove this user?", message: "<strong>" + esc(name) + "</strong> loses access to this account immediately.", confirmLabel: "Remove user" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/account_users/" + encodeURIComponent(userId), { method: "DELETE" });
      await loadUsers();
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Invite actions ──
  async function resendInvite(id) {
    setMsg("");
    try {
      await apiFetch("/api/v1/invitations/" + encodeURIComponent(id) + "/actions/resend", { method: "POST" });
      await loadInvites();
      setMsg("Invitation resent.", "success");
    } catch (err) { setMsg(err.message, "error"); }
  }
  async function revokeInvite(id) {
    const ok = await SM.confirm({ title: "Revoke this invitation?", message: "The invite link stops working immediately.", confirmLabel: "Revoke invitation" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/invitations/" + encodeURIComponent(id) + "/actions/revoke", { method: "POST" });
      await loadInvites();
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Invite modal (multiple emails + modern radio role) ──
  function openInvite() {
    const roleOpts = [["ADMIN", "Admin"], ["MEMBER", "Member"], ["VIEWER", "Viewer"]]
      .map(([v, label]) =>
        '<label class="radioPill"><input type="radio" name="role" value="' + v + '"' + (v === "MEMBER" ? " checked" : "") + " />" +
        '<span class="radioDot" aria-hidden="true"></span><span class="radioPillLabel">' + label + "</span></label>",
      ).join("");
    const bodyHtml =
      '<form class="form" id="invite-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Email addresses</span>' +
      '<textarea name="emails" rows="4" placeholder="Enter email addresses, separated by commas, newlines, or spaces"></textarea>' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<div class="field"><span class="detailFieldLabel fieldRequired">Role</span>' +
      '<div class="radioGroup" role="radiogroup" aria-label="Role">' + roleOpts + "</div></div>" +
      '<p class="form-status" id="invite-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Send invitations</button></div></form>';
    const m = SM.modal({ title: "Invite users", description: "Invitations will be sent by email.", bodyHtml: bodyHtml });
    const f = m.panel.querySelector("#invite-form");
    const emailsField = f.querySelector('textarea[name="emails"]').closest(".field");
    const msgEl = m.panel.querySelector("#invite-msg");
    function localMsg(text, kind) { msgEl.textContent = text || ""; msgEl.className = "form-status" + (text ? " is-" + (kind || "error") : ""); }
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      localMsg("");
      SM.clearFieldError(emailsField);
      const seen = new Set();
      const emails = [];
      f.emails.value.split(/[\s,]+/).forEach((raw) => {
        const e = raw.trim();
        const k = e.toLowerCase();
        if (e && !seen.has(k)) { seen.add(k); emails.push(e); }
      });
      if (!emails.length) { SM.setFieldError(emailsField, "Enter at least one email address."); f.emails.focus(); return; }
      const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad.length) { SM.setFieldError(emailsField, "These don't look like valid emails: " + bad.join(", ")); f.emails.focus(); return; }
      const role = (f.querySelector('input[name="role"]:checked') || {}).value || "MEMBER";
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      const failures = [];
      for (const email of emails) {
        try {
          await apiFetch("/api/v1/invitations", { method: "POST", body: jsonapiBody("invitation", { email: email, role: role }) });
        } catch (err) { failures.push(email + " — " + err.message); }
      }
      if (failures.length === emails.length) {
        submit.disabled = false;
        localMsg("Couldn't send: " + failures.join("; "), "error");
        return;
      }
      m.close();
      INVITES_LOADED = false;
      selectTab("invites");
      await loadInvites();
      const sent = emails.length - failures.length;
      if (failures.length) setMsg("Sent " + sent + " of " + emails.length + ". Failed: " + failures.join("; "), "error");
      else setMsg("Sent " + sent + " invitation" + (sent === 1 ? "" : "s") + ".", "success");
    });
    f.emails.addEventListener("input", () => SM.clearFieldError(emailsField));
  }
})();
