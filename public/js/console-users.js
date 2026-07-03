"use strict";

// Members (/account/users) — active members (role change / remove) + pending invitations
// (invite / resend / revoke). Admin-gated actions. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  function $(id) { return document.getElementById(id); }
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

  // Tabs
  const tabs = $("member-tabs");
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".segBtn");
    if (!btn) return;
    tabs.querySelectorAll(".segBtn").forEach((b) => b.classList.toggle("isActive", b === btn));
    const tab = btn.dataset.tab;
    $("tab-members").style.display = tab === "members" ? "" : "none";
    $("tab-invites").style.display = tab === "invites" ? "" : "none";
    if (tab === "invites") loadInvites();
  });

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
    const body = $("members-body");
    setMsg($("members-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/account_users");
      const list = (doc && doc.data) || [];
      body.innerHTML = list.map(memberRow).join("");
      wireMemberActions(list);
    } catch (err) {
      body.innerHTML = '<tr><td colspan="4" class="dataTableEmpty">Failed to load.</td></tr>';
      setMsg($("members-msg"), err.message, "error");
    }
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
    body.querySelectorAll(".role-change").forEach((el) =>
      el.addEventListener("change", () => changeRole(el)),
    );
    body.querySelectorAll(".member-remove").forEach((el) =>
      el.addEventListener("click", () => removeMember(el.dataset.user, el.dataset.name)),
    );
  }

  async function changeRole(select) {
    const userId = select.dataset.user;
    const role = select.value;
    setMsg($("members-msg"), "");
    try {
      await apiFetch("/api/v1/account_users/" + encodeURIComponent(userId), {
        method: "PUT",
        body: jsonapiBody("account_user", { role }),
      });
      select.dataset.prev = role;
      setMsg($("members-msg"), "Role updated.", "ok");
    } catch (err) {
      select.value = select.dataset.prev; // revert
      setMsg($("members-msg"), err.message, "error");
    }
  }

  async function removeMember(userId, name) {
    if (!window.confirm("Remove " + name + " from this account? They lose access immediately.")) return;
    setMsg($("members-msg"), "");
    try {
      await apiFetch("/api/v1/account_users/" + encodeURIComponent(userId), { method: "DELETE" });
      await loadMembers();
    } catch (err) {
      setMsg($("members-msg"), err.message, "error");
    }
  }

  // ── Invitations ──
  async function loadInvites() {
    const body = $("invites-body");
    setMsg($("invites-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/invitations");
      const list = (doc && doc.data) || [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="5" class="dataTableEmpty">No invitations. Use “Invite member” to add someone.</td></tr>';
        return;
      }
      body.innerHTML = list.map(inviteRow).join("");
      wireInviteActions();
    } catch (err) {
      body.innerHTML = '<tr><td colspan="5" class="dataTableEmpty">Failed to load.</td></tr>';
      setMsg($("invites-msg"), err.message, "error");
    }
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
    body.querySelectorAll(".inv-resend").forEach((el) =>
      el.addEventListener("click", () => inviteAction(el.dataset.id, "resend")),
    );
    body.querySelectorAll(".inv-revoke").forEach((el) =>
      el.addEventListener("click", () => inviteAction(el.dataset.id, "revoke")),
    );
  }

  async function inviteAction(id, action) {
    if (action === "revoke" && !window.confirm("Revoke this invitation?")) return;
    setMsg($("invites-msg"), "");
    try {
      await apiFetch("/api/v1/invitations/" + encodeURIComponent(id) + "/actions/" + action, { method: "POST" });
      await loadInvites();
      if (action === "resend") setMsg($("invites-msg"), "Invitation resent.", "ok");
    } catch (err) {
      setMsg($("invites-msg"), err.message, "error");
    }
  }

  // ── Invite modal ──
  const modal = $("invite-modal");
  function openInvite() {
    setMsg($("invite-msg"), "");
    $("invite-form").reset();
    modal.style.display = "grid";
    setTimeout(() => { const i = modal.querySelector('input[name="email"]'); if (i) i.focus(); }, 0);
  }
  function closeInvite() { modal.style.display = "none"; }
  $("invite-cancel").addEventListener("click", closeInvite);
  modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) closeInvite(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && modal.style.display !== "none") closeInvite(); });

  $("invite-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    setMsg($("invite-msg"), "");
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await apiFetch("/api/v1/invitations", {
        method: "POST",
        body: jsonapiBody("invitation", { email: form.email.value.trim(), role: form.role.value }),
      });
      closeInvite();
      // Jump to the Invited tab to show the pending invite.
      const invBtn = document.querySelector('.segBtn[data-tab="invites"]');
      if (invBtn) invBtn.click();
    } catch (err) {
      setMsg($("invite-msg"), err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
})();
