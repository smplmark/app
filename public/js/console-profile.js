"use strict";

// Profile (/account/profile) — avatar, editable display name, account info.
// Depends on api.js + shell.js.

(function () {
  function $(id) { return document.getElementById(id); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  let USER = null;

  $("profile-edit").innerHTML = SM.icon("pencil", 14);

  SM.ready.then((id) => {
    USER = id.user;
    render();
  }).catch(() => {
    $("profile-name").textContent = "Failed to load profile.";
  });

  function render() {
    const a = (USER && USER.attributes) || {};
    const email = a.email || "";
    const displayName = a.display_name || (email ? email.split("@")[0] : "Account");

    const host = $("profile-avatar");
    const av = SM.avatar(80, email, a.display_name);
    av.id = "profile-avatar";
    host.replaceWith(av);

    $("profile-name").textContent = displayName;
    $("profile-email").textContent = email;
    $("profile-since").textContent = formatDate(a.created_at);

    const verifiedEl = $("profile-verified");
    const resendBtn = $("profile-resend");
    if (a.verified) {
      verifiedEl.textContent = "Yes";
      resendBtn.style.display = "none";
    } else {
      verifiedEl.textContent = "No";
      resendBtn.style.display = "";
    }
  }

  // ── Edit display name ──
  const view = $("profile-name-view");
  const form = $("profile-edit-form");
  const input = $("profile-name-input");

  $("profile-edit").addEventListener("click", () => {
    const a = (USER && USER.attributes) || {};
    input.value = a.display_name || "";
    setMsg($("profile-edit-msg"), "");
    view.style.display = "none";
    form.style.display = "grid";
    input.focus();
    input.select();
  });

  $("profile-cancel").addEventListener("click", exitEdit);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); exitEdit(); } });
  function exitEdit() { form.style.display = "none"; view.style.display = "flex"; }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const trimmed = input.value.trim();
    if (!trimmed) { setMsg($("profile-edit-msg"), "Name is required.", "error"); return; }
    const current = (USER && USER.attributes && USER.attributes.display_name) || "";
    if (trimmed === current) { exitEdit(); return; }
    const save = $("profile-save");
    save.disabled = true;
    setMsg($("profile-edit-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/users/current", { method: "PUT", body: jsonapiBody("user", { display_name: trimmed }) });
      if (doc && doc.data) USER = doc.data;
      exitEdit();
      render();
      // refresh the sidebar user label
      const nameEl = document.getElementById("sm-user-name");
      if (nameEl) nameEl.textContent = trimmed;
    } catch (err) {
      setMsg($("profile-edit-msg"), err.message, "error");
    } finally {
      save.disabled = false;
    }
  });

  // ── Resend verification ──
  $("profile-resend").addEventListener("click", async () => {
    const btn = $("profile-resend");
    btn.disabled = true;
    try {
      await authFetch("/api/v1/auth/resend-verification", undefined, { method: "POST" });
      btn.textContent = "Sent!";
    } catch (err) {
      btn.textContent = "Try again";
      btn.disabled = false;
    }
  });
})();
