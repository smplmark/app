"use strict";

// Profile (/account/profile) — a standards-conforming detail page: a DetailHeader carrying the
// avatar, display name, and email plus a top-right Edit button, and a details panel. Edit mode swaps
// the display name and preferred theme into a form; Save persists both. The theme also applies live
// as you pick it (Cancel reverts). Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  let USER = null;
  let SETTINGS = {};
  let editing = false;
  let form = { display_name: "", theme: "system" };
  let savedTheme = "system"; // theme in effect when editing began — restored on Cancel

  const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };

  function formatDate(iso) { return SM.fmtDate(iso) || "—"; }
  function attrs() { return (USER && USER.attributes) || {}; }
  function currentTheme() { return SM.normalizeTheme(SETTINGS.theme); }
  function displayNameOf() {
    const a = attrs();
    return a.display_name || (a.email ? a.email.split("@")[0] : "Account");
  }
  function setMsg(text, kind) {
    const el = $("profile-edit-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  SM.ready.then(async (id) => {
    USER = id.user;
    try {
      SETTINGS = (await apiFetch("/api/v1/users/current/settings", { json: true })) || {};
    } catch (_e) {
      SETTINGS = {};
    }
    render();
  }).catch(() => {
    $("profile-root").innerHTML = '<div class="errorBanner"><p>Failed to load your profile.</p></div>';
  });

  // ── Render ──
  function render() {
    const a = attrs();
    const email = a.email || "";

    const actions = editing
      ? '<button type="button" class="button buttonSecondary" id="p-cancel">Cancel</button>' +
        '<button type="button" class="button buttonPrimary" id="p-save">Save</button>'
      : '<button type="button" class="button buttonSecondary" id="p-edit">Edit</button>';

    const leftCol = editing ? editFields() : viewFields(a);
    const rightCol =
      SM.detailField("Email", { value: email }) +
      verifiedField(a) +
      SM.detailField("Member since", { value: formatDate(a.created_at) });

    $("profile-root").innerHTML =
      '<div class="detailHeader">' +
        '<div class="profileHeaderLeft">' +
          '<span class="smAvatar" id="profile-avatar"></span>' +
          '<div class="profileHeaderText">' +
            '<div class="detailHeaderTitleRow"><h1>' + esc(displayNameOf()) + "</h1></div>" +
            '<div class="detailHeaderSecondary">' + esc(email) + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="detailHeaderActions">' + actions + "</div>" +
      "</div>" +
      '<div class="panel profileDetailPanel">' +
        '<div class="detailGrid">' +
          '<div class="detailCol">' + leftCol + "</div>" +
          '<div class="detailCol">' + rightCol + "</div>" +
        "</div>" +
        '<p id="profile-edit-msg" class="form-status"></p>' +
        '<p class="profilePicHelp">Your avatar comes from <a class="authTextLink" href="https://gravatar.com" target="_blank" rel="noopener">Gravatar</a>, matched on your email address. Set one there and it appears here automatically.</p>' +
      "</div>";

    const host = $("profile-avatar");
    const av = SM.avatar(56, email, a.display_name);
    av.id = "profile-avatar";
    av.style.width = "56px";
    av.style.height = "56px";
    av.style.fontSize = "20px";
    av.style.flexShrink = "0";
    host.replaceWith(av);

    if (editing) wireEdit(); else wireView();
  }

  function viewFields(a) {
    return (
      SM.detailField("Display name", { value: a.display_name }) +
      SM.detailField("Theme", { value: THEME_LABELS[currentTheme()] })
    );
  }

  function editFields() {
    const opts = SM.THEMES.map(
      (v) =>
        '<label class="radioPill">' +
          '<input type="radio" name="theme" value="' + v + '"' + (v === form.theme ? " checked" : "") + " />" +
          '<span class="radioDot" aria-hidden="true"></span>' +
          '<span class="radioPillLabel">' + esc(THEME_LABELS[v]) + "</span>" +
        "</label>",
    ).join("");
    return (
      '<div class="field"><span class="detailFieldLabel fieldRequired">Display name</span>' +
        '<input id="p-name" type="text" value="' + esc(form.display_name) + '" placeholder="Your name" />' +
        '<p class="fieldErrorMessage" hidden></p></div>' +
      '<div class="field"><span class="detailFieldLabel">Theme</span>' +
        '<div class="radioGroup" id="p-theme" role="radiogroup" aria-label="Theme">' + opts + "</div>" +
        '<p class="detailFieldHelp">Changes the look instantly; saved to your account when you click Save.</p></div>'
    );
  }

  // Read-only, but carries the resend link when the email is unverified.
  function verifiedField(a) {
    const value = a.verified
      ? '<span class="detailFieldValue">Yes</span>'
      : '<span class="detailFieldValue">No<button type="button" class="buttonLink" id="profile-resend">Send verification link</button></span>';
    return '<div class="field"><span class="detailFieldLabel">Email verified</span>' + value + "</div>";
  }

  // ── Wiring ──
  function wireView() {
    const edit = $("p-edit");
    if (edit) edit.addEventListener("click", enterEdit);
    const resend = $("profile-resend");
    if (resend) resend.addEventListener("click", resendVerification);
  }

  function wireEdit() {
    const name = $("p-name");
    name.addEventListener("input", () => { form.display_name = name.value; SM.clearFieldError(name); });
    $("p-theme").addEventListener("change", (ev) => {
      const t = ev.target;
      if (t && t.name === "theme") {
        form.theme = t.value;
        SM.applyThemeDom(form.theme); // live preview (DOM only; persisted on Save)
      }
    });
    $("p-cancel").addEventListener("click", cancelEdit);
    $("p-save").addEventListener("click", save);
    window.addEventListener("beforeunload", onBeforeUnload);
    name.focus();
    name.select();
  }

  // ── Edit lifecycle ──
  function enterEdit() {
    const a = attrs();
    editing = true;
    savedTheme = currentTheme();
    form = { display_name: a.display_name || "", theme: savedTheme };
    render();
  }
  function exitEdit() {
    editing = false;
    window.removeEventListener("beforeunload", onBeforeUnload);
  }
  function isDirty() {
    if (!editing) return false;
    const a = attrs();
    return form.display_name.trim() !== (a.display_name || "") || form.theme !== savedTheme;
  }
  function onBeforeUnload(e) { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } }

  function cancelEdit() {
    SM.applyThemeDom(savedTheme); // revert the live preview, then leave edit mode
    exitEdit();
    render();
  }

  async function save() {
    const name = $("p-name");
    SM.clearFieldError(name);
    const trimmed = name.value.trim();
    if (!trimmed) { SM.setFieldError(name, "A display name is required."); name.focus(); return; }
    const a = attrs();
    const btn = $("p-save");
    btn.disabled = true;
    setMsg("");
    try {
      if (trimmed !== (a.display_name || "")) {
        const doc = await apiFetch("/api/v1/users/current", { method: "PUT", body: jsonapiBody("user", { display_name: trimmed }) });
        if (doc && doc.data) USER = doc.data;
      }
      if (form.theme !== savedTheme) {
        // get-mutate-put: preserve any other preference keys already in the bag.
        const next = Object.assign({}, SETTINGS, { theme: form.theme });
        SETTINGS = (await apiFetch("/api/v1/users/current/settings", { method: "PUT", json: true, body: next })) || next;
        SM.cacheTheme(form.theme);
        SM.applyThemeDom(form.theme);
      }
      exitEdit();
      render();
      const nameEl = document.getElementById("sm-user-name");
      if (nameEl) nameEl.textContent = displayNameOf();
    } catch (err) {
      btn.disabled = false;
      setMsg(err.message, "error");
    }
  }

  // ── Resend verification ──
  async function resendVerification() {
    const btn = $("profile-resend");
    btn.disabled = true;
    try {
      await authFetch("/api/v1/auth/resend-verification", undefined, { method: "POST" });
      btn.textContent = "Sent!";
    } catch (_e) {
      btn.textContent = "Try again";
      btn.disabled = false;
    }
  }
})();
