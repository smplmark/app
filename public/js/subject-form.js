"use strict";

// Shared subject-value form — renders inputs for a subject's typed field VALUES from its subject
// type's field defs, collects+validates them, and formats a value for read display. Used by the
// "New subject" modal, the subject detail edit form, and the subject detail read view. The field
// DEFINITION editor (label/name/type/…) is separate — it lives in subject-type-form.js.
// Depends on shell.js (SM helpers). Exposes window.SMSubjectForm.

(function () {
  const esc = SM.esc;

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, "\\$&");
  }

  // A stored value → the string an <input type="date"> expects (YYYY-MM-DD), best-effort.
  function dateInputValue(v) {
    if (v == null || v === "") return "";
    const d = new Date(String(v));
    if (isNaN(d.getTime())) return typeof v === "string" ? v : "";
    return d.toISOString().slice(0, 10);
  }

  // One .field for a field def, pre-filled with `value`. `f.name` is the identifier (data-field key);
  // `f.label` is the human display.
  function fieldHtml(f, value) {
    const id = esc(f.name);
    const labelCls = "detailFieldLabel" + (f.required ? " fieldRequired" : "");
    const label = '<span class="' + labelCls + '">' + esc(f.label) + "</span>";
    let input;
    switch (f.type) {
      case "NUMBER":
        input = '<input type="number" step="any" data-field="' + id + '" value="' + esc(value == null ? "" : value) + '" />';
        break;
      case "BOOLEAN":
        input =
          '<label class="switchRow"><input type="checkbox" data-field="' + id + '"' + (value === true ? " checked" : "") + " />" +
          '<span class="switchState" data-switch-for="' + id + '">' + (value === true ? "Yes" : "No") + "</span></label>";
        break;
      case "ENUM": {
        const opts = (f.options || [])
          .map((o) => '<option value="' + esc(o) + '"' + (value === o ? " selected" : "") + ">" + esc(o) + "</option>")
          .join("");
        input =
          '<select data-field="' + id + '"><option value="">' + (f.required ? "Select…" : "—") + "</option>" + opts + "</select>";
        break;
      }
      case "DATE":
        input = '<input type="date" data-field="' + id + '" value="' + esc(dateInputValue(value)) + '" />';
        break;
      default: // STRING
        input =
          '<input type="text" data-field="' + id + '"' + (f.max_length ? ' maxlength="' + f.max_length + '"' : "") +
          ' value="' + esc(value == null ? "" : value) + '" />';
    }
    return '<div class="field">' + label + input + '<p class="fieldErrorMessage" hidden></p></div>';
  }

  window.SMSubjectForm = {
    // Render a form body (a stack of .field) for the given field defs + current values object.
    render: function (fields, values) {
      values = values || {};
      if (!fields || !fields.length) {
        return '<p class="detailFieldHelp" style="margin:0;">This subject type has no fields — a subject of it just needs a key and name.</p>';
      }
      return fields.map((f) => fieldHtml(f, values[f.name])).join("");
    },

    // Wire live bits (boolean switch label). Call once after inserting the rendered HTML.
    wire: function (container) {
      container.querySelectorAll('input[type="checkbox"][data-field]').forEach((cb) => {
        const label = container.querySelector('[data-switch-for="' + cssEsc(cb.getAttribute("data-field")) + '"]');
        if (label) cb.addEventListener("change", () => { label.textContent = cb.checked ? "Yes" : "No"; });
      });
    },

    // Read + validate values from the container. Returns { ok, values }; sets inline field errors.
    collect: function (container, fields) {
      const out = {};
      let ok = true;
      (fields || []).forEach((f) => {
        const el = container.querySelector('[data-field="' + cssEsc(f.name) + '"]');
        if (!el) return;
        SM.clearFieldError(el);
        if (f.type === "BOOLEAN") { out[f.name] = el.checked; return; }
        const raw = el.value;
        if (raw == null || String(raw).trim() === "") {
          if (f.required) { SM.setFieldError(el, f.label + " is required."); ok = false; }
          return;
        }
        if (f.type === "NUMBER") {
          const num = Number(raw);
          if (Number.isNaN(num)) { SM.setFieldError(el, f.label + " must be a number."); ok = false; return; }
          out[f.name] = num;
        } else {
          out[f.name] = String(raw);
        }
      });
      return { ok: ok, values: out };
    },

    // A read-only display string for a value.
    display: function (f, value) {
      if (value == null || value === "") return "—";
      if (f.type === "BOOLEAN") return value ? "Yes" : "No";
      return String(value);
    },
  };
})();
