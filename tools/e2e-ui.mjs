/**
 * Renders the popup and the options page in a real browser, screenshots them,
 * and fails on any console error.
 *
 *   node tools/e2e-ui.mjs
 *
 * The rest of the suite exercises the engine and never opens either page, so
 * without this a broken settings page would ship green.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, deriveExtensionId, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'shots');
const PORT = 9451;

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

async function buildVariant() {
  const from = path.join(ROOT, 'dist', 'chrome');
  const to = path.join(ROOT, 'dist', 'e2e-ui');
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

const PAGES = [
  { name: 'popup', url: 'popup/popup.html', width: 320, height: 620, probe: `({
      palettes: document.querySelectorAll('#palettes .swatch').length,
      modes: document.querySelectorAll('#modes .mode').length,
      sliders: document.querySelectorAll('input[type=range]').length,
      status: document.getElementById('status').textContent.trim(),
      swatchPainted: getComputedStyle(document.querySelector('#palettes .chip')).backgroundImage !== 'none',
      support: (document.querySelector('.foot a[href*="buymeacoffee"]') || {}).textContent,
      footOverflow: (() => {
        const foot = document.querySelector('.foot');
        return foot.scrollWidth - foot.clientWidth;
      })()
    })` },
  { name: 'options', url: 'options/options.html', width: 820, height: 1500, probe: `({
      palettes: document.querySelectorAll('#palettes .swatch').length,
      sliders: document.querySelectorAll('input[type=range]').length,
      previewFilled: document.getElementById('preview').children.length,
      previewBg: getComputedStyle(document.getElementById('preview')).backgroundColor,
      version: document.getElementById('version').textContent
    })` },
];

/** A plain light page, so the ladder has real work to do. */
const SITE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Site</title>
<style>body{background:#fff;color:#333;font:16px sans-serif;padding:20px}h1{color:#111}</style>
</head><body><h1>Heading</h1><p>Body copy.</p></body></html>`;

/**
 * Can the extension work out which site the open tab is showing?
 *
 * This suite builds the SHIPPED permission set (the key is added so the id is
 * predictable, and nothing else), which is what makes this the right place to
 * ask. Under `storage`, `alarms` and `scripting` with `<all_urls>` optional
 * and ungranted, Chrome returns Tab objects with no `url` property at all.
 * Every surface that parsed an origin out of one therefore got null on every
 * page: the popup said it could not run here, the site switch was disabled,
 * the toolbar icon stayed off, and the site shortcut did nothing. The origin
 * has to be asked for, from frame 0 of the page itself.
 */
async function inspectOpenTab(cdp, extensionId) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options/options.html`,
  });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor('extension page', () =>
    cdp.evaluate(sessionId, `typeof chrome !== 'undefined' && !!chrome.tabs`)
  );
  const value = await cdp.evaluate(
    sessionId,
    `(async () => {
       const tabs = await chrome.tabs.query({});
       /*
        * The tab cannot be picked out by URL, which is the whole point: under
        * the shipped permissions there is no URL to pick it out by. Ask every
        * tab instead and take the one that answers with an origin. Extension
        * pages have no content script and reject; about: pages run one but
        * resolve to no origin, which is correct for them.
        */
       let found = null;
       for (const tab of tabs) {
         if (tab.id == null) continue;
         const report = await chrome.tabs
           .sendMessage(tab.id, { type: 'get-state' }, { frameId: 0 })
           .catch(() => null);
         if (report && report.origin) {
           found = { tab, report };
           break;
         }
       }
       const anyUrlReadable = tabs.some((t) => typeof t.url === 'string' && t.url.length > 0);
       if (!found) return { urlReadable: anyUrlReadable, origin: null, tier: null, title: null };
       return {
         urlReadable: anyUrlReadable,
         origin: found.report.origin,
         tier: found.report.tier,
         title: await chrome.action.getTitle({ tabId: found.tab.id }),
       };
     })()`
  );
  await cdp.send('Target.closeTarget', { targetId });
  return value;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const variant = await buildVariant();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SITE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sitePort = server.address().port;
  const session = await launch(variant.dir, { port: PORT, headless: true, window: '1000,900' });
  try {
    const version = await waitFor('devtools', () => httpJson(PORT, '/json/version'));
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    console.log(`browser: ${version.Browser}\n`);

    for (const page of PAGES) {
      const { targetId } = await cdp.send('Target.createTarget', {
        url: `chrome-extension://${variant.id}/${page.url}`,
      });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);

      const errors = [];
      cdp.socket.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.exceptionThrown') {
          errors.push(msg.params.exceptionDetails.text || 'exception');
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          errors.push((msg.params.args || []).map((a) => a.value || a.description).join(' '));
        }
      });

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: page.width, height: page.height, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await new Promise((r) => setTimeout(r, 1200));

      const probe = await cdp.evaluate(sessionId, page.probe);
      record(errors.length === 0, `${page.name}: no console errors`, errors.join(' | '));
      record(probe.palettes === 5, `${page.name}: all five palettes rendered`, `${probe.palettes}`);
      record(probe.sliders >= 3, `${page.name}: sliders rendered`, `${probe.sliders}`);
      if (page.name === 'popup') {
        record(probe.modes === 4, 'popup: all four methods offered', `${probe.modes}`);
        record(!!probe.status, 'popup: status line has text', probe.status);
        record(probe.swatchPainted, 'popup: palette swatches painted by the real transform');
        record(
          probe.support === 'Buy me a coffee',
          'popup: the support link is present in the footer',
          probe.support
        );
        // The popup is a fixed 320px, so a third footer link is the kind of
        // thing that quietly pushes the row into a scrollbar.
        record(
          probe.footOverflow <= 0,
          'popup: the footer still fits the 320px width',
          `overflow ${probe.footOverflow}px`
        );
      } else {
        record(probe.previewFilled > 0, 'options: preview rendered', `${probe.previewFilled} nodes`);
        record(
          probe.previewBg !== 'rgba(0, 0, 0, 0)' && probe.previewBg !== 'rgb(255, 255, 255)',
          'options: preview uses a themed surface',
          probe.previewBg
        );
        record(/^Version \d/.test(probe.version), 'options: version shown', probe.version);
      }

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      await fs.writeFile(path.join(OUT, `ui-${page.name}.png`), Buffer.from(shot.data, 'base64'));
      await cdp.send('Target.closeTarget', { targetId });
    }

    // --- the per-site half, under the permission set we actually ship -----
    {
      const { targetId } = await cdp.send('Target.createTarget', {
        url: `http://localhost:${sitePort}/`,
      });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      }, sessionId);
      await waitFor('site themed', () =>
        cdp.evaluate(sessionId, `document.documentElement.getAttribute('data-nocturne-tier') != null`)
      , { timeout: 15000, interval: 120 });
      await new Promise((r) => setTimeout(r, 800));

      const seen = await inspectOpenTab(cdp, variant.id);
      record(
        seen.urlReadable === false,
        'shipped permissions: tab.url really is unavailable, so nothing may read it',
        `tab.url readable: ${seen.urlReadable}`
      );
      record(
        seen.origin === 'localhost',
        'shipped permissions: the origin still arrives, from the page over frame 0',
        String(seen.origin)
      );
      record(
        /on for this site/.test(seen.title || ''),
        'shipped permissions: the toolbar reflects the themed tab',
        String(seen.title)
      );
      await cdp.send('Target.closeTarget', { targetId });
    }
  } finally {
    await shutdown(session);
    server.close();
    await fs.rm(variant.dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
