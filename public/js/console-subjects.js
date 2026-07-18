"use strict";

// Subjects (/account/subjects) — a two-pane workspace like smplkit's context-type/context: a narrow
// left column of subject types (a picker — full management lives in the Subject Types module), and on
// the right the subjects of the selected type. Creating a subject renders a form generated from the
// type's fields (no raw JSON). The selected type lives in the URL hash; the "New subject" action lives
// in the top-bar banner. Depends on api.js + shell.js + subject-form.js (SMSubjectForm).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);

  let CAN_WRITE = false;
  let TYPES = [];
  let SUBJECTS = [];
  let SUB_SEARCH = "";
  let SUB_TABLE = null;

  SM.ready.then((id) => { CAN_WRITE = id.canWrite; boot(); })
    .catch(() => fail("Failed to load your account."));

  function fail(msg) { $("subjects-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }
  function byName(a, z) { return String((a.attributes || {}).name || "").localeCompare(String((z.attributes || {}).name || "")); }
  function fieldsOf(t) { return ((t && t.attributes && t.attributes.fields) || []); }
  function selectedId() { return (location.hash || "").replace(/^#/, ""); }
  function selectedType() { return TYPES.find((t) => t.id === selectedId()) || TYPES[0] || null; }

  async function boot() {
    try {
      const doc = await apiFetch("/api/v1/subject_types?page[size]=200");
      TYPES = ((doc && doc.data) || []).slice().sort(byName);
      renderShell();
    } catch (err) { fail(err.message || "Failed to load subject types."); }
  }

  window.addEventListener("hashchange", () => { if (TYPES.length) { renderTypesList(); renderMain(); } });

  // ── Shell: two panes ──
  function renderShell() {
    if (!TYPES.length) { renderNoTypes(); return; }
    const sel = selectedType();
    if (!selectedId() && sel) history.replaceState(null, "", "#" + sel.id);
    $("subjects-root").innerHTML =
      '<div class="subjectsLayout">' +
      '<aside class="typesPane"><div class="typesPaneHead"><span class="typesPaneTitle">Subject types</span></div>' +
      '<nav class="typesList" id="types-list"></nav></aside>' +
      '<section class="subjectsMain" id="subjects-main"></section></div>';
    renderTypesList();
    renderMain();
  }

  function renderNoTypes() {
    SM.setTopBarAction("");
    $("subjects-root").innerHTML =
      '<div class="emptyState"><div class="emptyIcon">' + SM.icon("subjects", 44) + "</div>" +
      "<h2>No subject types yet</h2><p>A subject is a thing you measure — a system, model, or configuration. Define a <strong>subject type</strong> first (its fields), then add subjects of that type here.</p>" +
      '<a class="button buttonPrimary" href="/account/subject-types">Go to Subject types</a></div>';
  }

  function renderTypesList() {
    const sel = selectedType();
    $("types-list").innerHTML = TYPES.map((t) => {
      const a = t.attributes || {};
      const on = sel && t.id === sel.id;
      const nf = fieldsOf(t).length;
      return '<button type="button" class="typeItem' + (on ? " isActive" : "") + '" data-id="' + esc(t.id) + '">' +
        '<span class="typeItemName">' + esc(a.name || a.key) + "</span>" +
        '<span class="typeItemMeta">' + nf + (nf === 1 ? " field" : " fields") + "</span></button>";
    }).join("");
    $("types-list").querySelectorAll(".typeItem").forEach((el) =>
      el.addEventListener("click", () => { if (el.dataset.id !== selectedId()) location.hash = el.dataset.id; }));
  }

  // ── Right pane: the selected type's subjects ──
  function renderMain() {
    const t = selectedType();
    if (!t) return;
    const a = t.attributes || {};
    const nf = fieldsOf(t).length;
    $("subjects-main").innerHTML =
      '<div class="subjectsMainHead"><div class="subjectsMainHeadText"><h1>' + esc(a.name || a.key) + "</h1>" +
      '<p class="subjectsMainSub">' + nf + (nf === 1 ? " field" : " fields") + ' · <code>' + esc(a.key) + "</code></p></div></div>" +
      '<div id="sub-toolbar-mount"></div><div id="sub-table"></div>';
    // Primary action lives in the top-bar banner (per standards); it acts on the currently-selected type.
    if (CAN_WRITE) {
      SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-subject">' + SM.icon("plus", 16) + " New subject</button>");
      const nb = document.getElementById("new-subject");
      // A subject can have many (possibly required) fields, so create on a full detail page, not a modal.
      if (nb) nb.addEventListener("click", () => { const cur = selectedType(); if (cur) location.href = "/account/subjects/detail?new=1&subject_type=" + encodeURIComponent(cur.id); });
    } else {
      SM.setTopBarAction("");
    }
    const bar = SM.toolbar({ placeholder: "Search subjects…", onSearch: (v) => { SUB_SEARCH = v; if (SUB_TABLE) SUB_TABLE.setRows(filteredSubjects()); }, onRefresh: () => loadSubjects(t) });
    $("sub-toolbar-mount").replaceWith(bar);
    SUB_SEARCH = "";
    SUB_TABLE = SM.pagedTable($("sub-table"), {
      columns: subjectColumns(t),
      rows: [],
      sort: { key: "key", dir: "asc" },
      emptyText: "No subjects of this type yet.",
      onRowClick: (s) => { location.href = "/account/subjects/detail?id=" + encodeURIComponent(s.id); },
    });
    loadSubjects(t);
  }

  // A column per subject-type field, plus Key + Name. Field columns key/sort/display by field name.
  function subjectColumns(t) {
    const cols = [
      { key: "key", label: "ID", sortable: true, sortValue: (s) => (s.attributes || {}).key || "", render: (s) => "<code>" + esc((s.attributes || {}).key || "") + "</code>" },
      { key: "name", label: "Name", sortable: true, sortValue: (s) => (s.attributes || {}).name || "", render: (s) => esc((s.attributes || {}).name || "") },
    ];
    fieldsOf(t).forEach((f) => {
      cols.push({
        key: "f_" + f.name,
        label: f.label,
        sortable: true,
        sortValue: (s) => { const v = ((s.attributes || {}).details || {})[f.name]; return v == null ? "" : (typeof v === "number" ? v : String(v)); },
        render: (s) => esc(SMSubjectForm.display(f, ((s.attributes || {}).details || {})[f.name])),
      });
    });
    return cols;
  }

  function filteredSubjects() {
    const q = SUB_SEARCH.trim().toLowerCase();
    if (!q) return SUBJECTS;
    return SUBJECTS.filter((s) => { const a = s.attributes || {}; return String(a.key || "").toLowerCase().includes(q) || String(a.name || "").toLowerCase().includes(q); });
  }

  async function loadSubjects(t) {
    try {
      SUBJECTS = [];
      const SIZE = 1000, MAX_PAGES = 20;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const doc = await apiFetch("/api/v1/subjects?filter[subject_type]=" + encodeURIComponent(t.id) + "&page[number]=" + page + "&page[size]=" + SIZE);
        const rows = (doc && doc.data) || [];
        SUBJECTS = SUBJECTS.concat(rows);
        if (rows.length < SIZE) break;
      }
      if (t.id === (selectedType() || {}).id && SUB_TABLE) SUB_TABLE.setRows(filteredSubjects());
    } catch (err) {
      const b = $("sub-table"); if (b) b.innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

})();
