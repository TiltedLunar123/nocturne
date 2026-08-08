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
    // What the sheet was asked to hold, which is what the mirror is built
    // from. The real one keeps this separately from the elements.
    ours() {
      return Array.from(NX.sheet.elements.values()).map((el) => el.textContent).join('\\n').trim();
    },
    isOurs() { return false; },
    reassert() { log.push('sheet:reassert'); },
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
    /** What the worker has stored, as the engine would read it back. */
    stored: () => store.settings || {},
    setSettings: (next) => {
      store.settings = { ...(store.settings || {}), ...next };
    },
    /** Deliver a message the way the browser does. */
    post: (message) => {
      for (const fn of messageListeners) fn(JSON.parse(JSON.stringify(message)), {}, () => {});
    },
    /** Let every pending await drain. */
    settle: async () => {
      for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** Real time, for the deferred catch-up pass. */
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

test('a busy page on the token rung is not thrown away for being busy', async () => {
  /*
   * The churn backstop is there to stop the compute rung re-sweeping a page
   * that never settles. The token rung does no per-mutation work at all: it
   * remaps custom properties on :root once, and anything the page adds
   * afterwards inherits them. rescan() knows that and returns immediately, so
   * on that rung the observer's only reachable effect was the demotion.
   *
   * A design-token application with a lively DOM, which is most of them,
   * therefore lost a faithful theme and got whole-page inversion instead, and
   * the demotion was written against the origin so every later visit started
   * there too.
   */
  const h = loadEngine({ offers: ['tokens', 'compute'] });
  await h.settle();
  assert.equal(h.tier(), '2');

  h.NX.observe.onChurn(1200);
  await h.settle();

  assert.equal(h.tier(), '2', 'a rung that does no work per mutation has nothing to back off from');
  assert.ok(!h.log.includes('tier:filter'), h.log.join(','));
});

test('the token sheet is put back if the page rebuilds its head', async () => {
  // Same reason the promoted-media rung is watched: this rung injects a sheet,
  // and a page that rewrites its head takes it with it.
  const h = loadEngine({ offers: ['tokens', 'compute'] });
  await h.settle();
  assert.equal(h.tier(), '2');

  h.NX.observe.onDirty([]);
  await h.settle();

  assert.ok(h.log.includes('sheet:reassert'), h.log.join(','));
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

test('pinning a method does not teach it to the automatic mode', async () => {
  /*
   * The learned rung is a cache of what measuring the page decided, and the
   * whole promise of `auto` is that the rung it starts on is still measured
   * there. A pinned mode is not a measurement: climb() returns the pinned rung
   * without running anything. Reporting that anyway wrote it against the
   * origin, and `auto` reads the value straight back as its starting rung.
   *
   * Pinning Invert once and putting the mode back therefore left the site
   * inverted under the mode described as "measures the page and picks the best
   * method", with the early return for a learned filter rung skipping every
   * cheaper rung and any measurement that could have undone it. Nothing in the
   * popup points at the Reset button that would clear it.
   */
  const site = { sites: { 'example.com': { mode: 'filter' } } };
  const h = loadEngine({ offers: ['class', 'compute'], settings: site });
  await h.settle();

  assert.equal(h.tier(), '4', 'the pin itself must still be honoured');
  assert.deepEqual(
    Object.keys(h.stored().learned || {}),
    [],
    `a pin is not a measurement: ${JSON.stringify(h.stored().learned)}`
  );

  // Put the mode back. The site's own dark theme has to be found again.
  h.setSettings({ sites: {} });
  h.post({ type: 'state-changed' });
  await h.settle();
  assert.equal(h.tier(), '1', "automatic must find the site's own theme again");
});

test('a measured rung is still remembered', async () => {
  const h = loadEngine({ offers: ['compute'] });
  await h.settle();
  assert.equal(h.stored().learned['example.com'].tier, 3, JSON.stringify(h.stored().learned));
});

test('the catch-up pass after load actually runs on a page that loads quickly', async () => {
  /*
   * The late full sweep exists because hydration can repaint anything, and it
   * was scheduled from a `load` listener registered at document_start that
   * checked `state.tier` when it fired. apply() is several awaits long, so on
   * any page whose subresources finish promptly, which is essentially every
   * real page and in particular an application shell that reaches
   * DOMContentLoaded and load back to back, `load` arrived while the climb was
   * still in flight, `state.tier` was still null, and the pass was never
   * scheduled at all.
   *
   * The end to end fixture serves a subresource that deliberately takes four
   * seconds, so it only ever exercised the slow case where the check happens
   * to pass.
   */
  const h = loadEngine({ offers: ['compute'] });
  await h.settle();
  await h.wait(400);

  // The first climb, then the catch-up sweep. Counted after the window rather
  // than across it, so a slow tick cannot decide the answer.
  assert.equal(
    h.log.filter((l) => l === 'tier:compute').length,
    2,
    `one climb plus one catch-up: ${h.log.join(',')}`
  );
});

test('the catch-up pass runs once per document, not once per settings change', async () => {
  const h = loadEngine({ offers: ['compute'] });
  await h.settle();
  await h.wait(400);

  h.post({ type: 'state-changed' });
  await h.settle();
  await h.wait(400);

  // Climb, catch-up, re-climb. A settings change re-sweeps the whole page by
  // itself, so a second catch-up would be a full sweep for nothing.
  assert.equal(
    h.log.filter((l) => l === 'tier:compute').length,
    3,
    `no second catch-up: ${h.log.join(',')}`
  );
});
