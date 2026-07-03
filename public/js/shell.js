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

  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    benchmarks: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
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
    { key: "dashboard", label: "Dashboard", href: "/account", icon: "dashboard", exact: true },
    { divider: true },
    { key: "benchmarks", label: "Benchmarks", href: "/account/benchmarks", icon: "benchmarks" },
    { key: "apikeys", label: "API Keys", href: "/account/api-keys", icon: "apikeys" },
  ];
  const ADMIN_NAV = [
    { divider: true },
    { key: "publishers", label: "Publishers", href: "/account/publishers", icon: "publishers" },
    { key: "members", label: "Members", href: "/account/users", icon: "members" },
    { key: "settings", label: "Settings", href: "/account/settings", icon: "settings" },
  ];

  // ── Avatar (Gravatar with initials fallback) ──
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
        img.src = "https://www.gravatar.com/avatar/" + hex + "?s=" + size * 2 + "&d=404";
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
      : '<div class="sidebarBrand"><a class="sidebarLogo" href="/account" aria-label="smplmark home"><picture>' +
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

  function renderTopBar() {
    const crumbs = (PAGE.breadcrumbs && PAGE.breadcrumbs.length) ? PAGE.breadcrumbs : [{ label: "Dashboard" }];
    let list = "";
    crumbs.forEach((c, i) => {
      const last = i === crumbs.length - 1;
      list += '<li class="breadcrumbItem">' +
        (i > 0 ? '<span class="breadcrumbSeparator">/</span>' : "") +
        (last || !c.href
          ? '<span' + (last ? ' class="breadcrumbCurrent"' : "") + ">" + esc(c.label) + "</span>"
          : '<a class="breadcrumbLink" href="' + c.href + '">' + esc(c.label) + "</a>") + "</li>";
    });
    header.innerHTML =
      '<nav class="breadcrumbs" aria-label="Breadcrumbs"><ol class="breadcrumbList">' + list + "</ol></nav>" +
      '<div class="topBarActions" id="sm-topbar-actions"></div>';
  }

  function setCollapsed(next, persist) {
    collapsed = next;
    if (persist) { try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch (_e) {} }
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

    fly.innerHTML =
      '<a class="flyoutItem" href="/account/profile">Profile</a>' +
      '<button class="flyoutItem" id="sm-contact" type="button">Contact Us</button>' +
      switcher +
      '<hr class="flyoutDivider" />' +
      '<button class="flyoutItem flyoutItemDanger" id="sm-signout" type="button">Sign out</button>';
    document.body.appendChild(fly);
    document.getElementById("sm-signout").addEventListener("click", signOut);
    document.getElementById("sm-contact").addEventListener("click", () => { closeUserFlyout(); openContact(); });
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
    clearToken();
    location.href = "/login";
  }

  async function switchAccount(accountId) {
    try {
      const doc = await authFetch("/api/v1/auth/switch", { account_id: accountId });
      if (doc && doc.token) { setToken(doc.token); location.href = "/account"; }
    } catch (err) {
      alert("Couldn't switch account: " + err.message);
    }
  }

  // ── Contact Us modal ──
  function openContact() {
    let overlay = document.getElementById("sm-contact-modal");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.id = "sm-contact-modal";
    overlay.innerHTML =
      '<div class="modalPanel" role="dialog" aria-modal="true">' +
      '<div class="modalHeader"><h2 class="modalTitle">Contact us</h2>' +
      '<p class="modalDescription">Send the smplmark team a message — we\'ll reply by email.</p></div>' +
      '<form class="form" id="sm-contact-form">' +
      '<label class="field"><span>Topic</span><select name="topic">' +
      '<option value="technical">Technical support</option>' +
      '<option value="account">Account question</option>' +
      '<option value="feature_request">Feature request</option>' +
      '<option value="other" selected>Other</option></select></label>' +
      '<label class="field"><span class="fieldRequired">Message</span>' +
      '<textarea name="body" rows="5" placeholder="How can we help?" required></textarea></label>' +
      '<p class="form-status" id="sm-contact-msg"></p>' +
      '<div class="modalActions">' +
      '<button type="button" class="button buttonSecondary buttonSmall" id="sm-contact-cancel">Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Send</button></div>' +
      "</form></div>";
    document.body.appendChild(overlay);
    overlay.style.display = "grid";
    const close = () => overlay.remove();
    document.getElementById("sm-contact-cancel").addEventListener("click", close);
    overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
    const form = document.getElementById("sm-contact-form");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msgEl = document.getElementById("sm-contact-msg");
      msgEl.textContent = "";
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await apiFetch("/api/v1/emails", {
          method: "POST",
          body: jsonapiBody("email", { topic: form.topic.value, body: form.body.value.trim() }),
        });
        overlay.querySelector(".modalPanel").innerHTML =
          '<div class="modalHeader"><h2 class="modalTitle">Message sent</h2>' +
          '<p class="modalDescription">Thanks — we\'ve emailed you a copy and will be in touch soon.</p></div>' +
          '<div class="modalActions"><button type="button" class="button buttonPrimary buttonSmall" id="sm-contact-done">Close</button></div>';
        document.getElementById("sm-contact-done").addEventListener("click", close);
      } catch (err) {
        msgEl.textContent = err.message;
        msgEl.className = "form-status is-error";
        submit.disabled = false;
      }
    });
    setTimeout(() => { const t = form.querySelector("textarea"); if (t) t.focus(); }, 0);
  }

  // ── Identity ──
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  async function loadIdentity() {
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
    IDENTITY = {
      account, user, accountId, token, role, memberships,
      canWrite: role === "OWNER" || role === "ADMIN" || role === "MEMBER",
      canAdmin: role === "OWNER" || role === "ADMIN",
      isOwner: role === "OWNER",
    };
    CAN_ADMIN = IDENTITY.canAdmin;
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

  window.SM = {
    ready: ready,
    icon: icon,
    avatar: avatar,
    esc: esc,
    openContact: openContact,
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
  };

  // ── Boot ──
  renderTopBar();
  renderSidebar();
  loadIdentity().then((id) => {
    renderSidebar(); // re-render with role-appropriate nav + user identity
    resolveReady(id);
  }, (err) => { rejectReady(err); });
})();
