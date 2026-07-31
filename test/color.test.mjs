/**
 * Colour parsing and conversion.
 *
 * The modern-syntax cases are the point of this file. `tools/probe-colors.mjs`
 * proved that getComputedStyle hands back oklch(), oklab(), lab(), lch() and
 * color() verbatim, so anything that only understands rgb() is broken on the
 * modern web and these tests are what stop that regressing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { bytes, loadLibs } from './helpers.mjs';

const NX = loadLibs(['color']);
const { color } = NX;

test('hex in every length', () => {
  assert.deepEqual(bytes(color.parse('#fff').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('#000').rgb), [0, 0, 0]);
  assert.deepEqual(bytes(color.parse('#abcdef').rgb), [171, 205, 239]);
  assert.equal(color.parse('#ff000080').a, 128 / 255);
  assert.equal(color.parse('#f008').a, 136 / 255);
  assert.equal(color.parse('#zzz'), null);
});

test('named colours', () => {
  assert.deepEqual(bytes(color.parse('rebeccapurple').rgb), [102, 51, 153]);
  assert.deepEqual(bytes(color.parse('WHITE').rgb), [255, 255, 255]);
  assert.equal(color.parse('transparent').a, 0);
  assert.equal(color.parse('notacolour'), null);
});

test('keywords that are not colours return null so callers leave them alone', () => {
  for (const keyword of ['currentColor', 'inherit', 'initial', 'unset', 'none', 'auto']) {
    assert.equal(color.parse(keyword), null, keyword);
  }
});

test('rgb and hsl in legacy and modern syntax', () => {
  assert.deepEqual(bytes(color.parse('rgb(1, 2, 3)').rgb), [1, 2, 3]);
  assert.deepEqual(bytes(color.parse('rgb(1 2 3)').rgb), [1, 2, 3]);
  assert.equal(color.parse('rgba(1,2,3,0.5)').a, 0.5);
  assert.equal(color.parse('rgb(1 2 3 / 50%)').a, 0.5);
  assert.deepEqual(bytes(color.parse('rgb(100%, 0%, 0%)').rgb), [255, 0, 0]);
  assert.deepEqual(bytes(color.parse('hsl(0 100% 50%)').rgb), [255, 0, 0]);
  assert.deepEqual(bytes(color.parse('hsl(120, 100%, 50%)').rgb), [0, 255, 0]);
  assert.deepEqual(bytes(color.parse('hwb(0 0% 0%)').rgb), [255, 0, 0]);
  assert.deepEqual(bytes(color.parse('hwb(0 100% 0%)').rgb), [255, 255, 255]);
});

test('hue units', () => {
  const red = bytes(color.parse('hsl(0 100% 50%)').rgb);
  assert.deepEqual(bytes(color.parse('hsl(0deg 100% 50%)').rgb), red);
  assert.deepEqual(bytes(color.parse('hsl(0turn 100% 50%)').rgb), red);
  assert.deepEqual(bytes(color.parse('hsl(1turn 100% 50%)').rgb), red);
  // A gradian turn is 400 units, not 360.
  assert.deepEqual(bytes(color.parse('hsl(400grad 100% 50%)').rgb), red);
  assert.deepEqual(bytes(color.parse('hsl(0rad 100% 50%)').rgb), red);
});

test('oklch and oklab round-trip through sRGB', () => {
  // White and black are the anchors: if these drift, every ramp is wrong.
  assert.deepEqual(bytes(color.parse('oklch(1 0 0)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('oklch(0 0 0)').rgb), [0, 0, 0]);

  const red = color.parse('oklch(0.62796 0.25768 29.234)');
  const px = bytes(red.rgb);
  assert.ok(px[0] > 250 && px[1] < 12 && px[2] < 12, `expected sRGB red, got ${px}`);

  const lab = color.parse('oklab(0.62796 0.22486 0.12585)');
  assert.deepEqual(bytes(lab.rgb), px);
});

test('CIE lab and lch resolve against D50 as CSS requires', () => {
  // lab(100 0 0) is the D50 white point and must land on sRGB white.
  assert.deepEqual(bytes(color.parse('lab(100 0 0)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('lab(0 0 0)').rgb), [0, 0, 0]);
  assert.deepEqual(bytes(color.parse('lch(100 0 0)').rgb), [255, 255, 255]);
});

test('color() in every space the spec defines', () => {
  assert.deepEqual(bytes(color.parse('color(srgb 1 1 1)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('color(srgb 0 0 0)').rgb), [0, 0, 0]);
  assert.deepEqual(bytes(color.parse('color(srgb-linear 1 1 1)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('color(display-p3 1 1 1)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('color(a98-rgb 1 1 1)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('color(rec2020 1 1 1)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('color(prophoto-rgb 1 1 1)').rgb), [255, 255, 255]);
  assert.deepEqual(bytes(color.parse('color(xyz-d65 0 0 0)').rgb), [0, 0, 0]);

  // display-p3 red is outside sRGB, so it must clip high rather than wrap.
  const p3red = bytes(color.parse('color(display-p3 1 0 0)').rgb);
  assert.equal(p3red[0], 255);
  assert.ok(p3red[1] < 40 && p3red[2] < 40, `p3 red should stay red, got ${p3red}`);

  assert.equal(color.parse('color(not-a-space 1 1 1)'), null);
});

test('a fourth component is alpha only in the legacy comma forms', () => {
  // color() puts the space name in the first slot, so its fourth argument is
  // the third CHANNEL. Reading that as alpha made every opaque color(srgb r g b)
  // parse as transparent, and transparent values are skipped everywhere.
  assert.equal(color.parse('color(srgb 1 0 0)').a, 1);
  assert.equal(color.parse('color(display-p3 0.15 0.15 0.2)').a, 1);
  assert.equal(color.parse('color(srgb 0.1 0.2 0.3)').a, 1);
  // Modern space functions take alpha after a slash and nowhere else.
  assert.equal(color.parse('oklch(0.5 0.1 200)').a, 1);
  assert.equal(color.parse('oklab(0.7 0.1 0.05)').a, 1);
  assert.equal(color.parse('lab(50 20 -30)').a, 1);
  assert.equal(color.parse('lch(50 30 200)').a, 1);
  // The legacy forms genuinely do take it positionally.
  assert.equal(color.parse('rgba(1, 2, 3, 0.5)').a, 0.5);
  assert.equal(color.parse('hsla(0, 100%, 50%, 0.25)').a, 0.25);
});

test('alpha via slash survives nested functions', () => {
  const parsed = color.parse('color(display-p3 0.5 0.2 0.9 / 0.25)');
  assert.equal(parsed.a, 0.25);
  assert.equal(color.parse('oklch(0.5 0.1 200 / 40%)').a, 0.4);
});

test('splitArgs is depth aware', () => {
  const { splitArgs } = color._internal;
  // Separators inside a nested function are NOT split on, so the nested value
  // comes back byte for byte including its internal spacing.
  assert.deepEqual(Array.from(splitArgs('in oklab, rgb(1, 2, 3), blue')), [
    'in',
    'oklab',
    'rgb(1, 2, 3)',
    'blue',
  ]);
});

test('OKLCh round-trips through sRGB without drift', () => {
  const samples = ['#ffffff', '#000000', '#ff0000', '#336699', '#f5f5f5', '#1a1a2e'];
  for (const hex of samples) {
    const { rgb } = color.parse(hex);
    const back = color.fromOklch(color.toOklch(rgb));
    assert.deepEqual(bytes(back), bytes(rgb), hex);
  }
});

test('hue is zeroed at zero chroma so restoring chroma does not drift', () => {
  const grey = color.toOklch(color.parse('#808080').rgb);
  assert.ok(grey[1] < 0.005, 'grey should have near-zero chroma');
  assert.equal(grey[2], 0);
});

test('gamut mapping reduces chroma instead of clipping channels', () => {
  // A wildly out-of-gamut chroma at mid lightness. Clipping would shift the
  // hue; chroma reduction must not.
  const wanted = [0.5, 0.4, 145];
  const mapped = color.fromOklch(wanted);
  assert.ok(color.inGamut(mapped), 'result must be inside sRGB');
  const actual = color.toOklch(mapped);
  assert.ok(Math.abs(actual[2] - wanted[2]) < 2, `hue drifted to ${actual[2]}`);
  assert.ok(actual[1] < wanted[1], 'chroma should have been reduced');
});

test('contrast matches known WCAG pairs', () => {
  const white = color.parse('#ffffff').rgb;
  const black = color.parse('#000000').rgb;
  assert.ok(Math.abs(color.contrast(white, black) - 21) < 0.01);
  assert.ok(Math.abs(color.contrast(white, white) - 1) < 0.001);
  // #767676 on white is the canonical 4.5:1 boundary case.
  const grey = color.parse('#767676').rgb;
  assert.ok(Math.abs(color.contrast(grey, white) - 4.54) < 0.1);
});

test('format emits values a browser accepts', () => {
  assert.equal(color.format([1, 0, 0]), 'rgb(255, 0, 0)');
  assert.equal(color.format([1, 0, 0], 0.5), 'rgba(255, 0, 0, 0.5)');
  assert.equal(color.format([1, 0, 0], 1), 'rgb(255, 0, 0)');
  // Out of range input must be clamped, not emitted as rgb(300, ...).
  assert.equal(color.format([1.4, -0.2, 0]), 'rgb(255, 0, 0)');
});
