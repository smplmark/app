"use strict";

// Dashboard (/account) — overview stats, quick actions, recent benchmarks.
// Depends on api.js + shell.js (SM.ready / SM.esc / SM.statusPill).

(function () {
  function $(id) { return document.getElementById(id); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  SM.ready.then(async (id) => {
    const attrs = (id.user && id.user.attributes) || {};
    const acct = (id.account && id.account.attributes) || {};
    const displayName = attrs.display_name || (attrs.email ? attrs.email.split("@")[0] : "there");
    $("dash-greeting").textContent = "Welcome, " + displayName;
    if (acct.name) $("dash-sub").textContent = acct.name + (acct.key ? "  ·  @" + acct.key : "");

    if (attrs.verified === false) {
      $("verify-banner").style.display = "flex";
      const btn = $("resend-verification");
      btn.addEventListener("click", async () => {
        setMsg($("verify-msg"), "");
        btn.disabled = true;
        try {
          await authFetch("/api/v1/auth/resend-verification", undefined, { method: "POST" });
          setMsg($("verify-msg"), "Verification email sent.", "success");
        } catch (err) {
          setMsg($("verify-msg"), err.message, "error");
        } finally {
          btn.disabled = false;
        }
      });
    }

    await Promise.all([loadBenchmarks(id.accountId), loadKeys()]);
  }).catch((err) => {
    $("recent-body").innerHTML = '<tr><td colspan="4" class="dataTableEmpty">Failed to load your account.</td></tr>';
  });

  async function loadBenchmarks(accountId) {
    try {
      const doc = await apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent(accountId));
      const list = (doc && doc.data) || [];
      const published = list.filter((b) => String((b.attributes || {}).status).toUpperCase() === "PUBLISHED").length;
      $("stat-benchmarks").textContent = String(list.length);
      $("stat-published").textContent = String(published);
      renderRecent(list);
    } catch (err) {
      $("stat-benchmarks").textContent = "—";
      $("recent-body").innerHTML = '<tr><td colspan="4" class="dataTableEmpty">Failed to load benchmarks.</td></tr>';
    }
  }

  async function loadKeys() {
    try {
      const doc = await apiFetch("/api/v1/api_keys");
      const list = (doc && doc.data) || [];
      const active = list.filter((k) => !(k.attributes || {}).revoked).length;
      $("stat-keys").textContent = String(active);
    } catch (err) {
      $("stat-keys").textContent = "—";
    }
  }

  function renderRecent(list) {
    const body = $("recent-body");
    if (!list.length) {
      body.innerHTML =
        '<tr><td colspan="4" class="dataTableEmpty">No benchmarks yet. ' +
        '<a class="buttonLink" href="/account/benchmarks">Create your first one.</a></td></tr>';
      return;
    }
    const rows = list
      .slice()
      .sort((a, b) => new Date((b.attributes || {}).created_at || 0) - new Date((a.attributes || {}).created_at || 0))
      .slice(0, 5);
    body.innerHTML = rows.map((b) => {
      const a = b.attributes || {};
      const status = String(a.status || "").toUpperCase();
      const view = status === "PRIVATE"
        ? '<a class="buttonLink" href="/account/benchmarks">Manage</a>'
        : '<a class="buttonLink" href="/benchmarks/' + encodeURIComponent(a.key || "") + '">View</a>';
      return (
        "<tr>" +
        '<td><code>' + SM.esc(a.key || "") + "</code></td>" +
        "<td>" + SM.esc(a.name || "") + "</td>" +
        "<td>" + SM.statusPill(status, status) + "</td>" +
        '<td class="actions">' + view + "</td>" +
        "</tr>"
      );
    }).join("");
  }
})();
