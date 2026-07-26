"use strict";

// Shared subject-type field tooling: the read/edit fields TABLE, a single-field editor MODAL (label +
// derived name + description + segmented type + required toggle + per-type extras), and the create-type
// modal. A field def is { name (identifier), label (display), type, required, description?, max_length?
// (STRING), options? (ENUM) }. Depends on api.js + shell.js (SM). Exposed as window.SMSubjectTypeForm.

(function () {
  const esc = SM.esc;
  const FIELD_TYPES = ["STRING", "NUMBER", "BOOLEAN", "ENUM", "DATE"];
  function titleCase(t) { return String(t).charAt(0) + String(t).slice(1).toLowerCase(); }
  function fieldsOf(t) { return ((t && t.attributes && t.attributes.fields) || []); }
  // Snake_case a label/name into a field identifier (mirrors the server): lowercase, non-alphanumerics
  // → single underscore, trimmed. `sanitizeName` is the lighter live version for the Name input (keeps
  // interior underscores as the user types, no trimming so a trailing "_" mid-word survives).
  function fieldNameSlug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60); }
  function sanitizeName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60); }

  function typePillHtml(type) { return '<span class="typePill">' + esc(titleCase(type)) + "</span>"; }

  // ── Column defs for SM.pagedTable ── in editable mode a trailing trash column removes the field
  // (caller wires [data-field-name]); in view mode a field's description shows beneath its name.
  function fieldColumns(opts) {
    opts = opts || {};
    const editable = !!opts.editable;
    const cols = [
      { key: "name", label: "Name", sortable: true, sortValue: (f) => f.name || "", render: (f) =>
          '<span class="fieldNameMain"><code>' + esc(f.name || "") + "</code></span>" +
          (!editable && f.description ? '<span class="fieldRowDesc">' + esc(f.description) + "</span>" : "") },
      { key: "label", label: "Label", sortable: true, sortValue: (f) => f.label || "", render: (f) => esc(f.label || "") },
      { key: "type", label: "Type", sortable: true, sortValue: (f) => f.type || "", render: (f) => typePillHtml(f.type || "") },
      { key: "required", label: "Required", sortable: true, sortValue: (f) => (f.required ? 0 : 1), render: (f) =>
          f.required ? '<span class="reqBadge">Required</span>' : '<span class="muted">Optional</span>' },
    ];
    if (editable) {
      cols.push({ key: "actions", label: "", sortable: false, thClass: "actions", tdClass: "actions", render: (f) =>
        '<button type="button" class="iconBtn fieldTrash" data-field-name="' + esc(f.name || "") + '" title="Remove field" aria-label="Remove field">' + SM.icon("trash", 15) + "</button>" });
    }
    return cols;
  }

  // ── Per-type "extra" controls ──
  function stepperHtml(value) {
    // Every string field carries a limit; default to 255 (the reasonable max) when none is set.
    const v = value == null || value === "" ? 255 : esc(value);
    return '<div class="stepper">' +
      '<button type="button" class="stepperBtn" data-step="-1" aria-label="Decrease">−</button>' +
      '<input type="number" id="fm-maxlen" min="1" max="255" step="1" value="' + v + '" />' +
      '<button type="button" class="stepperBtn" data-step="1" aria-label="Increase">+</button></div>';
  }
  function enumRowHtml(value) {
    return '<div class="enumValueRow"><input type="text" class="enumValueInput" value="' + esc(value || "") + '" placeholder="Value" autocomplete="off" />' +
      '<button type="button" class="iconBtn enumValueRemove" title="Remove value" aria-label="Remove value">' + SM.icon("trash", 15) + "</button></div>";
  }

  // ── Single-field editor modal ── opts: { field (null to create), onSave(def) }. onSave persists the
  // field and may throw (the modal stays open and shows the error). Removal is the table's trash icon.
  function openFieldModal(opts) {
    opts = opts || {};
    const field = opts.field || null;
    const isEdit = !!field;
    const initType = (field && field.type) || "STRING";
    const typePills = FIELD_TYPES.map((ft) =>
      '<label class="radioPill"><input type="radio" name="fm-type" value="' + ft + '"' + (initType === ft ? " checked" : "") + ' /><span class="radioDot"></span><span class="radioPillLabel">' + titleCase(ft) + "</span></label>",
    ).join("");
    const enumVals = (field && field.options) || [];
    const enumRows = (enumVals.length ? enumVals : [""]).map(enumRowHtml).join("");
    const bodyHtml =
      '<form class="form" id="fm-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="vendor" autocomplete="off" spellcheck="false" value="' + esc((field && field.name) || "") + '" /><p class="fieldErrorMessage" hidden></p><p class="detailFieldHelp">The identifier used in the API and a subject’s JSON — lowercase letters, numbers, and underscores.</p></label>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Label</span><input name="label" type="text" placeholder="Vendor" autocomplete="off" value="' + esc((field && field.label) || "") + '" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Description</span><input name="description" type="text" placeholder="Optional — a note about this field" autocomplete="off" value="' + esc((field && field.description) || "") + '" /></label>' +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Type</span><div class="radioGroup" id="fm-type-group" role="radiogroup" aria-label="Field type">' + typePills + "</div></div>" +
      '<div class="fieldModalBlock"><label class="fieldCheckRow"><input type="checkbox" id="fm-required"' + (field && field.required ? " checked" : "") + " /> <span>Required</span></label>" +
      '<p class="detailFieldHelp">When checked, every subject of this type must provide a value; unchecked, it’s optional.</p></div>' +
      '<div class="fieldModalBlock" id="fm-extra-string"><span class="detailFieldLabel fieldRequired">Max length</span>' + stepperHtml(field && field.max_length != null ? field.max_length : "") + '<p class="detailFieldHelp">The longest allowed text, from 1 to 255 characters.</p></div>' +
      '<div class="fieldModalBlock" id="fm-extra-enum"><span class="detailFieldLabel fieldRequired">Values</span><div class="enumEditor" id="fm-enum-rows">' + enumRows + '</div>' +
      '<button type="button" class="button buttonSecondary buttonSmall enumAdd" id="fm-enum-add">' + SM.icon("plus", 14) + " Add value</button></div>" +
      '<p class="form-status" id="fm-msg"></p>' +
      '<div class="modalActions">' +
      '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Save</button></div></form>';
    const m = SM.modal({ title: isEdit ? "Edit field" : "New field", description: "Define one field of this subject type.", bodyHtml: bodyHtml, width: 560 });
    const f = m.panel.querySelector("#fm-form");
    const msg = m.panel.querySelector("#fm-msg");
    const nameEl = f.name;
    let nameEdited = isEdit; // once editing, the name is fixed unless the user changes it

    const extraString = m.panel.querySelector("#fm-extra-string");
    const extraEnum = m.panel.querySelector("#fm-extra-enum");
    function currentType() { const r = f.querySelector('input[name="fm-type"]:checked'); return r ? r.value : "STRING"; }
    function syncExtra() {
      const t = currentType();
      extraString.style.display = t === "STRING" ? "" : "none";
      extraEnum.style.display = t === "ENUM" ? "" : "none";
    }
    syncExtra();

    f.label.addEventListener("input", () => {
      SM.clearFieldError(f.label);
      if (!nameEdited) nameEl.value = fieldNameSlug(f.label.value);
    });
    // Keep the Name field to lowercase [a-z0-9_] as the user types (preserving caret position).
    nameEl.addEventListener("input", () => {
      nameEdited = true;
      const cleaned = sanitizeName(nameEl.value);
      if (cleaned !== nameEl.value) {
        const pos = nameEl.selectionStart;
        nameEl.value = cleaned;
        try { nameEl.setSelectionRange(pos, pos); } catch (_e) { /* input may not support it */ }
      }
      SM.clearFieldError(nameEl);
    });
    m.panel.querySelectorAll('input[name="fm-type"]').forEach((r) => r.addEventListener("change", syncExtra));
    const reqEl = m.panel.querySelector("#fm-required");

    // Stepper +/- (clamped to 1..255; a string field always has a limit).
    m.panel.querySelectorAll(".stepperBtn").forEach((btn) => btn.addEventListener("click", () => {
      const input = m.panel.querySelector("#fm-maxlen");
      const cur = input.value.trim() === "" ? 255 : Math.floor(Number(input.value)) || 255;
      const next = Math.min(255, Math.max(1, cur + Number(btn.dataset.step)));
      input.value = String(next);
    }));

    // Enum values add/remove.
    const enumHost = m.panel.querySelector("#fm-enum-rows");
    function wireEnumRow(row) { row.querySelector(".enumValueRemove").addEventListener("click", () => row.remove()); }
    enumHost.querySelectorAll(".enumValueRow").forEach(wireEnumRow);
    m.panel.querySelector("#fm-enum-add").addEventListener("click", () => {
      const tmp = document.createElement("div");
      tmp.innerHTML = enumRowHtml("");
      const row = tmp.firstChild;
      enumHost.appendChild(row);
      wireEnumRow(row);
      row.querySelector(".enumValueInput").focus();
    });

    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.label);
      const label = f.label.value.trim();
      if (!label) { SM.setFieldError(f.label, "A label is required."); return; }
      const type = currentType();
      const name = fieldNameSlug(nameEl.value.trim() || label) || fieldNameSlug(label);
      if (!name) { SM.setFieldError(nameEl, "Enter a name with letters or numbers."); return; }
      const def = { name: name, label: label, type: type, required: reqEl.checked };
      const desc = f.description.value.trim();
      if (desc) def.description = desc;
      if (type === "STRING") {
        const ml = m.panel.querySelector("#fm-maxlen").value.trim();
        const num = ml === "" ? 255 : Number(ml);
        if (!Number.isInteger(num) || num < 1 || num > 255) { msg.textContent = "Max length must be a whole number between 1 and 255."; msg.className = "form-status is-error"; return; }
        def.max_length = num;
      }
      if (type === "ENUM") {
        const vals = [...enumHost.querySelectorAll(".enumValueInput")].map((i) => i.value.trim()).filter(Boolean);
        if (!vals.length) { msg.textContent = "An Enum field needs at least one value."; msg.className = "form-status is-error"; return; }
        if (new Set(vals).size !== vals.length) { msg.textContent = "Enum values must be unique."; msg.className = "form-status is-error"; return; }
        def.options = vals;
      }
      // onSave persists the field (add/update); keep the modal open on failure so the error shows here.
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        if (opts.onSave) await opts.onSave(def);
        m.close();
      } catch (err) { submit.disabled = false; msg.textContent = (err && err.message) || "Couldn't save the field."; msg.className = "form-status is-error"; }
    });
  }

  // ── Create-type modal (list page) ── just the name; fields are added on the detail page.
  function openCreateModal(opts) {
    opts = opts || {};
    const bodyHtml =
      '<form class="form" id="ct-form" novalidate>' +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="CPU configuration" autocomplete="off" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<p class="form-status" id="ct-msg"></p>' +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>' +
      '<button type="submit" class="button buttonPrimary buttonSmall">Create type</button></div></form>';
    const m = SM.modal({ title: "New subject type", description: "Name the type, then define its fields.", bodyHtml: bodyHtml, width: 480 });
    const f = m.panel.querySelector("#ct-form");
    f.name.addEventListener("input", () => SM.clearFieldError(f.name));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = m.panel.querySelector("#ct-msg"); msg.textContent = ""; msg.className = "form-status";
      SM.clearFieldError(f.name);
      if (!f.name.value.trim()) { SM.setFieldError(f.name, "A name is required."); return; }
      const submit = f.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/subject_types", { method: "POST", body: jsonapiBody("subject_type", { name: f.name.value.trim(), fields: [] }) });
        m.close();
        if (opts.onSaved) opts.onSaved((doc && doc.data) || null);
      } catch (err) { submit.disabled = false; msg.textContent = err.message; msg.className = "form-status is-error"; }
    });
  }

  window.SMSubjectTypeForm = {
    FIELD_TYPES: FIELD_TYPES,
    fieldColumns: fieldColumns,
    typePillHtml: typePillHtml,
    openFieldModal: openFieldModal,
    openCreateModal: openCreateModal,
    fieldsOf: fieldsOf,
    titleCase: titleCase,
  };
})();
