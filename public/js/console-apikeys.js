"use strict";

// API Keys (/account/api-keys) — list, create (with one-time reveal), rotate,
// revoke. Depends on api.js + shell.js.

(function () {
  const esc = SM.esc;
  let CAN_ADMIN = false;
  function $(id) { return document.getElementById(id); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  // Top-bar primary action (admins only; wired after identity resolves).
  function wireTopBar() {
    if (!CAN_ADMIN) return;
    SM.setTopBarAction(
      '<button type="button" class="button buttonPrimary buttonTopBar" id="new-key">' +
      SM.icon("plus", 16) + " Create API key</button>",
    );
    $("new-key").addEventListener("click", openCreate);
  }

  const modal = $("key-modal");
  const formState = $("create-apikey-form");
  const revealState = $("key-reveal-state");

  function openCreate() {
    setMsg($("create-apikey-msg"), "");
    formState.reset();
    formState.style.display = "";
    revealState.style.display = "none";
    $("key-modal-title").textContent = "Create API key";
    $("key-modal-desc").style.display = "";
    modal.style.display = "grid";
    const name = formState.querySelector('input[name="name"]');
    if (name) name.focus();
  }
  function closeModal() { modal.style.display = "none"; }
  $("key-cancel").addEventListener("click", closeModal);
  $("reveal-done").addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) closeModal(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && modal.style.display !== "none") closeModal(); });

  function showReveal(keyValue, title) {
    formState.style.display = "none";
    $("key-modal-desc").style.display = "none";
    revealState.style.display = "";
    $("key-modal-title").textContent = title || "New API key";
    $("reveal-code").textContent = keyValue;
    const copyBtn = $("reveal-copy");
    copyBtn.textContent = "Copy";
    copyBtn.onclick = () => {
      SM.copyText(keyValue).then(() => { copyBtn.textContent = "Copied"; }, () => { copyBtn.textContent = "Copy failed"; });
    };
    modal.style.display = "grid";
  }

  formState.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setMsg($("create-apikey-msg"), "");
    const attrs = { name: formState.name.value.trim(), scope_type: formState.scope_type.value };
    const ref = formState.scope_ref.value.trim();
    if (ref) attrs.scope_ref = ref;
    const submit = formState.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const doc = await apiFetch("/api/v1/api_keys", { method: "POST", body: jsonapiBody("api_key", attrs) });
      const created = doc && doc.data && doc.data.attributes;
      await loadKeys();
      if (created && created.key) showReveal(created.key, "New API key");
      else closeModal();
    } catch (err) {
      setMsg($("create-apikey-msg"), err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  // ── Boot ──
  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    wireTopBar();
    const attrs = (id.user && id.user.attributes) || {};
    if (attrs.verified === false) {
      $("verify-banner").style.display = "flex";
      const btn = $("resend-verification");
      btn.addEventListener("click", async () => {
        setMsg($("verify-msg"), "");
        btn.disabled = true;
        try {
          await authFetch("/api/v1/auth/resend-verification", undefined, { method: "POST" });
          setMsg($("verify-msg"), "Verification email sent.", "success");
        } catch (err) { setMsg($("verify-msg"), err.message, "error"); }
        finally { btn.disabled = false; }
      });
    }
    loadKeys();
  }).catch(() => {
    $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  async function loadKeys() {
    const body = $("apikeys-body");
    setMsg($("apikeys-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/api_keys");
      const list = (doc && doc.data) || [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="5" class="dataTableEmpty">No API keys yet. Use “Create API key” to make one.</td></tr>';
        return;
      }
      body.innerHTML = list.map(keyRow).join("");
      wireRowActions();
    } catch (err) {
      body.innerHTML = '<tr><td colspan="5" class="dataTableEmpty">Failed to load.</td></tr>';
      setMsg($("apikeys-msg"), err.message, "error");
    }
  }

  function keyRow(k) {
    const a = k.attributes || {};
    const id = esc(k.id);
    const scope = esc(a.scope_type || "") + (a.scope_ref ? ' <span class="muted">' + esc(a.scope_ref) + "</span>" : "");
    const state = a.revoked ? SM.statusPill("revoked", "revoked") : SM.statusPill("active", "active");
    let acts = "";
    if (!a.revoked && CAN_ADMIN) {
      acts =
        '<button type="button" class="button buttonSecondary buttonSmall key-rotate" data-id="' + id + '">Rotate</button>' +
        '<button type="button" class="button buttonDanger buttonSmall key-revoke" data-id="' + id + '">Revoke</button>';
    }
    return (
      "<tr><td><strong>" + esc(a.name || "") + "</strong></td>" +
      "<td><code>" + esc(a.prefix || "") + "…</code></td>" +
      "<td>" + scope + "</td>" +
      "<td>" + state + "</td>" +
      '<td class="actions">' + acts + "</td></tr>"
    );
  }

  function wireRowActions() {
    const body = $("apikeys-body");
    body.querySelectorAll(".key-rotate").forEach((el) => el.addEventListener("click", () => rotateKey(el.dataset.id)));
    body.querySelectorAll(".key-revoke").forEach((el) => el.addEventListener("click", () => revokeKey(el.dataset.id)));
  }

  async function rotateKey(id) {
    if (!window.confirm("Rotate this key? The old value stops working immediately.")) return;
    setMsg($("apikeys-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/api_keys/" + encodeURIComponent(id) + "/actions/rotate", { method: "POST" });
      const rotated = doc && doc.data && doc.data.attributes;
      await loadKeys();
      if (rotated && rotated.key) showReveal(rotated.key, "Rotated API key");
    } catch (err) { setMsg($("apikeys-msg"), err.message, "error"); }
  }

  async function revokeKey(id) {
    if (!window.confirm("Revoke this key? This cannot be undone.")) return;
    setMsg($("apikeys-msg"), "");
    try {
      await apiFetch("/api/v1/api_keys/" + encodeURIComponent(id), { method: "DELETE" });
      await loadKeys();
    } catch (err) { setMsg($("apikeys-msg"), err.message, "error"); }
  }
})();
