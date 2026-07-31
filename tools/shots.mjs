/**
 * Capture each fixture with and without the extension, side by side.
 *
 *   node tools/shots.mjs [outputDir]
 *
 * The end-to-end suite proves a page measured dark and readable. It cannot
 * tell you the result looks good. This is for looking at it.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'shots');

const PAGES = [
  'native-class.html',
  'native-media.html',
  'tokens.html',
  'legacy.html',
  'modern-color.html',
  'already-dark.html',
  'heavy.html',
];

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

async function capture(withExtension, port, tag) {
  const dist = path.join(ROOT, 'dist', 'chrome');
  const devtoolsPort = withExtension ? 9431 : 9432;
  const session = await launch(withExtension ? dist : null, {
    port: devtoolsPort,
    headless: true,
    window: '900,700',
  });
  try {
    const version = await waitFor('devtools', () => httpJson(devtoolsPort, '/json/version'));
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);

    for (const page of PAGES) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 880, height: 660, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      // Light preference, so the fixtures start where a real light page does.
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      }, sessionId);
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/${page}` }, sessionId);

      if (withExtension) {
        await waitFor(`${page} themed`, async () => {
          const ready = await cdp.evaluate(
            sessionId,
            `document.documentElement.getAttribute('data-nocturne-tier')`
          );
          return ready != null;
        }, { timeout: 15000, interval: 120 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 500));

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await fs.writeFile(
        path.join(OUT, `${page.replace('.html', '')}-${tag}.png`),
        Buffer.from(shot.data, 'base64')
      );
      await cdp.send('Target.closeTarget', { targetId });
    }
  } finally {
    await shutdown(session);
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const server = serve(path.join(ROOT, 'test-pages'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await capture(false, port, 'before');
    await capture(true, port, 'after');
    console.log(`wrote ${PAGES.length * 2} screenshots to ${path.relative(ROOT, OUT)}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
