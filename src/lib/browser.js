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
    SET_SETTINGS: 'set-settings',
    SET_SITE: 'set-site',
    RESET_SITE: 'reset-site',
    LEARNED: 'learned',
    REQUEST_STUBBORN: 'request-stubborn',
    DROP_STUBBORN: 'drop-stubborn',
    APPLY_USER_CSS: 'apply-user-css',
    CLEAR_USER_CSS: 'clear-user-css',
    STATE_CHANGED: 'state-changed',
    TOGGLE_SITE: 'toggle-site',
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

  NX.browser = {
    api,
    isFirefox,
    MSG,
    STORAGE_KEY,
    readSettings,
    writeSettings,
    send,
    sendToTab,
  };
})(typeof self !== 'undefined' ? self : globalThis);
