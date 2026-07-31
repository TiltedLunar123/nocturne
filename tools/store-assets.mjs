/**
 * Builds every image the Chrome Web Store submission form asks for.
 *
 *   node tools/store-assets.mjs
 *
 * Output lands in store/assets/:
 *   store-icon-128.png       128x128
 *   screenshot-1..5.png      1280x800, 24-bit, no alpha
 *   promo-small-440x280.png  24-bit, no alpha
 *   promo-marquee-1400x560.png
 *
 * Three browser passes, and the order matters. The extension themes any page it
 * is loaded against, including the composer pages this script uses to lay the
 * final images out, so compositing has to happen in a pass with the extension
 * absent or every caption band would come out re-themed.
 *
 *   pass 1  no extension   capture the "before" state of the demo pages
 *   pass 2  extension      capture the "after" state, plus popup and options
 *   pass 3  no extension   render the composer pages into the final assets
 *
 * The demo pages under store/demo are deliberately invented products. Putting a
 * real site in a store screenshot is someone else's trademark on your listing.
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CDP, deriveExtensionId, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store', 'assets');
const RAW = path.join(ROOT, 'dist', '_shots');

const SHOT_W = 1280;
const SHOT_H = 800;
const BAND = 108; // caption band height, so page art gets 692px

const BRAND = {
  bg: '#0e1116',
  panel: '#161a21',
  line: '#272d38',
  ink: '#e8eaf0',
  muted: '#98a0b0',
  accent: '#7b95f0',
};

async function serve(dirs) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    for (const dir of dirs) {
      try {
        const file = path.join(dir, rel);
        if (!file.startsWith(dir)) continue;
        const body = await fs.readFile(file);
        const ext = path.extname(file);
        const type =
          ext === '.png' ? 'image/png' : ext === '.css' ? 'text/css' : 'text/html; charset=utf-8';
        res.writeHead(200, { 'content-type': type });
        res.end(body);
        return;
      } catch {
        /* try the next root */
      }
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function buildVariant() {
  const from = path.join(ROOT, 'dist', 'chrome');
  const to = path.join(ROOT, 'dist', '_assets-ext');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const file = path.join(to, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.key = der.toString('base64');
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  return { dir: to, id: deriveExtensionId(der) };
}

/**
 * Open a tab, force a light system preference, navigate, screenshot.
 *
 * `script` runs after load and before the shot. `autoHeight` re-sizes the
 * viewport to the document's real height first, so a popup capture has no dead
 * space under it.
 */
async function capture(cdp, url, { width, height, name, waitFn, script, autoHeight, settle = 900 }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  if (waitFn) await waitFor(name, () => cdp.evaluate(sessionId, waitFn), { timeout: 15000, interval: 120 }).catch(() => {});
  await new Promise((r) => setTimeout(r, settle));

  let result;
  if (script) result = await cdp.evaluate(sessionId, script);

  if (autoHeight) {
    const real = await cdp.evaluate(sessionId, `Math.ceil(document.body.getBoundingClientRect().height)`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: real, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await new Promise((r) => setTimeout(r, 220));
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  await fs.writeFile(path.join(RAW, `${name}.png`), Buffer.from(shot.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  return result;
}

/**
 * The popup decides its own status text from the tier the page reported. A
 * popup captured on its own has no page behind it, so it truthfully says it
 * cannot run here, which would be a lie next to a screenshot of a themed page.
 *
 * These are the strings the popup itself would show, lifted from its source and
 * asserted against it below, so a wording change breaks the build rather than
 * quietly producing a screenshot that no longer matches the product.
 */
const TIER_COPY = {
  1: ['native', "Using this site's own dark theme"],
  3: ['generated', 'Generated theme from the page colours'],
};

async function assertCopyMatchesSource() {
  const src = await fs.readFile(path.join(ROOT, 'src', 'popup', 'popup.js'), 'utf8');
  for (const [tier, [quality, copy]] of Object.entries(TIER_COPY)) {
    if (!src.includes(copy) || !src.includes(`'${quality}'`)) {
      throw new Error(
        `popup.js no longer contains the tier ${tier} status "${copy}". ` +
        'Update TIER_COPY in this script so the screenshots keep matching the product.'
      );
    }
  }
}

const stagePopup = (tier, host) => {
  const [quality, copy] = TIER_COPY[tier];
  return `(() => {
    const s = document.getElementById('status');
    s.dataset.quality = ${JSON.stringify(quality)};
    s.textContent = ${JSON.stringify(copy)};
    document.getElementById('site-name').textContent = ${JSON.stringify(host)};
    document.getElementById('site').checked = true;
    return true;
  })()`;
};

// ---------------------------------------------------------------------------
// Composer markup
// ---------------------------------------------------------------------------

const shell = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${BRAND.bg};
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.band{height:${BAND}px;padding:22px 40px 0;display:flex;flex-direction:column;justify-content:center;
  background:linear-gradient(180deg,#141922 0%,${BRAND.bg} 100%);border-bottom:1px solid ${BRAND.line}}
h1{color:${BRAND.ink};font-size:29px;letter-spacing:-.022em;font-weight:660;line-height:1.15}
h1 em{font-style:normal;color:${BRAND.accent}}
p{color:${BRAND.muted};font-size:16px;margin-top:7px;letter-spacing:-.004em}
.stage{position:relative;width:${w}px;height:${h - BAND}px;overflow:hidden}
.half{position:absolute;top:0;height:100%;overflow:hidden}
.half img{position:absolute;top:0;left:0;width:${SHOT_W}px;display:block}
.divider{position:absolute;top:0;left:50%;width:2px;height:100%;background:${BRAND.accent};
  transform:translateX(-1px);box-shadow:0 0 22px rgba(123,149,240,.55)}
.tag{position:absolute;bottom:16px;padding:5px 13px;border-radius:20px;font-size:12px;font-weight:680;
  letter-spacing:.09em;text-transform:uppercase;backdrop-filter:blur(3px)}
.tag.before{left:18px;background:rgba(20,22,28,.82);color:#fff}
.tag.after{right:18px;background:${BRAND.accent};color:#0d1017}
</style></head><body>${body}</body></html>`;

const splitShot = (title, sub, before, after, at = 50) => {
  const px = Math.round((SHOT_W * at) / 100);
  return shell(SHOT_W, SHOT_H, `
    <div class="band"><h1>${title}</h1><p>${sub}</p></div>
    <div class="stage">
      <div class="half" style="left:0;width:${px}px"><img src="${before}"></div>
      <div class="half" style="left:${px}px;width:${SHOT_W - px}px"><img src="${after}" style="left:-${px}px"></div>
      <div class="divider" style="left:${px}px"></div>
      <span class="tag before">Before</span><span class="tag after">Nocturne</span>
    </div>`);
};

const overlayShot = (title, sub, base, overlay, css) =>
  shell(SHOT_W, SHOT_H, `
    <div class="band"><h1>${title}</h1><p>${sub}</p></div>
    <div class="stage">
      <img src="${base}" style="position:absolute;top:0;left:0;width:${SHOT_W}px">
      <img src="${overlay}" style="position:absolute;${css};border-radius:12px;
        box-shadow:0 24px 60px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.09)">
    </div>`);

const pairShot = (title, sub, left, right) =>
  shell(SHOT_W, SHOT_H, `
    <div class="band"><h1>${title}</h1><p>${sub}</p></div>
    <div class="stage" style="display:flex;align-items:center;justify-content:center;gap:32px;padding:0 46px">
      <img src="${left}" style="width:578px;border-radius:12px;
        box-shadow:0 18px 44px rgba(0,0,0,.55),0 0 0 1px ${BRAND.line}">
      <img src="${right}" style="width:578px;border-radius:12px;
        box-shadow:0 18px 44px rgba(0,0,0,.55),0 0 0 1px ${BRAND.line}">
    </div>`);

/** The disc mark, inlined so the tiles do not depend on a raster icon. */
const MARK = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c4cfef"/></linearGradient></defs>
  <circle cx="64" cy="64" r="50" fill="none" stroke="url(#g)" stroke-width="13"/>
  <path d="M64 14 A50 50 0 0 0 64 114 Z" fill="url(#g)"/></svg>`;

const promoTile = (w, h, opts) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{background:
  radial-gradient(1100px 520px at 78% -12%, rgba(123,149,240,.24), transparent 62%),
  linear-gradient(158deg,#1a2030 0%,#0d1015 62%);
  display:flex;align-items:center;gap:${opts.gap}px;padding:0 ${opts.pad}px;position:relative}
body::after{content:"";position:absolute;inset:0;
  background:radial-gradient(700px 300px at 12% 118%, rgba(123,149,240,.12), transparent 70%)}
.mark{flex:none;position:relative;z-index:1;filter:drop-shadow(0 8px 22px rgba(0,0,0,.55))}
.txt{position:relative;z-index:1}
.name{color:#fff;font-size:${opts.name}px;font-weight:700;letter-spacing:-.028em;line-height:1}
.tag{color:#aeb7c8;font-size:${opts.tag}px;margin-top:${opts.tagGap}px;letter-spacing:-.006em;
  line-height:1.35;max-width:${opts.tagWidth}px}
.tag b{color:#cdd6ea;font-weight:600}
.rule{width:${opts.rule}px;height:3px;border-radius:2px;background:#7b95f0;margin-top:${opts.ruleGap}px}
</style></head><body>
  <div class="mark">${MARK(opts.mark)}</div>
  <div class="txt">
    <div class="name">Nocturne</div>
    <div class="tag">${opts.text}</div>
    <div class="rule"></div>
  </div>
</body></html>`;

// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.rm(RAW, { recursive: true, force: true });
  await fs.mkdir(RAW, { recursive: true });

  await fs.access(path.join(ROOT, 'dist', 'chrome', 'manifest.json')).catch(() => {
    throw new Error('dist/chrome not built. Run: node tools/build.mjs');
  });

  await assertCopyMatchesSource();
  const variant = await buildVariant();
  const { server, port } = await serve([path.join(ROOT, 'store', 'demo'), RAW, OUT]);
  const base = `http://localhost:${port}`;
  const PAGE_H = SHOT_H - BAND;
  let cardRects = null;

  try {
    // --- pass 1: no extension, capture the light "before" -----------------
    let session = await launch(null, { port: 9461, headless: true, window: '1400,900' });
    try {
      const v = await waitFor('devtools', () => httpJson(9461, '/json/version'));
      const cdp = await CDP.connect(v.webSocketDebuggerUrl);
      await capture(cdp, `${base}/docs.html`, { width: SHOT_W, height: PAGE_H, name: 'docs-before' });
      await capture(cdp, `${base}/app.html`, { width: SHOT_W, height: PAGE_H, name: 'app-before' });
    } finally {
      await shutdown(session);
    }

    // --- pass 2: extension loaded, capture the themed result --------------
    session = await launch(variant.dir, { port: 9462, headless: true, window: '1400,900' });
    try {
      const v = await waitFor('devtools', () => httpJson(9462, '/json/version'));
      const cdp = await CDP.connect(v.webSocketDebuggerUrl);
      const themed = `document.documentElement.getAttribute('data-nocturne-tier') !== null`;
      const readTier = `Number(document.documentElement.getAttribute('data-nocturne-tier'))`;

      const docsTier = await capture(cdp, `${base}/docs.html`, {
        width: SHOT_W, height: PAGE_H, name: 'docs-after', waitFn: themed, script: readTier,
      });
      const appTier = await capture(cdp, `${base}/app.html`, {
        width: SHOT_W, height: PAGE_H, name: 'app-after', waitFn: themed, script: readTier,
      });

      /*
       * The staged popup statuses have to be the ones these pages really
       * produce. docs.html ships an html.dark theme so it should land on the
       * native rung; app.html is hardcoded hex with no dark mode so it should
       * land on the generated one. If either moves, the screenshot would claim
       * something the product no longer does, so fail instead of shipping it.
       */
      if (docsTier !== 1) throw new Error(`docs.html reached tier ${docsTier}, expected 1 (native)`);
      if (appTier !== 3) throw new Error(`app.html reached tier ${appTier}, expected 3 (generated)`);
      console.log(`verified: docs.html tier ${docsTier}, app.html tier ${appTier}`);

      await capture(cdp, `chrome-extension://${variant.id}/popup/popup.html`, {
        width: 320, height: 700, name: 'popup-native', settle: 1400,
        script: stagePopup(1, 'meridian.dev'), autoHeight: true,
      });
      await capture(cdp, `chrome-extension://${variant.id}/popup/popup.html`, {
        width: 320, height: 700, name: 'popup-generated', settle: 1400,
        script: stagePopup(3, 'northwind.app'), autoHeight: true,
      });

      // Measure the two cards worth showing instead of guessing a crop.
      cardRects = await capture(cdp, `chrome-extension://${variant.id}/options/options.html`, {
        width: 820, height: 1600, name: 'options', settle: 1400,
        script: `(() => {
          const pick = (h) => Array.from(document.querySelectorAll('.card'))
            .find((c) => c.querySelector('h2') && c.querySelector('h2').textContent.trim() === h);
          const box = (el) => { const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y + scrollY),
                     w: Math.round(r.width), h: Math.round(r.height) }; };
          return { theme: box(pick('Theme')), preview: box(pick('Preview')) };
        })()`,
      });
    } finally {
      await shutdown(session);
    }

    for (const [name, r] of Object.entries(cardRects)) {
      await run('magick', [
        path.join(RAW, 'options.png'),
        '-crop', `${r.w}x${r.h}+${r.x}+${r.y}`, '+repage',
        path.join(RAW, `options-${name}.png`),
      ]);
      console.log(`cropped options ${name}: ${r.w}x${r.h}`);
    }

    // --- pass 3: no extension, compose ------------------------------------
    const pages = {
      'screenshot-1': splitShot(
        'Sites with a dark theme get <em>their own</em> dark theme',
        'Nocturne finds the switch the site already has and turns it on. Not an approximation of it.',
        'docs-before.png', 'docs-after.png', 44
      ),
      'screenshot-2': splitShot(
        'Sites without one get a theme <em>built for them</em>',
        'Colours are remapped perceptually, then the result is measured to confirm the text is still readable.',
        'app-before.png', 'app-after.png', 50
      ),
      'screenshot-3': overlayShot(
        'It tells you which one you got',
        'So when a page looks especially good, or especially rough, you know why.',
        'docs-after.png', 'popup-native.png',
        `top:20px;right:34px;width:320px`
      ),
      'screenshot-4': pairShot(
        'Five palettes, and a preview that uses the real engine',
        'Brightness, contrast, colour and a minimum text-contrast floor. Every setting works per site too.',
        'options-theme.png', 'options-preview.png'
      ),
      'screenshot-5': overlayShot(
        'Per-site control, and never a network request',
        'Turn it off on one site, pin a different method, or change the palette just for that page.',
        'app-after.png', 'popup-generated.png',
        `top:20px;right:34px;width:320px`
      ),
      'promo-small-440x280': promoTile(440, 280, {
        mark: 84, gap: 22, pad: 30, name: 38, tag: 14, tagGap: 9, tagWidth: 232, rule: 44, ruleGap: 14,
        text: 'Dark mode that uses <b>the site’s own theme</b> when it has one.',
      }),
      'promo-marquee-1400x560': promoTile(1400, 560, {
        mark: 210, gap: 74, pad: 92, name: 104, tag: 30, tagGap: 22, tagWidth: 760, rule: 108, ruleGap: 32,
        text: 'Dark mode that uses <b>the site’s own theme</b> when it has one, and builds a proper one when it does not.',
      }),
    };

    for (const [name, html] of Object.entries(pages)) {
      await fs.writeFile(path.join(RAW, `${name}.html`), html);
    }

    session = await launch(null, { port: 9463, headless: true, window: '1500,900' });
    try {
      const v = await waitFor('devtools', () => httpJson(9463, '/json/version'));
      const cdp = await CDP.connect(v.webSocketDebuggerUrl);
      for (const name of Object.keys(pages)) {
        const [w, h] = name.startsWith('promo-small')
          ? [440, 280]
          : name.startsWith('promo-marquee')
            ? [1400, 560]
            : [SHOT_W, SHOT_H];
        await capture(cdp, `${base}/${name}.html`, { width: w, height: h, name: `raw-${name}`, settle: 700 });
      }
    } finally {
      await shutdown(session);
    }

    // --- flatten: the store rejects alpha on screenshots and tiles --------
    for (const name of Object.keys(pages)) {
      await run('magick', [
        path.join(RAW, `raw-${name}.png`),
        '-background', BRAND.bg, '-alpha', 'remove', '-alpha', 'off',
        '-type', 'TrueColor', '-depth', '8', '-strip',
        path.join(OUT, `${name}.png`),
      ]);
    }

    // The store icon keeps its alpha: rounded corners are meant to show.
    await fs.copyFile(
      path.join(ROOT, 'src', 'icons', 'icon-128.png'),
      path.join(OUT, 'store-icon-128.png')
    );

    // --- verify every file against what the form demands ------------------
    const expect = {
      'store-icon-128.png': [128, 128, true],
      'screenshot-1.png': [1280, 800, false],
      'screenshot-2.png': [1280, 800, false],
      'screenshot-3.png': [1280, 800, false],
      'screenshot-4.png': [1280, 800, false],
      'screenshot-5.png': [1280, 800, false],
      'promo-small-440x280.png': [440, 280, false],
      'promo-marquee-1400x560.png': [1400, 560, false],
    };
    let bad = 0;
    for (const [file, [w, h, alphaOk]] of Object.entries(expect)) {
      // Pipe separated, not space separated: %[channels] itself contains
      // whitespace ("srgb  3.0"), which silently shifts every later field.
      const { stdout } = await run('magick', [
        'identify', '-format', '%w|%h|%[type]|%[bit-depth]', path.join(OUT, file),
      ]);
      const [gw, gh, type, depth] = stdout.trim().split('|');
      const hasAlpha = /Alpha/i.test(type);
      const sizeOk = Number(gw) === w && Number(gh) === h;
      const alphaFine = alphaOk || !hasAlpha;
      const depthOk = Number(depth) === 8;
      const ok = sizeOk && alphaFine && depthOk;
      if (!ok) bad++;
      console.log(
        `${ok ? 'OK  ' : 'BAD '} ${file.padEnd(28)} ${gw}x${gh}  ${type}  ${depth}-bit`
      );
    }
    if (bad) throw new Error(`${bad} asset(s) do not meet the store requirements`);
    console.log(`\nwrote ${Object.keys(expect).length} assets to ${path.relative(ROOT, OUT)}`);
  } finally {
    server.close();
    await fs.rm(variant.dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
