/**
 * The ladder driver, run over stubbed collaborators.
 *
 * `content/main.js` was the last engine file with no coverage of its own. The
 * tiers, the probe and the sheet all have tests; the thing that decides when to
 * call them did not, and that is where the ordering lives. The end to end suite
 * cannot reach it either: it drives a real browser, so it can see the result of
 * one settle but cannot arrange for two of them to overlap.
 *
 * The collaborators here are fakes on purpose. What is under test is the
 * sequence of calls main.js makes, not what the tiers do when they are called.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ROOT } from './helpers.mjs';

const LIBS = ['lib/color.js', 'lib/theme.js', 'lib/settings.js', 'lib/signals.js', 'lib/browser.js'];

/**
 * The fakes, built inside the sandbox so main.js sees same-realm objects.
 *
 * `page.dark` is the whole model of the rendered page: a tier that themes sets
 * it, and the probe reports it. That is the real relationship, and it is the
 * one that matters here, because a second climb over an already-themed page is
 * exactly what "already dark" is supposed to detect.
 */
const FAKES = `
(function () {
  const NX = globalThis.NX;
  const log = globalThis.__log;
  const page = globalThis.__page;

  NX.sheet = {
    elements: new Map(),
    set(id, css) { NX.sheet.elements.set(id, { textContent: css }); },
    remove(id) { NX.sheet.elements.delete(id); },
    clearAll() { NX.sheet.elements.clear(); },
    isOurs() { return false; },
    reassert() {},
    withoutOurs(ids, fn) { return fn(); },
    noteMirror(live) { page.mirror = !!live; },
    mirrorLive() { return page.mirror; },
  };

  NX.probe = {
    alreadyDark() { return page.dark; },
    measure() { return { ok: page.dark, lightFraction: page.dark ? 0 : 1 }; },
    withoutGuard(fn) { return fn(); },
  };

  NX.tiers = {
    SHEET_VARS: 'tokens',
    SHEET_MEDIA: 'promoted',
    tryNativeClass() {
      if (!page.offers.includes('class')) return null;
      page.dark = true;
      log.push('tier:class');
      return { signal: NX.signals.SIGNALS[0], undo() { page.dark = false; }, result: { ok: true } };
    },
    tryNativeMedia() {
      if (!page.offers.includes('media')) return null;
      page.dark = true;
      log.push('tier:media');
      NX.sheet.set('promoted', 'promoted{}');
      return { result: { ok: true } };
    },
    tryTokens() {
      if (!page.offers.includes('tokens')) return null;
      page.dark = true;
      log.push('tier:tokens');
      NX.sheet.set('tokens', 'tokens{}');
      return { result: { ok: true }, count: 9 };
    },
    tryCompute() {
      if (!page.offers.includes('compute')) return null;
      page.dark = true;
      log.push('tier:compute');
      NX.sheet.set('computed', 'computed{}');
      return { result: { ok: true }, signatures: 12, elements: 40 };
    },
    computeOn() { log.push('tier:computeOn'); return { elements: 1 }; },
    clearCompute() { page.dark = false; NX.sheet.remove('computed'); },
    applyFilter() { page.dark = true; log.push('tier:filter'); NX.sheet.set('filter', 'filter{}'); },
  };

  NX.observe = {
    started: 0,
    onDirty: null,
    start(onDirty, onChurn) {
      NX.observe.started++;
      NX.observe.onDirty = onDirty;
      NX.observe.onChurn = onChurn;
      log.push('observe:start');
    },
    stop() { NX.observe.onDirty = null; log.push('observe:stop'); },
    run(fn) { return fn(); },
    watchRoot() { return () => {}; },
  };
})();
`;

/**
 * A root element with just enough attribute behaviour for the engine, plus a
 * document and the two globals it reads at boot.
 */
function loadEngine({ offers = ['compute'], settings = {}, sendDelay = 0 } = {}) {
  const log = [];
  const page = { dark: false, mirror: false, offers };
  const sent = [];
  const attrs = new Map();

  const root = {
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
    classList: { contains: () => false, add() {}, remove() {} },
  };

  // Storage and messaging are genuinely asynchronous. The ordering this file
  // exists to pin down only shows up when a handler yields partway through.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const store = { settings };
  const messageListeners = [];

  const chrome = {
    storage: {
      local: {
        async get(key) {
          await tick();
          return key in store ? { [key]: store[key] } : {};
        },
        async set(patch) {
          await tick();
          Object.assign(store, patch);
        },
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      /*
       * Enough of the worker to be honest about the two things the engine can
       * observe coming back from it: the learned rung is persisted, so a
       * re-apply reads it, and the user-origin mirror takes a round trip to
       * withdraw. A stub that only records would make a re-teach look correct
       * and would collapse the window this file is here to test.
       */
      async sendMessage(message) {
        sent.push(message.type);
        for (let i = 0; i < sendDelay + 1; i++) await tick();
        if (message.type === 'learned' && message.origin) {
          const current = store.settings || {};
          store.settings = {
            ...current,
            learned: { ...current.learned, [message.origin]: { tier: message.tier, at: 1 } },
          };
        }
        if (message.type === 'apply-user-css') page.mirror = true;
        if (message.type === 'clear-user-css') page.mirror = false;
        return null;
      },
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Object, Array, String, Number, Boolean, Date, Promise, Error, Map, Set, WeakMap,
    setTimeout,
    URL,
    chrome,
    location: { href: 'https://example.com/page' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: {
      documentElement: root,
      readyState: 'complete',
      addEventListener() {},
      querySelectorAll: () => [],
    },
    __log: log,
    __page: page,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.top = sandbox; // top frame
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);

  for (const rel of LIBS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8'), sandbox, { filename: rel });
  }
  vm.runInContext(FAKES, sandbox, { filename: 'fakes.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'content', 'main.js'), 'utf8'), sandbox, {
    filename: 'content/main.js',
  });

  return {
    log,
    page,
    sent,
    NX: sandbox.NX,
    tier: () => root.getAttribute('data-nocturne-tier'),
    /** Deliver a message the way the browser does. */
    post: (message) => {
      for (const fn of messageListeners) fn(JSON.parse(JSON.stringify(message)), {}, () => {});
    },
    /** Let every pending await drain. */
    settle: async () => {
      for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test('the first climb settles on the rung the page needs and starts watching', async () => {
  const h = loadEngine({ offers: ['compute'] });
  await h.settle();
  assert.equal(h.tier(), '3');
  assert.ok(h.log.includes('tier:compute'), h.log.join(','));
  assert.ok(h.log.includes('observe:start'), h.log.join(','));
});

test("a site's own theme is preferred and nothing is injected for it", async () => {
  const h = loadEngine({ offers: ['class', 'compute'] });
  await h.settle();
  assert.equal(h.tier(), '1');
  assert.ok(!h.log.includes('tier:compute'), h.log.join(','));
});

test('two settings changes in quick succession still leave the page on its real rung', async () => {
  /*
   * `broadcast` pokes every open tab on every settings write, and apply() is
   * several awaits long: it reads storage, then waits for the worker to
   * confirm the user-origin mirror is off. Two of them therefore overlap
   * whenever a second write lands before the first page has finished, which
   * is two clicks in the popup, or one click while the clock alarm fires.
   *
   * Overlapped, the second climb ran over the page the first had just themed,
   * measured it as already dark, and recorded that as the native rung. The
   * popup then said the site was using its own dark theme on a page that had
   * no dark theme at all, the rung got taught to the origin so the next visit
   * started there, and the observer the compute rung needs was replaced by the
   * one the native rung uses, so nothing added to the page afterwards was
   * themed.
   */
  const h = loadEngine({
    offers: ['compute'],
    sendDelay: 2,
    // Stubborn mode is what makes the window wide. Withdrawing the user-origin
    // mirror is a round trip through the worker, and apply() has to wait for
    // it before anything measures the page.
    settings: { stubborn: true },
  });
  await h.settle();
  assert.equal(h.tier(), '3');

  h.post({ type: 'state-changed' });
  h.post({ type: 'state-changed' });
  await h.settle();

  assert.equal(h.tier(), '3', 'the rung on the root element must describe the rung in force');
  assert.equal(
    h.NX.main.state.tier,
    3,
    'the rung the popup reads must describe the rung in force'
  );
  assert.ok(h.NX.observe.onDirty, 'the compute rung must still be watching for new content');
});

test('a learned rung is reported once, not on every re-apply', async () => {
  const h = loadEngine({ offers: ['compute'] });
  await h.settle();
  const first = h.sent.filter((t) => t === 'learned').length;
  assert.equal(first, 1, h.sent.join(','));

  h.post({ type: 'state-changed' });
  await h.settle();
  assert.equal(
    h.sent.filter((t) => t === 'learned').length,
    first,
    'the rung did not change, so there is nothing new to teach'
  );
});
