"use strict";

/* shell.js — renders the logged-in chrome (collapsible sidebar + top bar) for every /account/*
   console page and wires the shared interactions: role-gated nav, the user menu (Profile / Contact
   Us / account switcher / Sign out), and the Contact Us modal. Mirrors the smplkit app shell.

   Skeleton a page provides:
     <div class="appShell">
       <aside class="sidebar" id="sm-sidebar"></aside>
       <div class="appMain">
         <header class="topBar" id="sm-topbar"></header>
         <main class="appContent"> …page content… </main>
       </div>
     </div>
   plus `window.SM_PAGE = { active, breadcrumbs }`. Page scripts read identity via `SM.ready`. */

(function () {
  const token = requireAuth();
  if (!token) return;

  const COLLAPSE_KEY = "smplmark.sidebar.collapsed";
  const AUTO_COLLAPSE_WIDTH = 1024;
  const PAGE = window.SM_PAGE || { active: "", breadcrumbs: [] };

  // Stale-while-revalidate window for the per-page-load bootstrap (identity + theme settings): within
  // this age a repeat navigation renders the shell instantly from the sessionStorage cache and refreshes
  // in the background; past it, the bootstrap is re-fetched before the shell renders. Kept short so a
  // role/account change can never be shown stale for longer than the window.
  const BOOTSTRAP_TTL_MS = 60 * 1000;

  // Auth-scoped cache keys. The token hash guarantees one credential's cached bootstrap can never be
  // read under another — a new login or account switch mints a new token, hence a new key — so cached
  // identity/theme is impossible to serve across users. account_id is folded in for legibility only.
  function bootstrapScope() {
    const claims = decodeJwt(token);
    return (claims.account_id || "") + ":" + hashToken(token);
  }
  function identityCacheKey() { return "identity:" + bootstrapScope(); }
  function settingsCacheKey() { return "settings:" + bootstrapScope(); }

  // ── Theme (light / dark / system) ──
  // theme.js (loaded in <head>) applies the cached choice before first paint. Here we reconcile that
  // cache with the server — the source of truth across devices — and expose helpers the profile page
  // uses to preview and persist a change. "system" removes the override so the OS preference (via CSS
  // media queries) is back in charge.
  const THEME_KEY = "smplmark.theme";
  const THEMES = ["system", "light", "dark"];
  function normalizeTheme(v) {
    return v === "light" || v === "dark" ? v : "system";
  }
  function applyThemeDom(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }
  function cacheTheme(theme) {
    const t = normalizeTheme(theme);
    try { localStorage.setItem(THEME_KEY, t); } catch (_e) {}
    // Keep the SWR settings cache in step with a persisted theme change (this is the funnel the profile
    // page's Save calls too) so the next load's instant, cached theme matches what was just saved,
    // rather than re-applying the old one for a beat before the background settings fetch corrects it.
    // Merge onto the existing cached settings so any other preference keys in the bag survive.
    const key = settingsCacheKey();
    const hit = swrGet(key);
    const base = hit && hit.value && typeof hit.value === "object" ? hit.value : {};
    swrSet(key, Object.assign({}, base, { theme: t }));
  }
  function applyThemeFromSettings(s) {
    const theme = normalizeTheme(s && s.theme);
    cacheTheme(theme);
    applyThemeDom(theme);
  }
  // Reconcile the theme with the server (the source of truth across devices). Fire-and-forget: on a
  // fresh cache hit it applies the cached theme instantly, and it ALWAYS revalidates in the background.
  function syncTheme() {
    const key = settingsCacheKey();
    const hit = swrGet(key);
    if (hit && hit.age < BOOTSTRAP_TTL_MS && hit.value) {
      applyThemeFromSettings(hit.value);
    }
    return apiFetch("/api/v1/users/current/settings", { json: true }).then((s) => {
      const settings = s || {};
      swrSet(key, settings);
      applyThemeFromSettings(settings);
    }).catch(() => {
      /* offline / not a session credential — keep whatever theme.js or the cache applied. */
    });
  }

  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    benchmarks: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    subjects: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    apikeys: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    members: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    publishers: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  };
  function icon(name, size) {
    const s = size || 20;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="' + s + '" height="' + s + '" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>"
    );
  }

  // Base nav (everyone) + admin-only items appended once the role is known.
  const BASE_NAV = [
    { key: "dashboard", label: "Dashboard", href: "/", icon: "dashboard", exact: true },
    { divider: true },
    { key: "benchmarks", label: "Benchmarks", href: "/benchmarks", icon: "benchmarks" },
    { key: "metrics", label: "Metrics", href: "/account/metrics", icon: "activity" },
    { key: "subjects", label: "Subjects", href: "/subjects", icon: "subjects" },
    { key: "subject_types", label: "Subject types", href: "/account/subject-types", icon: "layers" },
  ];
  const ADMIN_NAV = [
    { divider: true },
    { key: "members", label: "Users", href: "/account/users", icon: "members" },
    { key: "settings", label: "Settings", href: "/account/settings", icon: "settings" },
  ];

  // ── Avatar (Gravatar with initials fallback) ──
  // Local-dev accounts use @localhost emails (never real users); give them a generated Gravatar
  // instead of the initials fallback so the console looks populated in development.
  function isDevEmail(email) { return typeof email === "string" && email.toLowerCase().endsWith("@localhost"); }
  async function sha256Hex(input) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function initials(name, email) {
    const n = (name || "").trim();
    if (n) {
      const parts = n.split(/\s+/);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      return parts[0].slice(0, 2).toUpperCase();
    }
    const e = (email || "").trim();
    if (e) return (e.split("@")[0] || e).slice(0, 2).toUpperCase();
    return "?";
  }
  function avatar(size, email, name) {
    const el = document.createElement("span");
    el.className = "smAvatar";
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.fontSize = Math.max(10, Math.round(size * 0.36)) + "px";
    el.textContent = initials(name, email);
    const lookup = (email || "").trim().toLowerCase();
    if (lookup && crypto.subtle) {
      sha256Hex(lookup).then((hex) => {
        const img = new Image();
        img.alt = "";
        img.onload = () => { el.textContent = ""; el.appendChild(img); };
        img.onerror = () => {};
        // Real users fall back to their initials when they have no Gravatar (d=404). Local-dev users
        // have no real Gravatar, so give them a stable generated one (d=identicon, forced with f=y).
        const fallback = isDevEmail(lookup) ? "&d=identicon&f=y" : "&d=404";
        img.src = "https://www.gravatar.com/avatar/" + hex + "?s=" + size * 2 + fallback;
      }).catch(() => {});
    }
    return el;
  }

  // ── Collapse state ──
  function collapsedInitial() {
    let stored = null;
    try { stored = localStorage.getItem(COLLAPSE_KEY); } catch (_e) {}
    if (stored === "true") return true;
    if (stored === "false") return false;
    return window.matchMedia("(max-width: " + AUTO_COLLAPSE_WIDTH + "px)").matches;
  }

  const aside = document.getElementById("sm-sidebar");
  const header = document.getElementById("sm-topbar");
  let collapsed = collapsedInitial();
  let IDENTITY = null;
  let CAN_ADMIN = false;

  function nav() {
    return CAN_ADMIN ? BASE_NAV.concat(ADMIN_NAV) : BASE_NAV;
  }

  function renderSidebar() {
    const brand = collapsed
      ? '<button class="sidebarLogoCompact" id="sm-expand" type="button" aria-label="Expand sidebar" title="Expand sidebar"><img src="/img/favicon-120.png" alt="smplmark" /></button>'
      : '<div class="sidebarBrand"><a class="sidebarLogo" href="/" aria-label="smplmark home"><picture>' +
        '<source srcset="/img/logo-light.png" media="(prefers-color-scheme: light)" />' +
        '<img src="/img/logo-dark.png" alt="smplmark" /></picture></a></div>' +
        '<button class="sidebarToggle" id="sm-collapse" type="button" aria-label="Collapse sidebar" title="Collapse sidebar">' + icon("chevronLeft", 18) + "</button>";

    let items = "";
    nav().forEach((item) => {
      if (item.divider) { items += '<hr class="sidebarDivider" />'; return; }
      const active = item.key === PAGE.active;
      items +=
        '<a href="' + item.href + '" class="sidebarLink' + (active ? " isActive" : "") + '"' +
        (collapsed ? ' title="' + esc(item.label) + '"' : "") + ">" +
        '<span class="sidebarLinkIcon">' + icon(item.icon, 20) + "</span>" +
        (collapsed ? "" : '<span class="sidebarLinkLabel">' + esc(item.label) + "</span>") + "</a>";
    });

    const user =
      '<div class="sidebarUser" id="sm-user">' +
      '<button class="sidebarUserButton" id="sm-user-button" type="button">' +
      '<span class="smAvatar" id="sm-user-avatar" style="width:32px;height:32px;font-size:12px;"></span>' +
      (collapsed ? "" :
        '<span class="sidebarUserInfo"><span class="sidebarUserName" id="sm-user-name">…</span>' +
        '<span class="sidebarUserEmail" id="sm-user-email"></span></span>' +
        '<span class="sidebarUserChevron">' + icon("chevronDown", 14) + "</span>") +
      "</button></div>";

    aside.className = "sidebar" + (collapsed ? " isCollapsed" : "");
    aside.innerHTML = '<div class="sidebarHeader">' + brand + "</div><nav class=\"sidebarNav\">" + items + "</nav>" + user;
    wireSidebar();
    fillUser();
  }

  function breadcrumbNavHtml(crumbs) {
    crumbs = (crumbs && crumbs.length) ? crumbs : [{ label: "Dashboard" }];
    let list = "";
    crumbs.forEach((c, i) => {
      const last = i === crumbs.length - 1;
      list += '<li class="breadcrumbItem">' +
        (i > 0 ? '<span class="breadcrumbSeparator">/</span>' : "") +
        (last || !c.href
          ? '<span' + (last ? ' class="breadcrumbCurrent"' : "") + ">" + esc(c.label) + "</span>"
          : '<a class="breadcrumbLink" href="' + c.href + '">' + esc(c.label) + "</a>") + "</li>";
    });
    return '<nav class="breadcrumbs" aria-label="Breadcrumbs"><ol class="breadcrumbList">' + list + "</ol></nav>";
  }
  function renderTopBar() {
    header.innerHTML = breadcrumbNavHtml(PAGE.breadcrumbs) + '<div class="topBarActions" id="sm-topbar-actions"></div>';
  }
  // Update just the breadcrumb trail (e.g. a tabbed page switching tabs), preserving any top-bar actions.
  function setBreadcrumbs(crumbs) {
    PAGE.breadcrumbs = crumbs;
    const nav = header.querySelector(".breadcrumbs");
    if (nav) nav.outerHTML = breadcrumbNavHtml(crumbs);
    else renderTopBar();
  }

  function setCollapsed(next, persist) {
    collapsed = next;
    if (persist) { try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch (_e) {} }
    renderSidebar();
  }

  // Change which sidebar item is highlighted after boot (e.g. a detail page that belongs to a section
  // it can only determine once its resource loads, like an API key resolving to its scope).
  function setActiveNav(key) {
    PAGE.active = key;
    renderSidebar();
  }

  let userFlyoutOpen = false;
  function wireSidebar() {
    const cb = document.getElementById("sm-collapse");
    if (cb) cb.addEventListener("click", () => setCollapsed(true, true));
    const eb = document.getElementById("sm-expand");
    if (eb) eb.addEventListener("click", () => setCollapsed(false, true));
    const ub = document.getElementById("sm-user-button");
    if (ub) ub.addEventListener("click", (ev) => { ev.stopPropagation(); toggleUserFlyout(); });
  }

  function toggleUserFlyout() {
    if (userFlyoutOpen) { closeUserFlyout(); return; }
    const btn = document.getElementById("sm-user-button");
    const rect = btn.getBoundingClientRect();
    const fly = document.createElement("div");
    fly.className = "userFlyout";
    fly.id = "sm-user-flyout";
    fly.style.bottom = window.innerHeight - rect.top + 4 + "px";
    fly.style.left = rect.left + "px";
    if (!collapsed) fly.style.width = rect.width + "px";

    const memberships = (IDENTITY && IDENTITY.memberships) || [];
    let switcher = "";
    if (memberships.length > 1) {
      switcher = '<hr class="flyoutDivider" /><span class="flyoutLabel">Switch account</span>';
      memberships.forEach((m) => {
        const a = m.attributes || {};
        const isCurrent = IDENTITY && a.account === IDENTITY.accountId;
        switcher += '<button class="flyoutItem sm-switch" data-account="' + esc(a.account) + '" type="button"' +
          (isCurrent ? ' disabled style="opacity:.55"' : "") + ">" + esc(a.name || a.key) +
          (isCurrent ? " ✓" : "") + "</button>";
      });
    }

    // Dev-only user switcher: when signed in as a local-dev (@localhost) user, offer to sign in as any
    // of the seeded role users. Navigating to /dev-login?role=… re-runs the dev-login hand-off.
    const devEmail = (IDENTITY && IDENTITY.user && IDENTITY.user.attributes && IDENTITY.user.attributes.email) || "";
    let devSwitch = "";
    if (isDevEmail(devEmail)) {
      devSwitch = '<hr class="flyoutDivider" /><span class="flyoutLabel">Dev — switch user</span>';
      [["OWNER", "Owner"], ["ADMIN", "Admin"], ["MEMBER", "Member"], ["VIEWER", "Viewer"]].forEach((pair) => {
        const isCurrent = IDENTITY && IDENTITY.role === pair[0];
        devSwitch += '<button class="flyoutItem sm-dev-user" data-role="' + pair[0] + '" type="button"' +
          (isCurrent ? ' disabled style="opacity:.55"' : "") + ">" + pair[1] + (isCurrent ? " ✓" : "") + "</button>";
      });
    }

    fly.innerHTML =
      '<a class="flyoutItem" href="/account/profile">Profile</a>' +
      '<button class="flyoutItem" id="sm-contact" type="button">Contact Us</button>' +
      switcher +
      devSwitch +
      '<hr class="flyoutDivider" />' +
      '<button class="flyoutItem flyoutItemDanger" id="sm-signout" type="button">Sign out</button>';
    document.body.appendChild(fly);
    document.getElementById("sm-signout").addEventListener("click", signOut);
    document.getElementById("sm-contact").addEventListener("click", () => { closeUserFlyout(); openContact(); });
    fly.querySelectorAll(".sm-dev-user").forEach((el) =>
      el.addEventListener("click", () => { location.href = "/api/v1/auth/dev-login?role=" + encodeURIComponent(el.dataset.role); }),
    );
    fly.querySelectorAll(".sm-switch").forEach((el) =>
      el.addEventListener("click", () => switchAccount(el.dataset.account)),
    );
    userFlyoutOpen = true;
    setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);
  }
  function closeUserFlyout() {
    const fly = document.getElementById("sm-user-flyout");
    if (fly) fly.remove();
    userFlyoutOpen = false;
    document.removeEventListener("mousedown", onDocClick);
  }
  function onDocClick(ev) {
    const fly = document.getElementById("sm-user-flyout");
    const btn = document.getElementById("sm-user-button");
    if (fly && !fly.contains(ev.target) && btn && !btn.contains(ev.target)) closeUserFlyout();
  }

  async function signOut() {
    try { await authFetch("/api/v1/auth/logout", undefined, { method: "POST" }); } catch (_e) {}
    signOutToRoot();
  }

  async function switchAccount(accountId) {
    try {
      const doc = await authFetch("/api/v1/auth/switch", { account_id: accountId });
      if (doc && doc.token) { setToken(doc.token); location.href = "/"; }
    } catch (err) {
      alert("Couldn't switch account: " + err.message);
    }
  }

  // ── Contact Us modal (uses the shared strict modal) ──
  function openContact() {
    const bodyHtml =
      '<form class="form" id="sm-contact-form">' +
      '<label class="field"><span>Topic</span><select name="topic">' +
      '<option value="technical">Technical support</option>' +
      '<option value="account">Account question</option>' +
      '<option value="feature_request">Feature request</option>' +
      '<option value="other" selected>Other</option></select></label>' +
      '<label class="field"><span class="fieldRequired">Message</span>' +
      '<textarea name="body" rows="5" placeholder="How can we help?"></textarea>' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="sm-contact-msg"></p>' +
      '<div class="modalActions">' +
      '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Send</button></div>' +
      "</form>";
    const m = modal({
      title: "Contact us",
      description: "Send the smplmark team a message — we'll reply by email.",
      bodyHtml: bodyHtml,
    });
    const form = m.panel.querySelector("#sm-contact-form");
    const bodyField = form.querySelector('textarea[name="body"]').closest(".field");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msgEl = m.panel.querySelector("#sm-contact-msg");
      msgEl.textContent = ""; msgEl.className = "form-status";
      clearFieldError(bodyField);
      const body = form.body.value.trim();
      if (!body) { setFieldError(bodyField, "A message is required."); form.body.focus(); return; }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await apiFetch("/api/v1/emails", { method: "POST", body: jsonapiBody("email", { topic: form.topic.value, body: body }) });
        m.panel.querySelector(".modalHeader").innerHTML =
          '<h2 class="modalTitle">Message sent</h2><p class="modalDescription">Thanks — we\'ve emailed you a copy and will be in touch soon.</p>';
        const done = document.createElement("div");
        done.className = "modalActions";
        done.innerHTML = '<button type="button" class="button buttonPrimary buttonSmall">Close</button>';
        done.querySelector("button").addEventListener("click", m.close);
        form.replaceWith(done);
      } catch (err) {
        msgEl.textContent = err.message; msgEl.className = "form-status is-error";
        submit.disabled = false;
      }
    });
  }

  // ── Identity ──
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  // The three shell-gating identity calls. Never rejects: each failure degrades that field to
  // null / claims-only exactly as before, so the composed identity is always usable.
  async function fetchIdentityParts() {
    const claims = decodeJwt(token);
    let accountId = claims.account_id || null;
    let role = claims.role || null;
    let account = null, user = null, memberships = [];
    try {
      const d = await apiFetch("/api/v1/accounts/current");
      account = (d && d.data) || null;
      if (account && account.id) accountId = account.id;
    } catch (_e) {}
    try {
      const d = await apiFetch("/api/v1/users/current");
      user = (d && d.data) || null;
    } catch (_e) {}
    try {
      const d = await apiFetch("/api/v1/accounts");
      memberships = (d && d.data) || [];
      const mine = memberships.find((m) => (m.attributes || {}).account === accountId);
      if (mine) role = (mine.attributes || {}).role || role;
    } catch (_e) {}
    return { account, user, accountId, role, memberships };
  }

  // Build IDENTITY (+ derived flags + CAN_ADMIN) from raw parts and the current token. The token is
  // re-attached from the closure rather than the cache, so the cached value never holds a credential.
  function composeIdentity(parts) {
    parts = parts || {};
    const role = parts.role || null;
    IDENTITY = {
      account: parts.account || null,
      user: parts.user || null,
      accountId: parts.accountId || null,
      token: token,
      role: role,
      memberships: parts.memberships || [],
      canWrite: role === "OWNER" || role === "ADMIN" || role === "MEMBER",
      canAdmin: role === "OWNER" || role === "ADMIN",
      isOwner: role === "OWNER",
    };
    CAN_ADMIN = IDENTITY.canAdmin;
    return IDENTITY;
  }

  // A compact signature of just the bits the shell renders from, so a background revalidation that
  // returns an unchanged identity skips a redundant re-render (and its flicker).
  function identitySignature(id) {
    if (!id) return "";
    const u = (id.user && id.user.attributes) || {};
    return JSON.stringify([
      id.accountId || "",
      id.role || "",
      u.display_name || "",
      u.email || "",
      (id.memberships || []).map((m) => (m.attributes || {}).account).sort(),
    ]);
  }

  // Re-run the shell chrome that depends on identity: role-gated nav (via CAN_ADMIN), the user
  // avatar/name/email (fillUser, inside renderSidebar), and the active-nav highlight.
  function renderIdentity() {
    renderSidebar();
  }

  async function loadIdentity() {
    const key = identityCacheKey();
    const hit = swrGet(key);
    if (hit && hit.age < BOOTSTRAP_TTL_MS && hit.value) {
      // Fresh cache: compose + resolve immediately so the shell renders this tick, then revalidate the
      // three calls in the background and re-render only if the composed identity actually changed.
      composeIdentity(hit.value);
      const priorSig = identitySignature(IDENTITY);
      fetchIdentityParts().then((parts) => {
        composeIdentity(parts);
        swrSet(key, parts);
        if (identitySignature(IDENTITY) !== priorSig) renderIdentity();
      }).catch(() => { /* keep the cached view; the next navigation revalidates again */ });
      return IDENTITY;
    }
    // No fresh cache: original behavior — fetch the three, compose, then cache for next time.
    const parts = await fetchIdentityParts();
    composeIdentity(parts);
    swrSet(key, parts);
    return IDENTITY;
  }

  function fillUser() {
    const host = document.getElementById("sm-user-avatar");
    const nameEl = document.getElementById("sm-user-name");
    const emailEl = document.getElementById("sm-user-email");
    if (!IDENTITY) return;
    const u = (IDENTITY.user && IDENTITY.user.attributes) || {};
    const email = u.email || "";
    const displayName = u.display_name || (email ? email.split("@")[0] : "Account");
    if (host) { const av = avatar(32, email, u.display_name); host.replaceWith(av); av.id = "sm-user-avatar"; }
    if (nameEl) nameEl.textContent = displayName;
    if (emailEl) emailEl.textContent = email;
    const btn = document.getElementById("sm-user-button");
    if (btn) btn.title = displayName + " — " + email;
  }

  const mql = window.matchMedia("(max-width: " + AUTO_COLLAPSE_WIDTH + "px)");
  mql.addEventListener("change", (e) => { if (e.matches && !collapsed) setCollapsed(true, false); });

  // ── Strict modal (× + Escape + explicit Cancel; NEVER a backdrop click). Returns { overlay,
  //    panel, close }. `bodyHtml` is inserted after the header; give Cancel buttons `data-close`. ──
  function modal(opts) {
    opts = opts || {};
    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    const panel = document.createElement("div");
    panel.className = "modalPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    if (opts.width) panel.style.width = "min(100%, " + opts.width + "px)";
    panel.innerHTML =
      '<button type="button" class="modalCloseBtn" aria-label="Close">' + icon("close", 16) + "</button>" +
      '<div class="modalHeader"><h2 class="modalTitle">' + esc(opts.title || "") + "</h2>" +
      (opts.description ? '<p class="modalDescription">' + esc(opts.description) + "</p>" : "") + "</div>" +
      (opts.bodyHtml || "");
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (opts.onClose) opts.onClose();
    }
    // Escape closes only the TOPMOST modal — with stacked modals (e.g. View JSON over a form modal),
    // each instance listens on document, so guard on being the last overlay in the DOM.
    function onKey(e) {
      if (e.key !== "Escape") return;
      // A confirm dialog stacked on top owns the Escape — cancelling it must not also close us.
      if (document.querySelector(".deleteConfirmOverlay")) return;
      const overlays = document.querySelectorAll(".modalOverlay");
      if (overlays[overlays.length - 1] !== overlay) return;
      close();
    }
    panel.querySelector(".modalCloseBtn").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    panel.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", () => close()));
    setTimeout(() => { const f = panel.querySelector("input,select,textarea"); if (f) f.focus(); }, 0);
    return { overlay: overlay, panel: panel, close: close };
  }

  // ── Inline confirm (replaces window.confirm / prompt). No backdrop dismiss. Resolves:
  //    plain → true/false;  with opts.reason → the trimmed reason string, or null when cancelled. ──
  function confirmDialog(opts) {
    opts = opts || {};
    const reason = opts.reason;
    const danger = opts.danger !== false;
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "deleteConfirmOverlay";
      let reasonHtml = "";
      if (reason) {
        reasonHtml =
          '<label class="field"><span' + (reason.required ? ' class="fieldRequired"' : "") + ">" + esc(reason.label || "Reason") + "</span>" +
          (reason.textarea
            ? '<textarea id="sm-confirm-reason" rows="3" placeholder="' + esc(reason.placeholder || "") + '"></textarea>'
            : '<input id="sm-confirm-reason" type="text" placeholder="' + esc(reason.placeholder || "") + '" />') +
          '<p class="fieldErrorMessage" id="sm-confirm-reason-err" hidden></p></label>';
      }
      overlay.innerHTML =
        '<div class="deleteConfirmPanel" role="dialog" aria-modal="true">' +
        "<h3>" + esc(opts.title || "Are you sure?") + "</h3>" +
        (opts.message ? "<p>" + opts.message + "</p>" : "") + // message is trusted HTML — caller escapes dynamic parts
        reasonHtml +
        '<div class="deleteConfirmActions">' +
        '<button type="button" class="button buttonSecondary buttonSmall" data-cancel>' + esc(opts.cancelLabel || "Cancel") + "</button>" +
        '<button type="button" class="button ' + (danger ? "buttonDanger" : "buttonPrimary") + ' buttonSmall" data-ok>' + esc(opts.confirmLabel || "Confirm") + "</button>" +
        "</div></div>";
      document.body.appendChild(overlay);
      let done = false;
      function cleanup(result) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(result);
      }
      const cancelResult = reason ? null : false;
      function onKey(e) { if (e.key === "Escape") cleanup(cancelResult); }
      document.addEventListener("keydown", onKey);
      overlay.querySelector("[data-cancel]").addEventListener("click", () => cleanup(cancelResult));
      overlay.querySelector("[data-ok]").addEventListener("click", () => {
        if (reason) {
          const input = overlay.querySelector("#sm-confirm-reason");
          const val = (input.value || "").trim();
          if (reason.required && !val) {
            input.closest(".field").classList.add("fieldHasError");
            const err = overlay.querySelector("#sm-confirm-reason-err");
            err.textContent = "This is required."; err.hidden = false;
            input.focus();
            return;
          }
          cleanup(val);
        } else {
          cleanup(true);
        }
      });
      setTimeout(() => { const f = overlay.querySelector("#sm-confirm-reason") || overlay.querySelector("[data-ok]"); if (f) f.focus(); }, 0);
    });
  }

  // ── Toast — a brief, centered (top) notification. Non-blocking; auto-dismisses; click to dismiss.
  //    kind: "success" | "error" | "info". Use for confirmations and transient results. ──
  // A brief centered notification. Back-compat signature: toast(message, { kind, duration }). Two
  // optional additions, both inert for existing callers:
  //   • action:   { label, onClick } — renders an inline button (e.g. "Undo"); clicking it runs
  //               onClick and closes the toast WITHOUT firing onDismiss (the action "took").
  //   • onDismiss: () => void — fires once when the toast goes away by timeout or a click on its body
  //               and the action was NOT taken. This is the commit hook behind the deferred-action
  //               pattern (do the real work when the undo window closes).
  function toast(message, opts) {
    opts = opts || {};
    const kind = opts.kind || "info";
    let host = document.getElementById("sm-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "sm-toast-host";
      host.className = "toastHost";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.setAttribute("role", "status");
    const glyph = kind === "success" ? icon("check", 16) : kind === "error" ? icon("close", 16) : "";
    const action = opts.action && typeof opts.action === "object" ? opts.action : null;
    el.innerHTML = glyph + '<span class="toastMsg">' + esc(message) + "</span>" +
      (action ? '<button type="button" class="toastAction">' + esc(action.label || "Undo") + "</button>" : "");
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("isIn"));
    let done = false;
    let actioned = false;
    function leave() {
      el.classList.remove("isIn");
      el.classList.add("isOut");
      setTimeout(() => el.remove(), 220);
    }
    function dismiss() {
      if (done) return;
      done = true;
      leave();
      if (!actioned && typeof opts.onDismiss === "function") opts.onDismiss();
    }
    if (action) {
      const btn = el.querySelector(".toastAction");
      if (btn) btn.addEventListener("click", (ev) => {
        ev.stopPropagation(); // an action click is not a body dismiss — onDismiss must not fire
        if (done) return;
        actioned = true;
        done = true;
        leave();
        if (typeof action.onClick === "function") action.onClick();
      });
    }
    el.addEventListener("click", dismiss);
    setTimeout(dismiss, opts.duration || 3800);
    return el;
  }

  // ── Detail-page header (title + status decorations + a user-facing secondary id + actions). ──
  function detailHeader(opts) {
    opts = opts || {};
    return (
      '<div class="detailHeader"><div class="detailHeaderLeft">' +
      '<div class="detailHeaderTitleRow"><h1>' + esc(opts.name || "") + "</h1>" + (opts.decorations || "") + "</div>" +
      (opts.secondaryId ? '<div class="detailHeaderSecondary">' + esc(opts.secondaryId) + window.SM.copyButton(opts.secondaryId) + "</div>" : "") +
      "</div>" +
      (opts.actions ? '<div class="detailHeaderActions">' + opts.actions + "</div>" : "") +
      "</div>"
    );
  }

  // ── A read-mode detail field (uppercase label + value). Edit-mode fields are built by pages as a
  //    plain .field with a .detailFieldLabel and an input + optional .fieldErrorMessage slot. ──
  function detailField(label, opts) {
    opts = opts || {};
    const empty = opts.value == null || opts.value === "";
    const cls =
      "detailFieldValue" + (opts.mono ? " isMono" : "") + (opts.multiline ? " isMultiline" : "") + (empty ? " isEmpty" : "");
    return (
      '<div class="field"><span class="detailFieldLabel' + (opts.required ? " fieldRequired" : "") + '">' + esc(label) + "</span>" +
      '<span class="' + cls + '">' + (empty ? esc(opts.emptyText || "—") : esc(opts.value)) + "</span></div>"
    );
  }

  function fieldOf(subject) {
    return subject && subject.classList && subject.classList.contains("field") ? subject : (subject && subject.closest ? subject.closest(".field") : null);
  }
  function setFieldError(subject, msg) {
    const f = fieldOf(subject);
    if (!f) return;
    f.classList.add("fieldHasError");
    let p = f.querySelector(".fieldErrorMessage");
    if (!p) { p = document.createElement("p"); p.className = "fieldErrorMessage"; f.appendChild(p); }
    p.textContent = msg; p.hidden = false;
  }
  function clearFieldError(subject) {
    const f = fieldOf(subject);
    if (!f) return;
    f.classList.remove("fieldHasError");
    const p = f.querySelector(".fieldErrorMessage");
    if (p) { p.textContent = ""; p.hidden = true; }
  }

  // ── List-page toolbar (search + refresh), floating above the table. Returns the element. ──
  function toolbar(opts) {
    opts = opts || {};
    const bar = document.createElement("div");
    bar.className = "toolbar";
    const parts = [];
    if (opts.search !== false) {
      parts.push('<div class="toolbarSearch">' + icon("search", 15) + '<input type="search" placeholder="' + esc(opts.placeholder || "Search…") + '" aria-label="Search" /></div>');
    }
    if (opts.extraLeft) parts.push(opts.extraLeft);
    parts.push('<div class="toolbarSpacer"></div>');
    if (opts.extraRight) parts.push(opts.extraRight);
    if (opts.onRefresh) parts.push('<button type="button" class="toolbarIconBtn" data-refresh title="Refresh" aria-label="Refresh">' + icon("refresh", 16) + "</button>");
    bar.innerHTML = parts.join("");
    const input = bar.querySelector(".toolbarSearch input");
    if (input && opts.onSearch) {
      let t = null;
      input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => opts.onSearch(input.value), 150); });
    }
    const rb = bar.querySelector("[data-refresh]");
    if (rb && opts.onRefresh) rb.addEventListener("click", () => opts.onRefresh());
    return bar;
  }

  // ── Date/time formatting (always rendered in the viewer's local time zone) ── fmtDateTime shows a
  // short zone label (e.g. "PDT"); fmtDate is date-only (a zone label would be meaningless there).
  function fmtDateTime(v) {
    if (v == null || v === "") return "";
    const d = new Date(typeof v === "number" ? v : String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  }
  function fmtDate(v) {
    if (v == null || v === "") return "";
    const d = new Date(typeof v === "number" ? v : String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // Render a number with an Excel-style pattern (a bounded subset: # 0 , . %). `#` is an optional digit
  // (trailing zeros trimmed), `0` is a required digit (padded), `,` groups thousands, and a trailing `%`
  // multiplies by 100 and appends a percent sign. Empty pattern → grouped with up to 6 trimmed decimals.
  // Cosmetic only — this mirrors how metric values are shown; it never changes stored data.
  function formatNumber(value, pattern) {
    const n = Number(value);
    if (!isFinite(n)) return "—";
    if (!pattern) return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
    const percent = pattern.indexOf("%") >= 0;
    const grouping = pattern.indexOf(",") >= 0;
    const dot = pattern.indexOf(".");
    const decs = dot >= 0 ? pattern.slice(dot + 1).replace(/[^0#]/g, "") : "";
    const minD = (decs.match(/0/g) || []).length;
    const maxD = decs.length;
    const v = percent ? n * 100 : n;
    const neg = v < 0;
    const fixed = Math.abs(v).toFixed(maxD).split(".");
    let ip = fixed[0];
    let fp = fixed[1] || "";
    while (fp.length > minD && fp.charAt(fp.length - 1) === "0") fp = fp.slice(0, -1);
    if (grouping) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    let out = (neg ? "-" : "") + (fp ? ip + "." + fp : ip);
    return percent ? out + "%" : out;
  }

  // ── Reusable sortable + client-paged table ── emits the shared dataTable markup: isSortable headers
  // with a ▲/▼ caret on the active column, and a "Showing X–Y of Z" footer with Previous/Next. Renders
  // into `container` and returns a controller { setRows, rerender, getSort }. Per-row action controls
  // (buttons/links) are wired by the caller in onRender; a click on any button/link/field inside a row
  // does NOT trigger onRowClick.
  //   columns: [{ key, label, sortable?, sortValue(row)?, render(row)->html, thClass?, tdClass? }]
  //   opts: { rows, sort:{key,dir}, pageSize=20, onRowClick(row), onRender(container), emptyText, rowClass(row) }
  function pagedTable(container, opts) {
    opts = opts || {};
    const columns = opts.columns || [];
    const pageSize = opts.pageSize || 20;
    const firstSortable = columns.find((c) => c.sortable);
    const state = {
      rows: opts.rows || [],
      sort: opts.sort ? { key: opts.sort.key, dir: opts.sort.dir || "asc" } : (firstSortable ? { key: firstSortable.key, dir: "asc" } : null),
      page: 1,
    };
    const colOf = (k) => columns.find((c) => c.key === k);
    function sortedRows() {
      const rows = state.rows.slice();
      const col = state.sort && colOf(state.sort.key);
      if (!col || !col.sortable) return rows;
      const dir = state.sort.dir === "desc" ? -1 : 1;
      const val = (r) => (col.sortValue ? col.sortValue(r) : "");
      rows.sort((a, z) => {
        const av = val(a), zv = val(z);
        const cmp = typeof av === "number" && typeof zv === "number"
          ? av - zv
          : String(av == null ? "" : av).localeCompare(String(zv == null ? "" : zv), undefined, { numeric: true, sensitivity: "base" });
        return cmp * dir;
      });
      return rows;
    }
    function render() {
      const all = sortedRows();
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      state.page = Math.min(Math.max(1, state.page), pages);
      const start = (state.page - 1) * pageSize;
      const pageRows = all.slice(start, start + pageSize);
      const head = "<tr>" + columns.map((c) => {
        const active = state.sort && state.sort.key === c.key;
        if (c.sortable) {
          const caret = active ? ' <span class="sortCaret">' + (state.sort.dir === "asc" ? "▲" : "▼") + "</span>" : "";
          return '<th class="isSortable' + (c.thClass ? " " + c.thClass : "") + '" data-sort="' + esc(c.key) + '">' + esc(c.label) + caret + "</th>";
        }
        return "<th" + (c.thClass ? ' class="' + c.thClass + '"' : "") + ">" + esc(c.label) + "</th>";
      }).join("") + "</tr>";
      const body = total
        ? pageRows.map((row, i) => {
            const clickable = typeof opts.onRowClick === "function";
            const rc = (opts.rowClass ? opts.rowClass(row) : "") || "";
            return '<tr class="' + (clickable ? "dataTableRowClickable " : "") + rc + '" data-row-index="' + i + '">' +
              columns.map((c) => "<td" + (c.tdClass ? ' class="' + c.tdClass + '"' : "") + ">" + (c.render ? c.render(row) : "") + "</td>").join("") + "</tr>";
          }).join("")
        : '<tr><td class="dataTableEmpty" colspan="' + columns.length + '">' + esc(opts.emptyText || "No results.") + "</td></tr>";
      const from = total ? start + 1 : 0;
      const to = Math.min(start + pageSize, total);
      const footer =
        '<div class="dataTableFooter"><span class="dataTableCount">Showing ' + from + "–" + to + " of " + total + "</span>" +
        '<div class="dataTablePager">' +
        '<button type="button" class="button buttonSecondary buttonSmall" data-page="prev"' + (state.page <= 1 ? " disabled" : "") + ">Previous</button>" +
        '<button type="button" class="button buttonSecondary buttonSmall" data-page="next"' + (state.page >= pages ? " disabled" : "") + ">Next</button></div></div>";
      container.innerHTML = '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>" + footer + "</div>";
      container.querySelectorAll("th.isSortable[data-sort]").forEach((th) => th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort");
        if (state.sort && state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        else state.sort = { key: key, dir: "asc" };
        state.page = 1;
        render();
      }));
      if (typeof opts.onRowClick === "function") {
        container.querySelectorAll("tbody tr[data-row-index]").forEach((tr) => tr.addEventListener("click", (ev) => {
          if (ev.target.closest("button, a, input, select, label")) return;
          const r = pageRows[Number(tr.dataset.rowIndex)];
          if (r) opts.onRowClick(r);
        }));
      }
      const prev = container.querySelector('[data-page="prev"]');
      const next = container.querySelector('[data-page="next"]');
      if (prev) prev.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; render(); } });
      if (next) next.addEventListener("click", () => { if (state.page < pages) { state.page += 1; render(); } });
      if (typeof opts.onRender === "function") opts.onRender(container);
    }
    render();
    return {
      setRows: function (rows, toLast) {
        state.rows = rows || [];
        state.page = toLast ? Math.max(1, Math.ceil(state.rows.length / pageSize)) : 1;
        render();
      },
      rerender: render,
      getSort: function () { return state.sort; },
    };
  }

  // ── Combobox ── an editable input with a themed popup of pickable options. The native <datalist>
  // popup is unstylable (it ignores the app theme, detaches from the input, and sizes itself), so this
  // renders its own: anchored under the input at the input's width, filtered as the user types
  // (substring on value + label), with hover/keyboard highlight (ArrowUp/Down + Enter, Escape closes)
  // and mousedown-to-pick so the input never loses focus. The menu is position:fixed at viewport
  // coordinates so it is never clipped by a scrollable ancestor (modal panels overflow-y:auto); it
  // closes on any outside scroll or resize rather than tracking the moving anchor.
  //
  // opts.options() is called fresh on every open/refilter and may return, interchangeably:
  //   ["a", "b"]                                — flat values
  //   [{ value, label }, …]                     — values with display labels
  //   [["Group", [items]], …]                   — grouped (items in either form above)
  // Picking sets input.value and dispatches `input` + `change` so the caller's existing listeners run.
  // opts.emptyText (string, or a function evaluated per render — e.g. "Loading…" until a fetch lands)
  // shows when nothing matches; null/undefined hides the popup instead (free-text fields).
  // opts.mono renders options in the monospace font. Returns { refresh, close }.
  let comboSeq = 0;
  function combobox(input, opts) {
    opts = opts || {};
    const menuId = "sm-combo-" + ++comboSeq;
    const menu = document.createElement("div");
    menu.className = "smComboMenu" + (opts.mono ? " isMono" : "");
    menu.id = menuId;
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    input.insertAdjacentElement("afterend", menu);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", menuId);

    // Normalize options() output to [[groupLabel, [{ value, label }]]].
    function groupsOf() {
      const src = (opts.options && opts.options()) || [];
      const grouped = Array.isArray(src[0]) ? src : [["", src]];
      return grouped.map(function (g) {
        return [g[0], (g[1] || []).map(function (it) { return typeof it === "string" ? { value: it, label: "" } : it; })];
      });
    }
    // Close when anything outside the menu scrolls (the anchor moves) or the window resizes. Attached
    // only while the menu is open so per-instance listeners never accumulate on window.
    function onOutsideScroll(e) { if (!menu.contains(e.target)) close(); }
    function onResize() { close(); }
    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      window.removeEventListener("scroll", onOutsideScroll, true);
      window.removeEventListener("resize", onResize);
    }
    function setActive(items, i) {
      items.forEach(function (o, n) {
        o.classList.toggle("isActive", n === i);
        o.setAttribute("aria-selected", String(n === i));
      });
      if (i >= 0 && items[i]) {
        input.setAttribute("aria-activedescendant", items[i].id);
        items[i].scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }
    function render() {
      const q = input.value.trim().toLowerCase();
      let html = "";
      let n = 0;
      groupsOf().forEach(function (g) {
        const hits = g[1].filter(function (o) {
          return !q || o.value.toLowerCase().indexOf(q) >= 0 || (o.label || "").toLowerCase().indexOf(q) >= 0;
        });
        if (!hits.length) return;
        if (g[0]) html += '<div class="smComboOptGroup" role="presentation">' + esc(g[0]) + "</div>";
        html += hits.map(function (o) {
          return '<button type="button" class="smComboOpt" role="option" id="' + menuId + "-" + (n++) + '" tabindex="-1" aria-selected="false" data-v="' + esc(o.value) + '">' + esc(o.label || o.value) + "</button>";
        }).join("");
      });
      if (!html) {
        const et = typeof opts.emptyText === "function" ? opts.emptyText() : opts.emptyText;
        if (et == null) { close(); return; }
        html = '<div class="smComboEmpty">' + esc(et) + "</div>";
      }
      // Fixed positioning at viewport coordinates — never clipped by a scrollable ancestor.
      const r = input.getBoundingClientRect();
      menu.style.top = r.bottom + 4 + "px";
      menu.style.left = r.left + "px";
      menu.style.width = r.width + "px";
      menu.innerHTML = html;
      input.removeAttribute("aria-activedescendant");
      if (menu.hidden) {
        menu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        window.addEventListener("scroll", onOutsideScroll, true);
        window.addEventListener("resize", onResize);
      }
    }
    function pick(value) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      close();
    }
    input.addEventListener("focus", render);
    input.addEventListener("input", render);
    input.addEventListener("blur", function () { close(); });
    // A click on the already-focused input fires no focus event — reopen the menu explicitly (the
    // native datalist reopens on click too; without this, Escape or a pick would be a mouse dead end).
    input.addEventListener("click", function () { if (menu.hidden) render(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!menu.hidden) { close(); e.stopPropagation(); }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (menu.hidden) render();
        const items = Array.from(menu.querySelectorAll(".smComboOpt"));
        if (!items.length) return;
        const cur = menu.querySelector(".smComboOpt.isActive");
        let i = cur ? items.indexOf(cur) + (e.key === "ArrowDown" ? 1 : -1) : e.key === "ArrowDown" ? 0 : items.length - 1;
        i = Math.max(0, Math.min(items.length - 1, i));
        setActive(items, i);
      } else if (e.key === "Enter" && !menu.hidden) {
        const active = menu.querySelector(".smComboOpt.isActive");
        if (active) { e.preventDefault(); pick(active.getAttribute("data-v")); }
        else close(); // fall through — the caller's own Enter/submit behavior applies to the typed text
      }
    });
    // mousedown (not click) so the pick lands before blur would close the menu.
    menu.addEventListener("mousedown", function (e) {
      const opt = e.target.closest && e.target.closest(".smComboOpt");
      if (!opt) { e.preventDefault(); return; }
      e.preventDefault();
      pick(opt.getAttribute("data-v"));
    });

    return {
      refresh: function () { if (!menu.hidden) render(); },
      close: close,
    };
  }

  // ── Favicon resolution ── sites keep their icon at different conventional paths (many have no
  // /favicon.ico at all — they declare an SVG/PNG via <link>). We can't read another origin's <link>
  // tags (CORS), so we probe the common paths in order and use the first that loads as an image.
  const FAVICON_PATHS = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/favicon.png"];
  function faviconCandidates(domain) {
    const d = String(domain || "").trim();
    return d ? FAVICON_PATHS.map((p) => "https://" + d + p) : [];
  }
  // Try each candidate until one loads; cb(url) with the winner, or cb(null) if none resolve.
  function probeFavicon(domain, cb) {
    const urls = faviconCandidates(domain);
    let i = 0;
    (function next() {
      if (i >= urls.length) { cb(null); return; }
      const url = urls[i++];
      const im = new Image();
      im.onload = () => (im.naturalWidth > 0 ? cb(url) : next());
      im.onerror = next;
      im.src = url;
    })();
  }

  window.SM = {
    ready: ready,
    icon: icon,
    avatar: avatar,
    esc: esc,
    openContact: openContact,
    modal: modal,
    confirm: confirmDialog,
    toast: toast,
    detailHeader: detailHeader,
    detailField: detailField,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    formatNumber: formatNumber,
    pagedTable: pagedTable,
    combobox: combobox,
    setFieldError: setFieldError,
    clearFieldError: clearFieldError,
    toolbar: toolbar,
    setBreadcrumbs: setBreadcrumbs,
    setActiveNav: setActiveNav,
    setTopBarAction: function (html) {
      const h = document.getElementById("sm-topbar-actions");
      if (h) h.innerHTML = html || "";
      return h;
    },
    copyText: function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      return new Promise((resolve, reject) => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error("copy failed"));
        } catch (e) { reject(e); }
      });
    },
    statusPill: function (label, variant) {
      return '<span class="statusPill is-' + esc(String(variant).toLowerCase()) + '">' + esc(label) + "</span>";
    },
    // ── Theme ── the profile page previews with applyThemeDom (DOM only) and, on Save, persists with
    // cacheTheme + a PUT to /users/current/settings. THEMES is the option list; normalizeTheme coerces
    // any stored/loaded value to one of them.
    THEMES: THEMES,
    normalizeTheme: normalizeTheme,
    applyThemeDom: applyThemeDom,
    cacheTheme: cacheTheme,
    // ── Copy-to-clipboard icon button ── render HTML with copyButton(value), then call
    // wireCopyButtons(container) once after inserting it. Shows a check + accent on success.
    copyButton: function (value, opts) {
      opts = opts || {};
      return (
        '<button type="button" class="copyIconBtn" data-copy="' + esc(String(value == null ? "" : value)) +
        '" title="' + esc(opts.title || "Copy") + '" aria-label="' + esc(opts.title || "Copy") + '">' +
        icon("copy", opts.size || 14) + "</button>"
      );
    },
    // ── Publisher icon ── a domain-initial monogram, or the domain's favicon layered over it (which
    // falls back to the monogram if it fails to load — wire with wirePublisherIcons after inserting).
    publisherIcon: function (domain, iconKind, size) {
      const sz = size || 28;
      const d = String(domain || "");
      const letter = (d.replace(/^www\./, "")[0] || "?").toUpperCase();
      let img = "";
      if (iconKind === "favicon" && d) {
        const urls = faviconCandidates(d);
        img = '<img class="pubIconImg" alt="" src="' + esc(urls[0]) + '" data-fallbacks="' + esc(urls.slice(1).join(" ")) + '" />';
      }
      return (
        '<span class="pubIcon" style="width:' + sz + "px;height:" + sz + "px;font-size:" + Math.round(sz * 0.45) + 'px;">' +
        '<span class="pubIconMono">' + esc(letter) + "</span>" + img + "</span>"
      );
    },
    faviconCandidates: faviconCandidates,
    probeFavicon: probeFavicon,
    wirePublisherIcons: function (container) {
      (container || document).querySelectorAll(".pubIconImg").forEach((img) => {
        if (img.__wired) return;
        img.__wired = true;
        // On failure, advance to the next candidate path; when they're exhausted, drop the <img> so the
        // monogram underneath shows through.
        img.addEventListener("error", () => {
          const rest = (img.getAttribute("data-fallbacks") || "").split(" ").filter(Boolean);
          if (rest.length) {
            img.setAttribute("data-fallbacks", rest.slice(1).join(" "));
            img.src = rest[0];
          } else {
            img.remove();
          }
        });
      });
    },
    wireCopyButtons: function (container) {
      const root = container || document;
      root.querySelectorAll(".copyIconBtn[data-copy]").forEach((btn) => {
        if (btn.__copyWired) return;
        btn.__copyWired = true;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const val = btn.getAttribute("data-copy") || "";
          const flash = () => {
            const prev = btn.innerHTML;
            btn.classList.add("isCopied");
            btn.innerHTML = icon("check", 14);
            setTimeout(() => { btn.innerHTML = prev; btn.classList.remove("isCopied"); }, 1400);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(val).then(flash, () => {});
          } else {
            try {
              const ta = document.createElement("textarea");
              ta.value = val; ta.style.position = "fixed"; ta.style.opacity = "0";
              document.body.appendChild(ta); ta.select();
              document.execCommand("copy"); document.body.removeChild(ta); flash();
            } catch (_e) { /* ignore */ }
          }
        });
      });
    },
  };

  // ── Boot ──
  renderTopBar();
  renderSidebar();
  syncTheme(); // reconcile the cached theme with the server (fire-and-forget)
  loadIdentity().then((id) => {
    renderIdentity(); // re-render with role-appropriate nav + user identity (from cache or fresh)
    resolveReady(id);
  }, (err) => { rejectReady(err); });
})();
