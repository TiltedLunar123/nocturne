/**
 * Platform probe.
 *
 * Answers the questions the engine architecture depends on, by asking a real
 * Chromium rather than by trusting anyone's recollection. Run it before
 * changing how a tier works:
 *
 *   node tools/probe-platform.mjs
 *
 * This drives a plain page, not the extension, so it needs no build.
 */

import http from 'node:http';
import { CDP, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const PORT = 9412;

/**
 * The probe fixture deliberately mixes the cases that decide the design:
 * a same-origin sheet with a prefers-color-scheme block, a palette expressed
 * as custom properties, an inline style, and a cross-origin sheet.
 */
const FIXTURE = `<!doctype html>
<html><head>
<style>
  :root { --brand-bg: #ffffff; --brand-fg: #1a1a1a; --brand-accent: rgb(0, 90, 200); }
  body { background: var(--brand-bg); color: var(--brand-fg); }
  .card { background: #f3f4f6; border: 1px solid #e5e7eb; }
  @media (prefers-color-scheme: dark) {
    :root { --brand-bg: #101014; --brand-fg: #e8e8e8; }
    .card { background: #1c1c22; }
  }
  @media screen and (min-width: 100px) { .wide { color: red; } }
</style>
<link rel="stylesheet" href="CROSS_ORIGIN_HREF">
</head>
<body>
  <div class="card" id="card">card</div>
  <div id="inline" style="background-color: rgb(255, 255, 255) !important; color: #000">inline</div>
  <div id="wide">wide</div>
  <div id="host"></div>
  <canvas id="cv" width="20" height="20"></canvas>
  <input id="inp"><select id="sel"><option>a</option></select>
  <script>
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>p { background: #fff; color: #111 }</style><p id="sp">shadow</p>';
  <\/script>
</body></html>`;

/** Runs in the page. Returns a flat record of yes/no answers plus evidence. */
const PROBE = `(() => {
  const out = {};
  const sheets = Array.from(document.styleSheets);

  // --- cross-origin cssRules access -------------------------------------
  let crossOrigin = null;
  for (const sheet of sheets) {
    if (!sheet.href) continue;
    try {
      const n = sheet.cssRules.length;
      crossOrigin = { readable: true, rules: n };
    } catch (err) {
      crossOrigin = { readable: false, error: err.name };
    }
  }
  out.crossOriginCssRules = crossOrigin;

  // --- same-origin media rule introspection -----------------------------
  const media = [];
  for (const sheet of sheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (rule.constructor.name === 'CSSMediaRule') {
        media.push({ condition: rule.conditionText, inner: rule.cssRules.length });
      }
    }
  }
  out.mediaRules = media;

  // --- are custom properties enumerable on computed style? --------------
  const rootStyle = getComputedStyle(document.documentElement);
  const listed = Array.from(rootStyle);
  out.computedStyleIterable = listed.length;
  out.customPropsEnumerable = listed.filter((p) => p.startsWith('--'));
  out.customPropReadable = rootStyle.getPropertyValue('--brand-bg').trim();

  // --- colour feature support -------------------------------------------
  out.supports = {
    oklch: CSS.supports('color', 'oklch(0.5 0.1 200)'),
    colorMix: CSS.supports('color', 'color-mix(in oklab, red, blue)'),
    lightDark: CSS.supports('color', 'light-dark(#fff, #000)'),
    colorScheme: CSS.supports('color-scheme', 'dark'),
    relativeColor: CSS.supports('color', 'oklch(from red l c h)'),
    hasSelector: CSS.supports('selector(:has(a))'),
  };

  // --- can the page compute oklch back to rgb for us? -------------------
  const probe = document.createElement('div');
  probe.style.color = 'oklch(0.3 0.02 250)';
  document.body.appendChild(probe);
  out.oklchComputesTo = getComputedStyle(probe).color;
  probe.remove();

  // --- constructable stylesheets + adoptedStyleSheets --------------------
  out.constructableSheets = typeof CSSStyleSheet === 'function' && (() => {
    try { new CSSStyleSheet(); return true; } catch { return false; }
  })();
  out.adoptedStyleSheets = 'adoptedStyleSheets' in Document.prototype;

  // --- shadow DOM reachability -------------------------------------------
  const host = document.getElementById('host');
  out.shadowOpenReachable = !!(host && host.shadowRoot);
  out.shadowComputed = host && host.shadowRoot
    ? getComputedStyle(host.shadowRoot.getElementById('sp')).backgroundColor
    : null;

  // --- inline !important vs an author-origin rule ------------------------
  const style = document.createElement('style');
  style.textContent = '#inline { background-color: rgb(1,2,3) !important }';
  document.head.appendChild(style);
  out.authorBeatsInlineImportant =
    getComputedStyle(document.getElementById('inline')).backgroundColor === 'rgb(1, 2, 3)';

  // --- what does color-scheme actually change? ---------------------------
  const before = {
    canvas: getComputedStyle(document.documentElement).backgroundColor,
    input: getComputedStyle(document.getElementById('inp')).backgroundColor,
  };
  document.documentElement.style.colorScheme = 'dark';
  const after = {
    canvas: getComputedStyle(document.documentElement).backgroundColor,
    input: getComputedStyle(document.getElementById('inp')).backgroundColor,
  };
  out.colorSchemeEffect = { before, after };
  document.documentElement.style.colorScheme = '';

  // --- cost of a computed-style sweep ------------------------------------
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 5000; i++) {
    const el = document.createElement('div');
    el.textContent = 'x';
    el.style.background = 'rgb(' + (i % 255) + ',200,200)';
    frag.appendChild(el);
  }
  document.body.appendChild(frag);
  const all = document.querySelectorAll('div');
  const t0 = performance.now();
  const seen = new Set();
  for (const el of all) {
    const cs = getComputedStyle(el);
    seen.add(cs.backgroundColor + '|' + cs.color);
  }
  out.sweep = {
    elements: all.length,
    distinctSignatures: seen.size,
    ms: Math.round(performance.now() - t0),
  };

  return out;
})()`;

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/cross')) {
      res.writeHead(200, {
        'content-type': 'text/css',
        'access-control-allow-origin': '*',
      });
      res.end('.from-cross { color: rgb(9, 9, 9) }');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE.replace('CROSS_ORIGIN_HREF', `http://127.0.0.1:${crossPort}/cross.css`));
  });
  return server;
}

let crossPort = 0;

async function main() {
  // Two origins: different ports are different origins, which is all the
  // cross-origin stylesheet check needs.
  const crossServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('.from-cross { color: rgb(9, 9, 9) }');
  });
  await new Promise((r) => crossServer.listen(0, '127.0.0.1', r));
  crossPort = crossServer.address().port;

  const pageServer = serve();
  await new Promise((r) => pageServer.listen(0, '127.0.0.1', r));
  const pagePort = pageServer.address().port;

  // No extension needed for these questions, so load a bare browser.
  const session = await launch(null, { port: PORT, headless: true });
  try {
    const version = await httpJson(PORT, '/json/version');
    const targets = await waitFor('page target', async () => {
      const list = await httpJson(PORT, '/json/list');
      return list.find((t) => t.type === 'page');
    });
    const cdp = await CDP.connect(targets.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://localhost:${pagePort}/` });
    await new Promise((r) => setTimeout(r, 1200));

    const result = await cdp.evaluate(undefined, PROBE);
    console.log(JSON.stringify({ browser: version['User-Agent'], ...result }, null, 2));
  } finally {
    await shutdown(session);
    pageServer.close();
    crossServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
