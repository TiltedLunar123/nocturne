/**
 * Watching the page without fighting it.
 *
 * Three separate hazards live here, and each has bitten this category of
 * extension before:
 *
 * 1. Reacting to our own writes. Every sheet and attribute Nocturne adds is
 *    marked, and records caused by our own work are drained rather than
 *    handled.
 * 2. Duelling with a rich text editor. Editors rewrite style attributes on
 *    every keystroke; if we rewrite them back, the two loop forever and the
 *    tab hangs. A per-node re-entry counter retires nodes that keep coming
 *    back, so the worst case is one unthemed node rather than a frozen page.
 * 3. Death by a thousand mutations. Sustained churn is reported upward so the
 *    ladder can demote this origin to a cheaper tier and stop trying.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});

  const RETRY_LIMIT = 12; // per-node rewrites before we give up on it
  const CHURN_WINDOW = 4000; // ms
  const CHURN_LIMIT = 900; // mutations in that window before demotion

  const state = {
    observer: null,
    onDirty: null,
    onChurn: null,
    pending: new Set(),
    scheduled: false,
    suppress: 0,
    counts: new WeakMap(),
    hostile: new WeakSet(),
    windowStart: 0,
    windowCount: 0,
    churnReported: false,
  };

  const schedule =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 250 })
      : (fn) => setTimeout(fn, 32);

  /** Is this mutation something we caused? */
  function selfInflicted(record) {
    if (state.suppress > 0) return true;
    if (record.type === 'attributes' && record.attributeName === 'data-nx') return true;
    if (NX.sheet.isOurs(record.target)) return true;
    for (const node of record.addedNodes || []) {
      if (NX.sheet.isOurs(node)) return true;
    }
    return false;
  }

  function note(el) {
    if (!el || el.nodeType !== 1) return;
    if (state.hostile.has(el)) return;
    const seen = (state.counts.get(el) || 0) + 1;
    state.counts.set(el, seen);
    if (seen > RETRY_LIMIT) {
      // This node and Nocturne disagree. Concede rather than spin.
      state.hostile.add(el);
      state.pending.delete(el);
      return;
    }
    state.pending.add(el);
  }

  function flush() {
    state.scheduled = false;
    if (!state.pending.size) return;
    const batch = Array.from(state.pending);
    state.pending.clear();
    if (state.onDirty) {
      run(() => state.onDirty(batch));
    }
  }

  function handle(records) {
    const now = Date.now();
    if (now - state.windowStart > CHURN_WINDOW) {
      state.windowStart = now;
      state.windowCount = 0;
    }

    let relevant = 0;
    for (const record of records) {
      if (selfInflicted(record)) continue;
      relevant++;
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          note(node);
          // A subtree can arrive in one record; the ladder needs the whole of it.
          if (node.querySelectorAll) {
            const kids = node.querySelectorAll('*');
            for (let i = 0; i < kids.length && i < 500; i++) note(kids[i]);
          }
        }
      } else {
        note(record.target);
      }
    }

    state.windowCount += relevant;
    if (
      !state.churnReported &&
      state.windowCount > CHURN_LIMIT &&
      typeof state.onChurn === 'function'
    ) {
      state.churnReported = true;
      state.onChurn(state.windowCount);
      return;
    }

    if (relevant && !state.scheduled) {
      state.scheduled = true;
      schedule(flush);
    }
  }

  /**
   * Run a function whose DOM writes must not come back as mutations.
   * Records queued during it are taken and discarded.
   */
  function run(fn) {
    state.suppress++;
    try {
      return fn();
    } finally {
      if (state.observer) state.observer.takeRecords();
      state.suppress--;
    }
  }

  function start(onDirty, onChurn) {
    stop();
    state.onDirty = onDirty;
    state.onChurn = onChurn;
    state.windowStart = Date.now();
    state.windowCount = 0;
    state.churnReported = false;
    state.observer = new MutationObserver(handle);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'fill', 'stroke', 'bgcolor', 'color'],
    });
  }

  function stop() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.pending.clear();
    state.scheduled = false;
  }

  /**
   * Watch <html> for a theme class being torn off again by the page.
   *
   * A site whose own theme script keeps winning gets a bounded number of
   * re-applications, then `onGiveUp` fires. Giving up has to escalate rather
   * than simply stop: a page left light while the engine still reports the
   * native rung as a success is a worse outcome than the loop this cap exists
   * to prevent.
   */
  /**
   * Every attribute a signal can set, derived from the signal table.
   *
   * Hand-listing these meant the list covered five of the ten attributes
   * signals.js actually writes, so for the other five a site's own theme
   * script could strip Nocturne's attribute straight back off with nothing
   * watching: the page went light again while the engine went on reporting
   * the native rung as a success. Deriving it means a signal added over there
   * cannot be silently unwatchable over here.
   */
  function rootAttributes() {
    const names = new Set(['class']);
    for (const signal of (NX.signals && NX.signals.SIGNALS) || []) {
      if (signal.attr) names.add(signal.attr[0]);
      for (const [name] of signal.extraAttrs || []) names.add(name);
    }
    return Array.from(names);
  }

  function watchRoot(onLost, check, onGiveUp) {
    let reapplied = 0;
    const observer = new MutationObserver(() => {
      if (reapplied >= 5) {
        observer.disconnect();
        if (typeof onGiveUp === 'function') onGiveUp();
        return;
      }
      if (!check()) {
        reapplied++;
        run(onLost);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: rootAttributes(),
    });
    return () => observer.disconnect();
  }

  NX.observe = { start, stop, run, watchRoot, rootAttributes, state };
})(typeof self !== 'undefined' ? self : globalThis);
