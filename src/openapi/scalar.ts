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
    /* Branded header above the Scalar app (which renders as a normal block below it). */
    header.brand {
      display: flex; align-items: center; gap: 12px; height: 52px; padding: 0 20px;
      background: color-mix(in srgb, #0e1116 85%, transparent);
      border-bottom: 1px solid #2a3140;
      font: 14px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    header.brand img { height: 20px; width: auto; display: block; }
    header.brand .page { color: #9aa7b4; }
    header.brand nav { margin-left: auto; display: flex; gap: 18px; }
    header.brand a { color: #9aa7b4; text-decoration: none; }
    header.brand a:hover { color: #e6edf3; }
  </style>
</head>
<body>
  <header class="brand">
    <a href="https://www.smplmark.org" title="smplmark home"><img src="/img/logo-dark.png" alt="smplmark" /></a>
    <span class="page">API reference</span>
    <nav>
      <a href="https://www.smplmark.org/benchmarks">Benchmarks</a>
      <a href="https://www.smplmark.org/about">About</a>
    </nav>
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
