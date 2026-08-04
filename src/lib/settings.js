/**
 * Settings schema, defaults, and per-site resolution.
 *
 * Everything the engine reads passes through `resolve`, so a site override and
 * a global preference are never handled by two different code paths.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});

  const MODES = ['auto', 'native', 'dynamic', 'filter', 'off'];

  /**
   * What a surface puts in a patch to clear a per-site override.
   *
   * Explicitly not `undefined`. Extension messaging serialises, and JSON drops
   * a key whose value is undefined entirely, so "clear this override" arrived
   * at the worker as "change nothing at all": a site switched off in the popup
   * could never be switched back on from the popup. `null` survives the trip
   * and `setSite` already treats both the same way.
   */
  const CLEAR = null;

  const DEFAULTS = {
    version: 1,
    enabled: true,
    /**
     * `auto` runs the escalation ladder. The others pin a rung, which is what
     * the per-site menu writes when a user says "this page looks wrong".
     */
    mode: 'auto',
    palette: 'nocturne',
    brightness: 100,
    contrast: 100,
    saturation: 100,
    minContrast: 4.5,
    /** Upgrades the override sheet to USER origin. Needs the optional grant. */
    stubborn: false,
    /** Dim bright images rather than leaving them glaring. Never inverts. */
    dimImages: 0,
    /** Follow the system dark preference instead of being always on. */
    schedule: { kind: 'always', from: '20:00', to: '07:00' },
    /** Origins the user has turned off, or pinned to a rung. */
    sites: {},
    /** Origins where the ladder settled, so a repeat visit skips straight there. */
    learned: {},
  };

  const SITE_KEYS = [
    'enabled',
    'mode',
    'palette',
    'brightness',
    'contrast',
    'saturation',
    'minContrast',
    'dimImages',
  ];

  const clampNum = (v, lo, hi, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };

  /** Reject anything malformed rather than letting it reach the engine. */
  function sanitise(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const out = { ...DEFAULTS };

    out.enabled = raw.enabled !== false;
    out.mode = MODES.includes(raw.mode) ? raw.mode : DEFAULTS.mode;

    /*
     * The membership test has to run on a string, and the value stored has to
     * be that same string.
     *
     * `PALETTES[raw.palette]` coerces its key, so an object with a toString of
     * "nocturne" passes the check, and then the ORIGINAL object gets written
     * to storage. Everything downstream keeps working by coercion until
     * something serialises it. Sanitising means emitting primitives, not
     * waving through whatever happened to coerce.
     */
    const palettes = (NX.theme && NX.theme.PALETTES) || null;
    const wanted = typeof raw.palette === 'string' ? raw.palette : '';
    out.palette =
      palettes && Object.prototype.hasOwnProperty.call(palettes, wanted)
        ? wanted
        : DEFAULTS.palette;
    out.brightness = clampNum(raw.brightness, 50, 150, DEFAULTS.brightness);
    out.contrast = clampNum(raw.contrast, 50, 150, DEFAULTS.contrast);
    out.saturation = clampNum(raw.saturation, 0, 200, DEFAULTS.saturation);
    out.minContrast = clampNum(raw.minContrast, 1, 21, DEFAULTS.minContrast);
    out.dimImages = clampNum(raw.dimImages, 0, 60, DEFAULTS.dimImages);
    out.stubborn = raw.stubborn === true;

    const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
    // Same rule as the palette above: test a string, store that string.
    // RegExp.test coerces too, so a non-string would otherwise pass through.
    const time = (value, fallback) =>
      typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : fallback;
    out.schedule = {
      kind: ['always', 'system', 'clock'].includes(schedule.kind) ? schedule.kind : 'always',
      from: time(schedule.from, DEFAULTS.schedule.from),
      to: time(schedule.to, DEFAULTS.schedule.to),
    };

    out.sites = {};
    if (raw.sites && typeof raw.sites === 'object') {
      for (const [origin, value] of Object.entries(raw.sites)) {
        if (!value || typeof value !== 'object') continue;
        const site = {};
        for (const key of SITE_KEYS) {
          if (value[key] === undefined) continue;
          const probe = sanitise({ ...DEFAULTS, [key]: value[key] });
          site[key] = probe[key];
        }
        if (Object.keys(site).length) out.sites[origin] = site;
      }
    }

    out.learned = {};
    if (raw.learned && typeof raw.learned === 'object') {
      for (const [origin, value] of Object.entries(raw.learned)) {
        if (!value || typeof value !== 'object') continue;
        const tier = Number(value.tier);
        if (!Number.isInteger(tier) || tier < 0 || tier > 4) continue;
        out.learned[origin] = { tier, at: Number(value.at) || 0 };
      }
    }

    return out;
  }

  /** Minutes since midnight, for the clock schedule. */
  const minutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };

  /**
   * Is the theme active right now?
   * `systemDark` is supplied by the caller because the service worker and the
   * content script learn it in different ways.
   */
  function activeNow(settings, { systemDark = false, now = null } = {}) {
    if (!settings.enabled) return false;
    const schedule = settings.schedule || DEFAULTS.schedule;
    if (schedule.kind === 'always') return true;
    if (schedule.kind === 'system') return !!systemDark;

    const date = now || new Date();
    const current = date.getHours() * 60 + date.getMinutes();
    const from = minutes(schedule.from);
    const to = minutes(schedule.to);
    // A window that wraps midnight is the normal case for this feature.
    return from <= to ? current >= from && current < to : current >= from || current < to;
  }

  /**
   * Normalise a URL to the key used for per-site settings.
   * Returns null for pages an extension has no business touching.
   */
  function originOf(url) {
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
      return null;
    }
    if (parsed.protocol === 'file:') return 'file://';
    return parsed.hostname;
  }

  /** Fold the global settings and any site override into one flat object. */
  function resolve(settings, origin, context = {}) {
    const base = sanitise(settings);
    const site = (origin && base.sites[origin]) || {};
    const merged = { ...base, ...site };
    merged.active = activeNow(merged, context) && merged.mode !== 'off';
    merged.origin = origin || null;
    merged.learnedTier =
      origin && base.learned[origin] ? base.learned[origin].tier : null;
    return merged;
  }

  NX.settings = {
    DEFAULTS,
    MODES,
    CLEAR,
    SITE_KEYS,
    sanitise,
    resolve,
    activeNow,
    originOf,
  };
})(typeof self !== 'undefined' ? self : globalThis);
