/**
 * Second platform probe: how colours actually serialise, and what the
 * DOM-write half of the compute tier costs.
 *
 *   node tools/probe-colors.mjs
 *
 * The first probe proved a 5000 element computed-style read costs ~30ms and
 * collapses to a couple of hundred distinct signatures. This one checks the
 * parsing surface that a naive implementation gets wrong, because
 * getComputedStyle does NOT normalise everything to rgb().
 */

import http from 'node:http';
import { CDP, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const PORT = 9413;

const FIXTURE = `<!doctype html>
<html><head><style>
  #g1 { background-image: linear-gradient(to right, #fff, #eee 50%, rgb(200,200,200)); }
  #g2 { background-image: url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"); }
  #g3 { background: #fff url(none.png) no-repeat, linear-gradient(#000, #111); }
  #sh { box-shadow: 0 1px 2px rgba(0,0,0,.2), inset 0 0 0 1px #ddd; }
  #tr { background-color: transparent; }
  #cur { color: currentColor; border-color: currentColor; }
</style></head><body>
<div id="probe"></div>
<div id="g1"></div><div id="g2"></div><div id="g3"></div>
<div id="sh"></div><div id="tr"></div><div id="cur"></div>
</body></html>`;

const PROBE = `(() => {
  const out = {};
  const el = document.getElementById('probe');

  // --- how does each colour syntax come back out of computed style? -----
  const inputs = [
    '#abcdef', 'rebeccapurple', 'rgb(1 2 3)', 'rgba(1,2,3,0.5)',
    'hsl(200 50% 40%)', 'hwb(200 20% 30%)',
    'oklch(0.7 0.1 200)', 'oklab(0.7 0.1 0.05)',
    'lab(50 20 -30)', 'lch(50 30 200)',
    'color(display-p3 0.5 0.2 0.9)', 'color(srgb 0.1 0.2 0.3)',
    'color-mix(in oklab, red 40%, blue)',
    'light-dark(#ffffff, #000000)',
    'transparent', 'currentColor',
  ];
  out.serialisation = {};
  for (const input of inputs) {
    el.style.color = '';
    el.style.color = input;
    out.serialisation[input] = {
      accepted: el.style.color !== '',
      computed: getComputedStyle(el).color,
    };
  }

  // --- background-image serialisation ------------------------------------
  out.backgroundImage = {
    gradient: getComputedStyle(document.getElementById('g1')).backgroundImage,
    dataUrl: getComputedStyle(document.getElementById('g2')).backgroundImage.slice(0, 60),
    layered: getComputedStyle(document.getElementById('g3')).backgroundImage.slice(0, 90),
  };
  out.boxShadow = getComputedStyle(document.getElementById('sh')).boxShadow;
  out.transparentBg = getComputedStyle(document.getElementById('tr')).backgroundColor;
  out.currentColorBorder = getComputedStyle(document.getElementById('cur')).borderTopColor;

  // --- cost of the write half of the compute tier ------------------------
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 5000; i++) {
    const d = document.createElement('div');
    d.textContent = 'x';
    frag.appendChild(d);
  }
  document.body.appendChild(frag);
  const all = document.querySelectorAll('div');

  let t = performance.now();
  for (let i = 0; i < all.length; i++) all[i].setAttribute('data-nx', 'c' + (i % 250));
  out.writeAttrMs = Math.round(performance.now() - t);

  t = performance.now();
  for (let i = 0; i < all.length; i++) all[i].removeAttribute('data-nx');
  out.removeAttrMs = Math.round(performance.now() - t);

  // Interleaving a read after every write is the classic layout-thrash
  // mistake. Measure it so the cost of getting this wrong is on record.
  t = performance.now();
  for (let i = 0; i < 800; i++) {
    all[i].setAttribute('data-nx', 'c' + i);
    void all[i].offsetHeight;
  }
  out.thrashMs800 = Math.round(performance.now() - t);

  // --- a stylesheet with N rules: insert cost ----------------------------
  const sheet = new CSSStyleSheet();
  t = performance.now();
  for (let i = 0; i < 250; i++) {
    sheet.insertRule('[data-nx="c' + i + '"]{background-color:rgb(' + i + ',10,10) !important}', i);
  }
  out.insert250RulesMs = Math.round(performance.now() - t);

  t = performance.now();
  const text = Array.from({ length: 250 }, (_, i) =>
    '[data-nx="c' + i + '"]{background-color:rgb(' + i + ',10,10) !important}').join('');
  const s2 = document.createElement('style');
  s2.textContent = text;
  document.head.appendChild(s2);
  out.oneTextBlobMs = Math.round(performance.now() - t);

  return out;
})()`;

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const session = await launch(null, { port: PORT, headless: true });
  try {
    const target = await waitFor('page target', async () => {
      const list = await httpJson(PORT, '/json/list');
      return list.find((t) => t.type === 'page');
    });
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });
    await new Promise((r) => setTimeout(r, 1000));
    console.log(JSON.stringify(await cdp.evaluate(undefined, PROBE), null, 2));
  } finally {
    await shutdown(session);
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
