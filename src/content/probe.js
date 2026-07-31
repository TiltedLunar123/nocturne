/**
 * Did the page actually come out dark and readable?
 *
 * This is the measurement the whole ladder turns on. Without it, "try the
 * site's own theme first" is a guess that fails silently on every site where
 * the guess is wrong. With it, each rung is an experiment with a pass or fail.
 *
 * The measurement samples the viewport on a grid rather than walking the DOM.
 * Grid sampling weights the result by what is actually on screen, which is what
 * "the page looks light" means, and it costs a fixed ~81 hit tests regardless
 * of how many elements the page has. A DOM walk would instead be dominated by
 * thousands of tiny invisible nodes that contribute nothing to the impression.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});
  const color = NX.color;

  const GRID = 9; // 81 sample points
  const TRANSPARENT = /^rgba?\((?:\s*0\s*,){3}\s*0\s*\)$/;

  /**
   * Measure with the anti-flash shell stood down.
   *
   * Without this the shell's own dark background is what gets measured, every
   * tier reports success immediately, and the ladder never leaves the first
   * rung. Set and cleared within one synchronous task: getComputedStyle forces
   * a style recalc but not a paint, so nothing is visible on screen.
   */
  function withoutGuard(fn) {
    const root = document.documentElement;
    const had = root.hasAttribute('data-nocturne-probing');
    if (!had) root.setAttribute('data-nocturne-probing', '');
    try {
      return fn();
    } finally {
      if (!had) root.removeAttribute('data-nocturne-probing');
    }
  }

  function isTransparent(value) {
    if (!value || value === 'transparent') return true;
    if (TRANSPARENT.test(value.replace(/\s+/g, ' '))) return true;
    const parsed = color.parse(value);
    return !parsed || parsed.a < 0.05;
  }

  /**
   * What the canvas is actually painted with.
   *
   * This has to model CSS background propagation, not just read the root. When
   * the root's background is transparent the browser paints the canvas with
   * the BODY's background instead. Reading only the root and defaulting to
   * white reports a themed page as half light, because every point below the
   * content sits over the canvas rather than over any element.
   */
  function canvasBackground() {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      const value = getComputedStyle(node).backgroundColor;
      if (isTransparent(value)) continue;
      const parsed = color.parse(value);
      if (parsed) return parsed.rgb;
    }
    // Neither is painted, so this is the user agent's own canvas. With the
    // shell stood down for measurement that is the light default, which is the
    // honest answer to "would this page be light without us".
    return [1, 1, 1];
  }

  /**
   * The colour actually painted at an element's position: walk up until a
   * non-transparent background is found, because the topmost element under a
   * point usually has no background of its own.
   */
  function paintedBackground(el) {
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      const value = getComputedStyle(node).backgroundColor;
      if (!isTransparent(value)) {
        const parsed = color.parse(value);
        if (parsed) return parsed.rgb;
      }
      node = node.parentElement;
      depth++;
    }
    return canvasBackground();
  }

  /**
   * Measure the current page.
   *
   * Returns lightFraction (share of sampled screen that is a light surface),
   * medianContrast (text against its own painted background), and a verdict.
   * All reads, no writes, so it never forces more than one layout flush.
   */
  function measure(options = {}) {
    return withoutGuard(() => measureNow(options));
  }

  function measureNow(options) {
    const minContrast = options.minContrast || 4.5;
    const width = Math.max(1, window.innerWidth || 1);
    const height = Math.max(1, window.innerHeight || 1);

    let sampled = 0;
    let light = 0;
    let lightnessSum = 0;
    const contrasts = [];
    const seen = new Set();

    for (let ix = 0; ix < GRID; ix++) {
      for (let iy = 0; iy < GRID; iy++) {
        const x = ((ix + 0.5) / GRID) * width;
        const y = ((iy + 0.5) / GRID) * height;
        let el;
        try {
          el = document.elementFromPoint(x, y);
        } catch {
          el = null;
        }
        if (!el || el === document.documentElement) {
          // Nothing over the canvas here: still counts, using the canvas colour.
          el = document.body || document.documentElement;
        }
        if (!el) continue;

        const bg = paintedBackground(el);
        const l = color.toOklch(bg)[0];
        sampled++;
        lightnessSum += l;
        if (l > 0.55) light++;

        // Only measure text contrast where there is text to read, and only
        // once per element, so a big paragraph does not dominate the median.
        if (!seen.has(el) && hasText(el)) {
          seen.add(el);
          const fg = color.parse(getComputedStyle(el).color);
          if (fg && fg.a > 0.3) contrasts.push(color.contrast(fg.rgb, bg));
        }
      }
    }

    if (!sampled) {
      return { sampled: 0, lightFraction: 1, meanLightness: 1, medianContrast: 0, ok: false };
    }

    contrasts.sort((a, b) => a - b);
    const medianContrast = contrasts.length
      ? contrasts[Math.floor(contrasts.length / 2)]
      : Infinity;

    const lightFraction = light / sampled;
    const meanLightness = lightnessSum / sampled;

    return {
      sampled,
      lightFraction,
      meanLightness,
      medianContrast,
      textSamples: contrasts.length,
      // A rung passes when almost nothing on screen is still a light surface
      // and the text that is there remains readable. The contrast floor is
      // relaxed slightly against the setting: this is a smoke test for
      // "did the theme apply", not a per-element accessibility audit.
      ok: lightFraction <= 0.1 && medianContrast >= Math.min(minContrast, 4.5) * 0.72,
    };
  }

  function hasText(el) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'svg') return false;
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim().length > 1) return true;
    }
    return false;
  }

  /**
   * Was the page already dark before we touched it? If so the right move is to
   * leave it alone entirely, because re-theming a dark page is the classic way
   * to make it worse.
   */
  function alreadyDark() {
    const result = measure({ minContrast: 4.5 });
    return result.sampled > 0 && result.lightFraction <= 0.08 && result.meanLightness < 0.42;
  }

  NX.probe = { measure, alreadyDark, paintedBackground, isTransparent, withoutGuard };
})(typeof self !== 'undefined' ? self : globalThis);
