/**
 * Service worker / event page.
 *
 * Deliberately small. The engine lives in the content script, because MV3
 * service workers are evicted aggressively and anything stateful up here would
 * have to be rebuilt on every wake. This side owns exactly three things:
 * settings, the toolbar affordances, and the USER-origin upgrade, which is the
 * one capability a content script cannot perform for itself.
 */
(function (global) {
  'use strict';

  const NX = global.NX;
  const { api, MSG } = NX.browser;

  /**
   * The CSS text currently inserted at USER origin, keyed by tab.
   *
   * Backed by session storage, not just a Map, because removeCSS needs the
   * EXACT string that was inserted and an MV3 service worker is evicted
   * constantly. With only an in-memory map, one eviction means a later clear
   * silently does nothing and a later apply stacks a second user-origin sheet
   * on top of the first. User-origin rules outrank everything the content
   * script can write, so those leftovers would be unremovable for the life of
   * the document.
   *
   * Session storage is cleared when the browser closes, which is exactly the
   * lifetime of the documents these entries describe.
   */
  const USER_CSS_KEY = 'userCss';
  const session = api.storage.session || api.storage.local;

  async function readUserCss() {
    try {
      const stored = await session.get(USER_CSS_KEY);
      const value = stored && stored[USER_CSS_KEY];
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  async function writeUserCss(map) {
    try {
      await session.set({ [USER_CSS_KEY]: map });
    } catch {
      /* storage full or unavailable; the next insert simply re-registers */
    }
  }

  const ICON_ON = {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  };
  const ICON_OFF = {
    16: 'icons/icon-off-16.png',
    32: 'icons/icon-off-32.png',
    48: 'icons/icon-off-48.png',
    128: 'icons/icon-off-128.png',
  };

  const action = api.action || api.browserAction;

  async function broadcast() {
    const tabs = await api.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id) continue;
      NX.browser.sendToTab(tab.id, { type: MSG.STATE_CHANGED });
      refreshIcon(tab);
    }
  }

  async function refreshIcon(tab) {
    if (!tab || !tab.id || !action) return;
    const settings = await NX.browser.readSettings();
    const origin = NX.settings.originOf(tab.url);
    const systemDark = false; // the worker has no media query; clock still works
    const resolved = NX.settings.resolve(settings, origin, { systemDark });
    const on = !!origin && resolved.active;
    try {
      await action.setIcon({ tabId: tab.id, path: on ? ICON_ON : ICON_OFF });
      await action.setTitle({
        tabId: tab.id,
        title: on ? 'Nocturne: on for this site' : 'Nocturne: off for this site',
      });
    } catch {
      /* tab closed mid-update */
    }
  }

  async function setSite(origin, patch) {
    if (!origin) return null;
    const settings = await NX.browser.readSettings();
    const sites = { ...settings.sites };
    const next = { ...(sites[origin] || {}), ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined || next[key] === null) delete next[key];
    }
    if (Object.keys(next).length) sites[origin] = next;
    else delete sites[origin];
    const saved = await NX.browser.writeSettings({ ...settings, sites });
    await broadcast();
    return saved;
  }

  async function remember(origin, tier) {
    if (!origin) return;
    const settings = await NX.browser.readSettings();
    const learned = { ...settings.learned, [origin]: { tier, at: Date.now() } };
    // Keep the cache bounded; this is an optimisation, not a record.
    const entries = Object.entries(learned).sort((a, b) => b[1].at - a[1].at);
    await NX.browser.writeSettings({
      ...settings,
      learned: Object.fromEntries(entries.slice(0, 500)),
    });
  }

  async function applyUserCss(tabId, css) {
    if (!tabId) return false;
    const granted = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    const map = await readUserCss();
    const key = String(tabId);
    const previous = map[key];

    // Withdrawing the permission must still let the last sheet be removed.
    if (!granted && !previous) return false;

    try {
      if (previous) {
        await api.scripting
          .removeCSS({ target: { tabId }, css: previous, origin: 'USER' })
          .catch(() => {});
        delete map[key];
      }
      if (css && granted) {
        await api.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' });
        map[key] = css;
      }
      await writeUserCss(map);
      return true;
    } catch {
      delete map[key];
      await writeUserCss(map);
      return false;
    }
  }

  async function forgetUserCss(tabId) {
    const map = await readUserCss();
    if (map[String(tabId)] === undefined) return;
    delete map[String(tabId)];
    await writeUserCss(map);
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const tabId = sender && sender.tab ? sender.tab.id : null;

    switch (message.type) {
      case MSG.GET_STATE:
        (async () => {
          const settings = await NX.browser.readSettings();
          sendResponse({ settings });
        })();
        return true;

      case MSG.SET_SETTINGS:
        (async () => {
          const saved = await NX.browser.writeSettings(message.settings);
          await syncAlarm();
          await broadcast();
          sendResponse({ settings: saved });
        })();
        return true;

      case MSG.SET_SITE:
        (async () => {
          const saved = await setSite(message.origin, message.patch);
          sendResponse({ settings: saved });
        })();
        return true;

      case MSG.RESET_SITE:
        (async () => {
          const settings = await NX.browser.readSettings();
          const sites = { ...settings.sites };
          const learned = { ...settings.learned };
          delete sites[message.origin];
          delete learned[message.origin];
          const saved = await NX.browser.writeSettings({ ...settings, sites, learned });
          await broadcast();
          sendResponse({ settings: saved });
        })();
        return true;

      case MSG.LEARNED:
        remember(message.origin, message.tier);
        return undefined;

      case MSG.APPLY_USER_CSS:
        (async () => {
          sendResponse({ ok: await applyUserCss(tabId, message.css) });
        })();
        return true;

      case MSG.CLEAR_USER_CSS:
        (async () => {
          sendResponse({ ok: await applyUserCss(tabId, '') });
        })();
        return true;

      default:
        return undefined;
    }
  });

  api.tabs.onUpdated.addListener((tabId, info, tab) => {
    // A navigation discards the document, and with it any inserted CSS, so the
    // recorded text would only ever be a stale key for a removeCSS that has
    // nothing left to remove.
    if (info.status === 'loading') forgetUserCss(tabId);
    if (info.status) refreshIcon(tab);
  });
  api.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      refreshIcon(await api.tabs.get(tabId));
    } catch {
      /* gone already */
    }
  });
  api.tabs.onRemoved.addListener((tabId) => forgetUserCss(tabId));

  /**
   * A clock schedule needs something to wake the worker at the boundary.
   *
   * The alarm exists only while that schedule is selected. Running it
   * unconditionally wakes the service worker every minute for the entire
   * browsing session on the default settings, where it has nothing to do.
   */
  const ALARM = 'nocturne-schedule';

  async function syncAlarm() {
    const settings = await NX.browser.readSettings();
    if (settings.schedule.kind === 'clock') {
      // periodInMinutes is a floor, not a guarantee; a minute either side of
      // the boundary is not worth holding a worker alive for.
      api.alarms.create(ALARM, { periodInMinutes: 1 });
    } else {
      await api.alarms.clear(ALARM).catch(() => {});
    }
  }

  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM) return;
    const settings = await NX.browser.readSettings();
    if (settings.schedule.kind === 'clock') await broadcast();
    else await api.alarms.clear(ALARM).catch(() => {});
  });

  // The worker is evicted and restarted constantly, so the alarm has to be
  // reconciled on every wake rather than only at install.
  syncAlarm();
  if (api.runtime.onStartup) api.runtime.onStartup.addListener(syncAlarm);

  if (api.commands && api.commands.onCommand) {
    api.commands.onCommand.addListener(async (command) => {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (command === 'toggle-global') {
        const settings = await NX.browser.readSettings();
        await NX.browser.writeSettings({ ...settings, enabled: !settings.enabled });
        await broadcast();
        return;
      }
      if (command === 'toggle-site' && tab) {
        const origin = NX.settings.originOf(tab.url);
        if (!origin) return;
        const settings = await NX.browser.readSettings();
        const current = settings.sites[origin] || {};
        await setSite(origin, { enabled: current.enabled === false });
      }
    });
  }

  api.runtime.onInstalled.addListener(async () => {
    // Normalises whatever an older version wrote, and seeds first-run defaults.
    await NX.browser.writeSettings(await NX.browser.readSettings());
    await broadcast();
  });
})(typeof self !== 'undefined' ? self : globalThis);
