/**
 * The colour transform.
 *
 * Every mapping moves lightness in OKLCh and leaves hue alone, so a brand blue
 * stays that blue and a yellow warning stays yellow. The classic failure in
 * this category is doing the same job in HSL, where equal lightness steps are
 * not equally light, and saturated hues come out muddy or neon.
 *
 * Backgrounds and foregrounds are mapped through inverted ramps rather than
 * flipped outright, which preserves the *relationships* on the page: a card
 * that was slightly lighter than the body stays slightly lighter than the body,
 * so depth cues survive.
 *
 * Whatever the ramps produce, the text/background pair is then forced to clear
 * a contrast floor. Contrast is checked, not hoped for.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});
  const color = NX.color;
  const clamp = color.clamp;

  /**
   * A palette is expressed as lightness ranges in OKLCh, plus a hue the
   * near-neutrals drift towards. Pure black on pure white is deliberately not
   * an option: it is an accessibility problem, not a target.
   */
  const PALETTES = {
    nocturne: {
      // A white page lands on #0f1318 and surfaces step up from there. Chosen
      // by measuring: a lower floor reads as near-black, which is harsh for
      // long reading and leaves no room below it for a recessed surface.
      label: 'Nocturne',
      bg: [0.185, 0.34],
      fg: [0.66, 0.93],
      hue: 250,
      tint: 0.012,
      chroma: 0.9,
    },
    carbon: {
      label: 'Carbon',
      bg: [0.16, 0.35],
      fg: [0.65, 0.93],
      hue: 0,
      tint: 0,
      chroma: 0.88,
    },
    midnight: {
      label: 'Midnight',
      bg: [0.115, 0.3],
      fg: [0.68, 0.95],
      hue: 255,
      tint: 0.018,
      chroma: 0.85,
    },
    warm: {
      label: 'Warm',
      bg: [0.17, 0.35],
      fg: [0.68, 0.92],
      hue: 65,
      tint: 0.016,
      chroma: 0.95,
    },
    contrast: {
      label: 'High contrast',
      bg: [0.09, 0.28],
      fg: [0.78, 1.0],
      hue: 0,
      tint: 0,
      chroma: 1,
    },
  };

  const DEFAULT_TUNING = {
    palette: 'nocturne',
    brightness: 100, // 50..150, scales output lightness
    contrast: 100, // 50..150, expands or compresses around mid
    saturation: 100, // 0..200, scales chroma
    minContrast: 4.5, // WCAG AA for body text
  };

  function resolvePalette(tuning) {
    const base = PALETTES[tuning && tuning.palette] || PALETTES.nocturne;
    return base;
  }

  /**
   * Surface separation curve.
   *
   * The background ramp squeezes the whole 0..1 range into a band about 0.185
   * wide, so a card sitting just above its page (white against #eee, a gap of
   * 0.05 in lightness) comes out 0.009 apart and reads as flat. Perception
   * makes it worse: equal lightness steps are harder to tell apart at the dark
   * end than the light end, so a faithful mapping under-delivers depth exactly
   * where pages need it.
   *
   * Raising the inverted lightness to a power below one spends most of the
   * output band on the light end of the input, where nearly every page surface
   * actually lives. The white-to-#eee gap becomes 0.036, about four times the
   * separation, while the endpoints stay exactly where they were.
   */
  const SURFACE_CURVE = 0.55;
  const separate = (t) => Math.pow(clamp(t, 0, 1), SURFACE_CURVE);

  /** brightness and contrast act on a 0..1 lightness, around the ramp midpoint. */
  function tune(l, tuning) {
    const brightness = (tuning.brightness == null ? 100 : tuning.brightness) / 100;
    const contrast = (tuning.contrast == null ? 100 : tuning.contrast) / 100;
    let out = l * brightness;
    out = (out - 0.5) * contrast + 0.5;
    return clamp(out, 0, 1);
  }

  /**
   * Neutral greys look like dead television static on a dark page, so they are
   * pulled a little towards the palette hue. Colours that already have chroma
   * are left where the designer put them.
   */
  function tint(lch, palette, tuning) {
    const saturation = (tuning.saturation == null ? 100 : tuning.saturation) / 100;
    let c = lch[1] * palette.chroma * saturation;
    let h = lch[2];
    if (lch[1] < 0.02) {
      c = Math.max(c, palette.tint * saturation);
      h = palette.hue;
    }
    return [lch[0], c, h];
  }

  /**
   * Backgrounds: inverted ramp into the dark band.
   * White lands on the floor, black lands on the ceiling, and everything keeps
   * its ordering, which is what preserves elevation cues.
   */
  function mapBackground(rgb, tuning) {
    const palette = resolvePalette(tuning);
    const lch = color.toOklch(rgb);
    const [floor, ceil] = palette.bg;
    let l = floor + (ceil - floor) * separate(1 - lch[0]);
    l = tune(l, tuning);
    return color.fromOklch(tint([l, lch[1], lch[2]], palette, tuning));
  }

  /** Foregrounds: inverted ramp into the light band. */
  function mapForeground(rgb, tuning) {
    const palette = resolvePalette(tuning);
    const lch = color.toOklch(rgb);
    const [floor, ceil] = palette.fg;
    let l = ceil - (ceil - floor) * lch[0];
    l = tune(l, tuning);
    return color.fromOklch(tint([l, lch[1], lch[2]], palette, tuning));
  }

  /**
   * Borders sit between the two bands. Mapping them as backgrounds makes them
   * vanish into the surface; mapping them as text makes every table look like
   * a wireframe.
   */
  function mapBorder(rgb, tuning) {
    const palette = resolvePalette(tuning);
    const lch = color.toOklch(rgb);
    const floor = palette.bg[1];
    const ceil = (palette.bg[1] + palette.fg[0]) / 2;
    let l = floor + (ceil - floor) * separate(1 - lch[0]);
    l = tune(l, tuning);
    return color.fromOklch(tint([l, lch[1], lch[2]], palette, tuning));
  }

  /**
   * Shadows on a dark page have to get darker, not lighter. Inverting them is
   * how pages end up with white halos around every card.
   */
  function mapShadow(rgb, tuning) {
    const palette = resolvePalette(tuning);
    const lch = color.toOklch(rgb);
    const l = clamp(lch[0] * 0.35, 0, palette.bg[0]);
    return color.fromOklch([l, lch[1] * 0.5, lch[2]]);
  }

  /**
   * Push a foreground away from its background until the pair clears the
   * contrast floor. Direction is chosen by which way has more headroom, so
   * dark-on-light stays dark-on-light where that is what the page meant.
   */
  function ensureContrast(fg, bg, tuning) {
    const min = (tuning && tuning.minContrast) || DEFAULT_TUNING.minContrast;
    if (color.contrast(fg, bg) >= min) return fg;

    const fgLch = color.toOklch(fg);
    const bgL = color.toOklch(bg)[0];
    const up = 1 - fgLch[0];
    const down = fgLch[0];
    const dir = up >= down ? 1 : -1;

    let best = fg;
    let bestRatio = color.contrast(fg, bg);
    // 20 steps of 5% lightness covers the whole range; stop at the first pass.
    for (let i = 1; i <= 20; i++) {
      const l = clamp(fgLch[0] + dir * i * 0.05, 0, 1);
      const candidate = color.fromOklch([l, fgLch[1], fgLch[2]]);
      const ratio = color.contrast(candidate, bg);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = candidate;
      }
      if (ratio >= min) return candidate;
      if (l === 0 || l === 1) break;
    }

    // If moving one way never got there, the background is mid-grey. Take
    // whichever pole is further away rather than leaving unreadable text.
    if (bestRatio < min) {
      const poles = [
        color.fromOklch([0.98, fgLch[1] * 0.3, fgLch[2]]),
        color.fromOklch([0.06, fgLch[1] * 0.3, fgLch[2]]),
      ];
      for (const pole of poles) {
        const ratio = color.contrast(pole, bg);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = pole;
        }
      }
    }
    return best;
  }

  /**
   * Accents are the one role that must not be inverted.
   *
   * A brand colour gets used as a button background and as link text on the
   * same page, so flipping it either way is wrong half the time. Instead it is
   * pulled into a mid band where it works as both, keeping its hue outright.
   */
  function mapAccent(rgb, tuning) {
    const palette = resolvePalette(tuning);
    const lch = color.toOklch(rgb);
    const floor = 0.54;
    const ceil = 0.74;
    const l = tune(clamp(lch[0], floor, ceil), tuning);
    return color.fromOklch(tint([l, lch[1], lch[2]], palette, tuning));
  }

  /** Is this colour already dark enough that re-theming would be a downgrade? */
  function isDark(rgb) {
    return color.toOklch(rgb)[0] < 0.42;
  }

  /**
   * Role dispatch. `role` mirrors the CSS property group the value came from,
   * because the same rgb triple means different things as a background and as
   * text.
   */
  function map(rgb, role, tuning) {
    switch (role) {
      case 'fg':
        return mapForeground(rgb, tuning);
      case 'border':
        return mapBorder(rgb, tuning);
      case 'shadow':
        return mapShadow(rgb, tuning);
      case 'accent':
        return mapAccent(rgb, tuning);
      case 'bg':
      default:
        return mapBackground(rgb, tuning);
    }
  }

  NX.theme = {
    PALETTES,
    DEFAULT_TUNING,
    map,
    mapBackground,
    mapForeground,
    mapBorder,
    mapShadow,
    mapAccent,
    ensureContrast,
    isDark,
    resolvePalette,
  };
})(typeof self !== 'undefined' ? self : globalThis);
