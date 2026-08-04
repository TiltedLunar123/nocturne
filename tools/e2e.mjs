/**
 * End-to-end verification against a real browser.
 *
 * Loads the built extension, opens each fixture, and checks two things: that
 * the ladder settled on the rung the fixture was designed to exercise, and
 * that the page genuinely came out dark and readable.
 *
 *   node tools/e2e.mjs
 *
 * The darkness check is written here from scratch rather than reusing
 * NX.probe. An assertion that calls the implementation it is testing agrees
 * with it by construction; this one samples the rendered page independently
 * and can therefore disagree.
 *
 * Note on emulation: headless Chromium reports a dark system preference by
 * default, which would make every light fixture already dark and every test
 * vacuous. Each page is emulated to a light preference first, so the extension
 * has real work to do.
 *
 * Note on browser choice: branded Google Chrome ignores --load-extension, so
 * the extension silently never loads there. cdp.mjs prefers Edge.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9422;

const TIER = { OFF: 0, NATIVE: 1, TOKENS: 2, COMPUTE: 3, FILTER: 4 };
const TIER_NAME = ['off', 'native', 'tokens', 'compute', 'filter'];

/**
 * Independent measurement, run in the page's main world.
 *
 * Samples a grid over the viewport, resolves the actually painted background
 * at each point by walking up for the first opaque ancestor, and reports how
 * much of the screen is still light plus the worst text contrast it found.
 * Plain WCAG luminance, no shared code with the engine.
 */
const MEASURE = `(() => {
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const rgb = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  // Models CSS canvas background propagation: when the root is transparent the
  // browser paints the canvas with the body's background. Reading only the
  // root reports a correctly themed page as half light.
  const canvas = () => {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.05) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const painted = (el) => {
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth++ < 40) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.05) return c;
      node = node.parentElement;
    }
    return canvas();
  };
  const contrast = (a, b) => {
    const la = lum(a.r, a.g, a.b), lb = lum(b.r, b.g, b.b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const W = innerWidth, H = innerHeight;
  let sampled = 0, light = 0, sum = 0;
  const contrasts = [];
  const seen = new Set();

  for (let ix = 0; ix < 10; ix++) {
    for (let iy = 0; iy < 10; iy++) {
      const x = ((ix + 0.5) / 10) * W, y = ((iy + 0.5) / 10) * H;
      const el = document.elementFromPoint(x, y) || document.body;
      if (!el) continue;
      const bg = painted(el);
      const l = lum(bg.r, bg.g, bg.b);
      sampled++; sum += l;
      if (l > 0.22) light++;
      if (!seen.has(el)) {
        seen.add(el);
        const hasText = Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 1
        );
        const fg = rgb(getComputedStyle(el).color);
        if (hasText && fg && fg.a > 0.3) contrasts.push(contrast(fg, bg));
      }
    }
  }
  contrasts.sort((a, b) => a - b);
  return {
    sampled,
    lightFraction: sampled ? light / sampled : 1,
    meanLuminance: sampled ? sum / sampled : 1,
    worstContrast: contrasts.length ? contrasts[0] : null,
    medianContrast: contrasts.length ? contrasts[Math.floor(contrasts.length / 2)] : null,
    textSamples: contrasts.length,
    tier: document.documentElement.getAttribute('data-nocturne-tier'),
    ready: document.documentElement.hasAttribute('data-nocturne-ready'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})()`;

const CASES = [
  {
    file: 'native-class.html',
    label: 'site theme via class',
    expect: TIER.NATIVE,
    // Proof the site's own theme was switched on rather than one of ours.
    extra: `document.documentElement.classList.contains('dark')`,
    extraLabel: 'html.dark was set',
  },
  {
    file: 'native-media.html',
    label: 'site theme via media query',
    expect: TIER.NATIVE,
    extra: `!!document.querySelector('style[data-nocturne="promoted"]')`,
    extraLabel: 'dark media rules were promoted',
  },
  {
    file: 'tokens.html',
    label: 'design token remap',
    expect: TIER.TOKENS,
    extra: `!!document.querySelector('style[data-nocturne="tokens"]')`,
    extraLabel: 'token sheet was injected',
  },
  {
    file: 'legacy.html',
    label: 'computed sweep on a legacy page',
    expect: TIER.COMPUTE,
    extra: `document.querySelectorAll('[data-nx]').length > 5`,
    extraLabel: 'elements were tagged',
  },
  {
    file: 'modern-color.html',
    label: 'oklch, lab, display-p3 and color-mix',
    expect: TIER.COMPUTE,
  },
  {
    file: 'heavy.html',
    label: 'a heavy page',
    expect: TIER.COMPUTE,
    maxMs: 1600,
    // Asserted because the fixture builds its DOM in script, and a broken
    // fixture would quietly turn the timing check into a measurement of an
    // almost empty page. That is exactly what happened once.
    extra: `document.querySelectorAll('*').length > 4000`,
    extraLabel: 'the fixture really did build a large DOM',
    report: `({
      elements: document.querySelectorAll('*').length,
      tagged: document.querySelectorAll('[data-nx]').length,
      rules: (document.querySelector('style[data-nocturne="computed"]')?.textContent || '')
        .split('\\n').filter(Boolean).length
    })`,
  },
];

function serve(dir) {
  return http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname) || 'index.html';
    /*
     * A deliberately slow subresource, so `load` stays pending long enough to
     * sample the page before and after the engine's post-load re-sweep. The
     * re-sweep is the only path that reads a page Nocturne has already
     * written to, and it is therefore the only path that can read its own
     * output back.
     */
    if (name === 'slow.gif') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
      }, 4000);
      return;
    }
    try {
      const body = await fs.readFile(path.join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

async function openPage(cdp, browserTargetId) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  }, sessionId);
  return { targetId, sessionId };
}

async function run() {
  const dist = path.join(ROOT, 'dist', 'chrome');
  await fs.access(path.join(dist, 'manifest.json')).catch(() => {
    throw new Error('dist/chrome not built. Run: node tools/build.mjs');
  });

  const server = serve(path.join(ROOT, 'test-pages'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const session = await launch(dist, { port: PORT, headless: true, window: '1280,900' });
  let cdp;
  try {
    const version = await waitFor('devtools', () => httpJson(PORT, '/json/version'));
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    console.log(`browser: ${version.Browser}\n`);

    for (const testCase of CASES) {
      const { targetId, sessionId } = await openPage(cdp);
      const started = Date.now();
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/${testCase.file}` }, sessionId);

      // Wait for the ladder to publish a rung rather than sleeping a fixed time.
      let measurement = null;
      try {
        measurement = await waitFor(
          `${testCase.file} to be themed`,
          async () => {
            const value = await cdp.evaluate(sessionId, MEASURE);
            return value && value.tier != null ? value : null;
          },
          { timeout: 15000, interval: 120 }
        );
      } catch {
        record(false, `${testCase.label}: never themed`, `(${testCase.file})`);
        await cdp.send('Target.closeTarget', { targetId });
        continue;
      }
      const elapsed = Date.now() - started;

      const tier = Number(measurement.tier);
      record(
        tier === testCase.expect,
        `${testCase.label}: settled on tier ${TIER_NAME[tier]}`,
        `expected ${TIER_NAME[testCase.expect]}`
      );
      record(
        measurement.lightFraction <= 0.12,
        `${testCase.label}: page is dark`,
        `${Math.round(measurement.lightFraction * 100)}% of screen still light`
      );
      if (measurement.textSamples > 0) {
        record(
          measurement.medianContrast >= 3.2,
          `${testCase.label}: text is readable`,
          `median ${measurement.medianContrast.toFixed(1)}:1 over ${measurement.textSamples} samples`
        );
      }
      if (testCase.extra) {
        const value = await cdp.evaluate(sessionId, testCase.extra);
        record(!!value, `${testCase.label}: ${testCase.extraLabel}`);
      }
      if (testCase.report) {
        const detail = await cdp.evaluate(sessionId, testCase.report);
        console.log(`      ${testCase.label}: ${JSON.stringify(detail)}`);
      }
      if (testCase.maxMs) {
        record(elapsed <= testCase.maxMs, `${testCase.label}: themed in time`, `${elapsed}ms of ${testCase.maxMs}ms`);
      }
      await cdp.send('Target.closeTarget', { targetId });
    }

    // --- content that arrives after load must get themed too -------------
    {
      const { targetId, sessionId } = await openPage(cdp);
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/dynamic.html` }, sessionId);
      // Wait for the page's own late append, then for the observer to catch up.
      await waitFor('late content', () =>
        cdp.evaluate(sessionId, `document.documentElement.hasAttribute('data-test-added')`)
      );
      const late = await waitFor(
        'late content themed',
        async () => {
          const value = await cdp.evaluate(
            sessionId,
            `(() => {
               const nodes = Array.from(document.querySelectorAll('.late'));
               const tagged = nodes.filter((n) => n.hasAttribute('data-nx')).length;
               const bg = nodes.length ? getComputedStyle(nodes[0]).backgroundColor : null;
               const text = nodes.length ? getComputedStyle(nodes[0]).color : null;
               return { count: nodes.length, tagged, bg, text };
             })()`
          );
          return value && value.tagged === value.count ? value : null;
        },
        { timeout: 10000, interval: 150 }
      ).catch(() => null);

      record(!!late, 'late content: every added node was tagged', late ? `${late.tagged}/${late.count}` : 'timed out');
      if (late) {
        record(late.bg !== 'rgb(255, 255, 255)', 'late content: background was themed', late.bg);
        record(late.text !== 'rgb(0, 0, 0)', 'late content: text was themed', late.text);
      }
      await cdp.send('Target.closeTarget', { targetId });
    }

    // --- the post-load re-sweep must not read back our own output --------
    {
      const { targetId, sessionId } = await openPage(cdp);
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/slow-load.html` }, sessionId);

      const SAMPLE = `({
        tier: document.documentElement.getAttribute('data-nocturne-tier'),
        ready: document.readyState,
        page: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.getElementById('card')).backgroundColor,
        text: getComputedStyle(document.getElementById('para')).color
      })`;

      const before = await waitFor(
        'slow page to settle on compute',
        async () => {
          const value = await cdp.evaluate(sessionId, SAMPLE);
          return value && value.tier === String(TIER.COMPUTE) ? value : null;
        },
        { timeout: 15000, interval: 100 }
      );

      // Let load fire and the engine's own 250ms late pass run to completion.
      await waitFor(
        'slow page to finish loading',
        async () => (await cdp.evaluate(sessionId, SAMPLE)).ready === 'complete',
        { timeout: 20000, interval: 150 }
      );
      await new Promise((r) => setTimeout(r, 900));
      const after = await cdp.evaluate(sessionId, SAMPLE);

      /*
       * Every rule Nocturne writes for the compute tier is live while this
       * second sweep runs, so getComputedStyle hands back Nocturne's own
       * colours unless the sheet is stood down for the read. Mapping those a
       * second time walks every surface towards mid grey and collapses the
       * card into the page behind it.
       */
      record(
        before.page === after.page,
        're-sweep: page background is unchanged by the late pass',
        `${before.page} -> ${after.page}`
      );
      record(
        before.text === after.text,
        're-sweep: body text is unchanged by the late pass',
        `${before.text} -> ${after.text}`
      );
      record(
        before.card === after.card,
        're-sweep: the card is unchanged by the late pass',
        `${before.card} -> ${after.card}`
      );
      // "Different string" is not good enough here: the collapsed case landed
      // one part in 255 apart, which no eye can see. Ask for a real gap.
      const channels = (value) => (String(value).match(/\d+/g) || []).map(Number);
      const gap = Math.max(
        ...channels(after.card).map((c, i) => Math.abs(c - (channels(after.page)[i] ?? 0)))
      );
      record(
        gap >= 3,
        're-sweep: the card is still visibly raised above the page',
        `card ${after.card} vs page ${after.page}, widest channel gap ${gap}`
      );
      await cdp.send('Target.closeTarget', { targetId });
    }

    // --- a page that is already dark must be left alone ------------------
    {
      const { targetId, sessionId } = await openPage(cdp);
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/already-dark.html` }, sessionId);
      const measurement = await waitFor(
        'already-dark to settle',
        async () => {
          const value = await cdp.evaluate(sessionId, MEASURE);
          return value && value.tier != null ? value : null;
        },
        { timeout: 15000, interval: 120 }
      );
      const untouched = await cdp.evaluate(
        sessionId,
        `({
           tagged: document.querySelectorAll('[data-nx]').length,
           sheets: document.querySelectorAll('style[data-nocturne]').length,
           bodyBg: getComputedStyle(document.body).backgroundColor
         })`
      );
      record(
        untouched.tagged === 0 && untouched.sheets === 0,
        'already dark page: engine did not touch it',
        `${untouched.tagged} tagged, ${untouched.sheets} sheets`
      );
      record(
        untouched.bodyBg === 'rgb(13, 17, 23)',
        'already dark page: original colours intact',
        untouched.bodyBg
      );
      record(measurement.lightFraction <= 0.12, 'already dark page: still dark');
      await cdp.send('Target.closeTarget', { targetId });
    }

    // --- the anti-flash shell must be in force before the engine finishes -
    {
      const { targetId, sessionId } = await openPage(cdp);
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/legacy.html` }, sessionId);
      // Read the painted root background as early as the protocol allows. The
      // guard is CSS applied at document_start, so it should already be dark
      // even before the ladder has run.
      const early = await cdp.evaluate(
        sessionId,
        `({
           html: getComputedStyle(document.documentElement).backgroundColor,
           scheme: getComputedStyle(document.documentElement).colorScheme
         })`
      );
      record(
        early.html === 'rgb(22, 24, 28)',
        'anti-flash shell: root is dark immediately',
        early.html
      );
      record(early.scheme === 'dark', 'anti-flash shell: color-scheme is dark', early.scheme);
      await cdp.send('Target.closeTarget', { targetId });
    }
  } finally {
    await shutdown(session);
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
