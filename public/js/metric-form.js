"use strict";

// Shared metric form + display helpers, used by the Metrics module. The editable form is rendered
// INLINE on the metric detail page (both create and edit), not in a modal, and is split into two tabs:
// a DETAILS tab (name, label, description, type, kind) and — for a DERIVED metric — a FORMULA tab that
// builds the compute-on-read expression without any JSON Logic syntax.
//
// The formula is an ordered list of lettered steps (A, B, C…). Each step is either a binary OPERATION
// (`a <op> b`) or a unary FUNCTION (`fn(a)`); each operand slot picks a metric, a literal number, the
// built-in `created_at`, or an earlier step. A RESULT picker names the step that is the metric's value.
// A live preview shows the readable formula and its compiled JSON Logic. This mirrors the server model
// in src/schema/metric.ts (steps → JSON Logic). Depends on shell.js (SM). Exposed as window.SMMetricForm.

(function () {
  const esc = SM.esc;
  const TYPES = [["INTEGER", "Integer"], ["DECIMAL", "Decimal"]];
  const KINDS = [["STORED", "Stored"], ["DERIVED", "Derived"]];
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
  function defaultFormatFor(type) { return type === "INTEGER" ? "#,##0" : "#,##0.###"; }
  const OPS = [["ADD", "+"], ["SUB", "−"], ["MUL", "×"], ["DIV", "÷"], ["MOD", "mod"]];
  const FNS = [["FLOOR", "floor"], ["ROUND", "round"], ["CEIL", "ceil"], ["ABS", "abs"]];
  const OP_SYM = { ADD: "+", SUB: "−", MUL: "×", DIV: "÷", MOD: "mod" };
  const OP_JSON = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%" };
  const FN_JSON = { FLOOR: "floor", ROUND: "round", CEIL: "ceil", ABS: "abs" };
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function typeLabel(t) { const x = TYPES.find((p) => p[0] === t); return x ? x[1] : String(t || ""); }
  function kindLabel(k) { const x = KINDS.find((p) => p[0] === k); return x ? x[1] : String(k || ""); }
  function metricNameSlug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60); }
  function sanitizeName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60); }

  function typePillHtml(t) { return '<span class="typePill">' + esc(typeLabel(t)) + "</span>"; }
  function kindPillHtml(k) { return '<span class="typePill' + (k === "DERIVED" ? " kindDerived" : "") + '">' + esc(kindLabel(k)) + "</span>"; }

  // ── Formula rendering (shared by the builder preview and the read-only detail view) ──

  // Readable infix string for a token, inlining a STEP by rendering the step it refers to. A nested
  // OPERATION operand is wrapped in parentheses so precedence is never ambiguous.
  function tokenText(tok, byId) {
    if (!tok || !tok.kind) return "…";
    if (tok.kind === "METRIC") return tok.name || "…";
    if (tok.kind === "NUMBER") return String(tok.value);
    if (tok.kind === "CREATED_AT") return "created_at";
    if (tok.kind === "STEP") {
      const s = byId[tok.step];
      if (!s) return "…";
      const inner = stepText(s, byId);
      return s.kind === "OP" ? "(" + inner + ")" : inner;
    }
    return "…";
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

  function radioPill(name, value, label, checked) {
    return '<label class="radioPill"><input type="radio" name="' + name + '" value="' + value + '"' + (checked ? " checked" : "") + ' /><span class="radioDot"></span><span class="radioPillLabel">' + esc(label) + "</span></label>";
  }

  // ── render(): the tabbed form shell + the details fields; the formula builder is filled in by wire() ──
  function render(attrs, opts) {
    attrs = attrs || {};
    opts = opts || {};
    const isNew = !!opts.isNew;
    const initType = attrs.type || "DECIMAL";
    const initKind = attrs.kind || "STORED";
    const derived = initKind === "DERIVED";
    const initUnit = attrs.unit || "";
    const initFormat = attrs.format || "";
    const presetVals = FORMAT_PRESETS.map((p) => p[0]);
    const initFormatSel = initFormat === "" ? "" : presetVals.indexOf(initFormat) >= 0 ? initFormat : "__custom__";
    const initCustom = initFormatSel === "__custom__" ? initFormat : "";

    const typePills = TYPES.map((p) => radioPill("mf-type", p[0], p[1], p[0] === initType)).join("");
    const kindPills = KINDS.map((p) => radioPill("mf-kind", p[0], p[1], p[0] === initKind)).join("");
    const unitDatalist = '<datalist id="mf-unit-presets">' + UNIT_PRESETS.map((u) => '<option value="' + esc(u) + '"></option>').join("") + "</datalist>";
    const formatOptions = FORMAT_PRESETS.map((p) => '<option value="' + esc(p[0]) + '"' + (p[0] === initFormatSel ? " selected" : "") + ">" + esc(p[1]) + "</option>").join("");
    const nameHelp = isNew
      ? "The identifier used in the API and a measurement’s JSON — lowercase letters, numbers, and underscores."
      : "The identifier used in the API and a measurement’s JSON. Fixed after creation.";

    const details =
      '<label class="field"><span class="detailFieldLabel fieldRequired">Name</span><input name="name" type="text" placeholder="throughput" autocomplete="off" spellcheck="false"' + (isNew ? "" : " disabled") + ' value="' + esc(attrs.name || "") + '" /><p class="fieldErrorMessage" hidden></p><p class="detailFieldHelp">' + nameHelp + "</p></label>" +
      '<label class="field"><span class="detailFieldLabel fieldRequired">Label</span><input name="label" type="text" placeholder="Throughput" autocomplete="off" value="' + esc(attrs.label || "") + '" /><p class="fieldErrorMessage" hidden></p></label>' +
      '<label class="field"><span class="detailFieldLabel">Description</span><input name="description" type="text" placeholder="Optional — a note about this metric" autocomplete="off" value="' + esc(attrs.description || "") + '" /></label>' +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Type</span><div class="radioGroup" role="radiogroup" aria-label="Metric type">' + typePills + "</div>" +
      '<p class="detailFieldHelp">Every metric is a number. Integer — whole numbers; Decimal — continuous.</p></div>' +
      '<label class="field"><span class="detailFieldLabel">Unit</span><input name="unit" type="text" list="mf-unit-presets" autocomplete="off" spellcheck="false" placeholder="e.g. ms, bytes, req/s" maxlength="24" value="' + esc(initUnit) + '" />' + unitDatalist +
      '<p class="detailFieldHelp">What the metric measures. A display label — it doesn’t affect computation.</p></label>' +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Format</span>' +
      '<div class="mfFormatRow"><select name="mf-format-preset" class="mfSlotPick mfFormatPreset">' + formatOptions + "</select>" +
      '<input name="mf-format-custom" type="text" class="mfSlotPick mfFormatCustom" autocomplete="off" spellcheck="false" placeholder="#,##0.00" maxlength="32" value="' + esc(initCustom) + '"' + (initFormatSel === "__custom__" ? "" : " hidden") + " /></div>" +
      '<p class="detailFieldHelp">How values display. <span class="mfSample">Sample: <b class="mfSampleVal"></b></span></p></div>' +
      '<div class="fieldModalBlock"><span class="detailFieldLabel">Kind</span><div class="radioGroup" role="radiogroup" aria-label="Metric kind">' + kindPills + "</div>" +
      '<p class="detailFieldHelp">Stored — a value clients POST on each measurement. Derived — computed on read from a formula.</p></div>';

    return (
      '<div class="detailsTabHeader"><nav class="modalTabBar" role="tablist">' +
      '<button type="button" class="modalTabBtn isActive" data-mftab="details" role="tab" aria-selected="true">Details</button>' +
      '<button type="button" class="modalTabBtn" data-mftab="formula" id="mf-tab-formula" role="tab" aria-selected="false"' + (derived ? "" : " hidden") + ">Formula</button>" +
      "</nav></div>" +
      '<div class="mfPanel" data-mfpanel="details">' + details + "</div>" +
      '<div class="mfPanel" data-mfpanel="formula" hidden><div id="mf-builder" class="mfBuilder"></div></div>'
    );
  }

  // A default formula for a metric switched to DERIVED with none yet: one empty operation step.
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

  // Encode/decode a token as a <select> value. NUMBER is a sentinel that reveals a number input.
  function tokValue(tok) {
    if (!tok || !tok.kind) return "";
    if (tok.kind === "METRIC") return "metric:" + tok.name;
    if (tok.kind === "NUMBER") return "__number__";
    if (tok.kind === "CREATED_AT") return "__created_at__";
    if (tok.kind === "STEP") return "step:" + tok.step;
    return "";
  }

  // ── wire(): live behaviors — name derive, kind→formula-tab, tab switching, and the steps builder ──
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

    // Kind toggle reveals/hides the Formula tab.
    const formulaTabBtn = container.querySelector("#mf-tab-formula");
    function syncKind() {
      const derived = current("mf-kind") === "DERIVED";
      formulaTabBtn.hidden = !derived;
      if (!derived) showTab("details");
    }
    container.querySelectorAll('input[name="mf-kind"]').forEach((r) => r.addEventListener("change", syncKind));
    syncKind();

    // Format: a preset <select> plus a custom-pattern input (shown only for "Custom…"), with a live
    // sample that reflects the current pattern, type default, and unit.
    const unitEl = container.querySelector('[name="unit"]');
    const fmtPreset = container.querySelector('[name="mf-format-preset"]');
    const fmtCustom = container.querySelector('[name="mf-format-custom"]');
    const sampleEl = container.querySelector(".mfSampleVal");
    function formatValue() {
      return fmtPreset.value === "__custom__" ? fmtCustom.value.trim() : fmtPreset.value;
    }
    container.__mfFormat = formatValue; // read by collect()
    function updateSample() {
      const pattern = formatValue() || defaultFormatFor(current("mf-type"));
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
    updateSample();

    // Name auto-derive from label (create only).
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

    // ── Steps builder ──
    const builder = container.querySelector("#mf-builder");

    // One operand slot: a picker (metrics / created_at / earlier steps / number) plus a number input
    // shown only when "number" is chosen. `priorIds` are the step ids selectable here (earlier steps).
    function slotHtml(tok, si, slot, priorIds) {
      const val = tokValue(tok);
      const metricOpts = state.metrics.map((m) => '<option value="metric:' + esc(m.name) + '"' + (val === "metric:" + m.name ? " selected" : "") + ">" + esc(m.name) + "</option>").join("");
      const stepOpts = priorIds.map((id) => '<option value="step:' + esc(id) + '"' + (val === "step:" + id ? " selected" : "") + ">" + esc(id) + "</option>").join("");
      const sel =
        '<select class="mfSlotPick" data-role="slot" data-si="' + si + '" data-slot="' + slot + '">' +
        '<option value=""' + (val === "" ? " selected" : "") + ">Pick…</option>" +
        (metricOpts ? '<optgroup label="Metrics">' + metricOpts + "</optgroup>" : "") +
        (stepOpts ? '<optgroup label="Steps">' + stepOpts + "</optgroup>" : "") +
        '<optgroup label="Built-in"><option value="__created_at__"' + (val === "__created_at__" ? " selected" : "") + ">created_at</option></optgroup>" +
        '<option value="__number__"' + (val === "__number__" ? " selected" : "") + ">number…</option>" +
        "</select>";
      const numVal = tok && tok.kind === "NUMBER" ? tok.value : "";
      const num = '<input type="number" step="any" class="mfSlotNum" data-role="num" data-si="' + si + '" data-slot="' + slot + '" placeholder="0" value="' + esc(String(numVal)) + '"' + (val === "__number__" ? "" : " hidden") + " />";
      return '<span class="mfSlot">' + sel + num + "</span>";
    }

    function stepRowHtml(step, si) {
      const priorIds = state.formula.steps.slice(0, si).map((s) => s.id);
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
          '<span class="mfParen">(</span>' + slotHtml(step.a, si, "a", priorIds) + '<span class="mfParen">)</span>';
      } else {
        const opOpts = OPS.map((p) => '<option value="' + p[0] + '"' + (p[0] === step.op ? " selected" : "") + ">" + esc(p[1]) + "</option>").join("");
        body = slotHtml(step.a, si, "a", priorIds) +
          '<select class="mfOp" data-role="op" data-si="' + si + '">' + opOpts + "</select>" +
          slotHtml(step.b, si, "b", priorIds);
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
        '<div class="mfSteps">' + steps + "</div>" +
        '<div class="mfAddRow">' +
        '<button type="button" class="buttonLink" data-role="addop">' + SM.icon("plus", 14) + " Operation</button>" +
        '<button type="button" class="buttonLink" data-role="addfn">' + SM.icon("plus", 14) + " Function</button>" +
        "</div>" +
        resultRowHtml() +
        previewHtml();
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
    function decodeSlot(value) {
      if (value === "") return null;
      if (value === "__created_at__") return { kind: "CREATED_AT" };
      if (value === "__number__") return { kind: "NUMBER", value: 0 };
      if (value.indexOf("metric:") === 0) return { kind: "METRIC", name: value.slice(7) };
      if (value.indexOf("step:") === 0) return { kind: "STEP", step: value.slice(5) };
      return null;
    }

    builder.addEventListener("change", (e) => {
      const t = e.target;
      const role = t.getAttribute && t.getAttribute("data-role");
      if (!role) return;
      const si = Number(t.getAttribute("data-si"));
      if (role === "slot") {
        const step = state.formula.steps[si];
        step[t.getAttribute("data-slot")] = decodeSlot(t.value);
        renderBuilder();
      } else if (role === "op") {
        state.formula.steps[si].op = t.value; updatePreviewOnly();
      } else if (role === "fn") {
        state.formula.steps[si].fn = t.value; updatePreviewOnly();
      } else if (role === "result") {
        state.formula.result = t.value; updatePreviewOnly();
      }
    });
    builder.addEventListener("input", (e) => {
      const t = e.target;
      if (!t.getAttribute || t.getAttribute("data-role") !== "num") return;
      const step = state.formula.steps[Number(t.getAttribute("data-si"))];
      const slot = t.getAttribute("data-slot");
      const v = Number(t.value);
      step[slot] = { kind: "NUMBER", value: Number.isFinite(v) ? v : 0 };
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

    // Load the account's other metric names for the operand pickers, then re-render.
    apiFetch("/api/v1/metrics?page[size]=1000").then((doc) => {
      state.metrics = ((doc && doc.data) || [])
        .map((r) => r.attributes || {})
        .filter((m) => m.name && m.name !== opts.selfName)
        .map((m) => ({ name: m.name, label: m.label || m.name }));
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

    const attrs = { name: name, label: label, type: current("mf-type"), kind: current("mf-kind") };
    const desc = container.querySelector('[name="description"]').value.trim();
    if (desc) attrs.description = desc;
    const unit = container.querySelector('[name="unit"]').value.trim();
    if (unit) attrs.unit = unit;
    const format = container.__mfFormat ? container.__mfFormat() : "";
    if (format) attrs.format = format;

    if (attrs.kind === "DERIVED") {
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

  // Return an error message if the formula has an unfinished slot, else null.
  function validateFormula(formula) {
    if (!formula || !Array.isArray(formula.steps) || !formula.steps.length) return "Add at least one step to the formula.";
    const okTok = (t) => t && t.kind && (t.kind !== "NUMBER" || Number.isFinite(t.value));
    for (const s of formula.steps) {
      if (!okTok(s.a)) return "Every step needs its operands filled in — pick a metric, number, created_at, or step.";
      if (s.kind === "OP" && !okTok(s.b)) return "Every operation needs both operands filled in.";
    }
    return null;
  }

  window.SMMetricForm = {
    render: render,
    wire: wire,
    collect: collect,
    typePillHtml: typePillHtml,
    kindPillHtml: kindPillHtml,
    formulaText: formulaText,
    formulaJson: formulaJson,
    typeLabel: typeLabel,
    kindLabel: kindLabel,
  };
})();
