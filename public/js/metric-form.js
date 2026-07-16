"use strict";

// Shared metric form + display helpers, used by the Metrics module. The editable form is rendered
// INLINE on the metric detail page (both create and edit), not in a modal, and is split into two tabs:
// a DETAILS tab (name, label, description, unit, format, type) and — for a FORMULA metric — a FORMULA tab that
// builds the compute-on-read expression without any JSON Logic syntax.
//
// The formula is an ordered list of lettered steps (A, B, C…). Each step is either a binary OPERATION
// (`a <op> b`) or a unary FUNCTION (`fn(a)`); each operand slot picks a metric, a literal number, the
// built-in `created_at`, or an earlier step. A RESULT picker names the step that is the metric's value.
// A live preview shows the readable formula and its compiled JSON Logic. This mirrors the server model
// in src/schema/metric.ts (steps → JSON Logic). Depends on shell.js (SM). Exposed as window.SMMetricForm.

(function () {
  const esc = SM.esc;
  // A metric's single type facet: an INTEGER or DECIMAL value clients POST, or a FORMULA computed on read.
  const TYPES = [["INTEGER", "Integer"], ["DECIMAL", "Decimal"], ["FORMULA", "Formula"]];
  // Common units offered as suggestions (free text — any unit is allowed).
  const UNIT_PRESETS = ["ms", "s", "µs", "ns", "bytes", "KB", "MB", "GB", "req/s", "ops/s", "tokens", "tokens/s", "%", "°C", "count", "score"];
  // Format presets → an Excel-style pattern (SM.formatNumber). "" = default; "__custom__" reveals a field.
  const FORMAT_PRESETS = [
    ["", "Default"],
    ["#,##0", "Integer — 1,235"],
    ["#,##0.0", "1 decimal — 1,234.6"],
    ["#,##0.00", "2 decimals — 1,234.57"],
    ["#,##0.000", "3 decimals — 1,234.567"],
    ["0.0%", "Percent — 12.3%"],
    ["__custom__", "Custom…"],
  ];
  function defaultFormatFor(type) { return type === "INTEGER" ? "#,##0" : "#,##0.###"; } // DECIMAL + FORMULA share the decimal default
  const OPS = [["ADD", "+"], ["SUB", "−"], ["MUL", "×"], ["DIV", "÷"], ["MOD", "mod"]];
  const FNS = [["FLOOR", "floor"], ["ROUND", "round"], ["CEIL", "ceil"], ["ABS", "abs"]];
  const OP_SYM = { ADD: "+", SUB: "−", MUL: "×", DIV: "÷", MOD: "mod" };
  const OP_JSON = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%" };
  const FN_JSON = { FLOOR: "floor", ROUND: "round", CEIL: "ceil", ABS: "abs" };
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function typeLabel(t) { const x = TYPES.find((p) => p[0] === t); return x ? x[1] : String(t || ""); }
  function metricNameSlug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60); }
  function sanitizeName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60); }

  // FORMULA gets the accent pill so computed metrics read at a glance in tables + the header.
  function typePillHtml(t) { return '<span class="typePill' + (t === "FORMULA" ? " kindDerived" : "") + '">' + esc(typeLabel(t)) + "</span>"; }

  // ── Formula rendering (shared by the builder preview and the read-only detail view) ──

  // Readable infix string for a token, inlining a STEP by rendering the step it refers to. A nested
  // OPERATION operand is wrapped in parentheses so precedence is never ambiguous.
  function tokenText(tok, byId) {
    if (!tok || !tok.kind) return "…";
    if (tok.kind === "METRIC") return tok.name || "…";
    if (tok.kind === "NUMBER") return String(tok.value);
    if (tok.kind === "CREATED_AT") return "created_at";
    if (tok.kind === "RAW") return tok.text || "…";
    if (tok.kind === "STEP") {
      const s = byId[tok.step];
      if (!s) return "…";
      const inner = stepText(s, byId);
      return s.kind === "OP" ? "(" + inner + ")" : inner;
    }
    return "…";
  }

  // The editable text shown in an operand input for a token (empty when unset).
  function slotDisplay(tok) {
    if (!tok || !tok.kind) return "";
    if (tok.kind === "METRIC") return tok.name || "";
    if (tok.kind === "NUMBER") return String(tok.value);
    if (tok.kind === "CREATED_AT") return "created_at";
    if (tok.kind === "STEP") return tok.step || "";
    if (tok.kind === "RAW") return tok.text || "";
    return "";
  }

  // Parse what the user typed/picked in an operand slot into a token: the built-in `created_at`, an
  // earlier step (A, B…), a known metric, or a number. Anything else is RAW — kept as-is so the preview
  // echoes it, but rejected on save.
  function parseSlotText(text, priorIds, metricNames) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return null;
    if (t === "created_at") return { kind: "CREATED_AT" };
    if (priorIds.indexOf(t) >= 0) return { kind: "STEP", step: t };
    if (metricNames.indexOf(t) >= 0) return { kind: "METRIC", name: t };
    if (Number.isFinite(Number(t))) return { kind: "NUMBER", value: Number(t) };
    return { kind: "RAW", text: t };
  }
  function stepText(step, byId) {
    if (!step) return "…";
    if (step.kind === "FN") return (FN_JSON[step.fn] || "fn") + "(" + tokenText(step.a, byId) + ")";
    return tokenText(step.a, byId) + " " + (OP_SYM[step.op] || "?") + " " + tokenText(step.b, byId);
  }
  function byIdOf(formula) {
    const m = {};
    (formula && formula.steps || []).forEach((s) => { m[s.id] = s; });
    return m;
  }
  // A readable one-line rendering of a whole formula (the result step, fully inlined).
  function formulaText(formula) {
    if (!formula || !Array.isArray(formula.steps) || !formula.steps.length) return "—";
    const byId = byIdOf(formula);
    const result = byId[formula.result] || formula.steps[formula.steps.length - 1];
    return stepText(result, byId);
  }

  // Compile a formula to JSON Logic (client mirror of src/schema/metric.metricExprToJsonLogic), for the
  // "View JSON" preview. Returns null for an empty formula.
  function compileToken(tok, byId, active) {
    if (!tok || !tok.kind) return null;
    if (tok.kind === "METRIC") return { var: "metrics." + (tok.name || "") };
    if (tok.kind === "NUMBER") return tok.value;
    if (tok.kind === "CREATED_AT") return { var: "created_at" };
    if (tok.kind === "STEP") { const s = byId[tok.step]; return s ? compileStep(s, byId, active) : null; }
    return null;
  }
  function compileStep(step, byId, active) {
    if (!step || active[step.id]) return null;
    active[step.id] = true;
    const out = step.kind === "FN"
      ? { [FN_JSON[step.fn]]: [compileToken(step.a, byId, active)] }
      : { [OP_JSON[step.op]]: [compileToken(step.a, byId, active), compileToken(step.b, byId, active)] };
    active[step.id] = false;
    return out;
  }
  function formulaJson(formula) {
    if (!formula || !Array.isArray(formula.steps) || !formula.steps.length) return null;
    const byId = byIdOf(formula);
    const result = byId[formula.result] || formula.steps[formula.steps.length - 1];
    return compileStep(result, byId, {});
  }

  // The Unit + Format fields (shared markup — wireUnitFormat expects these exact control names).
  function unitFormatFieldsHtml(unit, format) {
    const presetVals = FORMAT_PRESETS.map((p) => p[0]);
    const formatSel = !format ? "" : presetVals.indexOf(format) >= 0 ? format : "__custom__";
    const custom = formatSel === "__custom__" ? format : "";
    const formatOptions = FORMAT_PRESETS.map((p) => '<option value="' + esc(p[0]) + '"' + (p[0] === formatSel ? " selected" : "") + ">" + esc(p[1]) + "</option>").join("");
    return (
      '<label class="field"><span class="detailFieldLabel">Unit</span><input name="unit" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. ms, bytes, req/s" maxlength="24" value="' + esc(unit || "") + '" />' +
      '<p class="detailFieldHelp">What the metric measures. A display label — it doesn’t affect computation.</p></label>' +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Format</span>' +
      '<div class="mfFormatRow"><select name="mf-format-preset" class="mfSlotPick mfFormatPreset">' + formatOptions + "</select>" +
      '<input name="mf-format-custom" type="text" class="mfSlotPick mfFormatCustom" autocomplete="off" spellcheck="false" placeholder="#,##0.00" maxlength="32" value="' + esc(custom) + '"' + (formatSel === "__custom__" ? "" : " hidden") + " /></div>" +
      '<p class="detailFieldHelp">How values display. <span class="mfSample">Sample: <b class="mfSampleVal"></b></span></p></div>'
    );
  }

  function radioPill(name, value, label, checked) {
    return '<label class="radioPill"><input type="radio" name="' + name + '" value="' + value + '"' + (checked ? " checked" : "") + ' /><span class="radioDot"></span><span class="radioPillLabel">' + esc(label) + "</span></label>";
  }

  // ── render(): the tabbed form shell + the details fields; the formula builder is filled in by wire() ──
  function render(attrs, opts) {
    attrs = attrs || {};
    opts = opts || {};
    const isNew = !!opts.isNew;
    const initType = attrs.type || "DECIMAL";
    const isFormula = initType === "FORMULA";
    const initUnit = attrs.unit || "";
    const initFormat = attrs.format || "";
    const typePills = TYPES.map((p) => radioPill("mf-type", p[0], p[1], p[0] === initType)).join("");
    const nameHelp = isNew
      ? "The identifier used in the API and a measurement’s JSON — lowercase letters, numbers, and underscores."
      : "The identifier used in the API and a measurement’s JSON. Fixed after creation.";

    const details =
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="throughput" autocomplete="off" spellcheck="false"' + (isNew ? "" : " disabled") + ' value="' + esc(attrs.name || "") + '" /><p class="fieldErrorMessage" hidden></p><p class="detailFieldHelp">' + nameHelp + "</p></label>" +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Label</span><input name="label" type="text" placeholder="Throughput" autocomplete="off" value="' + esc(attrs.label || "") + '" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Description</span><input name="description" type="text" placeholder="Optional — a note about this metric" autocomplete="off" value="' + esc(attrs.description || "") + '" /></label>' +
      unitFormatFieldsHtml(initUnit, initFormat);

    // The Details panel is a two-column grid (matching the view + the other detail pages): the editable
    // fields on the left; the read-only Created / Updated metadata with Type beneath it on the right, so
    // nothing jumps position when the page toggles between view and edit. Created/Updated are absent on
    // a new metric. Picking Formula reveals the Formula tab.
    const meta =
      (attrs.created_at
        ? SM.detailField("Created", { value: SM.fmtDateTime(attrs.created_at) }) + SM.detailField("Updated", { value: SM.fmtDateTime(attrs.updated_at) })
        : "") +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Type</span><div class="radioGroup" role="radiogroup" aria-label="Metric type">' + typePills + "</div>" +
      '<p class="detailFieldHelp">Integer / Decimal — a value clients POST on each measurement. Formula — computed on read from a formula you define.</p></div>';

    // Tabs sit at the top level (a full-width .detailsTabHeader with tabs left, an actions slot right),
    // with the panels below in a single .detailsTabPanel card — the app's standard tabbed-detail layout
    // (matches the settings / subject / benchmark pages). The host fills #mf-tab-actions (Cancel/Save).
    return (
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      '<button type="button" class="modalTabBtn isActive" data-mftab="details" role="tab" aria-selected="true">Details</button>' +
      '<button type="button" class="modalTabBtn" data-mftab="formula" id="mf-tab-formula" role="tab" aria-selected="false"' + (isFormula ? "" : " hidden") + ">Formula</button>" +
      "</nav>" +
      '<div class="detailsTabActions" id="mf-tab-actions"></div></div>' +
      '<div class="detailsTabPanel">' +
      '<div class="mfPanel" data-mfpanel="details"><div class="detailGrid">' +
      '<div class="detailCol">' + details + "</div>" +
      '<div class="detailCol">' + meta + "</div>" +
      "</div></div>" +
      '<div class="mfPanel" data-mfpanel="formula" hidden><div id="mf-builder" class="mfBuilder"></div></div>' +
      "</div>"
    );
  }

  // A default formula for a metric switched to FORMULA with none yet: one empty operation step.
  function defaultFormula() {
    return { steps: [{ id: "A", kind: "OP", op: "DIV", a: null, b: null }], result: "A" };
  }
  // Normalize a stored/loaded formula into the builder's working shape (fill result, coerce tokens).
  function normalizeFormula(formula) {
    if (!formula || !Array.isArray(formula.steps) || !formula.steps.length) return defaultFormula();
    const steps = formula.steps.map((s, i) => {
      const id = s.id || LETTERS[i] || String(i);
      if (s.kind === "FN") return { id, kind: "FN", fn: s.fn || "FLOOR", a: normTok(s.a) };
      return { id, kind: "OP", op: s.op || "ADD", a: normTok(s.a), b: normTok(s.b) };
    });
    const ids = steps.map((s) => s.id);
    const result = ids.indexOf(formula.result) >= 0 ? formula.result : ids[ids.length - 1];
    return { steps, result };
  }
  function normTok(t) {
    if (!t || !t.kind) return null;
    if (t.kind === "METRIC") return { kind: "METRIC", name: metricNameSlug(t.name || "") };
    if (t.kind === "NUMBER") { const v = Number(t.value); return Number.isFinite(v) ? { kind: "NUMBER", value: v } : null; }
    if (t.kind === "CREATED_AT") return { kind: "CREATED_AT" };
    if (t.kind === "STEP") return { kind: "STEP", step: t.step };
    return null;
  }

  // ── wire(): live behaviors — name derive, type→formula-tab, tab switching, and the steps builder ──
  function wire(container, opts) {
    opts = opts || {};
    const isNew = !!opts.isNew;
    const nameEl = container.querySelector('[name="name"]');
    const labelEl = container.querySelector('[name="label"]');
    const current = (name) => { const r = container.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; };

    const state = {
      metrics: [], // [{ name, label }] — the account's other metrics (operand suggestions)
      formula: normalizeFormula(opts.initFormula || (opts.attrs && opts.attrs.formula) || null),
    };
    container.__mfState = state;

    // Tabs
    const tabs = container.querySelectorAll(".modalTabBtn");
    const panels = container.querySelectorAll(".mfPanel");
    function showTab(which) {
      tabs.forEach((t) => {
        const on = t.getAttribute("data-mftab") === which;
        t.classList.toggle("isActive", on);
        t.setAttribute("aria-selected", String(on));
      });
      panels.forEach((p) => { p.hidden = p.getAttribute("data-mfpanel") !== which; });
    }
    tabs.forEach((t) => t.addEventListener("click", () => showTab(t.getAttribute("data-mftab"))));
    container.__mfShowFormulaTab = () => showTab("formula");

    // The FORMULA type reveals/hides the Formula tab.
    const formulaTabBtn = container.querySelector("#mf-tab-formula");
    function syncType() {
      const isFormula = current("mf-type") === "FORMULA";
      formulaTabBtn.hidden = !isFormula;
      if (!isFormula) showTab("details");
    }
    container.querySelectorAll('input[name="mf-type"]').forEach((r) => r.addEventListener("change", syncType));
    syncType();
    // Open on the tab the caller asked for (e.g. Edit was clicked from the Formula tab in view mode).
    if (opts.initTab === "formula" && current("mf-type") === "FORMULA") showTab("formula");

    // Format + unit behaviors (shared with the create wizard).
    wireUnitFormat(container, () => current("mf-type"));

    // Name auto-derive from label (create only).
    wireNameDerive(nameEl, labelEl, isNew);

    // ── Steps builder ──
    const builder = container.querySelector("#mf-builder");
    wireFormulaBuilder(builder, state, opts.selfName);
  }

  // Unit combobox + format preset/custom select with a live sample. Expects the container to hold
  // [name=unit], [name=mf-format-preset], [name=mf-format-custom], and .mfSampleVal (see
  // unitFormatFieldsHtml / render). `getType` supplies the metric type the default format derives from.
  // Stores the current-format reader on container.__mfFormat.
  function wireUnitFormat(container, getType) {
    const unitEl = container.querySelector('[name="unit"]');
    // Unit presets via the shared themed popup (free text stays allowed — the popup hides on no match).
    SM.combobox(unitEl, { options: () => UNIT_PRESETS, emptyText: null });
    const fmtPreset = container.querySelector('[name="mf-format-preset"]');
    const fmtCustom = container.querySelector('[name="mf-format-custom"]');
    const sampleEl = container.querySelector(".mfSampleVal");
    function formatValue() {
      return fmtPreset.value === "__custom__" ? fmtCustom.value.trim() : fmtPreset.value;
    }
    container.__mfFormat = formatValue; // read by collect() / the wizard
    function updateSample() {
      const pattern = formatValue() || defaultFormatFor(getType());
      const unit = unitEl.value.trim();
      const seed = /%/.test(pattern) ? 0.1234 : 1234.567;
      sampleEl.textContent = SM.formatNumber(seed, pattern) + (unit ? " " + unit : "");
    }
    fmtPreset.addEventListener("change", () => {
      fmtCustom.hidden = fmtPreset.value !== "__custom__";
      if (!fmtCustom.hidden) fmtCustom.focus();
      updateSample();
    });
    fmtCustom.addEventListener("input", updateSample);
    unitEl.addEventListener("input", updateSample);
    container.querySelectorAll('input[name="mf-type"]').forEach((r) => r.addEventListener("change", updateSample));
    container.__mfUpdateSample = updateSample;
    updateSample();
  }

  // Name auto-derives from the label until the user edits it directly (create only).
  function wireNameDerive(nameEl, labelEl, isNew) {
    if (!isNew) {
      labelEl.addEventListener("input", () => SM.clearFieldError(labelEl));
      return;
    }
    let nameEdited = nameEl.value.trim() !== "" && nameEl.value !== metricNameSlug(labelEl.value);
    labelEl.addEventListener("input", () => { SM.clearFieldError(labelEl); if (!nameEdited) nameEl.value = metricNameSlug(labelEl.value); });
    nameEl.addEventListener("input", () => {
      nameEdited = true;
      const cleaned = sanitizeName(nameEl.value);
      if (cleaned !== nameEl.value) { const pos = nameEl.selectionStart; nameEl.value = cleaned; try { nameEl.setSelectionRange(pos, pos); } catch (_e) { /* ignore */ } }
      SM.clearFieldError(nameEl);
    });
  }

  // The lettered-steps formula builder, wired into `builder` against `state` ({ metrics, formula }).
  // Shared by the tabbed form and the create wizard (whose pages re-mount it against persistent state).
  function wireFormulaBuilder(builder, state, selfName) {

    // One operand slot — an editable combobox (SM.combobox provides the themed popup). The popup lists
    // every metric, the built-in `created_at`, and the earlier steps (A, B…), grouped and filtered as
    // the user types; they can pick one or just type a number. The typed value is parsed into a token on
    // input and validated on save.
    function slotHtml(tok, si, slot) {
      return '<span class="mfSlot">' +
        '<input class="mfSlotInput" data-role="slot" data-si="' + si + '" data-slot="' + slot + '" autocomplete="off" spellcheck="false" placeholder="metric / step / number" value="' + esc(slotDisplay(tok)) + '" /></span>';
    }

    // The option groups available to a slot on step `si` (earlier steps only — no self/forward refs).
    function slotGroups(si) {
      const priorIds = state.formula.steps.slice(0, si).map((s) => s.id);
      const groups = [];
      if (state.metrics.length) groups.push(["Metrics", state.metrics.map((m) => m.name)]);
      groups.push(["Built-in", ["created_at"]]);
      if (priorIds.length) groups.push(["Steps", priorIds]);
      return groups;
    }

    function stepRowHtml(step, si) {
      const letter = '<span class="mfLetter">' + esc(step.id) + "</span>";
      const kindToggle =
        '<span class="mfStepKind" role="group" aria-label="Step kind">' +
        '<button type="button" class="mfKindBtn' + (step.kind === "OP" ? " isActive" : "") + '" data-role="stepkind" data-si="' + si + '" data-kind="OP">Operation</button>' +
        '<button type="button" class="mfKindBtn' + (step.kind === "FN" ? " isActive" : "") + '" data-role="stepkind" data-si="' + si + '" data-kind="FN">Function</button>' +
        "</span>";
      let body;
      if (step.kind === "FN") {
        const fnOpts = FNS.map((p) => '<option value="' + p[0] + '"' + (p[0] === step.fn ? " selected" : "") + ">" + esc(p[1]) + "</option>").join("");
        body = '<select class="mfFn" data-role="fn" data-si="' + si + '">' + fnOpts + "</select>" +
          '<span class="mfParen">(</span>' + slotHtml(step.a, si, "a") + '<span class="mfParen">)</span>';
      } else {
        const opOpts = OPS.map((p) => '<option value="' + p[0] + '"' + (p[0] === step.op ? " selected" : "") + ">" + esc(p[1]) + "</option>").join("");
        body = slotHtml(step.a, si, "a") +
          '<select class="mfOp" data-role="op" data-si="' + si + '">' + opOpts + "</select>" +
          slotHtml(step.b, si, "b");
      }
      const del = state.formula.steps.length > 1
        ? '<button type="button" class="mfStepDel" data-role="delstep" data-si="' + si + '" aria-label="Remove step ' + esc(step.id) + '">' + SM.icon("trash", 16) + "</button>"
        : "";
      return '<div class="mfStepRow">' + letter + '<div class="mfStepBody">' + kindToggle + '<div class="mfStepExpr">' + body + "</div></div>" + del + "</div>";
    }

    function resultRowHtml() {
      const opts = state.formula.steps.map((s) => '<option value="' + esc(s.id) + '"' + (s.id === state.formula.result ? " selected" : "") + ">" + esc(s.id) + "</option>").join("");
      return '<div class="mfResultRow"><span class="mfSectionLabel">Result</span><select class="mfResult" data-role="result">' + opts + "</select>" +
        '<span class="mfResultHint">the step that is this metric’s value</span></div>';
    }

    function previewHtml() {
      const text = formulaText(state.formula);
      return '<div class="mfPreview"><div class="mfPreviewHead"><span class="mfSectionLabel">Preview</span>' +
        '<button type="button" class="buttonLink" data-role="viewjson">View JSON</button></div>' +
        '<div class="mfPreviewText">' + esc(text) + "</div></div>";
    }

    function renderBuilder() {
      const steps = state.formula.steps.map((s, i) => stepRowHtml(s, i)).join("");
      builder.innerHTML =
        '<div class="mfSectionLabel mfStepsLabel">Steps</div>' +
        '<p class="detailFieldHelp mfStepsHelp">Each slot takes a metric, an earlier step (A, B…), or a number — type it or pick from the list.</p>' +
        '<div class="mfSteps">' + steps + "</div>" +
        '<div class="mfAddRow">' +
        '<button type="button" class="buttonLink" data-role="addop">' + SM.icon("plus", 14) + " Operation</button>" +
        '<button type="button" class="buttonLink" data-role="addfn">' + SM.icon("plus", 14) + " Function</button>" +
        "</div>" +
        resultRowHtml() +
        previewHtml();
      // Every operand slot gets the shared themed popup (metrics / created_at / earlier steps).
      builder.querySelectorAll(".mfSlotInput").forEach((inp) => {
        const si = Number(inp.getAttribute("data-si"));
        SM.combobox(inp, { options: () => slotGroups(si), emptyText: "No matches — a number works too", mono: true });
      });
    }
    function updatePreviewOnly() {
      const el = builder.querySelector(".mfPreviewText");
      if (el) el.textContent = formulaText(state.formula);
    }

    function nextId() {
      const used = new Set(state.formula.steps.map((s) => s.id));
      for (const c of LETTERS) if (!used.has(c)) return c;
      return "S" + (state.formula.steps.length + 1);
    }
    function removeStepRefs(removedId) {
      // Any operand that pointed at the removed step becomes unset (must be re-picked).
      state.formula.steps.forEach((s) => {
        ["a", "b"].forEach((k) => { if (s[k] && s[k].kind === "STEP" && s[k].step === removedId) s[k] = null; });
      });
      if (state.formula.result === removedId) state.formula.result = state.formula.steps[state.formula.steps.length - 1].id;
    }
    // op / fn / result are <select>s (fixed sets) — a change updates the model + preview, no re-render.
    builder.addEventListener("change", (e) => {
      const t = e.target;
      const role = t.getAttribute && t.getAttribute("data-role");
      if (!role) return;
      const si = Number(t.getAttribute("data-si"));
      if (role === "op") { state.formula.steps[si].op = t.value; updatePreviewOnly(); }
      else if (role === "fn") { state.formula.steps[si].fn = t.value; updatePreviewOnly(); }
      else if (role === "result") { state.formula.result = t.value; updatePreviewOnly(); }
    });
    // Operand slots are editable inputs — parse on each keystroke (no re-render, so focus is kept).
    // The popup itself (open/filter/pick/keyboard) is SM.combobox's, attached in renderBuilder.
    builder.addEventListener("input", (e) => {
      const t = e.target;
      if (!t.getAttribute || t.getAttribute("data-role") !== "slot") return;
      const si = Number(t.getAttribute("data-si"));
      const priorIds = state.formula.steps.slice(0, si).map((s) => s.id);
      const metricNames = state.metrics.map((m) => m.name);
      state.formula.steps[si][t.getAttribute("data-slot")] = parseSlotText(t.value, priorIds, metricNames);
      updatePreviewOnly();
    });
    builder.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-role]");
      if (!btn || !builder.contains(btn)) return;
      const role = btn.getAttribute("data-role");
      if (role === "addop") {
        const id = nextId();
        state.formula.steps.push({ id, kind: "OP", op: "ADD", a: null, b: null });
        state.formula.result = id; renderBuilder();
      } else if (role === "addfn") {
        const id = nextId();
        state.formula.steps.push({ id, kind: "FN", fn: "FLOOR", a: null });
        state.formula.result = id; renderBuilder();
      } else if (role === "stepkind") {
        const step = state.formula.steps[Number(btn.getAttribute("data-si"))];
        const kind = btn.getAttribute("data-kind");
        if (step.kind !== kind) {
          if (kind === "FN") { step.kind = "FN"; step.fn = step.fn || "FLOOR"; delete step.op; delete step.b; }
          else { step.kind = "OP"; step.op = step.op || "ADD"; delete step.fn; if (!("b" in step)) step.b = null; }
          renderBuilder();
        }
      } else if (role === "delstep") {
        const si = Number(btn.getAttribute("data-si"));
        const removed = state.formula.steps[si];
        state.formula.steps.splice(si, 1);
        removeStepRefs(removed.id);
        renderBuilder();
      } else if (role === "viewjson") {
        showJson();
      }
    });

    function showJson() {
      const json = formulaJson(state.formula);
      const pretty = json ? JSON.stringify(json, null, 2) : "// finish the formula to see its JSON Logic";
      const m = SM.modal({
        title: "Compiled JSON Logic",
        description: "What the compute-on-read engine evaluates for this metric.",
        width: 560,
        bodyHtml: '<pre class="mfJson"><code></code></pre>',
      });
      m.panel.querySelector("code").textContent = pretty;
    }

    renderBuilder();

    // Load the account's other metric names for the operand pickers, then re-render. Skipped when the
    // caller re-mounts the builder against already-loaded state (the wizard revisiting its page).
    if (state.metricsLoaded) return;
    apiFetch("/api/v1/metrics?page[size]=1000").then((doc) => {
      state.metrics = ((doc && doc.data) || [])
        .map((r) => r.attributes || {})
        .filter((m) => m.name && m.name !== selfName)
        .map((m) => ({ name: m.name, label: m.label || m.name }));
      state.metricsLoaded = true;
      renderBuilder();
    }).catch(() => {});
  }

  // ── collect(): validate + return the attributes to POST/PUT ──
  function collect(container, opts) {
    opts = opts || {};
    const nameEl = container.querySelector('[name="name"]');
    const labelEl = container.querySelector('[name="label"]');
    const current = (name) => { const r = container.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; };
    SM.clearFieldError(labelEl);
    SM.clearFieldError(nameEl);
    const label = labelEl.value.trim();
    if (!label) { container.__mfShowFormulaTab && showDetails(container); SM.setFieldError(labelEl, "A label is required."); return { ok: false }; }
    const name = metricNameSlug(nameEl.value.trim() || label) || metricNameSlug(label);
    if (!name) { SM.setFieldError(nameEl, "Enter a name with letters or numbers."); return { ok: false }; }

    const attrs = { name: name, label: label, type: current("mf-type") };
    const desc = container.querySelector('[name="description"]').value.trim();
    if (desc) attrs.description = desc;
    const unit = container.querySelector('[name="unit"]').value.trim();
    if (unit) attrs.unit = unit;
    const format = container.__mfFormat ? container.__mfFormat() : "";
    if (format) attrs.format = format;

    if (attrs.type === "FORMULA") {
      const state = container.__mfState;
      const formula = state && state.formula;
      const bad = validateFormula(formula);
      if (bad) { container.__mfShowFormulaTab && container.__mfShowFormulaTab(); return { ok: false, message: bad }; }
      attrs.formula = formula;
    }
    return { ok: true, attrs: attrs };
  }

  function showDetails(container) {
    const tabs = container.querySelectorAll(".modalTabBtn");
    const panels = container.querySelectorAll(".mfPanel");
    tabs.forEach((t) => {
      const on = t.getAttribute("data-mftab") === "details";
      t.classList.toggle("isActive", on);
      t.setAttribute("aria-selected", String(on));
    });
    panels.forEach((p) => { p.hidden = p.getAttribute("data-mfpanel") !== "details"; });
  }

  // Return an error message if any slot is empty or unresolved (not a metric, step, or number), else null.
  function validateFormula(formula) {
    if (!formula || !Array.isArray(formula.steps) || !formula.steps.length) return "Add at least one step to the formula.";
    const problem = (t) => {
      if (!t) return "empty";
      if (t.kind === "RAW") return t.text || "invalid";
      if (t.kind === "NUMBER" && !Number.isFinite(t.value)) return "invalid";
      if (["METRIC", "CREATED_AT", "STEP", "NUMBER"].indexOf(t.kind) < 0) return "invalid";
      return null;
    };
    for (const s of formula.steps) {
      const slots = s.kind === "OP" ? ["a", "b"] : ["a"];
      for (const k of slots) {
        const p = problem(s[k]);
        if (p === "empty") return "Every slot needs a metric, an earlier step, or a number.";
        if (p) return "“" + p + "” isn’t a metric, step, or number — pick one from the list or enter a number.";
      }
    }
    return null;
  }

  // Which tab (details / formula) is currently active in a rendered form — read on save/cancel so the
  // page can return to the same tab in view mode.
  function activeTab(container) {
    const t = container.querySelector(".modalTabBtn.isActive");
    return t ? t.getAttribute("data-mftab") : "details";
  }

  // ── Create wizard ── a 2-3 page modal: (1) name + label + type, (2) description + unit + format,
  // (3) the formula builder — page 3 exists only for a FORMULA metric. Values persist across pages
  // (Back re-renders with what was entered). Finish POSTs /metrics, then awaits opts.onDone(created)
  // — the caller links/navigates there; if onDone throws, the created metric is RETAINED so a retry
  // never mints a duplicate (it only re-runs onDone). Options: title, description, submitLabel, onDone.
  function openWizard(wopts) {
    wopts = wopts || {};
    const submitLabel = wopts.submitLabel || "Create metric";
    const data = { name: "", label: "", type: "DECIMAL", description: "", unit: "", format: "" };
    const fstate = { metrics: [], metricsLoaded: false, formula: normalizeFormula(null) }; // persists across page visits
    let created = null; // survives a failed onDone so a retry doesn't re-create the metric
    let busy = false;   // guards finish() re-entry (double-click, or Back + forward during the flight)
    const m = SM.modal({
      title: wopts.title || "New metric",
      description: wopts.description || "Define a new metric.",
      bodyHtml: '<div id="mw-root" class="form"></div>',
      width: 640,
    });
    const root = m.panel.querySelector("#mw-root");
    // Page navs are re-injected on every render, after SM.modal wired [data-close] — delegate instead.
    root.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) m.close(); });

    const pageCount = () => (data.type === "FORMULA" ? 3 : 2);
    function dots(active) {
      let out = '<div class="wzSteps" aria-hidden="true">';
      for (let i = 0; i < pageCount(); i++) out += '<span class="wzDot' + (i === active ? " isActive" : "") + '"></span>';
      return out + "</div>";
    }
    function nav(backFn, nextLabel) {
      return '<div class="modalActions">' +
        (backFn ? '<button type="button" class="button buttonSecondary buttonSmall" id="mw-back">Back</button>' : '<button type="button" class="button buttonSecondary buttonSmall" data-close>Cancel</button>') +
        '<button type="button" class="button buttonPrimary buttonSmall" id="mw-next">' + esc(nextLabel) + "</button></div>";
    }
    function setMsg(text) {
      const el = root.querySelector("#mw-msg");
      el.textContent = text || "";
      el.className = "form-status" + (text ? " is-error" : "");
    }

    // ── Page 1: name + label + type ──
    function renderIdentity() {
      const typePills = TYPES.map((p) => radioPill("mw-type", p[0], p[1], p[0] === data.type)).join("");
      root.innerHTML =
        '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input id="mw-name" type="text" placeholder="throughput" autocomplete="off" spellcheck="false" value="' + esc(data.name) + '" /><p class="fieldErrorMessage" hidden></p>' +
        '<p class="detailFieldHelp">The identifier used in the API and a measurement’s JSON — lowercase letters, numbers, and underscores.</p></label>' +
        '<label class="field"><span class="detailFieldLabel fieldRequired">Label</span><input id="mw-label" type="text" placeholder="Throughput" autocomplete="off" value="' + esc(data.label) + '" /><p class="fieldErrorMessage" hidden></p></label>' +
        '<div class="fieldModalBlock"><span class="detailFieldLabel">Type</span><div class="radioGroup" role="radiogroup" aria-label="Metric type">' + typePills + "</div>" +
        '<p class="detailFieldHelp">Integer / Decimal — a value clients POST on each measurement. Formula — computed on read from a formula you define.</p></div>' +
        '<p class="form-status" id="mw-msg"></p>' +
        dots(0) + nav(null, "Next");
      const nameEl = root.querySelector("#mw-name");
      const labelEl = root.querySelector("#mw-label");
      nameEl.setAttribute("name", "name"); // wireNameDerive is selector-free, but keep parity with the form
      wireNameDerive(nameEl, labelEl, true);
      nameEl.addEventListener("input", () => { data.name = nameEl.value; });
      labelEl.addEventListener("input", () => { data.label = labelEl.value; data.name = nameEl.value; });
      root.querySelectorAll('input[name="mw-type"]').forEach((r) => r.addEventListener("change", () => {
        data.type = r.value;
        renderIdentity(); // the page count (dots) depends on the type
      }));
      root.querySelector("#mw-next").addEventListener("click", () => {
        SM.clearFieldError(labelEl); SM.clearFieldError(nameEl);
        data.label = labelEl.value.trim();
        data.name = metricNameSlug(nameEl.value.trim() || data.label);
        if (!data.label) { SM.setFieldError(labelEl, "A label is required."); labelEl.focus(); return; }
        if (!data.name) { SM.setFieldError(nameEl, "Enter a name with letters or numbers."); nameEl.focus(); return; }
        renderDisplay();
      });
      (data.label ? labelEl : nameEl).focus();
    }

    // ── Page 2: description + unit + format ──
    function renderDisplay() {
      root.innerHTML =
        '<label class="field"><span class="detailFieldLabel">Description</span><input id="mw-desc" type="text" placeholder="Optional — a note about this metric" autocomplete="off" value="' + esc(data.description) + '" /></label>' +
        unitFormatFieldsHtml(data.unit, data.format) +
        '<p class="form-status" id="mw-msg"></p>' +
        dots(1) + nav(renderIdentity, data.type === "FORMULA" ? "Next" : submitLabel);
      wireUnitFormat(root, () => data.type);
      const save = () => {
        data.description = root.querySelector("#mw-desc").value.trim();
        data.unit = root.querySelector('[name="unit"]').value.trim();
        data.format = root.__mfFormat ? root.__mfFormat() : "";
      };
      root.querySelector("#mw-back").addEventListener("click", () => { save(); renderIdentity(); });
      root.querySelector("#mw-next").addEventListener("click", () => {
        save();
        if (data.type === "FORMULA") renderFormulaPage();
        else finish();
      });
      root.querySelector("#mw-desc").focus();
    }

    // ── Page 3 (FORMULA only): the steps builder ──
    function renderFormulaPage() {
      root.innerHTML =
        '<div id="mw-builder" class="mfBuilder"></div>' +
        '<p class="form-status" id="mw-msg"></p>' +
        dots(2) + nav(renderDisplay, submitLabel);
      wireFormulaBuilder(root.querySelector("#mw-builder"), fstate, null);
      root.querySelector("#mw-back").addEventListener("click", renderDisplay);
      root.querySelector("#mw-next").addEventListener("click", finish);
    }

    async function finish() {
      if (busy) return;
      if (data.type === "FORMULA") {
        const bad = validateFormula(fstate.formula);
        if (bad) { setMsg(bad); return; }
      }
      const attrs = { name: data.name, label: data.label, type: data.type };
      if (data.description) attrs.description = data.description;
      if (data.unit) attrs.unit = data.unit;
      if (data.format) attrs.format = data.format;
      if (data.type === "FORMULA") attrs.formula = fstate.formula;
      busy = true;
      const btn = root.querySelector("#mw-next"); btn.disabled = true;
      const back = root.querySelector("#mw-back"); if (back) back.disabled = true;
      setMsg("");
      try {
        if (!created) {
          const doc = await apiFetch("/api/v1/metrics", { method: "POST", body: jsonapiBody("metric", attrs) });
          created = doc && doc.data;
        } else if ((created.attributes || {}).name !== attrs.name) {
          // Retry after a failed onDone, and the user renamed via Back. Name is immutable on PUT, and
          // the retained metric is still unlinked (onDone failed), so replace it outright.
          await apiFetch("/api/v1/metrics/" + encodeURIComponent(created.id), { method: "DELETE" });
          created = null;
          const doc = await apiFetch("/api/v1/metrics", { method: "POST", body: jsonapiBody("metric", attrs) });
          created = doc && doc.data;
        } else {
          // Retry after a failed onDone: other fields may have been edited via Back — sync the
          // retained metric so the retry never links/opens a stale definition.
          const doc = await apiFetch("/api/v1/metrics/" + encodeURIComponent(created.id), { method: "PUT", body: jsonapiBody("metric", attrs) });
          created = (doc && doc.data) || created;
        }
        if (!root.isConnected) return; // closed (Escape/×) mid-create — leave the metric in the library, do nothing
        if (wopts.onDone) await wopts.onDone(created);
        m.close();
      } catch (err) {
        busy = false;
        if (!root.isConnected) return; // closed mid-flight; nowhere to show the error
        btn.disabled = false;
        if (back) back.disabled = false;
        const note = created ? " The metric was created — retrying won’t create a duplicate." : "";
        setMsg(err.message + note);
      }
    }

    renderIdentity();
    return m;
  }

  window.SMMetricForm = {
    render: render,
    wire: wire,
    collect: collect,
    activeTab: activeTab,
    openWizard: openWizard,
    typePillHtml: typePillHtml,
    formulaText: formulaText,
    formulaJson: formulaJson,
    typeLabel: typeLabel,
  };
})();
