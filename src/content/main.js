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
    announced: false,
    mirrored: false,
    // The exact text last handed to the worker, so an unchanged mirror is not
    // torn down and rebuilt. null until the first sync, which is not the same
    // as the empty string: that one means "cleared, and the worker knows".
    mirrorCss: null,
  };

  const root = () => document.documentElement;

  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  /**
   * The mirror's liveness is not only ours to know.
   *
   * Anything that reads the page back has to know a copy of our own rules is
   * up at an origin it cannot suspend, and the readers live in sheet.js and
   * tiers.js. Recorded in both places from here, so there is one writer.
   */
  function setMirrored(live) {
    state.mirrored = live;
    NX.sheet.noteMirror(live);
  }

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
    /*
     * The USER-origin mirror is not ours to leave behind.
     *
     * clearAll only reaches the sheets this document owns. The stubborn-sites
     * copy lives at USER origin, inserted by the worker, and it outranks every
     * rule the page itself can write. Left in place it keeps the page inverted
     * or token-remapped for the life of the document, unoverridable, while
     * Nocturne reports itself switched off. Only the top frame ever asked for
     * it, so only the top frame withdraws it.
     */
    if (isTopFrame()) {
      NX.browser.send({ type: MSG.CLEAR_USER_CSS });
      state.mirrorCss = '';
    }
    setMirrored(false);
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

    /*
     * The learned rung is an optimisation, and how much of it applies depends
     * on the mode.
     *
     * For `auto` it applies whole: start where this origin settled last time.
     *
     * For `dynamic` only the demotion to filter carries over. That demotion is
     * a performance backstop rather than a preference, and running the sweep
     * again on a page that already melted under it is the exact cost it exists
     * to avoid. The cheaper rungs are skipped anyway under this mode.
     *
     * For `native` none of it applies. Letting it set the starting rung meant
     * an origin that had learned rung 3 on `auto` skipped past the early
     * return further down that makes the mode mean anything, because that
     * return sits inside the block this value gates. The popup promises the
     * mode never recolours, and it recoloured.
     */
    let startAt = 1;
    if (from != null) {
      if (pinned === 'auto') startAt = Math.max(1, from);
      else if (pinned === 'dynamic' && from >= TIER.FILTER) startAt = TIER.FILTER;
    }

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
    /*
     * The compute sheet just grew, so the mirror is a sweep behind.
     *
     * It has to be caught up here for the same reason it is caught up after a
     * demotion: the mirror is not an extra, it is the only origin that beats a
     * page's own inline `!important`, and stubborn mode is only ever on for
     * pages that use one. Left at whatever the first climb wrote, every node
     * added since had its colours in author origin alone, which on those pages
     * is the origin that loses. The result was a themed page with light holes
     * in it wherever anything had been painted after load, which on a modern
     * application is most of it.
     *
     * Inside the budget on purpose: building the text walks every sheet, and a
     * page that makes that expensive should be demoted for it like any other
     * cost this function incurs.
     */
    syncUserCss(ctx);
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
    /*
     * Only the document does this. `scripting.insertCSS` with a tabId targets
     * the top frame, so an embed running this would be writing its own
     * computed rules, and its own `[data-nx]` ids, over the page that embeds
     * it. Stubborn mode never reached subframes anyway, so nothing is lost.
     */
    if (!isTopFrame()) return;
    /*
     * Taken from what the sheet was asked to contain, not from the elements.
     *
     * Those elements sit in the page's own DOM and the page can rewrite one.
     * Author origin is its own document to override, but this text is inserted
     * at USER origin, which outranks everything the page can write for itself
     * and is not subject to the page's own content security policy, so reading
     * it back off the element handed the page reach it does not otherwise have.
     */
    const wanted = !ctx.stubborn || (outcome && outcome.untouched) ? '' : NX.sheet.ours();

    /*
     * Resending an unchanged mirror is not free, so it is not sent.
     *
     * Replacing one is a removeCSS followed by an insertCSS, and for the
     * moment between them the page has only its author-origin theme, which is
     * the origin its own inline `!important` beats. That is affordable once
     * per climb. rescan() calls this on every mutation batch a single page
     * application produces, so sending only what actually changed is the
     * difference between a rare flicker and a continuous one.
     */
    if (wanted === state.mirrorCss) return;
    state.mirrorCss = wanted;
    NX.browser.send(
      wanted ? { type: MSG.APPLY_USER_CSS, css: wanted } : { type: MSG.CLEAR_USER_CSS }
    );
    setMirrored(!!wanted);
  }

  /**
   * Take the USER-origin mirror off the page and wait until it is really off.
   *
   * Nothing may measure the page while it is up. The mirror is a copy of
   * Nocturne's own rules at the one origin a content script cannot suspend:
   * `sheet.withoutOurs` flips `media` on the sheets this document owns, and
   * the mirror is not one of them, it was inserted by the worker. So a second
   * climb reads Nocturne's own colours, decides the page is already dark,
   * declares the page untouched, and then withdraws the mirror it just
   * measured. The page ends up fully light while the popup reports it as
   * using the site's own dark theme.
   *
   * Removal is a round trip through the worker, so the blunt half of guard.css
   * goes back up for the duration rather than leaving the page bare.
   */
  async function dropMirror() {
    if (!isTopFrame() || !state.mirrored) return;
    state.ready = false;
    root().removeAttribute('data-nocturne-ready');
    await NX.browser.send({ type: MSG.CLEAR_USER_CSS });
    state.mirrorCss = '';
    setMirrored(false);
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

    /*
     * "Site theme only" has nothing left to try.
     *
     * Its one rung just lost to the site's own script, and everything above it
     * is the recolouring this mode exists to refuse. Climbing anyway would
     * break the promise; re-entering the native rung would re-apply the signal
     * the site has already stripped five times and start the fight over. The
     * honest outcome is the page as the site renders it.
     */
    if (ctx.mode === 'native') {
      state.tier = TIER.NATIVE;
      root().setAttribute('data-nocturne-tier', String(TIER.NATIVE));
      syncUserCss(ctx, { untouched: true });
      return;
    }

    const outcome = NX.observe.run(() => climb(ctx, TIER.TOKENS));
    state.tier = outcome.tier;
    root().setAttribute('data-nocturne-tier', String(outcome.tier));
    remember(ctx, outcome.tier, 'native:lost');
    watch(ctx, outcome.tier);
    syncUserCss(ctx, outcome);
  }

  /**
   * Watch the page, in the way the rung that is actually in force needs.
   *
   * Only the compute rung does work per mutation, so only it needs the batch
   * and only it has anything to back off from when a page will not settle.
   * Pairing the token rung with the same callbacks looked harmless because
   * rescan() returns immediately unless the compute rung is in force, but the
   * churn half still fired: a design-token application with a lively DOM,
   * which is most of them, lost a faithful theme to whole-page inversion, and
   * the demotion was recorded against the origin so every later visit started
   * there too.
   *
   * What that rung needs is the same thing the promoted-media rung needs. Both
   * inject a stylesheet, and a page that rebuilds its head takes it away.
   * Tier 1a injects nothing, so it is watched only when a sheet exists. The
   * filter rung is deliberately left unwatched: it is where a page ends up
   * after everything cheaper was too expensive, and an observer is exactly the
   * cost it was demoted to avoid.
   */
  function watch(ctx, tier) {
    if (tier === TIER.COMPUTE) {
      NX.observe.start(
        (batch) => rescan(ctx, batch),
        (count) => demote(ctx, `churn:${count}`)
      );
      return;
    }
    if ((tier === TIER.TOKENS || tier === TIER.NATIVE) && NX.sheet.elements.size > 0) {
      NX.observe.start(
        () => NX.observe.run(() => NX.sheet.reassert()),
        () => {}
      );
    }
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

  /**
   * Report the rung this origin settled on, so the next visit can start there.
   *
   * Top frame only, like `announce` and `syncUserCss`. A subframe's document
   * has none of the embedding page's stylesheets, so it falls to the compute
   * rung on a site whose own dark theme works perfectly, and the rung is
   * stored against the origin rather than the frame. The worker guards this
   * too; both ends, because either one alone is a silent single point of
   * failure for the product's headline claim.
   */
  function remember(ctx, tier, reason) {
    if (!state.origin || !isTopFrame()) return;
    NX.browser.send({ type: MSG.LEARNED, origin: state.origin, tier, reason: reason || '' });
  }

  /**
   * Is this the frame entitled to speak for the tab?
   *
   * The script runs in every frame, and only the document itself has the
   * origin the toolbar and the popup mean. Comparing the WindowProxy is
   * allowed across origins; reading anything off it is not, hence the guard.
   */
  function isTopFrame() {
    try {
      return global.top === global.self;
    } catch {
      return false;
    }
  }

  /**
   * Tell the worker where this page is and whether it ended up themed.
   *
   * The worker cannot work either out for itself: with no `tabs` permission
   * and no default host permission it gets Tab objects with no `url`, and a
   * service worker has no media query so it cannot evaluate a system
   * schedule. Reporting is the only honest source for both.
   */
  function announce(ctx) {
    if (!isTopFrame()) return;
    /*
     * `fresh` is true only on this document's first report. A content script
     * boots once per document, so it is the one honest signal the worker has
     * that the previous document in this tab is gone and anything it inserted
     * went with it. Every later report comes from a re-apply, where the sheet
     * the worker is holding a record of is still very much on the page.
     */
    const fresh = !state.announced;
    state.announced = true;
    NX.browser.send({
      type: MSG.TAB_STATE,
      origin: state.origin,
      active: !!(ctx && ctx.active),
      fresh,
    });
  }

  /**
   * One climb at a time, and one more afterwards if anything asked while it ran.
   *
   * `applyNow` is several awaits long: it reads storage, and on a stubborn site
   * it waits for the worker to confirm the user-origin mirror is off before
   * anything is allowed to measure the page. `broadcast` pokes every open tab
   * on every settings write, so a second run starts inside the first whenever
   * two writes land close together. Two clicks in the popup does it, and so
   * does one click while the clock schedule's alarm fires.
   *
   * Overlapped, the second climb reached the page the first had just themed,
   * measured it as already dark, and reported that as the site's own dark
   * theme: the popup described a generated theme as native, the rung was
   * taught to the origin so the next visit started on the wrong one, and the
   * observer the compute rung needs was replaced by the one the native rung
   * uses, which left everything the page painted afterwards untouched.
   *
   * The trailing pass is what keeps this correct rather than merely safe. The
   * settings change that arrived mid-climb is real and still has to be
   * applied; it just has to happen after, not during. Any number of them
   * collapse into that one pass, which is also what stops a burst of
   * broadcasts from queueing a climb each.
   */
  let climbing = null;
  let restart = false;

  function apply() {
    if (climbing) {
      restart = true;
      return climbing;
    }
    climbing = (async () => {
      try {
        do {
          restart = false;
          await applyNow();
        } while (restart);
      } finally {
        climbing = null;
      }
    })();
    return climbing;
  }

  async function applyNow() {
    const settings = await NX.browser.readSettings();
    const origin = NX.settings.originOf(location.href);
    state.origin = origin;

    const systemDark =
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const ctx = NX.settings.resolve(settings, origin, { systemDark });
    state.settings = ctx;
    announce(ctx);

    if (!ctx.active) {
      standDown();
      return;
    }

    resume();
    NX.observe.stop();
    NX.sheet.clearAll();
    NX.tiers.clearCompute();
    // Before anything measures the page, and after clearAll, which cannot
    // reach a sheet this document does not own.
    await dropMirror();
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

    watch(ctx, outcome.tier);
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
    // Known from document_start, so a popup opened before the ladder has run
    // still learns which site it is looking at.
    state.origin = NX.settings.originOf(location.href);
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
