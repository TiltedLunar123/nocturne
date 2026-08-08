/**
 * The settings page, driven through a stub DOM.
 *
 * The end to end suite renders this page in Chromium and would therefore never
 * see a rule that only applies on Gecko, which is exactly where the bug this
 * file was written for lives. Loading the real options.js over a stub document
 * lets the engine be chosen per test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPage } from './helpers.mjs';

const IDS = [
  'clock-row', 'enabled', 'export', 'palettes', 'preview', 'reset-all',
  'schedule-from', 'schedule-kind', 'schedule-to', 'sites', 'sites-empty',
  'stubborn', 'stubborn-note', 'version', 'brightness', 'contrast',
  'saturation', 'minContrast', 'dimImages', 'brightness-out', 'contrast-out',
  'saturation-out', 'minContrast-out', 'dimImages-out',
];

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/**
 * Load the real options page over the stub, on a chosen engine.
 *
 * `permissions` records every call rather than performing one, because what
 * this file asserts is which calls the page decides to make.
 */
function loadOptions({ userAgent, stubborn = true }) {
  const calls = { request: [], remove: [], patches: [] };

  /*
   * Record a copy made in this realm, not the object the page handed over.
   * The page runs in its own vm context, so its objects carry that context's
   * prototypes and a deepStrictEqual against a literal here fails on two
   * identical values. A JSON round trip is also what really happens to
   * anything crossing the messaging boundary.
   */
  const recorded = (value) => JSON.parse(JSON.stringify(value));

  const api = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      async sendMessage(message) {
        if (message && message.patch) calls.patches.push(recorded(message.patch));
        return null;
      },
    },
    storage: {
      local: {
        async get() {
          return { settings: { stubborn } };
        },
        async set() {},
      },
    },
    permissions: {
      async request(what) {
        calls.request.push(recorded(what));
        return true;
      },
      async remove(what) {
        calls.remove.push(recorded(what));
        return true;
      },
    },
  };

  const { byId, NX } = loadPage('options/options.js', {
    ids: IDS,
    globals: {
      chrome: api,
      navigator: { userAgent },
      confirm: () => true,
      Blob: class {},
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    },
  });

  return { byId, calls, NX };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('turning stubborn sites off on Firefox does not hand back the all-sites grant', async () => {
  /*
   * Gecko treats the match patterns in `content_scripts` as host permissions
   * granted at install, and they name the same `<all_urls>` the optional
   * grant does. Removing the optional one takes the content script's host
   * access with it, so guard.css and the engine stop being injected on every
   * site: no anti-flash shell, no ladder, no per-site state, and nothing in
   * the extension's own UI to say why or to undo it. Unticking one checkbox
   * would silently disable the whole product until the user re-granted host
   * access from about:addons.
   */
  const { byId, calls } = loadOptions({ userAgent: FIREFOX_UA });
  await settle();

  await byId.get('stubborn').fire('change', { target: { checked: false } });
  await settle();

  assert.deepEqual(
    calls.remove,
    [],
    'the grant the content script itself runs on must not be revoked on Gecko'
  );
  assert.deepEqual(
    calls.patches,
    [{ stubborn: false }],
    'the option itself must still be turned off, which is what the switch promises'
  );
});

test('turning stubborn sites off on Chrome says where the grant can be taken back', async () => {
  /*
   * This test used to assert that the grant was handed back, and it only ever
   * asserted that the call was made. Measured on Edg/151.0.4129.72 against the
   * shipped manifest, that call rejects: "You cannot remove required
   * permissions", because a content-script match pattern is a required
   * scriptable host and this extension's is `<all_urls>`, the same pattern the
   * optional grant names. The rejection went into a .catch that discarded it,
   * so the option looked like it returned the access and never did.
   *
   * Nothing can hand it back from in here on either engine, so the honest
   * thing is to turn the feature off and say where it can be.
   */
  const { byId, calls } = loadOptions({ userAgent: CHROME_UA });
  await settle();

  await byId.get('stubborn').fire('change', { target: { checked: false } });
  await settle();

  assert.deepEqual(calls.remove, [], 'a call that always rejects is not worth making');
  assert.deepEqual(calls.patches, [{ stubborn: false }]);

  const note = byId.get('stubborn-note');
  assert.equal(note.hidden, false, 'the user has to be told the permission stays');
  assert.match(note.textContent, /extensions page/);
});

test('turning stubborn sites on still asks for the grant on both engines', async () => {
  for (const userAgent of [FIREFOX_UA, CHROME_UA]) {
    const { byId, calls } = loadOptions({ userAgent, stubborn: false });
    await settle();

    await byId.get('stubborn').fire('change', { target: { checked: true } });
    await settle();

    assert.deepEqual(calls.request, [{ origins: ['<all_urls>'] }]);
    assert.deepEqual(calls.patches, [{ stubborn: true }]);
  }
});
