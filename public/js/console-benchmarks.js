"use strict";

// Benchmarks (/account/benchmarks) — list, create, publish/withdraw/delete, and
// the inline manage panel (targets + runs). Depends on api.js + shell.js.

(function () {
  let ACCOUNT_ID = null;
  let CAN_WRITE = true;
  let CAN_ADMIN = false;
  let USER_ID = null;
  let ALLOW_PERSONAL = false;
  const esc = SM.esc;

  function $(id) { return document.getElementById(id); }
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    // Toggle the status modifier without clobbering marker classes (e.g. run-msg), which are used to
    // re-locate per-target/per-run message elements after a render.
    el.classList.remove("is-error", "is-success");
    if (text) el.classList.add("is-" + (kind || "error"));
  }
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, "\\$&");
  }

  // Top-bar primary action (writers only; wired after identity resolves).
  function wireTopBar() {
    if (!CAN_WRITE) return;
    SM.setTopBarAction(
      '<button type="button" class="button buttonPrimary buttonTopBar" id="new-benchmark">' +
      SM.icon("plus", 16) + " New benchmark</button>",
    );
    $("new-benchmark").addEventListener("click", openCreateModal);
  }

  // ── Create modal ──
  const modal = $("create-modal");
  function openCreateModal() {
    setMsg($("create-benchmark-msg"), "");
    $("create-benchmark-form").reset();
    modal.style.display = "grid";
    const first = modal.querySelector('input[name="key"]');
    if (first) first.focus();
  }
  function closeCreateModal() { modal.style.display = "none"; }
  $("create-cancel").addEventListener("click", closeCreateModal);
  modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) closeCreateModal(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && modal.style.display !== "none") closeCreateModal(); });

  $("create-benchmark-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    setMsg($("create-benchmark-msg"), "");
    const attrs = { key: form.key.value.trim(), name: form.name.value.trim() };
    const desc = form.description.value.trim();
    if (desc) attrs.description = desc;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await apiFetch("/api/v1/benchmarks", { method: "POST", body: jsonapiBody("benchmark", attrs) });
      closeCreateModal();
      await loadBenchmarks();
    } catch (err) {
      setMsg($("create-benchmark-msg"), err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  // ── Boot ──
  SM.ready.then((id) => {
    ACCOUNT_ID = id.accountId;
    CAN_WRITE = id.canWrite;
    CAN_ADMIN = id.canAdmin;
    USER_ID = (id.user && id.user.id) || null;
    ALLOW_PERSONAL = !!(id.account && id.account.attributes && id.account.attributes.allow_personal_publish);
    wireTopBar();
    loadBenchmarks();
  }).catch(() => {
    $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>';
  });

  // ── Benchmarks list ──
  async function loadBenchmarks() {
    const body = $("benchmarks-body");
    setMsg($("benchmarks-msg"), "");
    try {
      const doc = await apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent(ACCOUNT_ID));
      const list = (doc && doc.data) || [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="4" class="dataTableEmpty">No benchmarks yet. Use “New benchmark” to create one.</td></tr>';
        return;
      }
      body.innerHTML = list.map(benchmarkRow).join("");
      wireRowActions(list);
    } catch (err) {
      body.innerHTML = '<tr><td colspan="4" class="dataTableEmpty">Failed to load.</td></tr>';
      setMsg($("benchmarks-msg"), err.message, "error");
    }
  }

  function benchmarkRow(b) {
    const a = b.attributes || {};
    const status = String(a.status || "").toUpperCase();
    const id = esc(b.id);
    // A private benchmark is either still a draft or marked ready to publish (draft=false).
    const isReady = status === "PRIVATE" && a.draft === false;
    let actions = "";
    if (!CAN_WRITE) {
      // Viewers can open published benchmarks but not manage anything.
      actions = status === "PRIVATE" ? "" : viewLink(a.key);
    } else if (status === "PRIVATE") {
      if (isReady) {
        actions =
          btn("Publish…", "act-publish", id, "primary") +
          btn("Return to draft", "act-undraft", id) +
          btn("Manage", "act-manage", id) +
          btn("Delete", "act-delete", id, "danger");
      } else {
        actions =
          btn("Mark ready", "act-markready", id) +
          btn("Manage", "act-manage", id) +
          btn("Delete", "act-delete", id, "danger");
      }
    } else if (status === "PUBLISHED") {
      actions = viewLink(a.key) + btn("Manage", "act-manage", id) + btn("Withdraw", "act-withdraw", id, "danger");
    } else {
      actions = viewLink(a.key) + btn("Manage", "act-manage", id);
    }
    return (
      '<tr data-id="' + id + '">' +
      "<td><code>" + esc(a.key || "") + "</code></td>" +
      "<td>" + esc(a.name || "") + "</td>" +
      "<td>" + statusCell(a, status, isReady) + "</td>" +
      '<td class="actions">' + actions + "</td>" +
      "</tr>"
    );
  }
  // Status column: the lifecycle pill, plus draft/ready sub-state for private benchmarks and the
  // frozen attribution for published ones.
  function statusCell(a, status, isReady) {
    let html = SM.statusPill(status, status);
    if (status === "PRIVATE") {
      html += " " + (isReady ? SM.statusPill("ready", "ready") : SM.statusPill("draft", "draft"));
    } else if (a.published_as) {
      const pa = a.published_as;
      const who = pa.kind === "ORGANIZATION" ? (pa.name || "") : (pa.display_name || "you");
      html += ' <span class="muted attributionLabel">as ' + esc(who) + "</span>";
    }
    return html;
  }
  function viewLink(key) {
    return '<a class="button buttonSecondary buttonSmall" href="/benchmarks/' + encodeURIComponent(key || "") + '">View</a>';
  }
  function btn(label, cls, id, extra) {
    const kind = extra === "danger" ? "buttonDanger" : extra === "primary" ? "buttonPrimary" : "buttonSecondary";
    return '<button type="button" class="button ' + kind + ' buttonSmall ' + cls + '" data-id="' + esc(id) + '">' + esc(label) + "</button>";
  }

  function wireRowActions(list) {
    const byId = {};
    list.forEach((b) => { byId[b.id] = b; });
    const body = $("benchmarks-body");
    body.querySelectorAll(".act-markready").forEach((el) => el.addEventListener("click", () => doMarkReady(el.dataset.id)));
    body.querySelectorAll(".act-undraft").forEach((el) => el.addEventListener("click", () => doReturnToDraft(el.dataset.id)));
    body.querySelectorAll(".act-publish").forEach((el) => el.addEventListener("click", () => openPublishModal(byId[el.dataset.id])));
    body.querySelectorAll(".act-withdraw").forEach((el) => el.addEventListener("click", () => doWithdraw(el.dataset.id)));
    body.querySelectorAll(".act-delete").forEach((el) => el.addEventListener("click", () => doDelete(el.dataset.id)));
    body.querySelectorAll(".act-manage").forEach((el) => el.addEventListener("click", () => openManage(byId[el.dataset.id])));
  }

  // ── Draft workflow ──
  async function doMarkReady(id) {
    setMsg($("benchmarks-msg"), "");
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(id) + "/actions/mark_ready", { method: "POST" });
      await loadBenchmarks();
    } catch (err) { setMsg($("benchmarks-msg"), err.message, "error"); }
  }

  async function doReturnToDraft(id) {
    const reason = window.prompt("Return to draft — optional note (why it's going back):", "");
    if (reason === null) return; // cancelled
    setMsg($("benchmarks-msg"), "");
    const body = reason.trim() ? jsonapiBody("benchmark", { reason: reason.trim() }) : undefined;
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(id) + "/actions/return_to_draft", { method: "POST", body });
      await loadBenchmarks();
    } catch (err) { setMsg($("benchmarks-msg"), err.message, "error"); }
  }

  // ── Publish attribution modal ──
  // Fetch the account's organization identities and their VERIFIED domains (admins only — org
  // publishing is admin-gated). An identity is publishable only when it has ≥1 verified domain.
  async function loadOrgIdentities() {
    const [identsDoc, domainsDoc] = await Promise.all([
      apiFetch("/api/v1/publisher_identities"),
      apiFetch("/api/v1/publisher_domains?filter[status]=VERIFIED"),
    ]);
    const idents = (identsDoc && identsDoc.data) || [];
    const verifiedByIdentity = {};
    ((domainsDoc && domainsDoc.data) || []).forEach((d) => {
      const pid = d.attributes.publisher_identity;
      (verifiedByIdentity[pid] = verifiedByIdentity[pid] || []).push(d.attributes.domain);
    });
    return idents.map((i) => ({ id: i.id, name: i.attributes.name, domains: verifiedByIdentity[i.id] || [] }));
  }

  function optionRow(value, title, enabled, detail) {
    return (
      '<label class="publishOption' + (enabled ? "" : " isDisabled") + '">' +
      '<input type="radio" name="attribution" value="' + esc(value) + '"' + (enabled ? "" : " disabled") + " />" +
      '<span class="publishOptionBody"><span class="publishOptionTitle">' + esc(title) + "</span>" +
      (detail ? '<span class="publishOptionDetail">' + esc(detail) + "</span>" : "") +
      "</span></label>"
    );
  }

  function openPublishModal(b) {
    if (!b) return;
    const a = b.attributes || {};
    const existing = $("publish-modal");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.id = "publish-modal";
    overlay.innerHTML =
      '<div class="modalPanel" role="dialog" aria-modal="true" aria-labelledby="publish-title">' +
      '<div class="modalHeader"><h2 class="modalTitle" id="publish-title">Publish “' + esc(a.name || a.key || "") + '”</h2>' +
      '<p class="modalDescription">Publishing is a one-way step and freezes this benchmark\'s interpretation. Choose how it\'s attributed.</p></div>' +
      '<form class="form" id="publish-form">' +
      '<div id="publish-options"><p class="muted">Loading publishing options…</p></div>' +
      '<p id="publish-msg" class="form-status"></p>' +
      '<div class="modalActions">' +
      '<button type="button" class="button buttonSecondary buttonSmall" id="publish-cancel">Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall" id="publish-submit" disabled>Publish</button>' +
      "</div></form></div>";
    document.body.appendChild(overlay);
    overlay.style.display = "grid";

    const close = () => overlay.remove();
    $("publish-cancel").addEventListener("click", close);
    overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
    const onEsc = (ev) => { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
    document.addEventListener("keydown", onEsc);
    $("publish-form").addEventListener("submit", (ev) => { ev.preventDefault(); submitPublish(b, overlay); });

    buildPublishOptions(b);
  }

  async function buildPublishOptions(b) {
    const a = b.attributes || {};
    const host = $("publish-options");
    const submit = $("publish-submit");
    const isAuthor = !!(USER_ID && a.created_by === USER_ID);
    const personalAvailable = ALLOW_PERSONAL && isAuthor;

    // Personal option — always shown so the reason it's unavailable is visible.
    let personalDetail = "Attributed to you.";
    if (!ALLOW_PERSONAL) personalDetail = "Personal publishing is off for this account (enable it in Settings).";
    else if (!isAuthor) personalDetail = "Only the benchmark's author can publish it personally.";
    let rows = [optionRow("personal", "Publish personally", personalAvailable, personalDetail)];

    // Organization options — admins only.
    if (CAN_ADMIN) {
      let orgs = null;
      try {
        orgs = await loadOrgIdentities();
      } catch (err) {
        host.innerHTML = rows.join("") + '<p class="form-status is-error" style="margin-top:0.4rem;">Couldn\'t load organization identities: ' + esc(err.message) + "</p>";
        wireOptions(host, submit);
        return;
      }
      if (orgs.length) {
        orgs.forEach((o) => {
          const ok = o.domains.length > 0;
          rows.push(optionRow("org:" + o.id, o.name, ok, ok ? "Verified: " + o.domains.join(", ") : "No verified domain — verify one under Publishers first."));
        });
      } else {
        rows.push('<p class="muted" style="margin:0.5rem 0 0;">No organization identities yet. <a href="/account/publishers">Create one</a> to publish under a brand.</p>');
      }
    }
    host.innerHTML = rows.join("");
    wireOptions(host, submit);
  }

  function wireOptions(host, submit) {
    host.querySelectorAll('input[name="attribution"]').forEach((r) =>
      r.addEventListener("change", () => { submit.disabled = false; }),
    );
  }

  async function submitPublish(b, overlay) {
    const sel = overlay.querySelector('input[name="attribution"]:checked');
    if (!sel) return;
    const msg = $("publish-msg");
    setMsg(msg, "");
    const submit = $("publish-submit");
    submit.disabled = true;
    // Personal → empty body; organization → { publisher_identity: <id> }.
    let body;
    if (sel.value !== "personal") {
      body = jsonapiBody("benchmark", { publisher_identity: sel.value.slice(4) });
    }
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(b.id) + "/actions/publish", { method: "POST", body });
      overlay.remove();
      await loadBenchmarks();
    } catch (err) {
      setMsg(msg, err.message, "error");
      submit.disabled = false;
    }
  }

  async function doWithdraw(id) {
    const reason = window.prompt("Reason for withdrawal (required):", "");
    if (reason === null) return;
    if (!reason.trim()) { setMsg($("benchmarks-msg"), "A withdrawal reason is required.", "error"); return; }
    setMsg($("benchmarks-msg"), "");
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(id) + "/actions/withdraw", {
        method: "POST", body: jsonapiBody("benchmark", { withdrawal_reason: reason.trim() }),
      });
      await loadBenchmarks();
    } catch (err) { setMsg($("benchmarks-msg"), err.message, "error"); }
  }

  async function doDelete(id) {
    if (!window.confirm("Delete this benchmark? This cannot be undone.")) return;
    setMsg($("benchmarks-msg"), "");
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(id), { method: "DELETE" });
      const mp = $("manage-panel");
      if (mp && mp.dataset.id === id) { mp.innerHTML = ""; mp.removeAttribute("data-id"); }
      await loadBenchmarks();
    } catch (err) { setMsg($("benchmarks-msg"), err.message, "error"); }
  }

  // The benchmark's actor fields resolve to "you" for the signed-in user, "an API key" when a key
  // created it (created_by is null), and "another member" otherwise (we don't expose other users' names).
  function whoLabel(uid) {
    if (!uid) return "an API key";
    if (USER_ID && uid === USER_ID) return "you";
    return "another member";
  }

  // ── Manage panel: targets + runs ──
  function openManage(b) {
    if (!b) return;
    const a = b.attributes || {};
    const mp = $("manage-panel");
    mp.dataset.id = b.id;
    let meta = "Created by " + whoLabel(a.created_by);
    if (a.published_by) {
      const pa = a.published_as;
      const as = pa ? (pa.kind === "ORGANIZATION" ? " as " + (pa.name || "") : " personally") : "";
      meta += " · Published by " + whoLabel(a.published_by) + as;
    }
    mp.innerHTML =
      '<div class="panel">' +
      '<div class="sectionHead"><h2>Manage: ' + esc(a.name || a.key || "") + "</h2>" +
      '<button type="button" class="button buttonSecondary buttonSmall" id="manage-close">Close</button></div>' +
      '<p class="muted manageMeta">' + esc(meta) + "</p>" +
      '<div class="manageBody">' +
      '<p class="miniLabel">Targets</p>' +
      '<div id="targets-host"></div>' +
      '<form id="create-target-form" class="inlineForm" style="margin-top:0.9rem;">' +
      '<label class="field"><span class="fieldRequired">Key</span><input name="key" type="text" placeholder="target-key" required /></label>' +
      '<label class="field"><span class="fieldRequired">Name</span><input name="name" type="text" placeholder="Target name" required /></label>' +
      '<label class="field"><span>Details</span><input name="details" type="text" placeholder="optional" /></label>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add target</button>' +
      "</form>" +
      '<div id="create-target-msg" class="form-status"></div>' +
      "</div></div>";

    $("manage-close").addEventListener("click", () => { mp.innerHTML = ""; mp.removeAttribute("data-id"); });

    $("create-target-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      setMsg($("create-target-msg"), "");
      const f = ev.target;
      const attrs = { benchmark: b.id, key: f.key.value.trim(), name: f.name.value.trim() };
      const d = f.details.value.trim();
      if (d) attrs.details = d;
      try {
        await apiFetch("/api/v1/targets", { method: "POST", body: jsonapiBody("target", attrs) });
        f.reset();
        await loadTargets(b.id);
      } catch (err) { setMsg($("create-target-msg"), err.message, "error"); }
    });

    mp.scrollIntoView({ behavior: "smooth", block: "nearest" });
    loadTargets(b.id);
  }

  async function loadTargets(benchmarkId) {
    const host = $("targets-host");
    if (!host) return;
    host.innerHTML = '<div class="muted">Loading targets…</div>';
    try {
      const doc = await apiFetch("/api/v1/targets?filter[benchmark]=" + encodeURIComponent(benchmarkId));
      const list = (doc && doc.data) || [];
      if (!list.length) { host.innerHTML = '<div class="muted">No targets yet.</div>'; return; }
      host.innerHTML = list.map((t) => {
        const a = t.attributes || {};
        const id = esc(t.id);
        return (
          '<div class="subPanel" style="margin-bottom:0.75rem;" data-target="' + id + '">' +
          '<div class="sectionHead" style="margin-bottom:0.5rem;">' +
          "<div><code>" + esc(a.key || "") + '</code> <span class="muted">' + esc(a.name || "") + "</span></div>" +
          '<button type="button" class="button buttonDanger buttonSmall del-target" data-id="' + id + '">Delete</button>' +
          "</div>" +
          '<div class="runsBlock">' +
          '<p class="miniLabel">Runs</p>' +
          '<div class="runs-host" data-target="' + id + '"></div>' +
          '<form class="inlineForm create-run-form" data-target="' + id + '" style="margin-top:0.6rem;">' +
          '<label class="field"><span class="fieldRequired">Key</span><input name="key" type="text" placeholder="run-key" required /></label>' +
          '<label class="field"><span>Started at</span><input name="started_at" type="text" placeholder="2026-01-01T00:00:00Z" /></label>' +
          '<button type="submit" class="button buttonPrimary buttonSmall">Add run</button>' +
          "</form>" +
          '<div class="form-status run-msg" data-target="' + id + '"></div>' +
          "</div></div>"
        );
      }).join("");

      host.querySelectorAll(".del-target").forEach((el) => el.addEventListener("click", () => deleteTarget(el.dataset.id, benchmarkId)));
      host.querySelectorAll(".create-run-form").forEach((form) => form.addEventListener("submit", (ev) => createRun(ev, form.dataset.target)));
      list.forEach((t) => loadRuns(t.id));
    } catch (err) {
      host.innerHTML = '<div class="form-status is-error">' + esc(err.message) + "</div>";
    }
  }

  async function deleteTarget(targetId, benchmarkId) {
    if (!window.confirm("Delete this target and its runs?")) return;
    try {
      await apiFetch("/api/v1/targets/" + encodeURIComponent(targetId), { method: "DELETE" });
      await loadTargets(benchmarkId);
    } catch (err) { setMsg($("create-target-msg"), err.message, "error"); }
  }

  async function createRun(ev, targetId) {
    ev.preventDefault();
    const form = ev.target;
    const msg = document.querySelector('.run-msg[data-target="' + cssEsc(targetId) + '"]');
    setMsg(msg, "");
    const attrs = { target: targetId, key: form.key.value.trim() };
    const startedAt = form.started_at.value.trim();
    if (startedAt) attrs.started_at = startedAt;
    try {
      await apiFetch("/api/v1/runs", { method: "POST", body: jsonapiBody("run", attrs) });
      form.reset();
      await loadRuns(targetId);
    } catch (err) { setMsg(msg, err.message, "error"); }
  }

  async function loadRuns(targetId) {
    const host = document.querySelector('.runs-host[data-target="' + cssEsc(targetId) + '"]');
    if (!host) return;
    host.innerHTML = '<div class="muted">Loading runs…</div>';
    try {
      const doc = await apiFetch("/api/v1/runs?filter[target]=" + encodeURIComponent(targetId));
      const list = (doc && doc.data) || [];
      if (!list.length) { host.innerHTML = '<div class="muted">No runs yet.</div>'; return; }
      host.innerHTML =
        '<table class="dataTable"><tbody>' +
        list.map((r) => {
          const a = r.attributes || {};
          const id = esc(r.id);
          const invalidated = a.invalidated || a.invalidated_at || a.invalidation_reason;
          const ended = a.ended_at || a.live === false;
          let state;
          if (invalidated) state = SM.statusPill("invalidated", "invalidated");
          else if (ended) state = SM.statusPill("ended", "ended");
          else state = SM.statusPill("live", "live");
          let acts = "";
          if (!ended && !invalidated) acts += '<button type="button" class="button buttonSecondary buttonSmall run-end" data-id="' + id + '" data-target="' + esc(targetId) + '">End</button>';
          if (!invalidated) acts += '<button type="button" class="button buttonDanger buttonSmall run-invalidate" data-id="' + id + '" data-target="' + esc(targetId) + '">Invalidate</button>';
          return "<tr><td><code>" + esc(a.key || "") + "</code></td><td>" + state + '</td><td class="actions">' + acts + "</td></tr>";
        }).join("") +
        "</tbody></table>";
      host.querySelectorAll(".run-end").forEach((el) => el.addEventListener("click", () => endRun(el.dataset.id, el.dataset.target)));
      host.querySelectorAll(".run-invalidate").forEach((el) => el.addEventListener("click", () => invalidateRun(el.dataset.id, el.dataset.target)));
    } catch (err) {
      host.innerHTML = '<div class="form-status is-error">' + esc(err.message) + "</div>";
    }
  }

  async function endRun(runId, targetId) {
    const msg = document.querySelector('.run-msg[data-target="' + cssEsc(targetId) + '"]');
    setMsg(msg, "");
    try {
      await apiFetch("/api/v1/runs/" + encodeURIComponent(runId) + "/actions/end", { method: "POST" });
      await loadRuns(targetId);
    } catch (err) { setMsg(msg, err.message, "error"); }
  }

  async function invalidateRun(runId, targetId) {
    const reason = window.prompt("Invalidation reason (optional):", "");
    if (reason === null) return;
    const msg = document.querySelector('.run-msg[data-target="' + cssEsc(targetId) + '"]');
    setMsg(msg, "");
    const attrs = {};
    if (reason.trim()) attrs.invalidation_reason = reason.trim();
    try {
      await apiFetch("/api/v1/runs/" + encodeURIComponent(runId) + "/actions/invalidate", { method: "POST", body: jsonapiBody("run", attrs) });
      await loadRuns(targetId);
    } catch (err) { setMsg(msg, err.message, "error"); }
  }
})();
