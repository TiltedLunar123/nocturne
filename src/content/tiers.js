/**
 * The rungs of the escalation ladder.
 *
 * Each tier is a pure-ish attempt: it applies something, and the caller
 * measures whether the page came out dark. A tier that fails is reverted and
 * the next one runs. None of them decide for themselves whether they worked.
 *
 * Ordered cheapest and highest fidelity first:
 *   1a  turn on the site's own dark theme via its class or attribute
 *   1b  promote the site's own prefers-color-scheme rules
 *   2   remap the site's design tokens
 *   3   sample computed colours and rewrite them, deduplicated
 *   4   invert with a GPU filter
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});
  const color = NX.color;
  const theme = NX.theme;

  const SHEET_MEDIA = 'promoted';
  const SHEET_VARS = 'tokens';
  const SHEET_COMPUTE = 'computed';
  const SHEET_FILTER = 'filter';

  // ---------------------------------------------------------------------
  // Reading the page's own CSS
  // ---------------------------------------------------------------------

  /**
   * Same-origin rules only. Cross-origin sheets throw SecurityError on
   * cssRules, which `tools/probe-platform.mjs` confirms, and which is exactly
   * why Nocturne never builds anything load-bearing on stylesheet text.
   */
  function eachReadableSheet(fn) {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin, invisible to us by design
      }
      if (rules) fn(rules, sheet);
    }
  }

  const ruleName = (rule) => {
    const c = rule && rule.constructor && rule.constructor.name;
    return c || '';
  };

  /** Pool every selector we can see, for signal detection. */
  function harvestSelectors(limit = 400000) {
    const parts = [];
    let size = 0;
    const walk = (rules) => {
      for (const rule of Array.from(rules)) {
        if (size > limit) return;
        if (rule.selectorText) {
          parts.push(rule.selectorText);
          size += rule.selectorText.length;
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    eachReadableSheet((rules) => walk(rules));
    return parts.join('\n');
  }

  // ---------------------------------------------------------------------
  // Tier 1a: the site's own theme, by class or attribute
  // ---------------------------------------------------------------------

  /**
   * Try each detected signal, keeping the first that measurably works.
   * Signals the page already has switched on are skipped: if the site is
   * already in its dark theme, there is nothing here to do.
   */
  function tryNativeClass(ctx) {
    const root = document.documentElement;
    const selectors = harvestSelectors();
    const candidates = NX.signals.detect(selectors);
    if (!candidates.length) return null;

    for (const signal of candidates) {
      if (NX.signals.alreadyOn(signal, root)) continue;
      const undo = NX.signals.apply(signal, root);
      const result = NX.probe.measure(ctx);
      if (result.ok) return { signal, undo, result };
      undo();
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Tier 1b: promote the site's own prefers-color-scheme rules
  // ---------------------------------------------------------------------

  /** Split a media condition on top-level commas. */
  function splitQueryList(text) {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  }

  /**
   * Remove the colour-scheme clause and keep every other condition, so
   * `(min-width: 40em) and (prefers-color-scheme: dark)` still only applies
   * above 40em. Returns null when the branch is not one we can promote.
   *
   * A media query is an optional `only`/`not` plus a media type, and then any
   * number of feature clauses joined by `and`. Only the feature clauses are
   * joined that way: `only screen` is two tokens of one media-type clause,
   * and rebuilding it as `only and screen` is not a valid query, so the
   * engine rewrites the whole condition to `not all` and the block matches
   * nothing. That idiom is still common enough that it was silently costing
   * those sites their own dark theme and dropping them to the compute sweep.
   */
  function stripColorScheme(condition) {
    if (!/prefers-color-scheme\s*:\s*dark/i.test(condition)) return null;
    const clauses = [];
    let depth = 0;
    let current = '';
    const push = () => {
      const clause = current.trim();
      if (clause && !/^and$/i.test(clause)) clauses.push(clause);
      current = '';
    };
    for (let i = 0; i < condition.length; i++) {
      const ch = condition[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && /\s/.test(ch)) {
        push();
        continue;
      }
      current += ch;
    }
    push();

    // The media-type run is however many leading tokens are not parenthesised.
    let split = 0;
    while (split < clauses.length && !clauses[split].startsWith('(')) split++;
    const type = clauses.slice(0, split);

    /*
     * `not screen and (prefers-color-scheme: dark)` negates the whole query,
     * so it applies when the page is NOT on a dark screen: it describes the
     * light theme, not the dark one. There is no rewrite that keeps that
     * meaning while dropping the clause, so leave the branch alone.
     */
    if (type.length && /^not$/i.test(type[0])) return null;

    const kept = clauses
      .slice(split)
      .filter((c) => !/prefers-color-scheme\s*:\s*dark/i.test(c));
    return [type.join(' '), ...kept].filter(Boolean).join(' and ');
  }

  /**
   * Re-emit dark-scheme rules unconditionally.
   *
   * Cascade layers are deliberately dropped from the wrapper stack: unlayered
   * rules beat layered ones, which is the direction we want.
   */
  function promoteDarkMedia() {
    const chunks = [];

    const emit = (rules, stack) => {
      const body = Array.from(rules)
        .map((r) => r.cssText)
        .join('\n');
      if (!body.trim()) return;
      chunks.push(stack.reduceRight((acc, prelude) => `${prelude}{${acc}}`, body));
    };

    const walk = (rules, stack) => {
      for (const rule of Array.from(rules)) {
        const kind = ruleName(rule);
        if (kind === 'CSSMediaRule') {
          const branches = splitQueryList(rule.conditionText || '');
          const promoted = branches
            .map(stripColorScheme)
            .filter((c) => c !== null);
          if (promoted.length) {
            const condition = promoted.filter(Boolean).join(', ');
            emit(rule.cssRules, condition ? [...stack, `@media ${condition}`] : stack);
          }
          // Keep descending: a dark block can be nested inside another query.
          walk(rule.cssRules, [...stack, `@media ${rule.conditionText}`]);
        } else if (kind === 'CSSSupportsRule') {
          walk(rule.cssRules, [...stack, `@supports ${rule.conditionText}`]);
        } else if (kind === 'CSSLayerBlockRule') {
          walk(rule.cssRules, stack);
        } else if (kind === 'CSSContainerRule') {
          walk(rule.cssRules, [...stack, `@container ${rule.conditionText || ''}`]);
        }
      }
    };

    eachReadableSheet((rules) => walk(rules, []));
    return chunks.join('\n');
  }

  function tryNativeMedia(ctx) {
    const css = promoteDarkMedia();
    if (!css.trim()) return null;
    NX.sheet.set(SHEET_MEDIA, css);
    const result = NX.probe.measure(ctx);
    if (result.ok) return { result };
    NX.sheet.remove(SHEET_MEDIA);
    return null;
  }

  // ---------------------------------------------------------------------
  // Tier 2: design token remap
  // ---------------------------------------------------------------------

  const ROLE_PATTERNS = [
    [/shadow/i, 'shadow'],
    [/border|outline|divider|separator|stroke|\brule\b|hairline/i, 'border'],
    [/primary|accent|brand|link|action|focus|highlight|interactive/i, 'accent'],
    [/text|foreground|\bfg\b|ink|copy|label|heading|title|caption|body-c/i, 'fg'],
    [/\bbg\b|background|surface|paper|canvas|backdrop|elevat|card|panel|sheet|fill|base|muted|subtle/i, 'bg'],
  ];

  /**
   * Guess what a token is for. The name is the strongest evidence available,
   * and lightness is a serviceable fallback: light values are usually
   * surfaces, dark values are usually text.
   */
  function roleForToken(name, rgb) {
    for (const [pattern, role] of ROLE_PATTERNS) {
      if (pattern.test(name)) return role;
    }
    return color.toOklch(rgb)[0] > 0.5 ? 'bg' : 'fg';
  }

  function tryTokens(ctx) {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const declarations = [];

    for (const property of Array.from(computed)) {
      if (!property.startsWith('--')) continue;
      const value = computed.getPropertyValue(property).trim();
      if (!value || value.length > 64) continue;
      const parsed = color.parse(value);
      if (!parsed || parsed.a < 0.05) continue;
      const role = roleForToken(property, parsed.rgb);
      const mapped = theme.map(parsed.rgb, role, ctx);
      declarations.push(`${property}:${color.format(mapped, parsed.a)}`);
    }

    if (declarations.length < 3) return null;

    // Emitted on :root with !important so a token defined later in the page's
    // own cascade does not quietly win.
    const css = `:root{${declarations.map((d) => `${d} !important`).join(';')}}`;
    NX.sheet.set(SHEET_VARS, css);
    const result = NX.probe.measure(ctx);
    if (result.ok) return { result, count: declarations.length };
    NX.sheet.remove(SHEET_VARS);
    return null;
  }

  // ---------------------------------------------------------------------
  // Tier 3: computed-colour sweep
  // ---------------------------------------------------------------------

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'BASE', 'NOSCRIPT', 'TEMPLATE',
  ]);

  /** Colour tokens inside a compound value such as a gradient or shadow. */
  const COLOR_TOKEN =
    /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi;

  /** url(...) segments, which must be copied through untouched. */
  const URL_SEGMENT = /url\((?:"[^"]*"|'[^']*'|[^)]*)\)/gi;

  function remapCompound(value, role, tuning) {
    const swap = (text) =>
      text.replace(COLOR_TOKEN, (token) => {
        const parsed = color.parse(token);
        if (!parsed) return token;
        return color.format(theme.map(parsed.rgb, role, tuning), parsed.a);
      });

    /*
     * Colours are only swapped outside url(). A fragment identifier inside a
     * url can be made entirely of hex digits, so `url("sprite.svg#cafe")` has
     * a "#cafe" in it that the colour pattern matches happily. Rewriting that
     * breaks the reference and the image disappears.
     */
    let out = '';
    let last = 0;
    URL_SEGMENT.lastIndex = 0;
    let match;
    while ((match = URL_SEGMENT.exec(value)) !== null) {
      out += swap(value.slice(last, match.index)) + match[0];
      last = match.index + match[0].length;
    }
    return out + swap(value.slice(last));
  }

  /**
   * Read phase. Pure reads, in one pass, returning data. Nothing here touches
   * the DOM: `tools/probe-colors.mjs` measured interleaved reads and writes at
   * roughly twenty times the per-element cost, so the separation is structural
   * rather than a convention.
   */
  /**
   * Wrapped twice, because there are two ways to read our own work back.
   *
   * guard.css is the first. Its forced background and text colour are read
   * back as if the page had chosen them, and then mapped again: the root ends
   * up a mid grey that does not match the body, leaving a visible seam below
   * the content, and body text is dimmed twice.
   *
   * Our own compute sheet is the second, and it only bites on the sweeps
   * after the first. The engine runs a full re-sweep 250ms after load,
   * precisely because hydration can repaint anything, and at that moment every
   * already-tagged element computes to the colour Nocturne gave it rather than
   * the one the site did. Mapping that a second time pushes surfaces back up
   * the inverted ramp: a page that had settled on #0f1318 with a card at
   * #14181d came out at #2f343a with the card at #2f3439, which is the same
   * colour to any eye. Every elevation cue on the page collapsed one second
   * after it loaded.
   *
   * The USER-origin mirror is a third, and it is the one with no cascade trick
   * available: the worker inserted it, so `withoutOurs` has nothing to flip.
   * That is handled in the loop below instead of here.
   */
  function readPhase(limit, nodes) {
    return NX.probe.withoutGuard(() =>
      NX.sheet.withoutOurs([SHEET_COMPUTE, SHEET_VARS], () => readPhaseNow(limit, nodes))
    );
  }

  /**
   * The signature index persists across sweeps, and it has to.
   *
   * Rebuilding it per sweep numbers signatures by document order, so id 5 can
   * mean one colour on the first pass and a different one on the second. Any
   * element that was tagged on the first pass but not revisited on the second,
   * because it moved past the element cap or stopped matching, then keeps a
   * tag that now points at somebody else's colours. Appending to a stable
   * index means an old tag stays correct forever.
   *
   * It is reset by clearCompute, which runs whenever the settings change and
   * every mapping has to be recomputed anyway.
   */
  const SIGNATURE_CAP = 4000;
  let index = new Map(); // signature text -> id
  let unique = []; // id -> parts

  function readPhaseNow(limit, nodes) {
    const all = nodes || document.querySelectorAll('*');
    const records = [];
    const count = Math.min(all.length, limit);

    /*
     * While the mirror is up, an element that already carries a tag is a
     * surface painted by Nocturne in an origin nothing here can suspend.
     *
     * `withoutOurs` handles the author-origin copy of these rules by flipping
     * `media` on it, which only works for sheets this document owns. The
     * stubborn-sites mirror was inserted by the worker at USER origin, so
     * reading a tagged element back would return the colour Nocturne gave it,
     * map that a second time, and walk the surface up the ramp until a card
     * and the page behind it are the same grey. Skipping is the only
     * equivalent of standing it down that is available from here, and the set
     * it covers is exact: `[data-nx]` is the only hook the mirror's compute
     * rules have, so a tag is precisely what makes an element unreadable.
     *
     * The cost is that a tagged element which later changes colour on its own
     * keeps the theming it was given, on stubborn sites only. New content is
     * unaffected, which is the case that matters: it is untagged, so it is
     * read against the page's own colours exactly as on the first climb.
     */
    const mirrored = NX.sheet.mirrorLive();

    for (let i = 0; i < count; i++) {
      const el = all[i];
      if (SKIP_TAGS.has(el.tagName) || NX.sheet.isOurs(el)) continue;
      if (mirrored && el.hasAttribute('data-nx')) continue;

      const cs = getComputedStyle(el);
      const isSvg = typeof SVGElement !== 'undefined' && el instanceof SVGElement;

      const parts = [
        cs.color,
        cs.backgroundColor,
        cs.borderTopColor,
        cs.borderRightColor,
        cs.borderBottomColor,
        cs.borderLeftColor,
        cs.outlineColor,
        cs.boxShadow === 'none' ? '' : cs.boxShadow,
        cs.backgroundImage.startsWith('none') ? '' : cs.backgroundImage,
        isSvg ? cs.fill : '',
        isSvg ? cs.stroke : '',
      ];
      const signature = parts.join('|');
      if (!parts.some(Boolean)) continue;

      let id = index.get(signature);
      if (id === undefined) {
        // A page cycling through colours forever must not grow this without
        // bound. Past the cap new signatures go unthemed rather than unbounded.
        if (unique.length >= SIGNATURE_CAP) continue;
        id = unique.length;
        index.set(signature, id);
        unique.push(parts);
      }
      records.push({ el, id });
    }

    return { records, unique, scanned: count, total: all.length };
  }

  const NAMES = [
    'color',
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'box-shadow',
    'background-image',
    'fill',
    'stroke',
  ];
  const ROLES = ['fg', 'bg', 'border', 'border', 'border', 'border', 'border', 'shadow', 'bg', 'fg', 'fg'];
  /**
   * Only the two properties that decide readability are forced.
   *
   * Leaving borders, outlines and shadows at normal weight means a page's own
   * :hover and :focus rules still win on those, so interaction states survive.
   * This tier only runs on pages the earlier rungs could not handle, which in
   * practice are the plainer ones.
   */
  const FORCED = new Set(['color', 'background-color']);

  function buildComputeCss(unique, tuning) {
    const rules = [];
    for (let id = 0; id < unique.length; id++) {
      const parts = unique[id];
      if (!parts) continue;
      const declarations = [];

      // Background first: the text colour is corrected against it below.
      const bgRaw = parts[1];
      const bgParsed = bgRaw ? color.parse(bgRaw) : null;
      const bgMapped = bgParsed && bgParsed.a >= 0.05 ? theme.map(bgParsed.rgb, 'bg', tuning) : null;

      for (let p = 0; p < NAMES.length; p++) {
        const raw = parts[p];
        if (!raw || raw === 'none') continue;
        const name = NAMES[p];
        const role = ROLES[p];
        let value;

        if (name === 'box-shadow' || name === 'background-image') {
          if (name === 'background-image' && !/gradient\(/i.test(raw)) continue;
          value = remapCompound(raw, role, tuning);
          if (value === raw) continue;
        } else {
          const parsed = color.parse(raw);
          if (!parsed || parsed.a < 0.02) continue;
          let mapped = theme.map(parsed.rgb, role, tuning);
          if (name === 'color' && bgMapped) {
            mapped = theme.ensureContrast(mapped, bgMapped, tuning);
          }
          value = color.format(mapped, parsed.a);
        }
        declarations.push(`${name}:${value}${FORCED.has(name) ? ' !important' : ''}`);
      }

      if (declarations.length) {
        rules.push(`[data-nx="${id}"]{${declarations.join(';')}}`);
      }
    }
    return rules.join('\n');
  }

  /** Write phase. Attributes only, in one pass, no reads interleaved. */
  function writePhase(records) {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const value = String(record.id);
      if (record.el.getAttribute('data-nx') !== value) {
        record.el.setAttribute('data-nx', value);
      }
    }
  }

  function tryCompute(ctx, limit = 20000) {
    const { records, unique: all, scanned, total } = readPhase(limit);
    if (!records.length) return null;
    const css = buildComputeCss(all, ctx);
    NX.sheet.set(SHEET_COMPUTE, css);
    writePhase(records);
    const result = NX.probe.measure(ctx);
    return { result, scanned, total, signatures: all.length, elements: records.length };
  }

  /**
   * Theme just the elements a mutation brought in.
   *
   * The whole-page sweep is only correct for the first pass. Re-running it on
   * every mutation batch is what makes extensions in this category melt single
   * page applications: the cost becomes O(page) per change instead of
   * O(change).
   *
   * This works because the signature index is stable. New colours append to
   * it, so rebuilding the stylesheet from the full list is still correct while
   * the read and the tagging touch only the elements that actually changed.
   * Rebuilding the sheet was measured at about a millisecond, so there is
   * nothing to gain from appending rules instead.
   */
  function computeOn(elements, ctx) {
    const live = elements.filter((el) => el && el.isConnected && el.nodeType === 1);
    if (!live.length) return null;
    const before = unique.length;
    const { records } = readPhase(live.length, live);
    if (!records.length) return null;
    if (unique.length !== before) NX.sheet.set(SHEET_COMPUTE, buildComputeCss(unique, ctx));
    writePhase(records);
    return { elements: records.length, newSignatures: unique.length - before };
  }

  function clearCompute() {
    NX.sheet.remove(SHEET_COMPUTE);
    for (const el of document.querySelectorAll('[data-nx]')) el.removeAttribute('data-nx');
    // Tags and index go together: keeping one without the other is what makes
    // an id mean two different colours.
    index = new Map();
    unique = [];
  }

  // ---------------------------------------------------------------------
  // Tier 4: filter inversion
  // ---------------------------------------------------------------------

  /**
   * The blunt instrument. Cheap, works on canvas and cross-origin iframes, and
   * looks worse than every tier above it. Media is counter-inverted so photos
   * are not destroyed.
   */
  function applyFilter(ctx) {
    const brightness = (ctx.brightness || 100) / 100;
    const contrast = (ctx.contrast || 100) / 100;
    const invert = `invert(1) hue-rotate(180deg) brightness(${brightness.toFixed(2)}) contrast(${contrast.toFixed(2)})`;
    const counter = 'invert(1) hue-rotate(180deg)';
    const css = `
html{filter:${invert} !important;background:#fff !important;}
img,picture,video,canvas,iframe,embed,object,svg image,
[style*="background-image"]{filter:${counter} !important;}
img[src*=".svg"],svg{filter:none !important;}
`.trim();
    NX.sheet.set(SHEET_FILTER, css);
    return { result: NX.probe.measure(ctx) };
  }

  function clearFilter() {
    NX.sheet.remove(SHEET_FILTER);
  }

  NX.tiers = {
    SHEET_MEDIA,
    SHEET_VARS,
    SHEET_COMPUTE,
    SHEET_FILTER,
    tryNativeClass,
    tryNativeMedia,
    tryTokens,
    tryCompute,
    computeOn,
    clearCompute,
    applyFilter,
    clearFilter,
    // exported for tests
    stripColorScheme,
    splitQueryList,
    promoteDarkMedia,
    roleForToken,
    remapCompound,
    buildComputeCss,
    harvestSelectors,
  };
})(typeof self !== 'undefined' ? self : globalThis);
