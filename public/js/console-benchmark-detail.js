"use strict";

// Benchmark detail (/account/benchmarks/detail?id=…) — a conforming detail page: DetailHeader with
// the lifecycle actions, Details (view/edit 2-column form), Targets, and Runs tabs. Runs and targets
// are both benchmark children now. Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  const ID = new URLSearchParams(location.search).get("id") || "";
  let BM = null;
  let CAN_WRITE = false, CAN_ADMIN = false, USER_ID = null, ALLOW_PERSONAL = false;

  // Edit-mode state for the Details tab.
  let editing = false;
  let form = { name: "", description: "", about: "", methodology: "" };

  const TABS = ["details", "targets", "runs"];
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }

  function fmtDate(v) {
    if (!v) return "";
    const d = typeof v === "number" ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function whoLabel(uid) {
    if (!uid) return "an API key";
    if (USER_ID && uid === USER_ID) return "you";
    return "another member";
  }
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, "\\$&");
  }

  // ── Boot ──
  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    CAN_ADMIN = id.canAdmin;
    USER_ID = (id.user && id.user.id) || null;
    ALLOW_PERSONAL = !!(id.account && id.account.attributes && id.account.attributes.allow_personal_publish);
    loadBenchmark();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) {
    $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>";
  }

  async function loadBenchmark() {
    if (!ID) { fail("No benchmark id."); return; }
    try {
      const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID));
      BM = (doc && doc.data) || null;
      if (!BM) { fail("Benchmark not found."); return; }
      render();
    } catch (err) {
      fail(err.message || "Failed to load benchmark.");
    }
  }

  // Reload the benchmark then re-render (after a lifecycle action).
  async function refresh() {
    const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID));
    BM = (doc && doc.data) || BM;
    render();
  }

  // ── Status decorations (lifecycle pill + draft/ready + closed + attribution) ──
  function statusInfo() {
    const a = BM.attributes || {};
    const status = String(a.status || "").toUpperCase();
    const isReady = status === "PRIVATE" && a.draft === false;
    return { a, status, isReady };
  }
  function decorations() {
    const { a, status, isReady } = statusInfo();
    let html = SM.statusPill(status, status);
    if (a.closed) html += " " + SM.statusPill("complete", "complete");
    if (status === "PRIVATE") html += " " + (isReady ? SM.statusPill("ready", "ready") : SM.statusPill("draft", "draft"));
    return html;
  }

  // ── Header lifecycle actions (by status) ──
  function headerActions() {
    if (!CAN_WRITE) {
      const { a, status } = statusInfo();
      return status === "PRIVATE" ? "" : viewLink(a.key);
    }
    const { a, status, isReady } = statusInfo();
    const b = (label, act, kind) =>
      '<button type="button" class="button button' + (kind || "Secondary") + ' buttonSmall" data-act="' + act + '">' + esc(label) + "</button>";
    if (status === "PRIVATE") {
      return isReady
        ? b("Publish…", "publish", "Primary") + b("Return to draft", "undraft")
        : b("Mark ready", "markready", "Primary");
    }
    if (status === "PUBLISHED") {
      return viewLink(a.key) + (a.closed ? b("Reopen", "reopen") : b("Close", "close")) + b("Withdraw", "withdraw", "Danger");
    }
    return viewLink(a.key);
  }
  function viewLink(key) {
    return '<a class="button buttonSecondary buttonSmall" href="/benchmarks/' + encodeURIComponent(key || "") + '" target="_blank" rel="noopener">View</a>';
  }

  // ── Render ──
  function render() {
    const a = BM.attributes || {};
    const tab = activeTab();
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || a.key || "Benchmark", decorations: decorations(), secondaryId: a.key || "", actions: headerActions() }) +
      '<div class="detailsTabHeader">' +
      '<nav class="modalTabBar" role="tablist">' + tabBtn("details", "Details") + tabBtn("targets", "Targets") + tabBtn("runs", "Runs") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div>' +
      "</div>" +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    // Breadcrumb current label
    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Benchmark";
    document.title = (a.name || "Benchmark") + " — smplmark";

    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => switchTab(el.dataset.tab)));
    $("detail-root").querySelectorAll(".detailHeaderActions [data-act]").forEach((el) =>
      el.addEventListener("click", () => lifecycle(el.dataset.act)));

    renderTab();
  }

  function switchTab(key) {
    if (key === activeTab()) return;
    if (editing && isDirty()) {
      SM.confirm({ title: "Discard changes?", message: "You have unsaved edits. Leave the Details tab and discard them?", confirmLabel: "Discard", cancelLabel: "Keep editing" })
        .then((ok) => { if (ok) { exitEdit(); location.hash = key; render(); } });
      return;
    }
    editing = false;
    location.hash = key;
    render();
  }
  window.addEventListener("hashchange", () => { if (activeTab() !== currentRenderedTab) render(); });
  let currentRenderedTab = "details";

  function renderTab() {
    currentRenderedTab = activeTab();
    const panel = $("tab-panel");
    const actions = $("tab-actions");
    actions.innerHTML = "";
    if (currentRenderedTab === "details") { renderDetails(panel, actions); }
    else if (currentRenderedTab === "targets") { renderTargets(panel); }
    else { renderRuns(panel); }
  }

  // ── Details tab (view / edit) ──
  function isDirty() {
    if (!editing || !BM) return false;
    const a = BM.attributes || {};
    return (
      form.name.trim() !== (a.name || "") ||
      form.description !== (a.description || "") ||
      form.about !== (a.about || "") ||
      form.methodology !== (a.methodology || "")
    );
  }
  function enterEdit() {
    const a = BM.attributes || {};
    editing = true;
    form = { name: a.name || "", description: a.description || "", about: a.about || "", methodology: a.methodology || "" };
    renderTab();
  }
  function exitEdit() { editing = false; window.removeEventListener("beforeunload", onBeforeUnload); }
  function onBeforeUnload(e) { if (editing && isDirty()) { e.preventDefault(); e.returnValue = ""; } }

  function renderDetails(panel, actions) {
    const a = BM.attributes || {};
    const canEdit = CAN_WRITE;
    const { status } = statusInfo();

    // Tab actions: [Edit] (+ Delete when private) — or [Cancel] [Save] in edit mode.
    if (canEdit) {
      actions.innerHTML = editing
        ? '<button type="button" class="button buttonSecondary buttonSmall" id="d-cancel">Cancel</button>' +
          '<button type="button" class="button buttonPrimary buttonSmall" id="d-save">Save</button>'
        : '<button type="button" class="button buttonSecondary buttonSmall" id="d-edit">Edit</button>' +
          (status === "PRIVATE" ? '<button type="button" class="button buttonDanger buttonSmall" id="d-delete">Delete</button>' : "");
    }

    const left = editing ? editFields() : viewFields(a);
    const right =
      SM.detailField("Created", { value: fmtDate(a.created_at) }) +
      SM.detailField("Updated", { value: fmtDate(a.updated_at) }) +
      '<div class="field"><span class="detailFieldLabel">Status</span><span>' + decorations() + "</span></div>" +
      SM.detailField("Created by", { value: whoLabel(a.created_by) }) +
      (a.published_by ? SM.detailField("Published by", { value: publishedByLabel(a) }) : "");

    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div>" +
      "</div></div>";

    if (canEdit && editing) {
      const p = panel;
      const bind = (name) => {
        const el = p.querySelector('[data-edit="' + name + '"]');
        if (el) el.addEventListener("input", () => { form[name] = el.value; SM.clearFieldError(el); });
      };
      ["name", "description", "about", "methodology"].forEach(bind);
      $("d-cancel").addEventListener("click", cancelEdit);
      $("d-save").addEventListener("click", saveDetails);
      window.addEventListener("beforeunload", onBeforeUnload);
      const nameEl = p.querySelector('[data-edit="name"]'); if (nameEl) nameEl.focus();
    } else if (canEdit) {
      $("d-edit").addEventListener("click", enterEdit);
      const del = $("d-delete"); if (del) del.addEventListener("click", () => lifecycle("delete"));
    }
  }

  function viewFields(a) {
    return (
      SM.detailField("Name", { value: a.name }) +
      SM.detailField("Description", { value: a.description, emptyText: "(none)" }) +
      SM.detailField("About", { value: a.about, multiline: true, emptyText: "(none)" }) +
      SM.detailField("Methodology", { value: a.methodology, multiline: true, emptyText: "(none)" })
    );
  }
  function editFields() {
    const f = (label, name, opts) => {
      opts = opts || {};
      const input = opts.textarea
        ? '<textarea data-edit="' + name + '" rows="' + (opts.rows || 4) + '">' + esc(form[name]) + "</textarea>"
        : '<input data-edit="' + name + '" type="text" value="' + esc(form[name]) + '" />';
      return '<div class="field"><span class="detailFieldLabel' + (opts.required ? " fieldRequired" : "") + '">' + esc(label) + "</span>" + input +
        '<p class="fieldErrorMessage" hidden></p></div>';
    };
    return (
      f("Name", "name", { required: true }) +
      f("Description", "description") +
      f("About", "about", { textarea: true, rows: 4 }) +
      f("Methodology", "methodology", { textarea: true, rows: 5 })
    );
  }

  function cancelEdit() {
    if (isDirty()) {
      SM.confirm({ title: "Discard changes?", message: "Discard your unsaved edits?", confirmLabel: "Discard", cancelLabel: "Keep editing" })
        .then((ok) => { if (ok) { exitEdit(); renderTab(); } });
      return;
    }
    exitEdit();
    renderTab();
  }

  async function saveDetails() {
    const panel = $("tab-panel");
    const nameEl = panel.querySelector('[data-edit="name"]');
    let ok = true;
    if (!form.name.trim()) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    if (!ok) { nameEl.focus(); return; }
    const a = BM.attributes || {};
    // get-mutate-put: round-trip the full representation, changing only the edited fields.
    const attrs = {
      key: a.key,
      name: form.name.trim(),
      description: form.description.trim() || null,
      about: form.about.trim() || null,
      methodology: form.methodology.trim() || null,
    };
    const save = $("d-save"); save.disabled = true;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("benchmark", attrs) });
      BM = (doc && doc.data) || BM;
      exitEdit();
      render();
    } catch (err) {
      save.disabled = false;
      setMsg(err.message, "error");
    }
  }

  function publishedByLabel(a) {
    const pa = a.published_as;
    let s = whoLabel(a.published_by);
    if (pa) {
      if (pa.kind === "ORGANIZATION") s += " as " + (pa.name || "");
      else if (pa.kind === "INGESTED") s += " from " + (pa.source_name || "an ingested source");
      else s += " personally";
    }
    return s;
  }

  function setMsg(text, kind) {
    const el = $("detail-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }

  // ── Targets tab (M:N: link an existing account target, or create one on the fly by name) ──
  let ACCT_TARGETS = []; // the account's targets, for the pick-or-create combobox

  function slugify(s) {
    const out = String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/, "");
    return out || "target";
  }

  async function renderTargets(panel) {
    panel.innerHTML =
      (CAN_WRITE ? targetLinkForm() : "") +
      '<div class="panel isFlush" style="margin-top:' + (CAN_WRITE ? "1rem" : "0") + ';"><div class="tableWrap">' +
      '<table class="dataTable"><thead><tr><th>Key</th><th>Name</th>' + (CAN_WRITE ? '<th class="actions"></th>' : "") + "</tr></thead>" +
      '<tbody id="targets-body"><tr><td colspan="3" class="dataTableEmpty">Loading…</td></tr></tbody></table></div></div>' +
      '<datalist id="acct-targets"></datalist>';
    try {
      const [linkedDoc, linksDoc] = await Promise.all([
        apiFetch("/api/v1/targets?filter[benchmark]=" + encodeURIComponent(ID)),
        apiFetch("/api/v1/benchmark_targets?filter[benchmark]=" + encodeURIComponent(ID)),
      ]);
      const linked = (linkedDoc && linkedDoc.data) || [];
      const linkIdByTarget = {};
      ((linksDoc && linksDoc.data) || []).forEach((l) => { linkIdByTarget[(l.attributes || {}).target] = l.id; });
      if (CAN_WRITE) { await loadAcctTargets(linked); wireTargetLinkForm(); }
      const body = $("targets-body");
      if (!linked.length) { body.innerHTML = '<tr><td colspan="3" class="dataTableEmpty">No targets linked yet.</td></tr>'; return; }
      body.innerHTML = linked.map((t) => {
        const a = t.attributes || {};
        const lid = linkIdByTarget[t.id] || "";
        return "<tr><td><code>" + esc(a.key || "") + "</code></td><td>" + esc(a.name || "") + "</td>" +
          (CAN_WRITE ? '<td class="actions"><button type="button" class="button buttonDanger buttonSmall unlink-target" data-link="' + esc(lid) + '" data-name="' + esc(a.name || a.key || "") + '">Unlink</button></td>' : "") + "</tr>";
      }).join("");
      body.querySelectorAll(".unlink-target").forEach((el) => el.addEventListener("click", () => unlinkTarget(el.dataset.link, el.dataset.name)));
    } catch (err) {
      $("targets-body").innerHTML = '<tr><td colspan="3" class="dataTableEmpty">' + esc(err.message) + "</td></tr>";
    }
  }

  // Fetch the account's targets and offer the not-yet-linked ones as combobox suggestions.
  async function loadAcctTargets(linked) {
    try {
      const doc = await apiFetch("/api/v1/targets");
      ACCT_TARGETS = (doc && doc.data) || [];
    } catch (_e) { ACCT_TARGETS = []; }
    const linkedIds = new Set((linked || []).map((t) => t.id));
    const dl = $("acct-targets");
    if (dl) {
      // The option VALUE is the unique key (what lands in the input on pick), so two same-named
      // targets can't resolve to the wrong one; the label shows "name — key" for readability.
      dl.innerHTML = ACCT_TARGETS
        .filter((t) => !linkedIds.has(t.id))
        .map((t) => {
          const a = t.attributes || {};
          const label = (a.name || "") + (a.key ? " — " + a.key : "");
          return '<option value="' + esc(a.key || "") + '">' + esc(label) + "</option>";
        })
        .join("");
    }
  }

  function targetLinkForm() {
    return '<form id="target-form" class="inlineForm">' +
      '<label class="field" style="min-width:340px;"><span class="detailFieldLabel fieldRequired">Target</span>' +
      '<input name="q" type="text" list="acct-targets" autocomplete="off" placeholder="Pick an existing target, or type a name to create one" />' +
      '<p class="fieldErrorMessage" hidden></p></label>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add target</button></form>';
  }

  function wireTargetLinkForm() {
    const f = $("target-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      SM.clearFieldError(f.q);
      const val = f.q.value.trim();
      if (!val) { SM.setFieldError(f.q, "Type a target name or key."); return; }
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      setMsg("");
      try {
        // 1) Match a known account target by key (unique) or name (best-effort) from the picker window.
        const lower = val.toLowerCase();
        const match =
          ACCT_TARGETS.find((t) => String((t.attributes || {}).key || "").toLowerCase() === lower) ||
          ACCT_TARGETS.find((t) => String((t.attributes || {}).name || "").toLowerCase() === lower);
        let targetId;
        if (match) {
          targetId = match.id;
        } else {
          // 2) Resolve server-side by key before creating — authoritative beyond the picker's page
          //    window, so a target that exists past it is reused, never silently duplicated.
          const slug = slugify(val);
          const existing = await apiFetch("/api/v1/targets?filter[key]=" + encodeURIComponent(slug));
          const found = existing && existing.data && existing.data[0];
          if (found) {
            targetId = found.id;
          } else {
            const doc = await apiFetch("/api/v1/targets", { method: "POST", body: jsonapiBody("target", { key: slug, name: val }) });
            targetId = doc && doc.data && doc.data.id;
          }
        }
        await apiFetch("/api/v1/benchmark_targets", { method: "POST", body: jsonapiBody("benchmark_target", { benchmark: ID, target: targetId }) });
        renderTargets($("tab-panel"));
      } catch (err) {
        submit.disabled = false;
        SM.setFieldError(f.q, err.message);
      }
    });
    f.q.addEventListener("input", () => SM.clearFieldError(f.q));
  }

  async function unlinkTarget(linkId, name) {
    if (!linkId) { setMsg("Couldn't resolve the link to remove — refresh and try again.", "error"); return; }
    const ok = await SM.confirm({ title: "Unlink target?", message: "Remove <strong>" + esc(name) + "</strong> from this benchmark and drop its measurements here? The target itself is kept in your account.", confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_targets/" + encodeURIComponent(linkId), { method: "DELETE" });
      renderTargets($("tab-panel"));
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Runs tab (benchmark-scoped) ──
  async function renderRuns(panel) {
    panel.innerHTML =
      (CAN_WRITE ? runAddForm() : "") +
      '<div class="panel isFlush" style="margin-top:' + (CAN_WRITE ? "1rem" : "0") + ';"><div class="tableWrap">' +
      '<table class="dataTable"><thead><tr><th>Key</th><th>State</th>' + (CAN_WRITE ? '<th class="actions"></th>' : "") + "</tr></thead>" +
      '<tbody id="runs-body"><tr><td colspan="3" class="dataTableEmpty">Loading…</td></tr></tbody></table></div></div>';
    if (CAN_WRITE) wireRunAddForm();
    try {
      const doc = await apiFetch("/api/v1/runs?filter[benchmark]=" + encodeURIComponent(ID));
      const list = (doc && doc.data) || [];
      const body = $("runs-body");
      if (!list.length) { body.innerHTML = '<tr><td colspan="3" class="dataTableEmpty">No runs yet.</td></tr>'; return; }
      body.innerHTML = list.map((r) => {
        const a = r.attributes || {};
        const invalidated = a.invalidated || a.invalidated_at || a.invalidation_reason;
        const ended = a.ended_at || a.live === false;
        const state = invalidated ? SM.statusPill("invalidated", "invalidated") : ended ? SM.statusPill("ended", "ended") : SM.statusPill("live", "live");
        let acts = "";
        if (CAN_WRITE) {
          if (!ended && !invalidated) acts += '<button type="button" class="button buttonSecondary buttonSmall run-end" data-id="' + esc(r.id) + '">End</button>';
          if (!invalidated) acts += '<button type="button" class="button buttonDanger buttonSmall run-invalidate" data-id="' + esc(r.id) + '">Invalidate</button>';
        }
        return "<tr><td><code>" + esc(a.key || "") + "</code></td><td>" + state + "</td>" + (CAN_WRITE ? '<td class="actions">' + acts + "</td>" : "") + "</tr>";
      }).join("");
      body.querySelectorAll(".run-end").forEach((el) => el.addEventListener("click", () => endRun(el.dataset.id)));
      body.querySelectorAll(".run-invalidate").forEach((el) => el.addEventListener("click", () => invalidateRun(el.dataset.id)));
    } catch (err) {
      $("runs-body").innerHTML = '<tr><td colspan="3" class="dataTableEmpty">' + esc(err.message) + "</td></tr>";
    }
  }
  function runAddForm() {
    return '<form id="run-form" class="inlineForm">' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Key</span><input name="key" type="text" placeholder="run-key" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Name</span><input name="name" type="text" placeholder="optional" /></label>' +
      '<label class="field"><span class="detailFieldLabel">Started at</span><input name="started_at" type="text" placeholder="2026-01-01T00:00:00Z" /></label>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Add run</button></form>';
  }
  function wireRunAddForm() {
    const f = $("run-form");
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      SM.clearFieldError(f.key);
      if (!f.key.value.trim()) { SM.setFieldError(f.key, "Required."); return; }
      const attrs = { benchmark: ID, key: f.key.value.trim() };
      const n = f.name.value.trim(); if (n) attrs.name = n;
      const s = f.started_at.value.trim(); if (s) attrs.started_at = s;
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      setMsg("");
      try {
        await apiFetch("/api/v1/runs", { method: "POST", body: jsonapiBody("run", attrs) });
        renderRuns($("tab-panel"));
      } catch (err) { submit.disabled = false; setMsg(err.message, "error"); }
    });
  }
  async function endRun(id) {
    setMsg("");
    try { await apiFetch("/api/v1/runs/" + encodeURIComponent(id) + "/actions/end", { method: "POST" }); renderRuns($("tab-panel")); }
    catch (err) { setMsg(err.message, "error"); }
  }
  async function invalidateRun(id) {
    const reason = await SM.confirm({ title: "Invalidate run?", message: "Invalidated runs stay visible but are flagged. This can't be undone.", confirmLabel: "Invalidate", reason: { label: "Reason (optional)", placeholder: "Why is this run invalid?" } });
    if (reason === null) return;
    setMsg("");
    const attrs = {};
    if (reason) attrs.invalidation_reason = reason;
    try { await apiFetch("/api/v1/runs/" + encodeURIComponent(id) + "/actions/invalidate", { method: "POST", body: jsonapiBody("run", attrs) }); renderRuns($("tab-panel")); }
    catch (err) { setMsg(err.message, "error"); }
  }

  // ── Lifecycle actions ──
  async function lifecycle(act) {
    if (act === "publish") { openPublishModal(); return; }
    if (act === "delete") { doDelete(); return; }
    if (act === "withdraw") { doWithdraw(); return; }
    if (act === "undraft") { doReturnToDraft(); return; }
    if (act === "markready") { await post("mark_ready"); return; }
    if (act === "close") { await post("close"); return; }
    if (act === "reopen") { await post("reopen"); return; }
  }
  async function post(action, body) {
    setMsg("");
    try { await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID) + "/actions/" + action, { method: "POST", body }); await refresh(); }
    catch (err) { setMsg(err.message, "error"); }
  }
  async function doReturnToDraft() {
    const reason = await SM.confirm({ title: "Return to draft?", message: "This reopens the benchmark for edits.", confirmLabel: "Return to draft", danger: false, reason: { label: "Note (optional)", placeholder: "Why it's going back" } });
    if (reason === null) return;
    await post("return_to_draft", reason ? jsonapiBody("benchmark", { reason: reason }) : undefined);
  }
  async function doWithdraw() {
    const reason = await SM.confirm({ title: "Withdraw benchmark?", message: "Withdrawing keeps the data public for the record but marks it retracted.", confirmLabel: "Withdraw", reason: { label: "Reason", placeholder: "Why is it being withdrawn?", required: true, textarea: true } });
    if (reason === null) return;
    await post("withdraw", jsonapiBody("benchmark", { withdrawal_reason: reason }));
  }
  async function doDelete() {
    const a = BM.attributes || {};
    const ok = await SM.confirm({ title: "Delete benchmark?", message: "Delete <strong>" + esc(a.name || a.key || "") + "</strong>? This can't be undone.", confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/benchmarks";
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Publish modal (attribution) ──
  async function loadOrgIdentities() {
    const [identsDoc, domainsDoc] = await Promise.all([
      apiFetch("/api/v1/publisher_identities"),
      apiFetch("/api/v1/publisher_domains?filter[status]=VERIFIED"),
    ]);
    const idents = (identsDoc && identsDoc.data) || [];
    const byIdentity = {};
    ((domainsDoc && domainsDoc.data) || []).forEach((d) => {
      const pid = d.attributes.publisher_identity;
      (byIdentity[pid] = byIdentity[pid] || []).push(d.attributes.domain);
    });
    return idents.map((i) => ({ id: i.id, name: i.attributes.name, domains: byIdentity[i.id] || [] }));
  }
  function optionRow(value, title, enabled, detail) {
    return '<label class="publishOption' + (enabled ? "" : " isDisabled") + '">' +
      '<input type="radio" name="attribution" value="' + esc(value) + '"' + (enabled ? "" : " disabled") + " />" +
      '<span class="publishOptionBody"><span class="publishOptionTitle">' + esc(title) + "</span>" +
      (detail ? '<span class="publishOptionDetail">' + esc(detail) + "</span>" : "") + "</span></label>";
  }
  function openPublishModal() {
    const a = BM.attributes || {};
    const m = SM.modal({
      title: "Publish “" + (a.name || a.key || "") + "”",
      description: "Publishing is a one-way step and freezes this benchmark's interpretation. Choose how it's attributed.",
      bodyHtml:
        '<form class="form" id="publish-form">' +
        '<div id="publish-options"><p class="muted">Loading publishing options…</p></div>' +
        '<p id="publish-msg" class="form-status"></p>' +
        '<div class="modalActions">' +
        '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
        '<button type="submit" class="button buttonPrimary buttonSmall" id="publish-submit" disabled>Publish</button>' +
        "</div></form>",
    });
    const panel = m.panel;
    panel.querySelector("#publish-form").addEventListener("submit", (ev) => { ev.preventDefault(); submitPublish(m); });
    buildPublishOptions(panel);
  }
  async function buildPublishOptions(panel) {
    const a = BM.attributes || {};
    const host = panel.querySelector("#publish-options");
    const submit = panel.querySelector("#publish-submit");
    const isAuthor = !!(USER_ID && a.created_by === USER_ID);
    const personalAvailable = ALLOW_PERSONAL && isAuthor;
    let personalDetail = "Attributed to you.";
    if (!ALLOW_PERSONAL) personalDetail = "Personal publishing is off for this account (enable it in Settings).";
    else if (!isAuthor) personalDetail = "Only the benchmark's author can publish it personally.";
    const rows = [optionRow("personal", "Publish personally", personalAvailable, personalDetail)];
    if (CAN_ADMIN) {
      let orgs = null;
      try { orgs = await loadOrgIdentities(); }
      catch (err) {
        host.innerHTML = rows.join("") + '<p class="form-status is-error" style="margin-top:0.4rem;">Couldn\'t load organization identities: ' + esc(err.message) + "</p>";
        wireOptions(host, submit); return;
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
    host.querySelectorAll('input[name="attribution"]').forEach((r) => r.addEventListener("change", () => { submit.disabled = false; }));
  }
  async function submitPublish(m) {
    const sel = m.panel.querySelector('input[name="attribution"]:checked');
    if (!sel) return;
    const msg = m.panel.querySelector("#publish-msg");
    msg.textContent = ""; msg.className = "form-status";
    const submit = m.panel.querySelector("#publish-submit"); submit.disabled = true;
    let body;
    if (sel.value !== "personal") body = jsonapiBody("benchmark", { publisher_identity: sel.value.slice(4) });
    try {
      await apiFetch("/api/v1/benchmarks/" + encodeURIComponent(ID) + "/actions/publish", { method: "POST", body });
      m.close();
      await refresh();
    } catch (err) { msg.textContent = err.message; msg.className = "form-status is-error"; submit.disabled = false; }
  }
})();
