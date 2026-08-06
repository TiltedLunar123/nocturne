/**
 * The popup, driven through a stub DOM.
 *
 * The end to end suite renders this page and checks that it painted. What it
 * cannot arrange is the ordering of two overlapping replies, which is where
 * the status line goes wrong.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPage } from './helpers.mjs';

const IDS = [
  'global', 'site', 'site-name', 'status', 'palettes', 'modes', 'mode-hint',
  'brightness', 'contrast', 'saturation', 'brightness-out', 'contrast-out',
  'saturation-out', 'reset', 'options',
];

/**
 * Load the popup with a scripted set of replies.
 *
 * `states` is consumed one entry per GET_STATE sent to the page, each with an
 * optional `delay`, so a test can make an early reply arrive late.
 */
function loadPopup({ states = [], settings = {} }) {
  const asked = [];
  let stored = {
    version: 1, enabled: true, mode: 'auto', palette: 'nocturne',
    brightness: 100, contrast: 100, saturation: 100, minContrast: 4.5,
    stubborn: false, dimImages: 0,
    schedule: { kind: 'always', from: '20:00', to: '07:00' },
    sites: {}, learned: {},
    ...settings,
  };

  const api = {
    runtime: {
      async sendMessage(message) {
        if (message.type === 'set-site') {
          const sites = { ...stored.sites };
          const next = { ...(sites[message.origin] || {}), ...message.patch };
          for (const key of Object.keys(next)) {
            if (next[key] === undefined || next[key] === null) delete next[key];
          }
          if (Object.keys(next).length) sites[message.origin] = next;
          else delete sites[message.origin];
          stored = { ...stored, sites };
          return { settings: JSON.parse(JSON.stringify(stored)) };
        }
        if (message.type === 'patch-settings') {
          stored = { ...stored, ...message.patch };
          return { settings: JSON.parse(JSON.stringify(stored)) };
        }
        return null;
      },
      openOptionsPage() {},
    },
    storage: {
      local: {
        async get() {
          return { settings: JSON.parse(JSON.stringify(stored)) };
        },
        async set() {},
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, active: true }];
      },
      async sendMessage(tabId, message) {
        if (message.type !== 'get-state') return null;
        const reply = states[asked.length] || states[states.length - 1] || null;
        asked.push(message);
        if (!reply) return null;
        if (reply.delay) await new Promise((r) => setTimeout(r, reply.delay));
        return JSON.parse(JSON.stringify(reply.value));
      },
    },
  };

  const page = loadPage('popup/popup.js', {
    ids: IDS,
    globals: { chrome: api, navigator: { userAgent: 'Chrome' } },
  });
  return { ...page, asked, current: () => stored };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test('the status line reflects the newest answer, not the slowest', async () => {
  /*
   * refreshStatus awaits a round trip to the page and then writes whatever
   * comes back. Two of them can be in flight at once: render() starts one on
   * open, and every click starts another. With no ordering rule the reply to
   * the first request lands last and wins, so the popup shows the state from
   * before the click and keeps showing it until it is closed and reopened.
   */
  const themed = { origin: 'example.com', tier: 1, ready: true };
  const { byId, current } = loadPopup({
    states: [
      // init() asks first, to find out which site this is.
      { value: themed },
      // Then render() asks, and this is the answer that arrives late.
      { value: themed, delay: 200 },
      // And this is the one the click starts.
      { value: themed },
    ],
  });
  await settle(40);
  assert.equal(byId.get('site-name').textContent, 'example.com', 'the popup should have settled');

  await byId.get('site').fire('change', { target: { checked: false } });
  await settle(400);

  assert.equal(
    current().sites['example.com'].enabled,
    false,
    'the click should have turned the site off'
  );
  assert.equal(
    byId.get('status').textContent,
    'Off for this site',
    'the status line must not go back to describing the state before the click'
  );
});

test('the popup reports the origin the page gave it', async () => {
  const { byId } = loadPopup({
    states: [{ value: { origin: 'news.example', tier: 3, ready: true } }],
  });
  await settle();

  assert.equal(byId.get('site-name').textContent, 'news.example');
  assert.equal(byId.get('site').disabled, false, 'the per-site switch must be usable');
  assert.equal(byId.get('status').textContent, 'Generated theme from the page colours');
});

test('a page that cannot be themed says so once, and stays saying it', async () => {
  const { byId } = loadPopup({ states: [{ value: null }] });
  await settle();

  assert.equal(byId.get('status').textContent, 'Nocturne cannot run on this kind of page');
  assert.equal(byId.get('site').disabled, true);
});
