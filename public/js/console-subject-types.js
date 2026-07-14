"use strict";

// Subject Types list (/account/subject-types) — a conforming list page: a search + refresh toolbar
// above the table, a contextual empty state, and row-click to the detail page (where a type's fields
// are viewed/edited). Create is a strict modal (the field-definitions editor). Depends on api.js +
// shell.js + subject-type-form.js (SMSubjectTypeForm).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  let CAN_WRITE = false;
  let ALL = [];
  let SEARCH = "";
  let TABLE = null;

  SM.ready.then((id) => {
    CAN_WRITE = id.canWrite;
    load();
  }).catch(() => { $("load-error").innerHTML = '<div class="errorBanner"><p>Failed to load your account.</p></div>'; });

  function wireTopBar() {
    if (!CAN_WRITE) { SM.setTopBarAction(""); return; }
    SM.setTopBarAction('<button type="button" class="button buttonPrimary buttonTopBar" id="new-type">' + SM.icon("plus", 16) + " New subject type</button>");
    $("new-type").addEventListener("click", openCreate);
  }

  function openCreate() {
    SMSubjectTypeForm.openCreateModal({
      onSaved: (t) => { if (t && t.id) location.href = "/account/subject-types/detail?id=" + encodeURIComponent(t.id) + "&new=1#fields"; else load(); },
    });
  }

  async function load() {
    try {
      const doc = await apiFetch("/api/v1/subject_types?page[size]=200");
      ALL = (doc && doc.data) || [];
      ALL.sort((a, z) => String((a.attributes || {}).name || "").localeCompare(String((z.attributes || {}).name || "")));
      render();
    } catch (err) {
      $("st-content").innerHTML = '<div class="errorBanner"><p>' + esc(err.message) + "</p></div>";
    }
  }

  function filtered() {
    const q = SEARCH.trim().toLowerCase();
    if (!q) return ALL;
    return ALL.filter((t) => { const a = t.attributes || {}; return (a.name || "").toLowerCase().includes(q) || (a.key || "").toLowerCase().includes(q); });
  }

  function render() {
    const host = $("st-content");
    // Truly-empty first visit: the create-your-first hero stands alone (no toolbar, no top-bar dup).
    if (!ALL.length && !SEARCH.trim()) {
      SM.setTopBarAction("");
      host.innerHTML =
        '<div class="emptyState"><div class="emptyIcon">' + SM.icon("layers", 44) + "</div>" +
        "<h2>No subject types yet</h2><p>A subject type defines the fields subjects carry — think of it as a schema. Define one, then add subjects of that type from the Subjects page.</p>" +
        (CAN_WRITE ? '<button type="button" class="button buttonPrimary" id="empty-create">New subject type</button>' : "") + "</div>";
      const b = $("empty-create"); if (b) b.addEventListener("click", openCreate);
      return;
    }
    wireTopBar();
    host.innerHTML = '<div id="st-toolbar-mount"></div><div id="st-table"></div>';
    const bar = SM.toolbar({ placeholder: "Search subject types…", onSearch: (v) => { SEARCH = v; if (TABLE) TABLE.setRows(filtered()); }, onRefresh: () => load() });
    const input = bar.querySelector(".toolbarSearch input"); if (input) input.value = SEARCH;
    $("st-toolbar-mount").replaceWith(bar);
    const nfOf = (t) => (((t.attributes || {}).fields) || []).length;
    TABLE = SM.pagedTable($("st-table"), {
      columns: [
        { key: "name", label: "Name", sortable: true, sortValue: (t) => (t.attributes || {}).name || "", render: (t) => esc((t.attributes || {}).name || "") },
        { key: "fields", label: "Fields", sortable: true, sortValue: nfOf, render: (t) => { const n = nfOf(t); return n + (n === 1 ? " field" : " fields"); } },
      ],
      rows: filtered(),
      sort: { key: "name", dir: "asc" },
      emptyText: "No matching subject types.",
      onRowClick: (t) => { location.href = "/account/subject-types/detail?id=" + encodeURIComponent(t.id); },
    });
  }
})();
