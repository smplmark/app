"use strict";

// Publisher detail (/account/publishers/detail?id=…) — a publisher IS a domain. Shows the domain, its
// verification status + DNS TXT instructions, an icon choice (monogram | favicon), and Verify / Delete
// actions. There is no name/logo: attribution shows only the verified domain. Admin-only.
// Depends on api.js + shell.js (SM helpers).

(function () {
  const esc = SM.esc;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get("id") || "";
  const VERIFY_SUBDOMAIN = "_smplmark-verify"; // token is accepted here OR at the domain root

  function txtRow(label, value, copyTitle) {
    return '<span class="txtLabel">' + esc(label) + '</span><span class="txtValueWrap"><code>' + esc(value) + "</code>" + SM.copyButton(value, { title: copyTitle }) + "</span>";
  }

  let PUB = null;
  let CAN_ADMIN = false;

  function fmtDateTime(iso) { return SM.fmtDateTime(iso) || "—"; }
  function setMsg(text, kind) {
    const el = $("pub-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (text ? " is-" + (kind || "error") : "");
  }
  function statusPill(status) {
    const s = String(status || "").toUpperCase();
    return SM.statusPill(s.toLowerCase(), s === "VERIFIED" ? "active" : s === "LAPSED" ? "revoked" : "live");
  }

  SM.ready.then((id) => {
    CAN_ADMIN = id.canAdmin;
    if (!CAN_ADMIN) { $("detail-root").innerHTML = '<div class="panel"><p class="muted" style="margin:0;">Only admins can manage publishers.</p></div>'; return; }
    load();
  }).catch(() => fail("Failed to load your account."));

  function fail(msg) { $("detail-root").innerHTML = '<div class="errorBanner"><p>' + esc(msg) + "</p></div>"; }

  async function load() {
    if (!ID) { fail("No publisher id."); return; }
    try {
      const doc = await apiFetch("/api/v1/publishers/" + encodeURIComponent(ID));
      PUB = (doc && doc.data) || null;
      if (!PUB) { fail("Publisher not found."); return; }
      render();
    } catch (err) { fail(err.message || "Failed to load the publisher."); }
  }

  function render() {
    const a = PUB.attributes || {};
    const verified = a.status === "VERIFIED";

    const actions =
      '<button type="button" class="button buttonSecondary buttonSmall" id="p-verify">' + (verified ? "Re-check" : "Verify") + "</button>" +
      '<button type="button" class="button buttonDanger buttonSmall" id="p-delete">Delete</button>';

    // Icon choice (live: PUT on change, updates the header icon).
    const iconOpts = [["monogram", "Monogram"], ["favicon", "Favicon"]]
      .map(([v, label]) =>
        '<label class="radioPill"><input type="radio" name="icon" value="' + v + '"' + (a.icon === v ? " checked" : "") + " />" +
        '<span class="radioDot" aria-hidden="true"></span><span class="radioPillLabel">' + label + "</span></label>",
      ).join("");

    // Verification block — the TXT record to add (until verified), plus the value + copy.
    const token = a.verification_token || "";
    const verifyBlock = verified
      ? '<div class="field"><span class="detailFieldLabel">Verification</span><span class="detailFieldValue">Verified ' + esc(fmtDateTime(a.verified_at)) + "</span></div>"
      : '<div class="field"><span class="detailFieldLabel">Verify by DNS</span>' +
        '<p class="detailFieldHelp" style="margin-bottom:0.5rem;">Add this DNS <code>TXT</code> record for <code>' + esc(a.domain || "") + "</code>, then Verify:</p>" +
        '<div class="txtGrid"><span class="txtLabel">Type</span><code>TXT</code>' +
        txtRow("Name", VERIFY_SUBDOMAIN, "Copy record name") +
        txtRow("Value", token, "Copy verification value") + "</div>" +
        '<p class="txtHint" style="margin-top:0.6rem;">Prefer your domain root? Add the same value with name <code>@</code> instead (leave the name <strong>blank</strong> on some providers, e.g. Route&nbsp;53) — either works.</p></div>';

    const left =
      '<div class="field"><span class="detailFieldLabel">Domain</span><span class="detailFieldValue isMono">' + esc(a.domain || "") + "</span></div>" +
      '<div class="field"><span class="detailFieldLabel">Status</span><span class="detailFieldValue">' + statusPill(a.status) + "</span></div>" +
      '<div class="field"><span class="detailFieldLabel">Icon</span>' +
      '<div class="radioGroup" id="p-icon" role="radiogroup" aria-label="Icon">' + iconOpts + "</div>" +
      iconPreviewHtml(a) + "</div>" +
      verifyBlock;

    const right =
      SM.detailField("Created", { value: fmtDateTime(a.created_at) }) +
      SM.detailField("Verified", { value: a.verified_at ? fmtDateTime(a.verified_at) : "—" }) +
      SM.detailField("Last checked", { value: a.last_checked_at ? fmtDateTime(a.last_checked_at) : "—" });

    $("detail-root").innerHTML =
      SM.detailHeader({ name: a.domain || "Publisher", decorations: SM.publisherIcon(a.domain, a.icon, 30) + statusPill(a.status), actions: actions }) +
      '<div class="detailsTabPanel"><div class="detailGrid">' +
      '<div class="detailCol">' + left + "</div>" +
      '<div class="detailCol">' + right + "</div>" +
      "</div></div>" +
      '<div id="pub-msg" class="form-status" style="margin-top:0.5rem;"></div>';

    const cur = document.querySelector(".breadcrumbCurrent");
    if (cur) cur.textContent = a.domain || "Publisher";
    document.title = (a.domain || "Publisher") + " — smplmark";

    SM.wirePublisherIcons($("detail-root"));
    SM.wireCopyButtons($("detail-root"));
    $("p-verify").addEventListener("click", verify);
    $("p-delete").addEventListener("click", del);
    $("p-icon").addEventListener("change", (ev) => { if (ev.target && ev.target.name === "icon") setIcon(ev.target.value); });
    if (a.icon === "favicon") applyFaviconPreview(a.domain);
  }

  // Preview of what the selected icon looks like on a badge. Monogram is synchronous; favicon is
  // resolved live (see applyFaviconPreview) so the user sees the actual image, or a clear notice when
  // the domain has no discoverable favicon and the monogram will stand in.
  function iconPreviewHtml(a) {
    const base = SM.publisherIcon(a.domain, "monogram", 44);
    if (a.icon === "favicon") {
      return '<div class="iconPreview">' +
        '<div class="iconPreviewBox" id="icon-preview-box">' + base + "</div>" +
        '<p class="iconPreviewCaption" id="icon-preview-cap">Checking <code>' + esc(a.domain || "") + "</code> for a favicon…</p></div>";
    }
    return '<div class="iconPreview">' +
      '<div class="iconPreviewBox">' + base + "</div>" +
      '<p class="iconPreviewCaption">Badges show a domain-initial monogram from the domain name.</p></div>';
  }

  function applyFaviconPreview(domain) {
    const box = $("icon-preview-box");
    const cap = $("icon-preview-cap");
    if (!box || !cap) return;
    SM.probeFavicon(domain, (url) => {
      if ($("icon-preview-box") !== box) return; // panel re-rendered — ignore stale result
      if (url) {
        box.innerHTML = '<img class="iconPreviewImg" src="' + esc(url) + '" alt="favicon for ' + esc(domain) + '" />';
        cap.className = "iconPreviewCaption";
        cap.innerHTML = "The favicon found at <code>" + esc(domain) + "</code> — this is what badges will show.";
      } else {
        cap.className = "iconPreviewCaption isWarn";
        cap.innerHTML = "No favicon found at <code>" + esc(domain) + "</code>. Badges will show the monogram instead.";
      }
    });
  }

  async function verify() {
    const btn = $("p-verify"); btn.disabled = true; btn.textContent = "Checking…";
    try {
      const doc = await apiFetch("/api/v1/publishers/" + encodeURIComponent(ID) + "/actions/verify", { method: "POST" });
      PUB = (doc && doc.data) || PUB;
      const a = PUB.attributes || {};
      render(); // rebuilds the panel (and re-enables the button) with the latest status
      if (a.status === "VERIFIED") SM.toast((a.domain || "Publisher") + " verified", { kind: "success" });
      else notDetectedModal(a);
    } catch (err) {
      render();
      SM.toast(err.message || "The DNS check failed — please try again.", { kind: "error" });
    }
  }

  // Full-stop explanation when a Verify check comes back without the TXT record found. Covers the
  // common cause (the record isn't on the domain root — the Route 53 "@" gotcha) and propagation lag.
  function notDetectedModal(a) {
    const domain = a.domain || "your domain";
    const token = a.verification_token || "";
    const bodyHtml =
      '<p class="muted" style="margin:0 0 0.9rem;">We just checked DNS for <strong>' + esc(domain) +
      "</strong> and didn't find the verification record yet. It should be exactly:</p>" +
      '<div class="wzTxt txtGrid" style="margin-bottom:0.9rem;">' +
      '<span class="txtLabel">Type</span><code>TXT</code>' +
      txtRow("Name", VERIFY_SUBDOMAIN, "Copy record name") +
      txtRow("Value", token, "Copy verification value") + "</div>" +
      '<ul class="tipList">' +
      "<li>If you just added it, DNS can take a few minutes to propagate — wait a moment, then check again.</li>" +
      "<li>Add it at <code>" + esc(VERIFY_SUBDOMAIN + "." + domain) + "</code> (recommended), or at your domain <strong>root</strong>. On providers like Amazon Route&nbsp;53, the root is a <strong>blank</strong> name, not <code>@</code>.</li>" +
      "</ul>" +
      '<div class="modalActions"><button type="button" class="button buttonSecondary buttonSmall" data-close>Close</button>' +
      '<button type="button" class="button buttonPrimary buttonSmall" id="v-again">Check again</button></div>';
    const m = SM.modal({ title: "Not verified yet", bodyHtml: bodyHtml, width: 540 });
    SM.wireCopyButtons(m.panel);
    m.panel.querySelector("#v-again").addEventListener("click", () => { m.close(); verify(); });
  }

  async function setIcon(icon) {
    setMsg("");
    try {
      const doc = await apiFetch("/api/v1/publishers/" + encodeURIComponent(ID), { method: "PUT", body: jsonapiBody("publisher", { icon }) });
      PUB = (doc && doc.data) || PUB;
      render();
    } catch (err) { setMsg(err.message, "error"); }
  }

  async function del() {
    const a = PUB.attributes || {};
    const ok = await SM.confirm({
      title: "Delete this publisher?",
      message: "Benchmarks already published under <strong>" + esc(a.domain || "") + "</strong> keep their frozen badge, but you can no longer publish new ones under it.",
      confirmLabel: "Delete publisher",
    });
    if (!ok) return;
    setMsg("");
    try {
      await apiFetch("/api/v1/publishers/" + encodeURIComponent(ID), { method: "DELETE" });
      location.href = "/account/settings#publishers";
    } catch (err) { setMsg(err.message, "error"); }
  }
})();
