/**
 * The one place that knows Chrome and Firefox are different.
 *
 * Both ship promise-returning WebExtension APIs now, so this is thin: pick the
 * namespace, and paper over the couple of calls where the shapes still differ.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});

  const api = global.browser && global.browser.runtime ? global.browser : global.chrome;

  const isFirefox =
    typeof navigator !== 'undefined' && /\bGecko\/|Firefox\//.test(navigator.userAgent || '');

  /** Message names. Kept in one table so a typo is a missing key, not silence. */
  const MSG = {
    GET_STATE: 'get-state',
    /**
     * A partial update, merged over storage by the worker.
     *
     * Deliberately not "here is the whole settings object". The popup and the
     * options page can both be open, each holding a snapshot taken when it
     * loaded, and a surface that sends its whole snapshot back silently
     * reverts everything the other one changed while it sat there.
     */
    PATCH_SETTINGS: 'patch-settings',
    SET_SITE: 'set-site',
    RESET_SITE: 'reset-site',
    LEARNED: 'learned',
    REQUEST_STUBBORN: 'request-stubborn',
    DROP_STUBBORN: 'drop-stubborn',
    APPLY_USER_CSS: 'apply-user-css',
    CLEAR_USER_CSS: 'clear-user-css',
    STATE_CHANGED: 'state-changed',
    TOGGLE_SITE: 'toggle-site',
    /** A page telling the worker where it is and whether it is themed. */
    TAB_STATE: 'tab-state',
  };

  const STORAGE_KEY = 'settings';

  async function readSettings() {
    try {
      const stored = await api.storage.local.get(STORAGE_KEY);
      return NX.settings.sanitise(stored && stored[STORAGE_KEY]);
    } catch {
      return NX.settings.sanitise(null);
    }
  }

  async function writeSettings(settings) {
    const clean = NX.settings.sanitise(settings);
    await api.storage.local.set({ [STORAGE_KEY]: clean });
    return clean;
  }

  /**
   * sendMessage rejects when nothing is listening, which is routine (the popup
   * is usually closed). Callers should not have to guard every call site.
   */
  async function send(message) {
    try {
      return await api.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  async function sendToTab(tabId, message) {
    try {
      return await api.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
  }

  /**
   * Ask one frame, and mean it.
   *
   * The content script runs in every frame, so a tab-wide sendMessage is
   * answered by whichever frame replies first. For anything that describes
   * "the page" (its origin, the rung it settled on) that is a coin flip
   * between the document and any advert or embed inside it. Frame 0 is the
   * only frame entitled to answer those.
   */
  async function sendToFrame(tabId, frameId, message) {
    try {
      return await api.tabs.sendMessage(tabId, message, { frameId });
    } catch {
      return null;
    }
  }

  NX.browser = {
    api,
    isFirefox,
    MSG,
    STORAGE_KEY,
    readSettings,
    writeSettings,
    send,
    sendToTab,
    sendToFrame,
  };
})(typeof self !== 'undefined' ? self : globalThis);
