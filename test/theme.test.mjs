/**
 * The colour transform.
 *
 * These tests encode the properties that make the output look right, as
 * opposed to merely dark: ordering survives, hue survives, contrast is
 * enforced, and shadows do not become halos.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helpers.mjs';

const NX = loadLibs(['color', 'theme']);
const { color, theme } = NX;

const parse = (hex) => color.parse(hex).rgb;
const L = (rgb) => color.toOklch(rgb)[0];
const H = (rgb) => color.toOklch(rgb)[2];
const t = { palette: 'nocturne' };

test('a light page becomes dark and a dark page does not become light', () => {
  assert.ok(L(theme.mapBackground(parse('#ffffff'), t)) < 0.25);
  assert.ok(L(theme.mapForeground(parse('#000000'), t)) > 0.85);
});

test('surface ordering survives the mapping', () => {
  // A page, a slightly raised card, and a more raised one. After theming they
  // must still be in that order, or every depth cue on the page is lost.
  const page = L(theme.mapBackground(parse('#ffffff'), t));
  const card = L(theme.mapBackground(parse('#f3f4f6'), t));
  const raised = L(theme.mapBackground(parse('#e5e7eb'), t));
  assert.ok(page < card, `page ${page} should be darker than card ${card}`);
  assert.ok(card < raised, `card ${card} should be darker than raised ${raised}`);
});

test('surfaces stay far enough apart to be seen', () => {
  // The naive linear ramp put white and #eeeeee 0.009 apart, which renders as
  // a flat page. The separation curve is what fixes that.
  const page = theme.mapBackground(parse('#ffffff'), t);
  const card = theme.mapBackground(parse('#eeeeee'), t);
  const gap = L(card) - L(page);
  assert.ok(gap > 0.025, `expected a visible gap, got ${gap.toFixed(4)}`);
});

test('the endpoints of the ramp are not moved by the separation curve', () => {
  const palette = theme.PALETTES.nocturne;
  assert.ok(Math.abs(L(theme.mapBackground(parse('#ffffff'), t)) - palette.bg[0]) < 0.02);
  assert.ok(Math.abs(L(theme.mapBackground(parse('#000000'), t)) - palette.bg[1]) < 0.02);
});

test('hue is preserved, which is the whole reason for working in OKLCh', () => {
  // A yellow warning note must stay yellow. Naive inversion in HSL is what
  // turns these blue or muddy.
  const yellow = parse('#fffbe6');
  const mapped = theme.mapBackground(yellow, t);
  assert.ok(Math.abs(H(mapped) - H(yellow)) < 12, `hue moved from ${H(yellow)} to ${H(mapped)}`);

  const red = parse('#c0392b');
  const mappedRed = theme.mapForeground(red, t);
  assert.ok(Math.abs(H(mappedRed) - H(red)) < 12);
});

test('near-neutral greys pick up the palette hue instead of staying dead', () => {
  const mapped = theme.mapBackground(parse('#808080'), t);
  const lch = color.toOklch(mapped);
  assert.ok(lch[1] > 0.002, 'expected a slight tint');
  assert.ok(Math.abs(lch[2] - theme.PALETTES.nocturne.hue) < 1);
});

test('a neutral palette adds no tint', () => {
  const mapped = theme.mapBackground(parse('#808080'), { palette: 'carbon' });
  assert.ok(color.toOklch(mapped)[1] < 0.002);
});

test('borders land between the surface and the text bands', () => {
  const palette = theme.PALETTES.nocturne;
  const border = L(theme.mapBorder(parse('#e5e7eb'), t));
  assert.ok(border >= palette.bg[1] - 0.01, `border ${border} should sit above the surface band`);
  assert.ok(border < palette.fg[0], `border ${border} should sit below the text band`);
});

test('shadows get darker, never lighter', () => {
  // Inverting a shadow is how pages end up with a white halo around every card.
  const shadow = theme.mapShadow(parse('#000000'), t);
  assert.ok(L(shadow) < 0.12, `shadow lightness ${L(shadow)}`);
  const soft = theme.mapShadow(parse('#888888'), t);
  assert.ok(L(soft) < L(parse('#888888')));
});

test('accents are pulled into a usable band rather than inverted', () => {
  // A brand colour is a button background on one page and link text on the
  // next, so neither ramp is right for it.
  const brand = parse('#2563eb');
  const mapped = theme.mapAccent(brand, t);
  assert.ok(L(mapped) >= 0.5 && L(mapped) <= 0.8, `accent lightness ${L(mapped)}`);
  assert.ok(Math.abs(H(mapped) - H(brand)) < 10, 'accent must keep its hue');

  // Already-light accents are pulled down rather than left glaring.
  const pale = theme.mapAccent(parse('#cfe0ff'), t);
  assert.ok(L(pale) <= 0.78);
});

test('contrast is enforced against the actual background', () => {
  const bg = theme.mapBackground(parse('#ffffff'), t);
  for (const hex of ['#000000', '#333333', '#767676', '#aaaaaa', '#d0d0d0']) {
    const raw = theme.mapForeground(parse(hex), t);
    const fixed = theme.ensureContrast(raw, bg, { ...t, minContrast: 4.5 });
    assert.ok(
      color.contrast(fixed, bg) >= 4.5,
      `${hex} came out at ${color.contrast(fixed, bg).toFixed(2)}:1`
    );
  }
});

test('contrast enforcement copes with a mid-grey background', () => {
  // The hard case: mid grey has no headroom in either direction, so stepping
  // one way is not enough and the fallback poles have to engage.
  const bg = parse('#7a7a7a');
  const fixed = theme.ensureContrast(parse('#808080'), bg, { minContrast: 4.5 });
  assert.ok(color.contrast(fixed, bg) > color.contrast(parse('#808080'), bg));
});

test('contrast enforcement leaves an already-good pair alone', () => {
  const bg = theme.mapBackground(parse('#ffffff'), t);
  const fg = theme.mapForeground(parse('#000000'), t);
  assert.deepEqual(
    Array.from(theme.ensureContrast(fg, bg, t)),
    Array.from(fg)
  );
});

test('brightness and contrast tuning move the result in the right direction', () => {
  const base = L(theme.mapBackground(parse('#ffffff'), t));
  const brighter = L(theme.mapBackground(parse('#ffffff'), { ...t, brightness: 140 }));
  assert.ok(brighter > base);
  const dimmer = L(theme.mapBackground(parse('#ffffff'), { ...t, brightness: 60 }));
  assert.ok(dimmer < base);
});

test('saturation zero removes colour without moving lightness much', () => {
  const normal = theme.mapForeground(parse('#c0392b'), t);
  const grey = theme.mapForeground(parse('#c0392b'), { ...t, saturation: 0 });
  assert.ok(color.toOklch(grey)[1] < 0.01);
  assert.ok(Math.abs(L(grey) - L(normal)) < 0.05);
});

test('every palette produces an in-gamut, genuinely dark surface', () => {
  for (const id of Object.keys(theme.PALETTES)) {
    const bg = theme.mapBackground(parse('#ffffff'), { palette: id });
    assert.ok(color.inGamut(bg), `${id} produced an out-of-gamut colour`);
    assert.ok(L(bg) < 0.3, `${id} surface is not dark`);
    const fg = theme.mapForeground(parse('#000000'), { palette: id });
    assert.ok(
      color.contrast(fg, bg) >= 7,
      `${id} black-on-white came out at ${color.contrast(fg, bg).toFixed(1)}:1`
    );
  }
});

test('isDark recognises pages that need leaving alone', () => {
  assert.ok(theme.isDark(parse('#0d1117')));
  assert.ok(theme.isDark(parse('#1a1a1a')));
  assert.ok(!theme.isDark(parse('#ffffff')));
  assert.ok(!theme.isDark(parse('#f3f4f6')));
});

test('an unknown palette falls back rather than throwing', () => {
  const mapped = theme.mapBackground(parse('#ffffff'), { palette: 'nope' });
  assert.ok(color.inGamut(mapped));
});
