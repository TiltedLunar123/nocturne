/**
 * The ladder, driven.
 *
 * Reads the settings for this origin, climbs the rungs until the page measures
 * dark and readable, remembers where it stopped, and then keeps that state
 * true as the page changes.
 *
 * Every rung is under a time budget. A page that cannot be themed within
 * budget is demoted rather than allowed to hold the main thread, which is the
 * failure mode users of this category actually report.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});
  const { MSG } = NX.browser;

  const BUDGET_MS = 420; // whole ladder, first pass
  const RESCAN_BUDGET_MS = 90; // incremental work after a mutation batch

  const TIER = { OFF: 0, NATIVE: 1, TOKENS: 2, COMPUTE: 3, FILTER: 4 };

  const state = {
    settings: null,
    origin: null,
    tier: null,
    undoSignal: null,
    stopRootWatch: null,
    started: false,
    ready: false,
  };

  const root = () => document.documentElement;

  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  function markReady() {
    if (state.ready) return;
    state.ready = true;
    // Retires the blunt half of guard.css and lets the real theme show.
    root().setAttribute('data-nocturne-ready', '');
  }

  function standDown() {
    root().setAttribute('data-nocturne-off', '');
    root().removeAttribute('data-nocturne-ready');
    if (state.undoSignal) {
      state.undoSignal();
      state.undoSignal = null;
    }
    if (state.stopRootWatch) {
      state.stopRootWatch();
      state.stopRootWatch = null;
    }
    NX.observe.stop();
    NX.tiers.clearCompute();
    NX.sheet.clearAll();
    state.tier = TIER.OFF;
    state.ready = false;
  }

  function resume() {
    root().removeAttribute('data-nocturne-off');
  }

  /**
   * Climb until the measurement passes.
   *
   * `from` lets a repeat visit skip straight to the rung that worked last time.
   * The result is still measured there, so a site that has since shipped its
   * own dark mode falls back down the ladder rather than staying on an
   * expensive rung forever.
   */
  function climb(ctx, from) {
    const started = now();
    const spent = () => now() - started;
    const log = [];

    const pinned = ctx.mode;
    if (pinned === 'filter') {
      NX.tiers.applyFilter(ctx);
      return { tier: TIER.FILTER, log: ['pinned:filter'] };
    }

    // A page that is already dark is left alone. Re-theming a dark page is the
    // most reliable way to make it worse.
    if (pinned !== 'dynamic' && NX.probe.alreadyDark()) {
      return { tier: TIER.NATIVE, log: ['already-dark'], untouched: true };
    }

    const startAt = from == null ? 1 : Math.max(1, from);

    if (pinned !== 'dynamic' && startAt <= TIER.NATIVE) {
      const byClass = NX.tiers.tryNativeClass(ctx);
      if (byClass) {
        state.undoSignal = byClass.undo;
        state.stopRootWatch = NX.observe.watchRoot(
          () => NX.signals.apply(byClass.signal, root()),
          () => NX.signals.alreadyOn(byClass.signal, root()),
          // The site's own theme script won. Stop fighting it and climb, or
          // the page stays light while we report success.
          () => escalatePastNative(ctx)
        );
        return { tier: TIER.NATIVE, log: [...log, `class:${byClass.signal.id}`] };
      }
      log.push('class:none');

      const byMedia = NX.tiers.tryNativeMedia(ctx);
      if (byMedia) return { tier: TIER.NATIVE, log: [...log, 'media:promoted'] };
      log.push('media:none');

      /*
       * "Site theme only" means only that.
       *
       * The popup promises this mode never recolours, so when the site has no
       * theme of its own the honest outcome is to leave the page alone, not to
       * quietly fall through to generating one and then to inverting it.
       */
      if (pinned === 'native') {
        return { tier: TIER.NATIVE, log: [...log, 'pinned:native'], untouched: true };
      }
    }

    if (spent() < BUDGET_MS && startAt <= TIER.TOKENS && pinned !== 'dynamic') {
      const byTokens = NX.tiers.tryTokens(ctx);
      if (byTokens) return { tier: TIER.TOKENS, log: [...log, `tokens:${byTokens.count}`] };
      log.push('tokens:none');
    }

    /*
     * An origin that was demoted to filter must not pay for the sweep again.
     *
     * Without this gate the learned tier only skipped the two cheap rungs, so
     * a page demoted for melting under the compute tier ran the whole compute
     * tier again on every single load, and a pass that happened to measure well
     * re-learned it as compute and undid the demotion entirely.
     */
    if (startAt >= TIER.FILTER) {
      NX.tiers.applyFilter(ctx);
      return { tier: TIER.FILTER, log: [...log, 'learned:filter'] };
    }

    if (spent() < BUDGET_MS) {
      const byCompute = NX.tiers.tryCompute(ctx);
      if (byCompute && byCompute.result.ok) {
        return {
          tier: TIER.COMPUTE,
          log: [...log, `compute:${byCompute.signatures}/${byCompute.elements}`],
        };
      }
      // Compute is the general answer even when the probe is unconvinced: a
      // page with a canvas covering half the viewport never measures dark, and
      // inverting the whole thing would be worse than a partial theme.
      if (byCompute) {
        return {
          tier: TIER.COMPUTE,
          log: [...log, `compute:partial:${byCompute.signatures}`],
          partial: true,
        };
      }
      log.push('compute:none');
    } else {
      log.push('budget:exhausted');
    }

    NX.tiers.applyFilter(ctx);
    return { tier: TIER.FILTER, log: [...log, 'filter'] };
  }

  /**
   * Re-theme the nodes a mutation actually brought in.
   *
   * `batch` matters: re-sweeping the whole document on every mutation makes
   * the cost O(page) per change, and a single page application changes
   * constantly. With the batch it is O(change).
   */
  function rescan(ctx, batch) {
    if (state.tier !== TIER.COMPUTE) return;
    const started = now();
    NX.observe.run(() => {
      if (batch && batch.length) NX.tiers.computeOn(batch, ctx);
      else NX.tiers.tryCompute(ctx);
    });
    const cost = now() - started;
    if (cost > RESCAN_BUDGET_MS * 4) demote(ctx, `rescan:${Math.round(cost)}ms`);
  }

  /**
   * Mirror whatever author sheets are currently live into USER origin.
   *
   * The stubborn-sites upgrade. The author-origin sheets are already live, so
   * this is purely additive: the same declarations re-inserted at USER origin,
   * which is the only weight that outranks a page's own inline `!important`.
   * A content script cannot produce those itself.
   *
   * It has to run after EVERY change to the sheets, not only after the first
   * climb. A demotion swaps the token sheet for the filter sheet, and a
   * user-origin copy of the old token rules still matches `:root`, so the page
   * would end up both remapped and inverted at once.
   */
  function syncUserCss(ctx, outcome) {
    if (!ctx.stubborn || (outcome && outcome.untouched)) {
      NX.browser.send({ type: MSG.CLEAR_USER_CSS });
      return;
    }
    const css = Array.from(NX.sheet.elements.values())
      .map((el) => el.textContent)
      .join('\n');
    NX.browser.send(
      css.trim() ? { type: MSG.APPLY_USER_CSS, css } : { type: MSG.CLEAR_USER_CSS }
    );
  }

  /**
   * The site's theme script beat us. Undo the signal and climb from tokens.
   *
   * Reached only after the re-apply cap in watchRoot, so this runs once.
   */
  function escalatePastNative(ctx) {
    if (state.stopRootWatch) {
      state.stopRootWatch();
      state.stopRootWatch = null;
    }
    if (state.undoSignal) {
      state.undoSignal();
      state.undoSignal = null;
    }
    const outcome = NX.observe.run(() => climb(ctx, TIER.TOKENS));
    state.tier = outcome.tier;
    root().setAttribute('data-nocturne-tier', String(outcome.tier));
    remember(ctx, outcome.tier, 'native:lost');
    if (outcome.tier === TIER.COMPUTE || outcome.tier === TIER.TOKENS) {
      NX.observe.start(
        (batch) => rescan(ctx, batch),
        (count) => demote(ctx, `churn:${count}`)
      );
    }
    syncUserCss(ctx, outcome);
  }

  /** Drop to a cheaper rung and remember it for this origin. */
  function demote(ctx, reason) {
    if (state.tier >= TIER.FILTER) return;
    NX.observe.stop();
    NX.tiers.clearCompute();
    NX.sheet.remove(NX.tiers.SHEET_VARS);
    NX.sheet.remove(NX.tiers.SHEET_MEDIA);
    NX.tiers.applyFilter(ctx);
    state.tier = TIER.FILTER;
    root().setAttribute('data-nocturne-tier', String(TIER.FILTER));
    remember(ctx, TIER.FILTER, reason);
    // The sheets just changed, so the user-origin mirror is now stale.
    syncUserCss(ctx, { tier: TIER.FILTER });
  }

  function remember(ctx, tier, reason) {
    if (!state.origin) return;
    NX.browser.send({ type: MSG.LEARNED, origin: state.origin, tier, reason: reason || '' });
  }

  async function apply() {
    const settings = await NX.browser.readSettings();
    const origin = NX.settings.originOf(location.href);
    state.origin = origin;

    const systemDark =
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const ctx = NX.settings.resolve(settings, origin, { systemDark });
    state.settings = ctx;

    if (!ctx.active) {
      standDown();
      return;
    }

    resume();
    NX.observe.stop();
    NX.sheet.clearAll();
    NX.tiers.clearCompute();
    if (state.undoSignal) {
      state.undoSignal();
      state.undoSignal = null;
    }
    if (state.stopRootWatch) {
      state.stopRootWatch();
      state.stopRootWatch = null;
    }

    let outcome;
    try {
      outcome = NX.observe.run(() => climb(ctx, ctx.learnedTier));
    } finally {
      // Even a thrown tier must not leave the page stuck behind the blunt
      // guard styles with no theme underneath.
      markReady();
    }

    state.tier = outcome.tier;
    // Published on the root element so the rung is visible in devtools and to
    // anyone writing their own userstyles on top. It is also what the end to
    // end suite asserts against.
    root().setAttribute('data-nocturne-tier', String(outcome.tier));
    if (outcome.tier !== ctx.learnedTier) remember(ctx, outcome.tier, outcome.log.join(','));

    if (ctx.dimImages > 0) {
      const dim = 1 - ctx.dimImages / 100;
      NX.sheet.set(
        'media',
        `img,video,picture,canvas{filter:brightness(${dim.toFixed(2)})}`
      );
    }

    syncUserCss(ctx, outcome);

    if (outcome.tier === TIER.COMPUTE || outcome.tier === TIER.TOKENS) {
      NX.observe.start(
        (batch) => rescan(ctx, batch),
        (count) => demote(ctx, `churn:${count}`)
      );
    } else if (outcome.tier === TIER.NATIVE && NX.sheet.elements.size > 0) {
      /*
       * Only the promoted-media path injects a sheet, and only that path needs
       * watching in case the page rebuilds its head. Tier 1a injects nothing
       * at all, so starting an observer there would run a callback on every
       * mutation of the page for no work.
       */
      NX.observe.start(
        () => NX.observe.run(() => NX.sheet.reassert()),
        () => {}
      );
    }
  }

  function listen() {
    NX.browser.api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') return undefined;
      if (message.type === MSG.STATE_CHANGED) {
        apply();
        return undefined;
      }
      if (message.type === MSG.GET_STATE) {
        sendResponse({
          origin: state.origin,
          tier: state.tier,
          ready: state.ready,
          measurement: state.settings ? NX.probe.measure(state.settings) : null,
        });
        return true;
      }
      return undefined;
    });

    if (typeof matchMedia === 'function') {
      const query = matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (state.settings && state.settings.schedule.kind === 'system') apply();
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
    }
  }

  function boot() {
    if (state.started) return;
    state.started = true;
    listen();

    /*
     * Wait for the document to finish parsing before climbing.
     *
     * The obvious thing is to start the moment document.body exists, and it is
     * wrong: at that instant the body is empty, so every measurement says the
     * page is a dark blank and the ladder stops on the first rung. The page is
     * not visibly waiting either way, because guard.css is already holding it
     * dark, so there is nothing to gain by starting early and a correct
     * decision to lose.
     */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => apply(), { once: true });
    } else {
      apply();
    }

    // A late pass catches sites that paint their real UI after hydration.
    window.addEventListener(
      'load',
      () => {
        if (state.tier === TIER.COMPUTE || state.tier === TIER.TOKENS) {
          // A full sweep here on purpose: hydration can repaint anything.
          setTimeout(() => state.settings && rescan(state.settings, null), 250);
        }
      },
      { once: true }
    );
  }

  NX.main = { boot, apply, state, TIER, climb };
  boot();
})(typeof self !== 'undefined' ? self : globalThis);
