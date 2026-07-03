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
  </style>
</head>
<body>
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
