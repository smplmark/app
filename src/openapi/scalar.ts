// The Scalar API-reference page (§14). Served by the Worker at /api-reference, pointed at
// /api/openapi.json. Theme structure lifted from docs.smplkit.com's ApiReference.vue (theme:'none'
// + custom --scalar-* vars) but remapped to smplmark's dark palette (accent #4f8cff).
export function scalarHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API reference — smplmark</title>
  <link rel="icon" href="/img/favicon.svg" type="image/svg+xml" />
  <style>
    :root, .light-mode, .dark-mode {
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
    html, body { margin: 0; background: #0e1116; }
    /* The site banner, duplicated exactly from the website's header.site (dark palette). */
    header.site {
      border-bottom: 1px solid #2a3140;
      background: color-mix(in srgb, #0e1116 85%, transparent);
      backdrop-filter: blur(6px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    header.site .wrap {
      max-width: 1040px; margin: 0 auto; padding: 0 20px;
      display: flex; align-items: center; gap: 20px; height: 58px;
    }
    .brand { display: inline-flex; align-items: center; }
    .brand img { height: 22px; width: auto; display: block; }
    header.site nav { display: flex; gap: 20px; margin-left: auto; }
    header.site nav a {
      color: #9aa7b4; font-size: 14px; text-decoration: none;
      font: 14px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    header.site nav a:hover { color: #e6edf3; }
    header.site nav a.active { color: #4f8cff; font-weight: 600; }
  </style>
</head>
<body>
  <header class="site">
    <div class="wrap">
      <a class="brand" href="/benchmarks" title="smplmark home"><img src="/img/logo-dark.png" alt="smplmark" /></a>
      <nav>
        <a href="/benchmarks">Benchmarks</a>
        <a href="/about">About</a>
        <a href="/api-reference" class="active">API Reference</a>
        <a href="/login">Sign in</a>
        <a href="/signup">Sign up</a>
      </nav>
    </div>
  </header>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script>
    // Force the dark palette above (Scalar's own themes disabled).
    document.getElementById('api-reference').dataset.configuration = JSON.stringify({
      theme: 'none',
      darkMode: true,
      withDefaultFonts: false,
      hideClientButton: true,
      hiddenClients: { node: ['undici', 'unirest'] },
    });
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
