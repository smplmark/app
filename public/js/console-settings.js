"use strict";

// Account settings (/account/settings) — view account info; admins can rename the account.
// Depends on api.js + shell.js.

(function () {
  function $(id) { return document.getElementById(id); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  let ACCOUNT = null;
  let CAN_ADMIN = false;

  $("edit-name").innerHTML = SM.icon("pencil", 14);

  SM.ready.then((id) => {
    ACCOUNT = id.account;
    CAN_ADMIN = id.canAdmin;
    $("account-role").textContent = id.role || "—";
    render();
    renderPersonalToggle();
    if (CAN_ADMIN) {
      $("edit-name").style.display = "";
    } else {
      $("settings-note").style.display = "";
    }
  }).catch(() => {
    $("account-name").textContent = "Failed to load account.";
  });

  // ── Personal-publishing toggle ──
  const personalToggle = $("allow-personal");
  function renderPersonalToggle() {
    const a = (ACCOUNT && ACCOUNT.attributes) || {};
    const on = a.allow_personal_publish === true;
    personalToggle.checked = on;
    personalToggle.disabled = !CAN_ADMIN;
    $("allow-personal-state").textContent = on ? "On" : "Off";
  }

  personalToggle.addEventListener("change", async () => {
    if (!CAN_ADMIN) return;
    const attrs = (ACCOUNT && ACCOUNT.attributes) || {};
    const next = personalToggle.checked;
    personalToggle.disabled = true;
    setMsg($("personal-msg"), "");
    try {
      // Full-replace PUT (get-mutate-put): carry name/description/url, flip the flag.
      const doc = await apiFetch("/api/v1/accounts/current", {
        method: "PUT",
        body: jsonapiBody("account", {
          name: attrs.name,
          description: attrs.description ?? null,
          url: attrs.url ?? null,
          allow_personal_publish: next,
        }),
      });
      if (doc && doc.data) ACCOUNT = doc.data;
      renderPersonalToggle();
    } catch (err) {
      setMsg($("personal-msg"), err.message, "error");
      renderPersonalToggle(); // revert the checkbox to the server truth
    }
  });

  function render() {
    const a = (ACCOUNT && ACCOUNT.attributes) || {};
    $("account-name").textContent = a.name || "—";
    $("account-key").textContent = a.key ? "@" + a.key : "";
    $("account-created").textContent = fmtDate(a.created_at);
  }

  const view = $("account-name").closest(".profileRow");
  const form = $("edit-name-form");
  const input = $("name-input");

  $("edit-name").addEventListener("click", () => {
    const a = (ACCOUNT && ACCOUNT.attributes) || {};
    input.value = a.name || "";
    setMsg($("name-msg"), "");
    view.style.display = "none";
    form.style.display = "grid";
    input.focus();
    input.select();
  });

  $("name-cancel").addEventListener("click", exitEdit);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); exitEdit(); } });
  function exitEdit() { form.style.display = "none"; view.style.display = "grid"; }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) { setMsg($("name-msg"), "Account name is required.", "error"); return; }
    const attrs = (ACCOUNT && ACCOUNT.attributes) || {};
    if (name === attrs.name) { exitEdit(); return; }
    const save = $("name-save");
    save.disabled = true;
    setMsg($("name-msg"), "");
    try {
      // Full-replace PUT (get-mutate-put): keep description/url as-is.
      const doc = await apiFetch("/api/v1/accounts/current", {
        method: "PUT",
        body: jsonapiBody("account", {
          name,
          description: attrs.description ?? null,
          url: attrs.url ?? null,
        }),
      });
      if (doc && doc.data) ACCOUNT = doc.data;
      exitEdit();
      render();
    } catch (err) {
      setMsg($("name-msg"), err.message, "error");
    } finally {
      save.disabled = false;
    }
  });
})();
