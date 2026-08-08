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
  filtered: getComputedStyle(document.documentElement).filter,
  fights: document.documentElement.getAttribute('data-fights')
})`;

/**
 * Content the page paints after the ladder has already settled.
 *
 * The same inline `!important` the rest of the fixture uses, in colours nothing
 * on the page has used yet, so the first climb cannot already have written a
 * rule that covers it. Everything a modern application renders after hydration
 * arrives exactly like this.
 */
const LATE = `(() => {
  const el = document.createElement('div');
  el.id = 'late';
  el.setAttribute(
    'style',
    'background-color:#fdfdfd !important; color:#050505 !important; padding:16px; margin:12px 0'
  );
  el.textContent = 'Painted after the first climb, the way hydration does it.';
  document.body.appendChild(el);
  return 'added';
})()`;

const LATE_READ = `(() => {
  const el = document.getElementById('late');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { bg: cs.backgroundColor, fg: cs.color, tag: el.getAttribute('data-nx') };
})()`;

/** Nudge a panel the first climb already themed, without touching its colours. */
const TOUCH = `(() => {
  document.querySelector('div[style]').style.paddingTop = '17px';
  return 'touched';
})()`;

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

/**
 * Run an expression in an extension page, for things that must go through the
 * worker rather than straight into storage. A direct storage write does not
 * broadcast, so the content script never learns anything changed.
 */
async function sendFromExtension(cdp, extensionId, expression) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options/options.html`,
  });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor('extension page', () =>
    cdp.evaluate(sessionId, `typeof chrome !== 'undefined' && !!chrome.runtime`)
  );
  const value = await cdp.evaluate(sessionId, expression);
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

/**
 * What an extension page can actually learn about the open tab.
 *
 * This is the check that was missing. Nocturne ships with no `tabs`
 * permission and no default host permission, so `tabs.query` returns Tab
 * objects with no `url` key at all, and every surface that derived the origin
 * from one derived null: the popup claimed it could not run anywhere, the site
 * switch was disabled, the toolbar icon was stuck off, and the site shortcut
 * did nothing. The origin has to come from the page, over frame 0.
 */
async function inspectTab(cdp, extensionId, pageUrl) {
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
       const target = tabs.find((t) => t.id != null && t.url === ${JSON.stringify(pageUrl)});
       const any = tabs.find((t) => t.id != null && t.url == null);
       const tab = target || any;
       const report = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'get-state' }, { frameId: 0 }).catch(() => null) : null;
       return {
         urlWasReadable: tab ? typeof tab.url === 'string' : false,
         originFromPage: report ? report.origin : null,
         tierFromPage: report ? report.tier : null,
         title: tab ? await chrome.action.getTitle({ tabId: tab.id }) : null,
       };
     })()`
  );
  await cdp.send('Target.closeTarget', { targetId });
  return value;
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

    /*
     * The same promise, but for an origin the ladder has already been up.
     *
     * A site visited on `auto` first records where the ladder settled, so the
     * next visit can start there. That shortcut used to be applied before the
     * pinned-mode check rather than after, so switching an already-visited
     * site to "Site theme only" started the climb at the learned rung and
     * sailed straight past the early return that makes the mode mean
     * anything. The mode silently did the opposite of what it says.
     */
    await setSettings(cdp, variant.id, {
      enabled: true,
      mode: 'native',
      learned: { localhost: { tier: 3, at: 1 } },
    });
    const pinnedNativeLearned = await themedPage(cdp, legacy);
    record(
      pinnedNativeLearned.tagged === 0,
      'mode native: still does not recolour an origin that learned the compute tier',
      `${pinnedNativeLearned.tagged} elements tagged, tier ${pinnedNativeLearned.tier}`
    );
    record(
      pinnedNativeLearned.filtered === 'none',
      'mode native: a learned tier does not drag it into inversion either',
      pinnedNativeLearned.filtered
    );

    /*
     * The per-site half of the product, end to end in a real browser.
     *
     * Everything above drives storage directly, so none of it would have
     * noticed that no surface could work out which site it was looking at.
     */
    {
      await setSettings(cdp, variant.id, { enabled: true, mode: 'auto' });
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      }, sessionId);
      await cdp.send('Page.navigate', { url: legacy }, sessionId);
      await waitFor('themed', () =>
        cdp.evaluate(sessionId, `document.documentElement.getAttribute('data-nocturne-tier') != null`)
      , { timeout: 15000, interval: 120 });
      await new Promise((r) => setTimeout(r, 700));

      /*
       * Note that this harness's build grants <all_urls> so the stubborn
       * checks above can run, which means tab.url happens to be readable
       * here. That is exactly why the assertions below ignore it: they check
       * that the origin arrives from the page, which is the path the shipped
       * permission set actually has. The shipped permission set itself is
       * pinned by the release gate in tools/build.mjs.
       */
      const seen = await inspectTab(cdp, variant.id, legacy);
      record(
        seen.originFromPage === 'localhost',
        'per-site: the page reports its own origin over frame 0',
        String(seen.originFromPage)
      );
      record(
        seen.tierFromPage != null,
        'per-site: the page reports the rung it settled on',
        String(seen.tierFromPage)
      );
      record(
        /on for this site/.test(seen.title || ''),
        'per-site: the toolbar title reflects a themed tab',
        String(seen.title)
      );
      await cdp.send('Target.closeTarget', { targetId });
    }

    /*
     * A site that keeps stripping the theme class does not turn "Site theme
     * only" into permission to recolour.
     *
     * Losing that fight hands control back to the ladder, which is right for
     * `auto` and wrong here: everything above the native rung is exactly what
     * this mode refuses. Re-entering the native rung instead would re-apply
     * the class the site has already stripped five times and restart the
     * fight, so the honest outcome is the page as the site renders it.
     */
    {
      await setSettings(cdp, variant.id, { enabled: true, stubborn: false, mode: 'native' });
      const hostile = await themedPage(cdp, `http://localhost:${port}/hostile-theme.html`);
      record(
        Number(hostile.fights) >= 5,
        'hostile site: the page really did strip the theme class back off',
        `${hostile.fights} times`
      );
      record(
        hostile.tagged === 0 && hostile.filtered === 'none',
        'hostile site: losing the fight does not license recolouring under mode native',
        `tier ${hostile.tier}, ${hostile.tagged} tagged, filter ${hostile.filtered}`
      );
    }

    /*
     * A demotion to inversion is a performance backstop, not a preference, so
     * it still applies when the user has asked for a generated theme. Paying
     * for the whole sweep again on a page that already melted under it is the
     * cost the demotion exists to avoid, and a pass that happens to measure
     * well would re-learn compute and undo it entirely.
     */
    {
      await setSettings(cdp, variant.id, {
        enabled: true,
        stubborn: false,
        mode: 'dynamic',
        learned: { localhost: { tier: 4, at: 1 } },
      });
      const demoted = await themedPage(cdp, legacy);
      record(
        demoted.tier === '4' && demoted.tagged === 0,
        'demotion: a learned filter still short-circuits the sweep under mode dynamic',
        `tier ${demoted.tier}, ${demoted.tagged} tagged`
      );
    }

    /*
     * Turning Nocturne off has to take the USER-origin sheet with it.
     *
     * That sheet outranks every rule the page itself can write, so a copy
     * left behind is not a cosmetic leftover: the page stays inverted, or
     * token-remapped, for the life of the document, and nothing on the page
     * or in the extension can override it while Nocturne reports itself off.
     * Driven through the worker rather than through storage, because it is
     * the broadcast that makes the content script re-apply.
     */
    {
      await setSettings(cdp, variant.id, { enabled: true, stubborn: true, mode: 'filter' });
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      }, sessionId);
      await cdp.send('Page.navigate', { url: legacy }, sessionId);
      await waitFor('inverted', async () => {
        const value = await cdp.evaluate(sessionId, READ);
        return value.filtered && value.filtered !== 'none' ? value : null;
      }, { timeout: 15000, interval: 120 });
      await new Promise((r) => setTimeout(r, 700));

      await sendFromExtension(
        cdp,
        variant.id,
        `chrome.runtime.sendMessage({ type: 'set-site', origin: 'localhost', patch: { enabled: false } })`
      );
      await new Promise((r) => setTimeout(r, 1200));

      const after = await cdp.evaluate(sessionId, READ);
      record(
        after.filtered === 'none',
        'stand down: the user-origin sheet goes with it',
        `filter is ${after.filtered}`
      );
      record(
        after.sheets === 0,
        'stand down: no author sheets are left either',
        `${after.sheets} sheets`
      );
      await cdp.send('Target.closeTarget', { targetId });
    }

    /*
     * A settings change must not leave a stubborn site light.
     *
     * apply() tears down the sheets this document owns and climbs again, but
     * clearAll cannot reach the USER-origin mirror: that one was inserted by
     * the worker and a content script cannot suspend it. So the second climb
     * measured Nocturne's own colours, concluded the page was already dark,
     * returned "untouched", and then withdrew the very mirror it had just
     * measured. The page went white and the popup reported it as using the
     * site's own dark theme.
     */
    {
      const tokens = `http://localhost:${port}/tokens.html`;
      await setSettings(cdp, variant.id, { enabled: true, stubborn: true, mode: 'auto' });
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      }, sessionId);
      await cdp.send('Page.navigate', { url: tokens }, sessionId);
      await waitFor('themed', async () => {
        const value = await cdp.evaluate(sessionId, READ);
        return value.tier != null ? value : null;
      }, { timeout: 15000, interval: 120 });
      await new Promise((r) => setTimeout(r, 700));
      const before = await cdp.evaluate(sessionId, READ);

      // Through the worker, because it is the broadcast that makes the
      // content script re-apply. Any setting will do; the bug is in the
      // re-climb, not in what changed.
      await sendFromExtension(
        cdp,
        variant.id,
        `chrome.runtime.sendMessage({ type: 'patch-settings', patch: { brightness: 101 } })`
      );
      await new Promise((r) => setTimeout(r, 1500));
      const after = await cdp.evaluate(sessionId, READ);

      record(
        after.body !== 'rgb(255, 255, 255)',
        'stubborn re-apply: a settings change does not leave the page white',
        `${before.body} -> ${after.body}`
      );
      record(
        after.tier === before.tier,
        'stubborn re-apply: the page lands on the same rung it was already on',
        `tier ${before.tier} -> ${after.tier}`
      );
      await cdp.send('Target.closeTarget', { targetId });
    }

    /*
     * Content painted after the first climb has to reach USER origin too.
     *
     * Stubborn mode exists because author origin loses to a page's inline
     * `!important`, so a rule that only ever reaches author origin does nothing
     * on precisely the sites this option is for. rescan() grows the compute
     * sheet as the page changes, and the USER-origin mirror was a copy taken at
     * the first climb, so everything painted after hydration was left out of
     * it: themed only in the cascade origin the page outranks, and therefore
     * still light while the rest of the page is dark.
     *
     * The last check is the other half, and it is why this was not simply a
     * resync. The read that builds those rules cannot see the mirror stood
     * down: sheet.withoutOurs flips `media` on the sheets this document owns,
     * and the mirror is not one of them. Reading an element the mirror already
     * paints maps Nocturne's own colours a second time and walks the surface up
     * towards mid grey, so touching an element that is already themed has to
     * leave it exactly where it was.
     */
    {
      await setSettings(cdp, variant.id, { enabled: true, stubborn: true, mode: 'auto' });
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await cdp.attach(targetId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      }, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      await waitFor('themed', async () => {
        const value = await cdp.evaluate(sessionId, READ);
        return value.tier != null ? value : null;
      }, { timeout: 15000, interval: 120 });
      await new Promise((r) => setTimeout(r, 900));
      const before = await cdp.evaluate(sessionId, READ);

      record(
        before.tier === '3' && before.body !== 'rgb(255, 255, 255)',
        'late content: the fixture is on the compute rung with the mirror up',
        `tier ${before.tier}, body ${before.body}`
      );

      await cdp.evaluate(sessionId, LATE);
      const swept = await waitFor('late content swept', async () => {
        const value = await cdp.evaluate(sessionId, LATE_READ);
        return value && value.tag != null ? value : null;
      }, { timeout: 8000, interval: 150 });
      // The mirror is a round trip through the worker, like the first insert.
      await new Promise((r) => setTimeout(r, 900));
      const themed = await cdp.evaluate(sessionId, LATE_READ);

      record(
        themed.bg !== 'rgb(253, 253, 253)',
        'late content: the mirror grows with the sheet, so inline !important still loses',
        `${swept.bg} -> ${themed.bg}`
      );
      record(
        themed.fg !== 'rgb(5, 5, 5)',
        'late content: its inline text colour is beaten as well',
        themed.fg
      );

      await cdp.evaluate(sessionId, TOUCH);
      await new Promise((r) => setTimeout(r, 1500));
      const after = await cdp.evaluate(sessionId, READ);

      record(
        after.panel === before.panel,
        'late content: touching an already themed panel leaves its colour alone',
        `${before.panel} -> ${after.panel}`
      );
      await cdp.send('Target.closeTarget', { targetId });
    }

    await setSettings(cdp, variant.id, { enabled: true, stubborn: false, mode: 'filter' });
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
