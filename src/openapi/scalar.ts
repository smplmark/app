// The Scalar API-reference page (§14). Served by the Worker at /api-reference, pointed at
// /api/openapi.json. Theme structure lifted from docs.smplkit.com's ApiReference.vue (theme:'none'
// + custom --scalar-* vars) but remapped to smplmark's palette (accent #4f8cff dark / #2f6fe0 light).
//
// The page has no theme control of its own, so it follows the rest of smplmark. Before first paint it
// resolves the theme from, in order: the cross-subdomain cookie `smplmark-theme` that the marketing
// site's header switch writes (scoped to .smplmark.org), then the console's own saved theme
// (`smplmark.theme` in this origin's localStorage), then the OS preference. The resolved choice sets
// <html data-theme> (driving the banner + the Scalar var palette) and Scalar's own darkMode flag, so
// the banner and the reference never disagree.
export function scalarHtml(specUrl: string, wwwOrigin = "https://www.smplmark.org"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API reference — smplmark</title>
  <link rel="icon" href="/img/favicon.svg" type="image/svg+xml" />
  <script>(function(){try{var m=document.cookie.match(/(?:^|; )smplmark-theme=(light|dark)/);var t=m?m[1]:localStorage.getItem('smplmark.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <style>
    /* Banner + page palette as flip-able custom properties (mirrors the website's app.css). Dark is
       the default; light applies when the OS prefers it and the visitor hasn't forced dark, or when
       an explicit light choice is set. */
    :root {
      --bg: #0e1116;
      --panel2: #1c2330;
      --line: #2a3140;
      --text: #e6edf3;
      --muted: #9aa7b4;
      --accent: #4f8cff;
      --logo: url(/img/logo-dark.png);
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        --bg: #f6f8fa; --panel2: #eef1f5; --line: #d6dce4; --text: #1f2328; --muted: #5b6570; --accent: #2f6fe0;
        --logo: url(/img/logo-light.png);
      }
    }
    :root[data-theme="light"] {
      --bg: #f6f8fa; --panel2: #eef1f5; --line: #d6dce4; --text: #1f2328; --muted: #5b6570; --accent: #2f6fe0;
      --logo: url(/img/logo-light.png);
    }

    /* Scalar reads --scalar-* scoped to the .dark-mode / .light-mode class it puts on its app root, so
       the palettes must live on those classes (they out-specify Scalar's own built-ins). darkMode in
       the config below chooses which class Scalar applies. */
    :root, .dark-mode {
      --scalar-background-1: #0e1116;
      --scalar-background-2: #161b22;
      --scalar-background-3: #1c2330;
      --scalar-color-1: #e6edf3;
      --scalar-color-2: #9aa7b4;
      --scalar-color-3: #6b7684;
      --scalar-color-accent: #4f8cff;
      --scalar-border-color: #2a3140;
      --scalar-font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --scalar-font-code: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    .light-mode {
      --scalar-background-1: #ffffff;
      --scalar-background-2: #f6f8fa;
      --scalar-background-3: #eef1f5;
      --scalar-color-1: #1f2328;
      --scalar-color-2: #5b6570;
      --scalar-color-3: #8893a0;
      --scalar-color-accent: #2f6fe0;
      --scalar-border-color: #d6dce4;
      --scalar-font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --scalar-font-code: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    /* Match the website's global reset exactly — the banner .wrap's 1040px must INCLUDE its
       padding (border-box) or the column sits ~20px off the site's. */
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); }
    /* The site banner, duplicated from the website's header.site (palette via the vars above). */
    header.site {
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--bg) 85%, transparent);
      backdrop-filter: blur(6px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    header.site .wrap {
      max-width: 1040px; margin: 0 auto; padding: 0 20px;
      display: flex; align-items: center; gap: 20px; height: 58px;
    }
    /* Wordmark as a background image so it tracks the resolved theme (--logo), matching the website. */
    .brand { display: block; width: 108px; height: 22px; background: var(--logo) no-repeat left center; background-size: contain; }
    header.site nav { display: flex; align-items: center; gap: 20px; margin-left: auto; }
    header.site nav a {
      color: var(--muted); font-size: 14px; text-decoration: none;
      font: 14px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    header.site nav a:hover { color: var(--text); }
    header.site nav a.active { color: var(--accent); font-weight: 600; }
    header.site nav a.nav-cta {
      background: var(--accent); color: #fff; font-weight: 600;
      padding: 5px 14px; border-radius: 999px;
    }
    header.site nav a.nav-cta:hover { color: #fff; filter: brightness(1.12); }
    /* Light/dark switch — matches the website's header toggle. Knob left = light (sun), right = dark
       (moon); position + glyph are CSS-driven off the resolved theme so it's correct before its script
       runs. Clicking reloads the page (see the script below) so the JS-rendered reference re-themes
       cleanly with the banner rather than half-flipping. */
    .theme-toggle {
      position: relative; box-sizing: border-box;
      width: 46px; height: 26px; padding: 0;
      border: 1px solid var(--line); border-radius: 999px;
      background: var(--panel2); cursor: pointer; vertical-align: middle;
      transition: border-color .15s, background .18s;
    }
    .theme-toggle:hover { border-color: var(--accent); }
    .theme-toggle .knob {
      position: absolute; top: 50%; left: 2px;
      display: flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 50%;
      background: var(--accent); color: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      transform: translate(20px, -50%);
      transition: transform .2s cubic-bezier(.3, .1, .3, 1);
    }
    .theme-toggle .knob svg { width: 12px; height: 12px; }
    .theme-toggle .sun { display: none; }
    .theme-toggle .moon { display: block; }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) .theme-toggle .knob { transform: translate(0, -50%); }
      :root:not([data-theme="dark"]) .theme-toggle .sun { display: block; }
      :root:not([data-theme="dark"]) .theme-toggle .moon { display: none; }
    }
    :root[data-theme="light"] .theme-toggle .knob { transform: translate(0, -50%); }
    :root[data-theme="light"] .theme-toggle .sun { display: block; }
    :root[data-theme="light"] .theme-toggle .moon { display: none; }
    /* Constrain the reference to the site's narrow centered column (matches .wrap / --maxw). */
    .reference-wrap { max-width: 1040px; margin: 0 auto; }
    .reference-wrap .scalar-app { min-width: 0; }
  </style>
</head>
<body>
  <header class="site">
    <div class="wrap">
      <a class="brand" href="${wwwOrigin}" title="smplmark home" aria-label="smplmark home"></a>
      <nav>
        <a href="${wwwOrigin}/benchmarks">Benchmarks</a>
        <a href="${wwwOrigin}/about">About</a>
        <a href="/api-reference" class="active">API Reference</a>
        <a href="/login">Sign in</a>
        <a href="/signup" class="nav-cta">Sign up</a>
        <button class="theme-toggle" type="button" role="switch" aria-label="Dark mode">
          <span class="knob">
            <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </span>
        </button>
      </nav>
    </div>
  </header>
  <div class="reference-wrap">
    <script id="api-reference" data-url="${specUrl}"></script>
  </div>
  <script>
    // Wire the header switch. It writes the same cross-subdomain cookie the marketing site uses (so
    // the choice propagates back to www and persists), then reloads — the reference is rendered by
    // Scalar's JS with a fixed darkMode, so a reload is what re-themes the whole page cleanly.
    (function () {
      var btn = document.querySelector('.theme-toggle');
      if (!btn) return;
      function resolved() {
        var f = document.documentElement.getAttribute('data-theme');
        if (f === 'light' || f === 'dark') return f;
        return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      btn.setAttribute('aria-checked', resolved() === 'dark' ? 'true' : 'false');
      btn.addEventListener('click', function () {
        var next = resolved() === 'dark' ? 'light' : 'dark';
        var onProd = /(?:^|\\.)smplmark\\.org$/.test(location.hostname);
        document.cookie = 'smplmark-theme=' + next + '; path=/; max-age=31536000; samesite=lax' +
          (onProd ? '; domain=.smplmark.org' : '') +
          (location.protocol === 'https:' ? '; secure' : '');
        location.reload();
      });
    })();
  </script>
  <script>
    // Render in whichever theme <html data-theme> resolved to (see the head snippet), falling back to
    // the OS preference when no explicit choice is set. Scalar's own themes stay disabled (theme:'none').
    (function () {
      var forced = document.documentElement.getAttribute('data-theme');
      var dark = forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.getElementById('api-reference').dataset.configuration = JSON.stringify({
        theme: 'none',
        darkMode: dark,
        withDefaultFonts: false,
        hideClientButton: true,
        hiddenClients: { node: ['undici', 'unirest'] },
      });
    })();
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
