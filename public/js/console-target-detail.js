"use strict";

// Target detail (/account/targets/detail?id=…) — a conforming detail page: DetailHeader, a Details
// tab (view/edit name + details JSON), and a Benchmarks tab listing the benchmarks this target is
// linked to (with unlink for private ones). Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  const ID = new URLSearchParams(location.search).get("id") || "";
  let TG = null;
  let CAN_WRITE = false;

  let editing = false;
  let form = { name: "", details: "" };

  const TABS = ["details", "benchmarks"];
  function activeTab() {
    const h = (location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) >= 0 ? h : "details";
  }
  let currentRenderedTab = "details";

  function fmtDate(v) {
    if (!v) return "";
    const d = new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function detailsText(a) {
    return a.details == null ? "" : JSON.stringify(a.details, null, 2);
  }

  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!ID) { fail("No target id."); return; }
    try {
      const doc = await apiFetch("/api/v1/targets/" + encodeURIComponent(ID));
      TG = (doc && doc.data) || null;
      if (!TG) { fail("Target not found."); return; }
      render();
    } catch (err) { fail(err.message || "Failed to load target."); }
  }

  function render() {
    const a = TG.attributes || {};
    const tab = activeTab();
    const tabBtn = (key, label) =>
      '<button type="button" class="modalTabBtn' + (tab === key ? " isActive" : "") + '" data-tab="' + key + '" role="tab" aria-selected="' + (tab === key) + '">' + esc(label) + "</button>";

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.name || a.key || "Target", secondaryId: a.key || "", actions: "" }) +
      '<div class="detailsTabHeader">' +
      '<nav class="modalTabBar" role="tablist">' + tabBtn("details", "Details") + tabBtn("benchmarks", "Benchmarks") + "</nav>" +
      '<div class="detailsTabActions" id="tab-actions"></div>' +
      "</div>" +
      '<div id="tab-panel"></div>' +
      '<div id="detail-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.name || a.key || "Target";
    document.title = (a.name || "Target") + " — smplmark";

    $("detail-root").querySelectorAll(".modalTabBar .modalTabBtn").forEach((el) =>
      el.addEventListener("click", () => switchTab(el.dataset.tab)));
    renderTab();
  }

  function switchTab(key) {
    if (key === activeTab()) return;
    if (editing && isDirty()) {
      SM.confirm({ title: "Discard changes?", message: "You have unsaved edits. Leave and discard them?", confirmLabel: "Discard", cancelLabel: "Keep editing" })
        .then((ok) => { if (ok) { exitEdit(); location.hash = key; render(); } });
      return;
    }
    editing = false;
    location.hash = key;
    render();
  }
  window.addEventListener("hashchange", () => { if (activeTab() !== currentRenderedTab) render(); });

  function renderTab() {
    currentRenderedTab = activeTab();
    const panel = $("tab-panel");
    $("tab-actions").innerHTML = "";
    if (currentRenderedTab === "details") renderDetails(panel, $("tab-actions"));
    else renderBenchmarks(panel);
  }

  // ── Details tab ──
  function isDirty() {
    if (!editing || !TG) return false;
    const a = TG.attributes || {};
    return form.name.trim() !== (a.name || "") || form.details !== detailsText(a);
  }
  function enterEdit() {
    const a = TG.attributes || {};
    editing = true;
    form = { name: a.name || "", details: detailsText(a) };
    renderTab();
  }
  function exitEdit() { editing = false; window.removeEventListener("beforeunload", onBeforeUnload); }
  function onBeforeUnload(e) { if (editing && isDirty()) { e.preventDefault(); e.returnValue = ""; } }

  function renderDetails(panel, actions) {
    const a = TG.attributes || {};
    if (CAN_WRITE) {
      actions.innerHTML = editing
        ? '<button type="button" class="button buttonSecondary buttonSmall" id="t-cancel">Cancel</button>' +
          '<button type="button" class="button buttonPrimary buttonSmall" id="t-save">Save</button>'
        : '<button type="button" class="button buttonSecondary buttonSmall" id="t-edit">Edit</button>' +
          '<button type="button" class="button buttonDanger buttonSmall" id="t-delete">Delete</button>';
    }

    const left = editing
      ? '<div class="field"><span class="detailFieldLabel fieldRequired">Name</span><input data-edit="name" type="text" value="' + esc(form.name) + '" /><p class="fieldErrorMessage" hidden></p></div>' +
        '<div class="field"><span class="detailFieldLabel">Details (JSON)</span><textarea data-edit="details" rows="6">' + esc(form.details) + "</textarea><p class=\"fieldErrorMessage\" hidden></p></div>"
      : SM.detailField("Name", { value: a.name }) +
        SM.detailField("Key", { value: a.key, mono: true }) +
        SM.detailField("Details", { value: a.details == null ? "" : detailsText(a), multiline: true, mono: true, emptyText: "(none)" });

    const right =
      SM.detailField("Created", { value: fmtDate(a.created_at) }) +
      SM.detailField("Updated", { value: fmtDate(a.updated_at) });

    panel.innerHTML =
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div>" +
      "</div></div>";

    if (CAN_WRITE && editing) {
      const nameEl = panel.querySelector('[data-edit="name"]');
      const detEl = panel.querySelector('[data-edit="details"]');
      nameEl.addEventListener("input", () => { form.name = nameEl.value; SM.clearFieldError(nameEl); });
      detEl.addEventListener("input", () => { form.details = detEl.value; SM.clearFieldError(detEl); });
      $("t-cancel").addEventListener("click", cancelEdit);
      $("t-save").addEventListener("click", save);
      window.addEventListener("beforeunload", onBeforeUnload);
      nameEl.focus();
    } else if (CAN_WRITE) {
      $("t-edit").addEventListener("click", enterEdit);
      $("t-delete").addEventListener("click", del);
    }
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

  async function save() {
    const panel = $("tab-panel");
    const nameEl = panel.querySelector('[data-edit="name"]');
    const detEl = panel.querySelector('[data-edit="details"]');
    SM.clearFieldError(nameEl); SM.clearFieldError(detEl);
    let ok = true;
    if (!form.name.trim()) { SM.setFieldError(nameEl, "A name is required."); ok = false; }
    let details = null;
    const d = form.details.trim();
    if (d) { try { details = JSON.parse(d); } catch (_e) { SM.setFieldError(detEl, "Details must be valid JSON."); ok = false; } }
    if (!ok) return;
    const a = TG.attributes || {};
    // get-mutate-put: send the full representation (key is immutable server-side but round-trips).
    const attrs = { key: a.key, name: form.name.trim(), details: details };
    const btn = $("t-save"); btn.disabled = true;
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/targets/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("target", attrs) });
      TG = (doc && doc.data) || TG;
      exitEdit();
      render();
    } catch (err) { btn.disabled = false; setMsg(err.message, "error"); }
  }

  async function del() {
    const a = TG.attributes || {};
    const okc = await SM.confirm({ title: "Delete target?", message: "Delete <strong>" + esc(a.name || a.key || "") + "</strong> and its measurements? This can't be undone. A target linked to a published benchmark can't be deleted.", confirmLabel: "Delete" });
    if (!okc) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/targets/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/targets";
    } catch (err) { setMsg(err.message, "error"); }
  }

  // ── Benchmarks tab (where this target is linked) ──
  async function renderBenchmarks(panel) {
    panel.innerHTML =
      '<div class="panel isFlush"><div class="tableWrap"><table class="dataTable">' +
      '<thead><tr><th>Benchmark</th><th>Status</th>' + (CAN_WRITE ? '<th class="actions"></th>' : "") + "</tr></thead>" +
      '<tbody id="bm-body"><tr><td colspan="3" class="dataTableEmpty">Loading…</td></tr></tbody></table></div></div>';
    try {
      const [linksDoc, benchDoc] = await Promise.all([
        apiFetch("/api/v1/benchmark_targets?filter[target]=" + encodeURIComponent(ID)),
        apiFetch("/api/v1/benchmarks?filter[account]=" + encodeURIComponent((TG.attributes || {}).account || "")),
      ]);
      const links = (linksDoc && linksDoc.data) || [];
      const byId = {};
      ((benchDoc && benchDoc.data) || []).forEach((b) => { byId[b.id] = b; });
      const body = $("bm-body");
      if (!links.length) { body.innerHTML = '<tr><td colspan="3" class="dataTableEmpty">Not linked to any benchmark yet. Add it from a benchmark’s Targets tab.</td></tr>'; return; }
      body.innerHTML = links.map((lnk) => {
        const la = lnk.attributes || {};
        const b = byId[la.benchmark];
        const ba = (b && b.attributes) || {};
        const status = String(ba.status || "").toUpperCase();
        const nameCell = b
          ? '<a class="buttonLink" href="/account/benchmarks/detail?id=' + esc(la.benchmark) + '">' + esc(ba.name || ba.key || la.benchmark) + "</a>"
          : "<code>" + esc(la.benchmark) + "</code>";
        const canUnlink = CAN_WRITE && status === "PRIVATE";
        const acts = canUnlink
          ? '<button type="button" class="button buttonDanger buttonSmall unlink" data-id="' + esc(lnk.id) + '" data-name="' + esc(ba.name || ba.key || "") + '">Unlink</button>'
          : "";
        return "<tr><td>" + nameCell + "</td><td>" + (status ? SM.statusPill(status, status) : "") + "</td>" +
          (CAN_WRITE ? '<td class="actions">' + acts + "</td>" : "") + "</tr>";
      }).join("");
      body.querySelectorAll(".unlink").forEach((el) => el.addEventListener("click", () => unlink(el.dataset.id, el.dataset.name)));
    } catch (err) {
      $("bm-body").innerHTML = '<tr><td colspan="3" class="dataTableEmpty">' + esc(err.message) + "</td></tr>";
    }
  }

  async function unlink(linkId, benchName) {
    const ok = await SM.confirm({ title: "Unlink from benchmark?", message: "Remove this target from <strong>" + esc(benchName) + "</strong> and drop its measurements there? The target itself is kept.", confirmLabel: "Unlink" });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/benchmark_targets/" + encodeURIComponent(linkId), { method: "DELETE" });
      renderBenchmarks($("tab-panel"));
    } catch (err) { setMsg(err.message, "error"); }
  }

  function setMsg(text, kind) {
    const el = $("detail-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
})();
