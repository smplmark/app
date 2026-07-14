"use strict";

// First-run welcome wizard — shown once to a new account's OWNER on the dashboard. Three screens:
//   1. a brief welcome,
//   2. how benchmarks may be published (sets the account's allow_personal_publish), and
//   3. an optional publisher domain (creates a publisher + shows its DNS TXT record).
// A "welcome_dismissed" flag is stored in the owner's per-account settings bag so it shows only once.
// Depends on api.js + shell.js (SM helpers). Loaded on the dashboard, where a new owner first lands.

(function () {
  const FLAG = "welcome_dismissed";
  const VERIFY_SUBDOMAIN = "_smplmark-verify"; // token is accepted here OR at the domain root
  const esc = SM.esc;

  SM.ready
    .then(async (id) => {
      if (!id.isOwner) return; // onboarding is the owner's first-run choice
      let settings;
      try {
        settings = (await apiFetch("/api/v1/users/current/settings", { json: true })) || {};
      } catch (_e) {
        return; // couldn't read settings (e.g. an API-key session) — never nag
      }
      if (settings[FLAG] === true) return;
      startWizard(id, settings);
    })
    .catch(() => {});

  function startWizard(id, settings) {
    const account = (id.account && id.account.attributes) || {};
    let choice = account.allow_personal_publish === true ? "personal" : "publisher";
    let dismissed = false;

    const m = SM.modal({ title: "", bodyHtml: '<div class="wzRoot" id="wz-root"></div>', width: 480, onClose: markDismissed });
    const header = m.panel.querySelector(".modalHeader");
    if (header) header.style.display = "none"; // each screen renders its own heading
    const root = m.panel.querySelector("#wz-root");

    renderWelcome();

    // Persist the "seen" flag once, preserving any other preferences already in the bag (get-mutate-put).
    async function markDismissed() {
      if (dismissed) return;
      dismissed = true;
      try {
        const next = Object.assign({}, settings, { [FLAG]: true });
        await apiFetch("/api/v1/users/current/settings", { method: "PUT", json: true, body: next });
      } catch (_e) {
        /* best-effort — a failed write just means the wizard may reappear next visit */
      }
    }

    async function finish(toPublishers) {
      await markDismissed();
      if (toPublishers) location.href = "/account/settings#publishers";
      else m.close();
    }

    function dots(active) {
      let out = '<div class="wzSteps" aria-hidden="true">';
      for (let i = 0; i < 3; i++) out += '<span class="wzDot' + (i === active ? " isActive" : "") + '"></span>';
      return out + "</div>";
    }

    // ── Screen 1: welcome ──
    function renderWelcome() {
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHero">' +
        '<img class="wzHeroMark" src="/img/favicon-120.png" alt="" />' +
        '<h2 class="wzTitle">Welcome to smplmark</h2>' +
        '<p class="wzText">smplmark is where you host and publish benchmarks. Let\'s set up how your account publishes — a couple of quick choices you can always change later in Settings.</p>' +
        "</div>" +
        dots(0) +
        '<div class="modalActions"><button type="button" class="button buttonPrimary" id="wz-next">Get started</button></div>' +
        "</div>";
      root.querySelector("#wz-next").addEventListener("click", renderChoice);
    }

    // ── Screen 2: publishing identities → allow_personal_publish ──
    function choiceCard(value, title, desc) {
      return (
        '<label class="choiceCard">' +
        '<input type="radio" name="wz-pub" value="' + value + '"' + (choice === value ? " checked" : "") + " />" +
        '<span class="choiceDot" aria-hidden="true"></span>' +
        '<span class="choiceText"><span class="choiceTitle">' + esc(title) + "</span>" +
        '<span class="choiceDesc">' + esc(desc) + "</span></span></label>"
      );
    }
    function renderChoice() {
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHead"><h2 class="wzTitle">How can benchmarks be published?</h2>' +
        '<p class="wzText">Every published benchmark is attributed to an identity. Choose what your account allows — you can change this anytime in Settings.</p></div>' +
        '<div class="choiceGroup" id="wz-pub" role="radiogroup" aria-label="Publishing identities">' +
        choiceCard("personal", "Personal & publisher identities", "Members can publish under their own name and avatar, or under a verified publisher domain.") +
        choiceCard("publisher", "Verified publishers only", "Every published benchmark is attributed to a verified publisher domain — never an individual.") +
        "</div>" +
        '<p class="form-status" id="wz-msg"></p>' +
        dots(1) +
        '<div class="modalActions"><button type="button" class="button buttonSecondary" id="wz-back">Back</button>' +
        '<button type="button" class="button buttonPrimary" id="wz-next">Next</button></div>' +
        "</div>";
      root.querySelector("#wz-pub").addEventListener("change", (ev) => {
        if (ev.target && ev.target.name === "wz-pub") choice = ev.target.value;
      });
      root.querySelector("#wz-back").addEventListener("click", renderWelcome);
      root.querySelector("#wz-next").addEventListener("click", saveChoice);
    }
    async function saveChoice() {
      const next = root.querySelector("#wz-next");
      next.disabled = true;
      const msg = root.querySelector("#wz-msg");
      msg.textContent = ""; msg.className = "form-status";
      try {
        // get-mutate-put: round-trip the account, flipping only the personal-publish gate.
        await apiFetch("/api/v1/accounts/current", {
          method: "PUT",
          body: jsonapiBody("account", {
            name: account.name,
            description: account.description == null ? null : account.description,
            allow_personal_publish: choice === "personal",
          }),
        });
        renderDomain();
      } catch (err) {
        next.disabled = false;
        msg.textContent = err.message; msg.className = "form-status is-error";
      }
    }

    // ── Screen 3: optional publisher domain ──
    function renderDomain() {
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHead"><h2 class="wzTitle">Add a publisher domain</h2>' +
        '<p class="wzText">A publisher is a domain you publish benchmarks under, like <code>acme.com</code>. This is optional — you can add or change publishers anytime in Settings › Publishers.</p></div>' +
        '<div class="field"><span class="detailFieldLabel">Domain</span>' +
        '<input id="wz-domain" type="text" placeholder="acme.com" autocomplete="off" spellcheck="false" />' +
        '<p class="fieldErrorMessage" hidden></p></div>' +
        dots(2) +
        '<div class="modalActions"><button type="button" class="button buttonSecondary" id="wz-skip">Skip for now</button>' +
        '<button type="button" class="button buttonPrimary" id="wz-add">Add domain</button></div>' +
        "</div>";
      const input = root.querySelector("#wz-domain");
      input.addEventListener("input", () => SM.clearFieldError(input));
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addDomain(); } });
      root.querySelector("#wz-skip").addEventListener("click", () => finish(false));
      root.querySelector("#wz-add").addEventListener("click", addDomain);
      setTimeout(() => input.focus(), 0);
    }
    async function addDomain() {
      const input = root.querySelector("#wz-domain");
      SM.clearFieldError(input);
      const domain = input.value.trim();
      if (!domain) { SM.setFieldError(input, "Enter a domain, or skip for now."); input.focus(); return; }
      const add = root.querySelector("#wz-add");
      add.disabled = true;
      try {
        const doc = await apiFetch("/api/v1/publishers", { method: "POST", body: jsonapiBody("publisher", { domain }) });
        const pub = (doc && doc.data && doc.data.attributes) || {};
        renderTxt(pub);
      } catch (err) {
        add.disabled = false;
        SM.setFieldError(input, err.message);
      }
    }

    // ── Screen 3b: the created publisher's DNS TXT record ──
    function renderTxt(pub) {
      const domain = pub.domain || "";
      const token = pub.verification_token || "";
      m.panel.style.width = "min(100%, 580px)"; // wider so the verification value fits on one line
      m.panel.classList.add("wzWide");
      root.innerHTML =
        '<div class="wzScreen">' +
        '<div class="wzHead"><h2 class="wzTitle">Verify ' + esc(domain) + "</h2>" +
        '<p class="wzText">Add this DNS <code>TXT</code> record to <code>' + esc(domain) + "</code>, then verify it from Settings › Publishers. Until it's verified you can't publish under it yet.</p></div>" +
        '<div class="wzTxt txtGrid">' +
        '<span class="txtLabel">Type</span><code>TXT</code>' +
        '<span class="txtLabel">Name</span><span class="txtValueWrap"><code>' + esc(VERIFY_SUBDOMAIN) + "</code>" +
        SM.copyButton(VERIFY_SUBDOMAIN, { title: "Copy record name" }) + "</span>" +
        '<span class="txtLabel">Value</span><span class="txtValueWrap"><code>' + esc(token) + "</code>" +
        SM.copyButton(token, { title: "Copy verification value" }) + "</span></div>" +
        '<p class="txtHint" style="margin-top:0.6rem;">Prefer your domain root? Add the same value with name <code>@</code> instead (leave the name <strong>blank</strong> on some providers, e.g. Route&nbsp;53) — either works.</p>' +
        dots(2) +
        '<div class="modalActions"><button type="button" class="button buttonPrimary" id="wz-done">Got it → Publishers</button></div>' +
        "</div>";
      SM.wireCopyButtons(root);
      root.querySelector("#wz-done").addEventListener("click", () => finish(true));
    }
  }
})();
