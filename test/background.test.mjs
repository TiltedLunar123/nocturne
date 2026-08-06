/**
 * The service worker, driven through its own message listeners.
 *
 * The worker was the one file with no coverage at all, which is how it shipped
 * reading `tab.url` from a permission set that never supplies it. These tests
 * stub the extension APIs and assert on what the worker actually calls.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ROOT } from './helpers.mjs';

const MODULES = [
  'lib/color.js',
  'lib/theme.js',
  'lib/settings.js',
  'lib/browser.js',
  'background.main.js',
];

/**
 * A chrome API stub that records the calls the assertions care about.
 * Listeners are captured so a test can deliver a message the way the browser
 * would, rather than reaching into the module.
 */
function makeApi() {
  const calls = { insertCSS: [], removeCSS: [], setIcon: [], setTitle: [], sentToTab: [] };
  const listeners = {};
  const capture = (name) => ({
    addListener: (fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
  });

  let localStore = {};
  let sessionStore = {};
  // Storage is genuinely asynchronous, and the ordering bugs this file exists
  // to catch only appear when a handler yields in the middle.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const area = (bag) => ({
    async get(key) {
      await tick();
      return key in bag ? { [key]: bag[key] } : {};
    },
    async set(patch) {
      await tick();
      Object.assign(bag, patch);
    },
  });

  const api = {
    storage: {
      local: area((localStore = {})),
      session: area((sessionStore = {})),
    },
    runtime: {
      onMessage: capture('message'),
      onInstalled: capture('installed'),
      onStartup: capture('startup'),
      async sendMessage() {
        return null;
      },
    },
    tabs: {
      _tabs: [],
      async query(filter) {
        await tick();
        return api.tabs._tabs.filter((t) =>
          filter && filter.active ? t.active : true
        );
      },
      async get(id) {
        await tick();
        const found = api.tabs._tabs.find((t) => t.id === id);
        if (!found) throw new Error('no such tab');
        return found;
      },
      async sendMessage(tabId, message, options) {
        calls.sentToTab.push({ tabId, message, options });
        return api.tabs._reply ? api.tabs._reply(tabId, message) : null;
      },
      onUpdated: capture('updated'),
      onActivated: capture('activated'),
      onRemoved: capture('removed'),
    },
    action: {
      async setIcon(details) {
        calls.setIcon.push(details);
      },
      async setTitle(details) {
        calls.setTitle.push(details);
      },
    },
    alarms: {
      create() {},
      async clear() {},
      onAlarm: capture('alarm'),
    },
    permissions: {
      async contains() {
        return api.permissions._granted !== false;
      },
      _granted: true,
    },
    scripting: {
      async insertCSS(details) {
        await tick();
        calls.insertCSS.push(details);
      },
      async removeCSS(details) {
        await tick();
        calls.removeCSS.push(details);
      },
    },
    commands: { onCommand: capture('command') },
  };

  return { api, calls, listeners, stores: { local: localStore, session: sessionStore } };
}

function loadWorker() {
  const { api, calls, listeners } = makeApi();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    Promise,
    Error,
    setTimeout,
    chrome: api,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of MODULES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8'), sandbox, {
      filename: rel,
    });
  }
  return { NX: sandbox.NX, api, calls, listeners };
}

/**
 * Deliver a message the way the browser does, and resolve with the reply.
 *
 * The JSON round trip is not decoration. Extension messaging serialises, so a
 * property whose value is `undefined` does not arrive as undefined, it does
 * not arrive at all. Handing the listener a live object hides that, and a
 * patch that means "clear this key" turns into a patch that means nothing.
 */
function post(listeners, message, sender = {}) {
  message = JSON.parse(JSON.stringify(message));
  return new Promise((resolve) => {
    let answered = false;
    const done = (value) => {
      if (!answered) {
        answered = true;
        resolve(value);
      }
    };
    let kept = false;
    for (const fn of listeners.message || []) {
      if (fn(message, sender, done) === true) kept = true;
    }
    if (!kept) done(undefined);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * Wait for a fire-and-forget handler to land.
 *
 * Some messages are answered with `undefined` on purpose, so there is nothing
 * to await, and settings writes now hold a queue rather than overlapping. A
 * fixed sleep long enough for the slow case would be flaky on the fast one.
 */
async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('the toolbar reflects the origin a tab reported, because tab.url is never readable', async () => {
  const { NX, api, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  /*
   * This is the shipped reality, proved against a real browser: with only
   * storage, alarms and scripting, every Tab object comes back with no `url`
   * key at all. Any code that derives the origin from it derives null.
   */
  api.tabs._tabs = [{ id: 7, active: true, status: 'complete' }];

  await post(listeners, { type: MSG.TAB_STATE, origin: 'example.com', active: true }, { tab: { id: 7 } });
  await settle();

  const icon = calls.setIcon.at(-1);
  const title = calls.setTitle.at(-1);
  assert.ok(icon, 'the worker should have set an icon for the reporting tab');
  assert.equal(icon.tabId, 7);
  assert.match(title.title, /on for this site/);
  assert.ok(
    !/icon-off/.test(JSON.stringify(icon.path)),
    `a themed tab must not show the off icon, got ${JSON.stringify(icon.path)}`
  );
});

test('a tab that reports itself inactive gets the off icon', async () => {
  const { NX, api, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;
  api.tabs._tabs = [{ id: 3, active: true }];

  await post(listeners, { type: MSG.TAB_STATE, origin: 'example.com', active: false }, { tab: { id: 3 } });
  await settle();

  assert.match(JSON.stringify(calls.setIcon.at(-1).path), /icon-off/);
  assert.match(calls.setTitle.at(-1).title, /off for this site/);
});

test('the site shortcut toggles the origin the page reported, not one parsed from tab.url', async () => {
  const { NX, api, listeners } = loadWorker();
  const { MSG } = NX.browser;
  api.tabs._tabs = [{ id: 11, active: true }];
  api.tabs._reply = (tabId, message) =>
    message.type === MSG.GET_STATE ? { origin: 'news.example', tier: 3, ready: true } : null;

  const onCommand = (listeners.command || [])[0];
  assert.ok(onCommand, 'the worker registers a command listener');
  await onCommand('toggle-site');
  await settle();

  const stored = await NX.browser.readSettings();
  assert.deepEqual(
    Object.keys(stored.sites),
    ['news.example'],
    'the shortcut must write an override for the page it was pressed on'
  );
  assert.equal(stored.sites['news.example'].enabled, false);
});

test('two tabs applying user CSS at once do not lose each other record', async () => {
  const { NX, api, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;
  api.tabs._tabs = [
    { id: 1, active: true },
    { id: 2, active: false },
  ];

  /*
   * broadcast() pokes every tab at once, so every content script answers at
   * once. The worker's read-modify-write over session storage has to survive
   * that: a dropped record means the next clear finds nothing to remove and
   * the USER-origin sheet, which outranks everything a content script can
   * write, is stranded on the page for the life of the document.
   */
  await Promise.all([
    post(listeners, { type: MSG.APPLY_USER_CSS, css: 'body{--one:1}' }, { tab: { id: 1 } }),
    post(listeners, { type: MSG.APPLY_USER_CSS, css: 'body{--two:2}' }, { tab: { id: 2 } }),
  ]);
  await settle();

  assert.equal(calls.insertCSS.length, 2, 'both tabs should have had CSS inserted');

  await Promise.all([
    post(listeners, { type: MSG.CLEAR_USER_CSS }, { tab: { id: 1 } }),
    post(listeners, { type: MSG.CLEAR_USER_CSS }, { tab: { id: 2 } }),
  ]);
  await settle();

  const removed = calls.removeCSS.map((c) => c.css).sort();
  assert.deepEqual(
    removed,
    ['body{--one:1}', 'body{--two:2}'],
    `both sheets must be removable; removeCSS saw ${JSON.stringify(removed)}`
  );
});

test('re-applying to one tab replaces its sheet rather than stacking a second', async () => {
  const { NX, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await post(listeners, { type: MSG.APPLY_USER_CSS, css: 'a{}' }, { tab: { id: 5 } });
  await settle();
  await post(listeners, { type: MSG.APPLY_USER_CSS, css: 'b{}' }, { tab: { id: 5 } });
  await settle();

  assert.deepEqual(calls.removeCSS.map((c) => c.css), ['a{}']);
  assert.deepEqual(calls.insertCSS.map((c) => c.css), ['a{}', 'b{}']);
});

test('a site turned off from the popup can be turned back on again', async () => {
  const { NX, listeners } = loadWorker();
  const { MSG } = NX.browser;

  // What the popup sends when the per-site switch is unchecked.
  await post(listeners, { type: MSG.SET_SITE, origin: 'example.com', patch: { enabled: false } });
  let stored = await NX.browser.readSettings();
  assert.equal(stored.sites['example.com'].enabled, false, 'the site should now be off');

  /*
   * And what it sends when the switch goes back on: clear the override.
   *
   * The sentinel has to survive serialisation. The popup used `undefined`,
   * and JSON drops a key whose value is undefined, so the worker received an
   * empty patch, changed nothing, and the switch snapped straight back to
   * off. A site turned off from the popup could never be turned back on from
   * it. Asserting on the shared constant is what keeps that from coming back.
   */
  const patch = { enabled: NX.settings.CLEAR };
  assert.ok(
    'enabled' in JSON.parse(JSON.stringify(patch)),
    'the clear sentinel must survive the JSON round trip extension messaging performs'
  );
  await post(listeners, { type: MSG.SET_SITE, origin: 'example.com', patch });
  stored = await NX.browser.readSettings();
  assert.equal(
    stored.sites['example.com'],
    undefined,
    'clearing the only override should remove the site entry entirely'
  );
});

test('a settings patch merges over storage, not over whatever the page last saw', async () => {
  const { NX, listeners } = loadWorker();
  const { MSG } = NX.browser;

  /*
   * The options page and the popup can be open at the same time. Each held a
   * snapshot taken when it loaded and sent back the whole object, so whichever
   * saved last silently reverted every change made from the other one.
   */
  await post(listeners, { type: MSG.PATCH_SETTINGS, patch: { palette: 'carbon' } });
  await post(listeners, { type: MSG.PATCH_SETTINGS, patch: { brightness: 120 } });

  const stored = await NX.browser.readSettings();
  assert.equal(stored.palette, 'carbon', 'the other surface change must survive');
  assert.equal(stored.brightness, 120);
});

test('an embedded frame cannot inject user CSS into the page embedding it', async () => {
  const { NX, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  /*
   * insertCSS with only a tabId targets the TOP frame, so a message from an
   * advert or an embed does not style that embed: it styles its embedder, at
   * USER origin, which outranks everything the embedding page itself can
   * write. The content script runs in every frame, so the sender has to be
   * checked rather than trusted.
   */
  const reply = await post(
    listeners,
    { type: MSG.APPLY_USER_CSS, css: 'html{background:#f00 !important}' },
    { tab: { id: 4 }, frameId: 7 }
  );
  await settle();

  assert.equal(reply && reply.ok, false, 'the worker should refuse a subframe');
  assert.deepEqual(calls.insertCSS, [], 'nothing may be inserted on a subframe request');
});

test('the top frame is still allowed to upgrade its own sheets', async () => {
  const { NX, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await post(
    listeners,
    { type: MSG.APPLY_USER_CSS, css: 'html{color:#fff}' },
    { tab: { id: 4 }, frameId: 0 }
  );
  await settle();

  assert.equal(calls.insertCSS.length, 1);
});

test('a subframe cannot claim the tab origin either', async () => {
  const { NX, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await post(
    listeners,
    { type: MSG.TAB_STATE, origin: 'ads.example', active: true },
    { tab: { id: 6 }, frameId: 2 }
  );
  await settle();

  assert.deepEqual(calls.setIcon, [], 'an embed must not repaint the toolbar for the page');
});

test('a tab that goes away stops being tracked', async () => {
  const { NX, listeners, calls } = loadWorker();
  const { MSG } = NX.browser;

  await post(listeners, { type: MSG.TAB_STATE, origin: 'example.com', active: true }, { tab: { id: 9 } });
  await settle();
  const before = calls.setIcon.length;

  for (const fn of listeners.removed || []) fn(9, {});
  await settle();

  for (const fn of listeners.activated || []) fn({ tabId: 9 });
  await settle();

  assert.equal(
    calls.setIcon.length,
    before,
    'a closed tab must not keep painting a toolbar icon from a stale record'
  );
});

test('an embedded frame cannot tell the worker what rung the tab settled on', async () => {
  const { NX, listeners } = loadWorker();
  const { MSG } = NX.browser;

  /*
   * The script runs in every frame, and the learned rung is keyed by origin
   * rather than by frame. A subframe with no theme of its own settles on the
   * compute rung; if it is allowed to report that, the next visit to the
   * embedding site starts at compute and never tries the site's own dark
   * theme again. A cross-origin embed poisons a site the user never chose to
   * visit that way.
   */
  await post(
    listeners,
    { type: MSG.LEARNED, origin: 'victim.example', tier: 3 },
    { tab: { id: 4 }, frameId: 9 }
  );
  await settle();

  const stored = await NX.browser.readSettings();
  // Object.keys rather than the object itself: the worker runs in its own vm
  // realm, so a deepStrictEqual against a literal compares prototypes and
  // fails even when both sides are empty.
  assert.deepEqual(
    Object.keys(stored.learned),
    [],
    'only the top frame speaks for the tab, the same rule TAB_STATE already follows'
  );
});

test('a page finishing its climb does not revert a setting the user just changed', async () => {
  const { NX, listeners } = loadWorker();
  const { MSG } = NX.browser;

  /*
   * Both handlers are a read-modify-write over the single settings key, and
   * `broadcast` pokes every open tab at once, so a content script reaches
   * `remember` while the popup's own write is still in flight. Whichever read
   * first is working from a snapshot taken before the other wrote, so the
   * later write puts the older values back.
   */
  await Promise.all([
    post(listeners, { type: MSG.PATCH_SETTINGS, patch: { enabled: false, palette: 'carbon' } }),
    post(listeners, { type: MSG.LEARNED, origin: 'other.example', tier: 3 }, { tab: { id: 1 } }),
  ]);
  await waitFor(async () => {
    const seen = await NX.browser.readSettings();
    return !!seen.learned['other.example'];
  }, 'the learned rung to be written');

  const stored = await NX.browser.readSettings();
  assert.equal(stored.enabled, false, 'the switch the user just turned off must stay off');
  assert.equal(stored.palette, 'carbon', 'the palette the user just picked must survive');
});

test('a per-site override survives a learned rung written in the same turn', async () => {
  const { NX, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await Promise.all([
    post(listeners, { type: MSG.SET_SITE, origin: 'a.example', patch: { enabled: false } }),
    post(listeners, { type: MSG.LEARNED, origin: 'b.example', tier: 2 }, { tab: { id: 1 } }),
  ]);
  await waitFor(async () => {
    const seen = await NX.browser.readSettings();
    return !!seen.learned['b.example'];
  }, 'the learned rung to be written');

  const stored = await NX.browser.readSettings();
  assert.equal(
    stored.sites['a.example'] && stored.sites['a.example'].enabled,
    false,
    'the per-site switch is a user setting, not a cache, and must not be dropped'
  );
});

test('several tabs reporting a rung at once keep all of them', async () => {
  const { NX, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await Promise.all(
    ['one.example', 'two.example', 'three.example'].map((origin, i) =>
      post(listeners, { type: MSG.LEARNED, origin, tier: 3 }, { tab: { id: i + 1 } })
    )
  );
  await waitFor(async () => {
    const seen = await NX.browser.readSettings();
    return Object.keys(seen.learned).length >= 3;
  }, 'three learned rungs to be written');

  const stored = await NX.browser.readSettings();
  assert.deepEqual(
    Object.keys(stored.learned).sort(),
    ['one.example', 'three.example', 'two.example'],
    'every tab that reported a rung must be remembered, not just the last writer'
  );
});

test('an in-page navigation does not strand the user-origin sheet', async () => {
  const { NX, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await post(listeners, { type: MSG.TAB_STATE, origin: 'example.com', active: true, fresh: true }, { tab: { id: 6 } });
  await post(listeners, { type: MSG.APPLY_USER_CSS, css: 'body{color:red}' }, { tab: { id: 6 } });
  await settle();
  assert.equal(calls.insertCSS.length, 1, 'the sheet should be in');

  /*
   * Clicking an in-page anchor, or any SPA calling history.pushState, fires
   * tabs.onUpdated with status 'loading' while the SAME document stays on
   * screen. Dropping the recorded CSS text there loses the only key removeCSS
   * can be called with, and a USER-origin sheet outranks everything the page
   * or the content script can write, so the page is left themed with no way
   * to undo it for the life of the document.
   */
  for (const fn of listeners.updated || []) fn(6, { status: 'loading' }, {});
  await settle();

  await post(listeners, { type: MSG.CLEAR_USER_CSS }, { tab: { id: 6 } });
  await settle();

  assert.deepEqual(
    calls.removeCSS.map((c) => c.css),
    ['body{color:red}'],
    'the sheet must still be removable after an in-page navigation'
  );
});

test('a genuinely new document drops the old record instead of removing from it', async () => {
  const { NX, calls, listeners } = loadWorker();
  const { MSG } = NX.browser;

  await post(listeners, { type: MSG.TAB_STATE, origin: 'one.example', active: true, fresh: true }, { tab: { id: 8 } });
  await post(listeners, { type: MSG.APPLY_USER_CSS, css: 'body{color:red}' }, { tab: { id: 8 } });
  await settle();

  // A new document in the same tab: the old sheet went with the old document,
  // so there is nothing left to remove and the record is just a stale key.
  // Only a content script that has just booted can report this.
  await post(listeners, { type: MSG.TAB_STATE, origin: 'two.example', active: true, fresh: true }, { tab: { id: 8 } });
  await post(listeners, { type: MSG.APPLY_USER_CSS, css: 'body{color:blue}' }, { tab: { id: 8 } });
  await settle();

  assert.deepEqual(
    calls.removeCSS.map((c) => c.css),
    [],
    'nothing should be removed from a document that no longer exists'
  );
  assert.deepEqual(calls.insertCSS.map((c) => c.css), ['body{color:red}', 'body{color:blue}']);
});
