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
  /** Which origin each tab reported, and whether it themed itself. */
  const TAB_STATE_KEY = 'tabState';
  const session = api.storage.session || api.storage.local;

  /**
   * Every session record goes through one queue.
   *
   * Each of these is a read-modify-write over a single storage key, and
   * `broadcast` pokes every open tab at once, so the handlers all reach their
   * awaits together and the last writer wins. For the user-CSS map that is not
   * a cache miss anyone recovers from: removeCSS needs the EXACT string that
   * was inserted, so a dropped record strands a USER-origin sheet, and USER
   * origin outranks everything a content script can write. The page would be
   * left both themed and inverted with no way to undo either until it
   * navigates.
   */
  let queue = Promise.resolve();
  function serialise(work) {
    const next = queue.then(work, work);
    queue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  /**
   * The settings key needs that queue too, for exactly the same reason.
   *
   * Read, modify, write, over one storage key, from six different handlers.
   * A page finishing its climb reaches `remember` while the popup's own write
   * is still in flight, both having read the same snapshot, and the later
   * write puts the earlier one's values back. That is not only a lost cache
   * entry: a per-site switch or a palette the user just chose silently
   * reverts, while the surface that sent it renders the reply it was handed
   * and shows the change as applied. `broadcast` pokes every open tab at
   * once, so on a multi-tab window the collisions are the normal case rather
   * than the unlucky one.
   *
   * `mutate` gets the current settings and returns what to store, or nothing
   * to leave them alone. The whole read-modify-write holds the queue.
   */
  function updateSettings(mutate) {
    return serialise(async () => {
      const settings = await NX.browser.readSettings();
      const next = await mutate(settings);
      if (!next) return settings;
      return NX.browser.writeSettings(next);
    });
  }

  /**
   * Read one session map, hand it to `mutate`, write it back. The whole
   * sequence holds the queue, so no other handler can interleave with it.
   */
  function updateSession(key, mutate) {
    return serialise(async () => {
      let map = {};
      try {
        const stored = await session.get(key);
        const value = stored && stored[key];
        if (value && typeof value === 'object') map = value;
      } catch {
        map = {};
      }
      const result = await mutate(map);
      try {
        await session.set({ [key]: map });
      } catch {
        /* storage full or unavailable; the next write simply re-registers */
      }
      return result;
    });
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
      // Each page answers with a fresh TAB_STATE once it has re-applied, and
      // that is what repaints the toolbar. The worker does not guess.
      NX.browser.sendToTab(tab.id, { type: MSG.STATE_CHANGED });
    }
  }

  /**
   * The toolbar is painted from what the page reported, never from `tab.url`.
   *
   * Nocturne ships with no `tabs` permission and no default host permission,
   * which is the entire privacy claim. Under that permission set Chrome hands
   * back Tab objects with no `url` key at all, so anything that parsed an
   * origin out of one got null on every page: the icon was stuck off, the
   * title always read "off for this site", and the site shortcut did nothing.
   * The content script is the only thing that knows where it is, and it is
   * also the only thing that can see `prefers-color-scheme`, so it reports
   * both rather than being second-guessed from out here.
   */
  async function paintIcon(tabId, origin, active) {
    if (!tabId || !action) return;
    const on = !!origin && !!active;
    try {
      await action.setIcon({ tabId, path: on ? ICON_ON : ICON_OFF });
      await action.setTitle({
        tabId,
        title: on ? 'Nocturne: on for this site' : 'Nocturne: off for this site',
      });
    } catch {
      /* tab closed mid-update */
    }
  }

  async function noteTabState(tabId, origin, active, fresh) {
    if (!tabId) return;
    /*
     * A content script only ever boots into a document that has just been
     * created, so `fresh` is the one trustworthy signal that the previous
     * document in this tab is gone. Anything inserted into it went with it,
     * and the recorded CSS text is now only a stale key.
     */
    if (fresh) await forgetUserCss(tabId);
    await updateSession(TAB_STATE_KEY, (map) => {
      map[String(tabId)] = { origin: origin || null, active: !!active };
    });
    await paintIcon(tabId, origin, active);
  }

  function readTabState(tabId) {
    return updateSession(TAB_STATE_KEY, (map) => map[String(tabId)] || null);
  }

  function forgetTabState(tabId) {
    return updateSession(TAB_STATE_KEY, (map) => {
      delete map[String(tabId)];
    });
  }

  /**
   * Repaint from the stored record. A tab with no record has either not
   * reported yet or cannot run a content script at all, and painting a guess
   * for it is what produced the permanently-off icon in the first place.
   */
  async function refreshIcon(tabId) {
    const known = await readTabState(tabId);
    if (!known) return;
    await paintIcon(tabId, known.origin, known.active);
  }

  /**
   * The origin of a tab, asked for rather than parsed. Frame 0 only: the
   * script runs in every frame and an embed must not answer for the page.
   */
  async function originForTab(tabId) {
    if (!tabId) return null;
    const known = await readTabState(tabId);
    if (known && known.origin) return known.origin;
    const report = await NX.browser.sendToFrame(tabId, 0, { type: MSG.GET_STATE });
    return (report && report.origin) || null;
  }

  /** Apply a per-site patch to a settings object. Pure: no reads, no writes. */
  function withSite(settings, origin, patch) {
    const sites = { ...settings.sites };
    const next = { ...(sites[origin] || {}), ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined || next[key] === null) delete next[key];
    }
    if (Object.keys(next).length) sites[origin] = next;
    else delete sites[origin];
    return { ...settings, sites };
  }

  async function setSite(origin, patch) {
    if (!origin) return null;
    const saved = await updateSettings((settings) => withSite(settings, origin, patch));
    await broadcast();
    return saved;
  }

  function remember(origin, tier) {
    if (!origin) return Promise.resolve();
    return updateSettings((settings) => {
      const learned = { ...settings.learned, [origin]: { tier, at: Date.now() } };
      // Keep the cache bounded; this is an optimisation, not a record.
      const entries = Object.entries(learned).sort((a, b) => b[1].at - a[1].at);
      return { ...settings, learned: Object.fromEntries(entries.slice(0, 500)) };
    });
  }

  async function applyUserCss(tabId, css) {
    if (!tabId) return false;
    const granted = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);

    return updateSession(USER_CSS_KEY, async (map) => {
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
        return true;
      } catch {
        delete map[key];
        return false;
      }
    });
  }

  function forgetUserCss(tabId) {
    return updateSession(USER_CSS_KEY, (map) => {
      delete map[String(tabId)];
    });
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const tabId = sender && sender.tab ? sender.tab.id : null;

    /*
     * Anything that speaks for the whole tab has to come from the whole tab.
     *
     * The content script runs in every frame, and `scripting.insertCSS` with
     * only a tabId targets the TOP frame. So a message from an advert or an
     * embed does not restyle that embed, it restyles its embedder, at USER
     * origin, which outranks every rule the embedding page can write for
     * itself. The same goes for the origin used to paint the toolbar. A
     * missing frameId means a caller with no frame at all, and those already
     * have no tabId to act on.
     */
    const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
    const speaksForTab = frameId === 0;

    switch (message.type) {
      case MSG.GET_STATE:
        (async () => {
          const settings = await NX.browser.readSettings();
          sendResponse({ settings });
        })();
        return true;

      case MSG.PATCH_SETTINGS:
        (async () => {
          // Read, then merge, then write. The patch is the only thing the
          // sender is entitled to an opinion about.
          const saved = await updateSettings((current) => ({
            ...current,
            ...(message.patch && typeof message.patch === 'object' ? message.patch : {}),
          }));
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
          const saved = await updateSettings((settings) => {
            const sites = { ...settings.sites };
            const learned = { ...settings.learned };
            delete sites[message.origin];
            delete learned[message.origin];
            return { ...settings, sites, learned };
          });
          await broadcast();
          sendResponse({ settings: saved });
        })();
        return true;

      /*
       * The learned rung describes the tab, so only the tab may report it.
       *
       * It is keyed by origin and it sets the rung the NEXT visit starts on,
       * skipping every cheaper rung below it. A subframe has its own document
       * with none of the embedding page's stylesheets, so it settles on the
       * compute rung and, left unguarded, teaches the worker that the site
       * needs a generated theme. The site's own dark theme is then never
       * tried again. A cross-origin embed does it to an origin the user never
       * chose to visit that way. Same rule as TAB_STATE and the user-CSS
       * upgrade, which have been guarded since the last sweep.
       */
      case MSG.LEARNED:
        if (speaksForTab) remember(message.origin, message.tier);
        return undefined;

      case MSG.TAB_STATE:
        if (speaksForTab) noteTabState(tabId, message.origin, message.active, message.fresh);
        return undefined;

      case MSG.APPLY_USER_CSS:
        (async () => {
          sendResponse({ ok: speaksForTab && (await applyUserCss(tabId, message.css)) });
        })();
        return true;

      case MSG.CLEAR_USER_CSS:
        (async () => {
          sendResponse({ ok: speaksForTab && (await applyUserCss(tabId, '')) });
        })();
        return true;

      default:
        return undefined;
    }
  });

  api.tabs.onUpdated.addListener((tabId, info) => {
    /*
     * `status: 'loading'` does not mean the document is being replaced.
     *
     * Clicking an in-page anchor, or any SPA calling history.pushState, fires
     * it while the same document stays on screen. Dropping the recorded CSS
     * text there threw away the only key removeCSS can be called with, so the
     * USER-origin sheet became unremovable: the page stayed themed, above
     * everything the page or the content script could write, and standing
     * Nocturne down could not take it off again.
     *
     * Only a content script reporting that it has just booted proves the old
     * document is gone, so that is what discards the record now. The tab's
     * own state is different: it is what paints the toolbar, and a stale icon
     * during a navigation is worse than none.
     */
    if (info.status === 'loading') forgetTabState(tabId);
    if (info.status === 'complete') refreshIcon(tabId);
  });
  api.tabs.onActivated.addListener(({ tabId }) => refreshIcon(tabId));
  api.tabs.onRemoved.addListener((tabId) => {
    forgetUserCss(tabId);
    forgetTabState(tabId);
  });

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
        await updateSettings((settings) => ({ ...settings, enabled: !settings.enabled }));
        await broadcast();
        return;
      }
      if (command === 'toggle-site' && tab) {
        const origin = await originForTab(tab.id);
        if (!origin) return;
        // Read the current value inside the queue, so the flip is against
        // what is stored now rather than a snapshot taken before it.
        await updateSettings((settings) =>
          withSite(settings, origin, { enabled: (settings.sites[origin] || {}).enabled === false })
        );
        await broadcast();
      }
    });
  }

  api.runtime.onInstalled.addListener(async () => {
    // Normalises whatever an older version wrote, and seeds first-run defaults.
    await updateSettings((settings) => settings);
    await broadcast();
  });
})(typeof self !== 'undefined' ? self : globalThis);
