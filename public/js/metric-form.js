"use strict";

// Shared metric form + display helpers, used by the Metrics module. The editable form is rendered
// INLINE on the metric detail page (both create — a new, id-less detail page — and edit), not in a
// modal: render() emits the fields, wire() attaches the live behaviors, collect() validates + returns
// the attributes to POST/PUT. A metric has a snake_case `name` (identifier, immutable after create), a
// `label`, an optional `description`, a semantic `type`, and a `kind`: STORED (a value clients POST) or
// DERIVED (computed on read from a small, built-in formula set). Depends on shell.js (SM). Exposed as
// window.SMMetricForm.

(function () {
  const esc = SM.esc;
  const TYPES = [["NUMBER", "Number"], ["DURATION_MS", "Duration (ms)"], ["PERCENT", "Percent"], ["COUNT", "Count"], ["BYTES", "Bytes"]];
  const KINDS = [["STORED", "Stored"], ["DERIVED", "Derived"]];
  // op → [label, isBinary]
  const OPS = [["SKEW_MS", "Minute skew (skew_ms)", false], ["SUM", "Sum (a + b)", true], ["DIFFERENCE", "Difference (a − b)", true], ["RATIO", "Ratio (a ÷ b)", true], ["PERCENT", "Percent (100 × a ÷ b)", true]];

  function typeLabel(t) { const x = TYPES.find((p) => p[0] === t); return x ? x[1] : String(t || ""); }
  function kindLabel(k) { const x = KINDS.find((p) => p[0] === k); return x ? x[1] : String(k || ""); }
  function opBinary(op) { const x = OPS.find((p) => p[0] === op); return x ? x[2] : false; }
  function metricNameSlug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60); }
  function sanitizeName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60); }

  function typePillHtml(t) { return '<span class="typePill">' + esc(typeLabel(t)) + "</span>"; }
  function kindPillHtml(k) { return '<span class="typePill' + (k === "DERIVED" ? " kindDerived" : "") + '">' + esc(kindLabel(k)) + "</span>"; }
  // A readable rendering of a stored formula (for the detail page).
  function formulaText(formula) {
    if (!formula || !formula.op) return "—";
    if (formula.op === "SKEW_MS") return "minute skew of created_at";
    const a = formula.a || "a", b = formula.b || "b";
    if (formula.op === "SUM") return a + " + " + b;
    if (formula.op === "DIFFERENCE") return a + " − " + b;
    if (formula.op === "RATIO") return a + " ÷ " + b;
    if (formula.op === "PERCENT") return "100 × " + a + " ÷ " + b;
    return String(formula.op);
  }

  function radioPill(name, value, label, checked) {
    return '<label class="radioPill"><input type="radio" name="' + name + '" value="' + value + '"' + (checked ? " checked" : "") + ' /><span class="radioDot"></span><span class="radioPillLabel">' + esc(label) + "</span></label>";
  }

  // Render the editable metric-form fields (no <form> wrapper, no action buttons — the caller supplies
  // those). `attrs` is a metric's attributes (empty for a new metric). opts.isNew keeps the name editable
  // (auto-derived from the label); for an existing metric the name is immutable and shown read-only.
  function render(attrs, opts) {
    attrs = attrs || {};
    opts = opts || {};
    const isNew = !!opts.isNew;
    const initType = attrs.type || "NUMBER";
    const initKind = attrs.kind || "STORED";
    const initFormula = attrs.formula || null;
    const initOp = (initFormula && initFormula.op) || "SKEW_MS";

    const typePills = TYPES.map((p) => radioPill("mf-type", p[0], p[1], p[0] === initType)).join("");
    const kindPills = KINDS.map((p) => radioPill("mf-kind", p[0], p[1], p[0] === initKind)).join("");
    const opOptions = OPS.map((p) => '<option value="' + p[0] + '"' + (p[0] === initOp ? " selected" : "") + ">" + esc(p[1]) + "</option>").join("");

    const nameHelp = isNew
      ? "The identifier used in the API and a measurement’s JSON — lowercase letters, numbers, and underscores."
      : "The identifier used in the API and a measurement’s JSON. Fixed after creation.";
    return (
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="throughput" autocomplete="off" spellcheck="false"' + (isNew ? "" : " disabled") + ' value="' + esc(attrs.name || "") + '" /><p class="fieldErrorMessage" hidden></p><p class="detailFieldHelp">' + nameHelp + "</p></label>" +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Label</span><input name="label" type="text" placeholder="Throughput" autocomplete="off" value="' + esc(attrs.label || "") + '" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Description</span><input name="description" type="text" placeholder="Optional — a note about this metric" autocomplete="off" value="' + esc(attrs.description || "") + '" /></label>' +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Type</span><div class="radioGroup" role="radiogroup" aria-label="Metric type">' + typePills + "</div></div>" +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Kind</span><div class="radioGroup" role="radiogroup" aria-label="Metric kind">' + kindPills + "</div>" +
      '<p class="detailFieldHelp">Stored — a value clients POST on each measurement. Derived — computed on read from a formula.</p></div>' +
      '<div class="fieldModalBlock" id="mf-formula"><span class="detailFieldLabel fieldRequired">Formula</span>' +
      '<select id="mf-op" class="mfSelect">' + opOptions + "</select>" +
      '<div id="mf-operands" class="enumEditor" style="margin-top:0.5rem;">' +
      '<input type="text" id="mf-a" class="enumValueInput" list="mf-metric-names" autocomplete="off" placeholder="first metric (a)" value="' + esc((initFormula && initFormula.a) || "") + '" />' +
      '<input type="text" id="mf-b" class="enumValueInput" list="mf-metric-names" autocomplete="off" placeholder="second metric (b)" value="' + esc((initFormula && initFormula.b) || "") + '" /></div>' +
      '<datalist id="mf-metric-names"></datalist>' +
      '<p class="detailFieldHelp">Computed on read from a small, built-in set of formulas.</p></div>'
    );
  }

  // Attach live behaviors to a rendered form. `container` holds the fields. opts.isNew enables name
  // auto-derive from the label; opts.selfName excludes a metric from its own operand suggestions.
  function wire(container, opts) {
    opts = opts || {};
    const isNew = !!opts.isNew;
    const nameEl = container.querySelector('[name="name"]');
    const labelEl = container.querySelector('[name="label"]');
    const current = (name) => { const r = container.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; };
    const formulaBlock = container.querySelector("#mf-formula");
    const operandsBlock = container.querySelector("#mf-operands");
    const opSel = container.querySelector("#mf-op");
    function syncKind() { formulaBlock.style.display = current("mf-kind") === "DERIVED" ? "" : "none"; }
    function syncOp() { operandsBlock.style.display = opBinary(opSel.value) ? "" : "none"; }
    syncKind();
    syncOp();

    if (isNew) {
      let nameEdited = false;
      labelEl.addEventListener("input", () => { SM.clearFieldError(labelEl); if (!nameEdited) nameEl.value = metricNameSlug(labelEl.value); });
      nameEl.addEventListener("input", () => {
        nameEdited = true;
        const cleaned = sanitizeName(nameEl.value);
        if (cleaned !== nameEl.value) { const pos = nameEl.selectionStart; nameEl.value = cleaned; try { nameEl.setSelectionRange(pos, pos); } catch (_e) { /* ignore */ } }
        SM.clearFieldError(nameEl);
      });
    } else {
      labelEl.addEventListener("input", () => SM.clearFieldError(labelEl));
    }
    container.querySelectorAll('input[name="mf-kind"]').forEach((r) => r.addEventListener("change", syncKind));
    opSel.addEventListener("change", syncOp);

    // Populate operand suggestions with the account's other metric names.
    apiFetch("/api/v1/metrics?page[size]=1000").then((doc) => {
      const names = ((doc && doc.data) || []).map((r) => (r.attributes || {}).name).filter((n) => n && n !== opts.selfName);
      const dl = container.querySelector("#mf-metric-names");
      if (dl) dl.innerHTML = names.map((n) => '<option value="' + esc(n) + '"></option>').join("");
    }).catch(() => {});
  }

  // Read + validate the form. Returns { ok, attrs } (attrs ready to POST/PUT) or { ok:false } after
  // setting inline field errors. For an existing metric the disabled name input still round-trips (the
  // server treats name as immutable). opts.isNew derives the name from the name-or-label field.
  function collect(container, opts) {
    opts = opts || {};
    const nameEl = container.querySelector('[name="name"]');
    const labelEl = container.querySelector('[name="label"]');
    const current = (name) => { const r = container.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; };
    SM.clearFieldError(labelEl);
    SM.clearFieldError(nameEl);
    const label = labelEl.value.trim();
    if (!label) { SM.setFieldError(labelEl, "A label is required."); return { ok: false }; }
    const name = metricNameSlug(nameEl.value.trim() || label) || metricNameSlug(label);
    if (!name) { SM.setFieldError(nameEl, "Enter a name with letters or numbers."); return { ok: false }; }

    const attrs = { name: name, label: label, type: current("mf-type"), kind: current("mf-kind") };
    const desc = container.querySelector('[name="description"]').value.trim();
    if (desc) attrs.description = desc;
    if (attrs.kind === "DERIVED") {
      const op = container.querySelector("#mf-op").value;
      if (opBinary(op)) {
        const av = container.querySelector("#mf-a").value.trim();
        const bv = container.querySelector("#mf-b").value.trim();
        if (!av || !bv) { return { ok: false, message: "Enter both metrics for this formula." }; }
        attrs.formula = { op: op, a: av, b: bv };
      } else {
        attrs.formula = { op: op };
      }
    }
    return { ok: true, attrs: attrs };
  }

  window.SMMetricForm = {
    render: render,
    wire: wire,
    collect: collect,
    typePillHtml: typePillHtml,
    kindPillHtml: kindPillHtml,
    formulaText: formulaText,
    typeLabel: typeLabel,
    kindLabel: kindLabel,
  };
})();
