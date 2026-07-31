/**
 * Behaviour that only appears once settings are set a particular way.
 *
 *   node tools/e2e-settings.mjs
 *
 * Two things are covered: the cascade claim behind the "stubborn sites"
 * option, and the promise that pinning a method actually pins it.
 *
 * A page can put `background-color: #fff !important` in an inline style
 * attribute. Per css-cascade-5 that is an important AUTHOR declaration with the
 * highest possible specificity, and no author-origin stylesheet can outrank it.
 * Important USER-origin declarations can, and scripting.insertCSS is the only
 * way to produce them, which is the entire reason the option exists and the
 * only reason it asks for host access.
 *
 * The run has two phases and BOTH matter:
 *
 *   baseline  stubborn off. The inline white MUST survive. Without this the
 *             second phase could pass for some unrelated reason and nobody
 *             would notice that the feature does nothing.
 *   upgraded  stubborn on. The inline white MUST lose.
 *
 * This needs host access, which a real install only gets when the user grants
 * it from the options page, and a permission prompt cannot be synthesised over
 * the protocol. So the harness builds a THROWAWAY variant that holds the grant
 * up front. That variant is written to dist/, never zipped, and never shipped;
 * tools/build.mjs --check is what verifies the real permission set.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, deriveExtensionId, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9441;

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

async function buildVariant() {
  const from = path.join(ROOT, 'dist', 'chrome');
  const to = path.join(ROOT, 'dist', 'e2e-stubborn');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });

  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });

  const file = path.join(to, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.name = 'Nocturne (throwaway test build, do not ship)';
  // Stands in for the grant a user would make from the options page.
  manifest.host_permissions = ['<all_urls>'];
  manifest.key = der.toString('base64');
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));

  return { dir: to, id: deriveExtensionId(der) };
}

function serve(dir) {
  return http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    try {
      const body = await fs.readFile(path.join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

const READ = `({
  body: getComputedStyle(document.body).backgroundColor,
  panel: getComputedStyle(document.querySelector('div[style]') || document.body).backgroundColor,
  heading: getComputedStyle(document.querySelector('h1')).color,
  tier: document.documentElement.getAttribute('data-nocturne-tier'),
  tagged: document.querySelectorAll('[data-nx]').length,
  sheets: document.querySelectorAll('style[data-nocturne]').length,
  filtered: getComputedStyle(document.documentElement).filter
})`;

async function themedPage(cdp, url, { expectTier = true } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  if (expectTier) {
    await waitFor('themed', async () => {
      const value = await cdp.evaluate(sessionId, `document.documentElement.getAttribute('data-nocturne-tier')`);
      return value != null;
    }, { timeout: 15000, interval: 120 });
  } else {
    // Mode off never publishes a rung, so wait for the stand-down marker.
    await waitFor('stood down', () =>
      cdp.evaluate(sessionId, `document.documentElement.hasAttribute('data-nocturne-off')`)
    , { timeout: 15000, interval: 120 });
  }
  // The user-origin insert is a round trip through the service worker, so it
  // lands a moment after the rung is published.
  await new Promise((r) => setTimeout(r, 700));
  const value = await cdp.evaluate(sessionId, READ);
  await cdp.send('Target.closeTarget', { targetId });
  return value;
}

/** Write settings from an extension page, which is the only context that may. */
async function setSettings(cdp, extensionId, settings) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options/options.html`,
  });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor('options page', () => cdp.evaluate(sessionId, `typeof chrome !== 'undefined' && !!chrome.storage`));
  await cdp.evaluate(
    sessionId,
    `chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => 'ok')`
  );
  await cdp.send('Target.closeTarget', { targetId });
}

async function main() {
  const variant = await buildVariant();
  const server = serve(path.join(ROOT, 'test-pages'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://localhost:${port}/stubborn.html`;

  const session = await launch(variant.dir, { port: PORT, headless: true, window: '1000,800' });
  try {
    const version = await waitFor('devtools', () => httpJson(PORT, '/json/version'));
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    console.log(`browser: ${version.Browser}\nextension: ${variant.id}\n`);

    await setSettings(cdp, variant.id, { enabled: true, stubborn: false });
    const baseline = await themedPage(cdp, url);
    record(
      baseline.body === 'rgb(255, 255, 255)',
      'baseline: inline !important survives an author-origin sheet',
      baseline.body
    );
    record(
      baseline.panel === 'rgb(240, 240, 240)',
      'baseline: the inline panel survives too',
      baseline.panel
    );

    await setSettings(cdp, variant.id, { enabled: true, stubborn: true });
    const upgraded = await themedPage(cdp, url);
    record(
      upgraded.body !== 'rgb(255, 255, 255)',
      'stubborn on: user-origin beats inline !important on the body',
      upgraded.body
    );
    record(
      upgraded.panel !== 'rgb(240, 240, 240)',
      'stubborn on: and on an inline-styled panel',
      upgraded.panel
    );
    record(
      upgraded.heading !== 'rgb(0, 0, 0)',
      'stubborn on: inline !important text colour is beaten as well',
      upgraded.heading
    );

    /*
     * "Site theme only" on a site that has no theme of its own.
     *
     * legacy.html is pure hardcoded hex with no dark mode anywhere, so this
     * mode has nothing it is allowed to do. The failure this guards against is
     * falling through to the generated tier and then to inversion, which is
     * precisely what the popup tells the user will not happen.
     */
    const legacy = `http://localhost:${port}/legacy.html`;
    await setSettings(cdp, variant.id, { enabled: true, mode: 'native' });
    const pinnedNative = await themedPage(cdp, legacy);
    record(
      pinnedNative.tagged === 0,
      'mode native: did not recolour a site with no dark theme',
      `${pinnedNative.tagged} elements tagged`
    );
    record(
      pinnedNative.filtered === 'none',
      'mode native: did not fall through to inversion',
      pinnedNative.filtered
    );

    await setSettings(cdp, variant.id, { enabled: true, mode: 'filter' });
    const pinnedFilter = await themedPage(cdp, legacy);
    record(
      pinnedFilter.filtered !== 'none' && pinnedFilter.tier === '4',
      'mode filter: pins to inversion',
      `tier ${pinnedFilter.tier}, filter ${pinnedFilter.filtered}`
    );

    await setSettings(cdp, variant.id, { enabled: true, mode: 'off' });
    const pinnedOff = await themedPage(cdp, legacy, { expectTier: false });
    record(
      pinnedOff.body === 'rgb(255, 255, 255)' && pinnedOff.tagged === 0,
      'mode off: leaves the page completely alone',
      pinnedOff.body
    );
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
