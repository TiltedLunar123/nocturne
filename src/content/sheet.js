/**
 * Injected stylesheet management.
 *
 * Every sheet Nocturne owns carries a data attribute, which is how the mutation
 * observer tells our own writes apart from the page's. Getting that wrong is
 * how an extension ends up in a feedback loop with itself.
 *
 * Shadow roots get an adopted stylesheet rather than an injected <style>,
 * because adoptedStyleSheets does not appear in the root's childNodes and so
 * does not trip component libraries that police their own subtree.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});
  const MARK = 'data-nocturne';

  const elements = new Map();
  const adopted = new WeakMap();

  function container() {
    return document.head || document.documentElement;
  }

  /** Create or update a sheet. Idempotent, and cheap when the text is unchanged. */
  function set(id, cssText) {
    let el = elements.get(id);
    if (el && el.isConnected && el.textContent === cssText) return el;

    if (!el || !el.isConnected) {
      el = document.createElement('style');
      el.setAttribute(MARK, id);
      el.media = 'screen';
      elements.set(id, el);
    }
    if (el.textContent !== cssText) el.textContent = cssText;

    const parent = container();
    if (parent && el.parentNode !== parent) {
      // Appended last so that, at equal specificity, these rules win on order.
      parent.appendChild(el);
    }
    return el;
  }

  function remove(id) {
    const el = elements.get(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    elements.delete(id);
  }

  function clearAll() {
    for (const id of Array.from(elements.keys())) remove(id);
    for (const el of document.querySelectorAll(`style[${MARK}]`)) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }

  /** Is this node one of ours? Used by the observer to ignore self-inflicted churn. */
  const isOurs = (node) =>
    !!node &&
    node.nodeType === 1 &&
    (node.hasAttribute?.(MARK) || node.closest?.(`[${MARK}]`) != null);

  /**
   * Take some of our own sheets out of the cascade for the duration of a read.
   *
   * The compute tier decides what a colour should become by asking
   * getComputedStyle what it currently is. On the first sweep that answer is
   * the page's own design. On any later sweep it is whatever Nocturne wrote
   * last time, unless the sheet holding those rules is stood down first, and
   * mapping an already-mapped colour walks every surface back towards the
   * middle of the ramp until cards and the page behind them meet.
   *
   * Media rather than removal: removing the element would drop and rebuild
   * the whole sheet on every read. Flipping media is one attribute write,
   * reversed inside the same synchronous task, so style recalc sees it and
   * nothing ever repaints in between. That is the same trick, and the same
   * reasoning, as the probing attribute on guard.css.
   */
  function withoutOurs(ids, fn) {
    const suspended = [];
    for (const id of ids) {
      const el = elements.get(id);
      if (el && el.media !== 'not all') {
        el.media = 'not all';
        suspended.push(el);
      }
    }
    try {
      return fn();
    } finally {
      for (const el of suspended) el.media = 'screen';
    }
  }

  /** Re-append any sheet a page has ripped out of the head. */
  function reassert() {
    const parent = container();
    if (!parent) return;
    for (const el of elements.values()) {
      if (!el.isConnected) parent.appendChild(el);
    }
  }

  /**
   * Push CSS into an open shadow root. Falls back to a <style> element on the
   * rare engine without constructable stylesheets.
   */
  function adopt(root, cssText) {
    if (!root) return;
    try {
      if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function') {
        let sheet = adopted.get(root);
        if (!sheet) {
          sheet = new CSSStyleSheet();
          adopted.set(root, sheet);
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        }
        sheet.replaceSync(cssText);
        return;
      }
    } catch {
      /* fall through to the element path */
    }
    let el = root.querySelector(`style[${MARK}]`);
    if (!el) {
      el = document.createElement('style');
      el.setAttribute(MARK, 'shadow');
      root.appendChild(el);
    }
    if (el.textContent !== cssText) el.textContent = cssText;
  }

  function unadopt(root) {
    const sheet = adopted.get(root);
    if (sheet && root.adoptedStyleSheets) {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
      adopted.delete(root);
    }
    const el = root.querySelector && root.querySelector(`style[${MARK}]`);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  NX.sheet = {
    MARK,
    set,
    remove,
    clearAll,
    isOurs,
    reassert,
    adopt,
    unadopt,
    withoutOurs,
    elements,
  };
})(typeof self !== 'undefined' ? self : globalThis);
