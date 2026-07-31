/**
 * Settings.
 *
 * Everything the engine reads goes through sanitise and resolve, so this is
 * also the boundary that stops corrupt or hostile stored data reaching the
 * colour maths.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helpers.mjs';

const NX = loadLibs(['color', 'theme', 'settings'], { URL, Date, Number, Boolean });
const { settings } = NX;

test('defaults are produced from nothing at all', () => {
  for (const input of [null, undefined, 'nonsense', 42, []]) {
    const out = settings.sanitise(input);
    assert.equal(out.enabled, true);
    assert.equal(out.mode, 'auto');
    assert.equal(out.palette, 'nocturne');
  }
});

test('out-of-range numbers are clamped, not accepted', () => {
  const out = settings.sanitise({
    brightness: 9000,
    contrast: -50,
    saturation: 'banana',
    minContrast: 100,
    dimImages: 999,
  });
  assert.equal(out.brightness, 150);
  assert.equal(out.contrast, 50);
  assert.equal(out.saturation, 100); // non-numeric falls back to the default
  assert.equal(out.minContrast, 21);
  assert.equal(out.dimImages, 60);
});

test('an unknown palette or mode is replaced with the default', () => {
  assert.equal(settings.sanitise({ palette: 'chartreuse' }).palette, 'nocturne');
  assert.equal(settings.sanitise({ mode: 'telepathy' }).mode, 'auto');
  // A real one survives.
  assert.equal(settings.sanitise({ palette: 'midnight' }).palette, 'midnight');
  assert.equal(settings.sanitise({ mode: 'filter' }).mode, 'filter');
});

test('a malformed schedule is repaired', () => {
  const out = settings.sanitise({ schedule: { kind: 'whenever', from: '99', to: null } });
  assert.equal(out.schedule.kind, 'always');
  assert.equal(out.schedule.from, '20:00');
  assert.equal(out.schedule.to, '07:00');
});

test('site overrides are sanitised individually and junk is dropped', () => {
  const out = settings.sanitise({
    sites: {
      'good.com': { enabled: false, brightness: 120 },
      'bad.com': { brightness: 9999, palette: 'nope' },
      'empty.com': {},
      'junk.com': 'not an object',
    },
  });
  // Spread into this realm: vm-built objects fail deepStrictEqual on prototype.
  assert.deepEqual({ ...out.sites['good.com'] }, { enabled: false, brightness: 120 });
  assert.equal(out.sites['bad.com'].brightness, 150);
  assert.equal(out.sites['bad.com'].palette, 'nocturne');
  assert.ok(!('empty.com' in out.sites));
  assert.ok(!('junk.com' in out.sites));
});

test('learned tiers outside the ladder are discarded', () => {
  const out = settings.sanitise({
    learned: {
      'a.com': { tier: 3, at: 1 },
      'b.com': { tier: 99, at: 1 },
      'c.com': { tier: -1, at: 1 },
      'd.com': { tier: 'two', at: 1 },
    },
  });
  assert.equal(out.learned['a.com'].tier, 3);
  for (const host of ['b.com', 'c.com', 'd.com']) {
    assert.ok(!(host in out.learned), host);
  }
});

// --- origins ---------------------------------------------------------------

test('origins are hostnames, and pages we must not touch return null', () => {
  assert.equal(settings.originOf('https://example.com/a/b?c=d'), 'example.com');
  assert.equal(settings.originOf('http://sub.example.co.uk/'), 'sub.example.co.uk');
  assert.equal(settings.originOf('file:///C:/x.html'), 'file://');
  for (const url of [
    'chrome://extensions',
    'about:blank',
    'moz-extension://abc/page.html',
    'chrome-extension://abc/page.html',
    'data:text/html,hi',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
  ]) {
    assert.equal(settings.originOf(url), null, String(url));
  }
});

// --- scheduling ------------------------------------------------------------

const at = (h, m = 0) => new Date(2026, 0, 15, h, m);

test('the always schedule is always on', () => {
  const s = settings.sanitise({ schedule: { kind: 'always' } });
  assert.equal(settings.activeNow(s, { now: at(3) }), true);
  assert.equal(settings.activeNow(s, { now: at(15) }), true);
});

test('the system schedule follows the system preference', () => {
  const s = settings.sanitise({ schedule: { kind: 'system' } });
  assert.equal(settings.activeNow(s, { systemDark: true }), true);
  assert.equal(settings.activeNow(s, { systemDark: false }), false);
});

test('a clock window that wraps midnight behaves', () => {
  // The normal case for this feature, and the one a naive from <= now < to
  // comparison gets wrong.
  const s = settings.sanitise({ schedule: { kind: 'clock', from: '20:00', to: '07:00' } });
  assert.equal(settings.activeNow(s, { now: at(21) }), true);
  assert.equal(settings.activeNow(s, { now: at(2) }), true);
  assert.equal(settings.activeNow(s, { now: at(6, 59) }), true);
  assert.equal(settings.activeNow(s, { now: at(7) }), false);
  assert.equal(settings.activeNow(s, { now: at(12) }), false);
  assert.equal(settings.activeNow(s, { now: at(19, 59) }), false);
});

test('a clock window inside one day behaves', () => {
  const s = settings.sanitise({ schedule: { kind: 'clock', from: '09:00', to: '17:00' } });
  assert.equal(settings.activeNow(s, { now: at(12) }), true);
  assert.equal(settings.activeNow(s, { now: at(8) }), false);
  assert.equal(settings.activeNow(s, { now: at(18) }), false);
});

test('a global off beats any schedule', () => {
  const s = settings.sanitise({ enabled: false, schedule: { kind: 'always' } });
  assert.equal(settings.activeNow(s), false);
});

// --- resolution ------------------------------------------------------------

test('a site override wins over the global value', () => {
  const stored = { brightness: 100, sites: { 'example.com': { brightness: 130 } } };
  assert.equal(settings.resolve(stored, 'example.com').brightness, 130);
  assert.equal(settings.resolve(stored, 'other.com').brightness, 100);
});

test('a site turned off resolves to inactive while the rest stays on', () => {
  const stored = { sites: { 'off.com': { enabled: false } } };
  assert.equal(settings.resolve(stored, 'off.com').active, false);
  assert.equal(settings.resolve(stored, 'on.com').active, true);
});

test('mode off resolves to inactive', () => {
  assert.equal(settings.resolve({ mode: 'off' }, 'x.com').active, false);
  assert.equal(settings.resolve({ sites: { 'x.com': { mode: 'off' } } }, 'x.com').active, false);
});

test('the learned tier is exposed only for the origin it belongs to', () => {
  const stored = { learned: { 'a.com': { tier: 3, at: 1 } } };
  assert.equal(settings.resolve(stored, 'a.com').learnedTier, 3);
  assert.equal(settings.resolve(stored, 'b.com').learnedTier, null);
  assert.equal(settings.resolve(stored, null).learnedTier, null);
});

test('resolve never returns a value the theme code would choke on', () => {
  const hostile = {
    // An object that coerces to a valid palette name. It must not be stored.
    palette: { toString: () => 'nocturne' },
    brightness: Infinity,
    contrast: NaN,
    saturation: -1,
    sites: { 'x.com': { minContrast: 'lots' } },
  };
  const out = settings.resolve(hostile, 'x.com');
  assert.equal(out.palette, 'nocturne');
  assert.ok(Number.isFinite(out.brightness));
  assert.ok(Number.isFinite(out.contrast));
  assert.equal(out.saturation, 0);
  assert.ok(Number.isFinite(out.minContrast));
  assert.equal(typeof out.palette, 'string');
  assert.equal(typeof out.schedule.from, 'string');
});
