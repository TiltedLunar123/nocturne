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
      swatchPainted: getComputedStyle(document.querySelector('#palettes .chip')).backgroundImage !== 'none'
    })` },
  { name: 'options', url: 'options/options.html', width: 820, height: 1500, probe: `({
      palettes: document.querySelectorAll('#palettes .swatch').length,
      sliders: document.querySelectorAll('input[type=range]').length,
      previewFilled: document.getElementById('preview').children.length,
      previewBg: getComputedStyle(document.getElementById('preview')).backgroundColor,
      version: document.getElementById('version').textContent
    })` },
];

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const variant = await buildVariant();
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
  } finally {
    await shutdown(session);
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
