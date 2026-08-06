/**
 * The parts of the engine that can be tested without a browser: media-query
 * rewriting, token classification, compound-value remapping, and the CSS the
 * compute tier emits.
 *
 * The browser-dependent half is covered by tools/e2e.mjs against real pages.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helpers.mjs';

const NX = loadLibs(['color', 'theme', 'signals', 'content/tiers'], {
  // tiers.js only touches these when a tier actually runs.
  document: { styleSheets: [] },
  getComputedStyle: () => ({}),
  SVGElement: class {},
});
const { tiers, signals, color } = NX;
const t = { palette: 'nocturne', minContrast: 4.5 };

// --- media query rewriting -------------------------------------------------

test('the colour-scheme clause is removed and the rest is kept', () => {
  assert.equal(tiers.stripColorScheme('(prefers-color-scheme: dark)'), '');
  assert.equal(
    tiers.stripColorScheme('(min-width: 40em) and (prefers-color-scheme: dark)'),
    '(min-width: 40em)'
  );
  assert.equal(
    tiers.stripColorScheme('screen and (prefers-color-scheme: dark)'),
    'screen'
  );
  assert.equal(
    tiers.stripColorScheme('(prefers-color-scheme:dark) and (min-width: 20em)'),
    '(min-width: 20em)'
  );
});

test('the media type survives the rewrite as a media type', () => {
  /*
   * `only screen and (prefers-color-scheme: dark)` is the legacy idiom and it
   * is still everywhere. Joining every surviving token with ' and ' turned it
   * into `only and screen`, which is not a valid query, so the browser
   * rewrote the whole condition to `not all` and the promoted block matched
   * nothing. The site's own dark theme was then measured as having failed and
   * the page fell all the way to the compute sweep.
   */
  assert.equal(
    tiers.stripColorScheme('only screen and (prefers-color-scheme: dark)'),
    'only screen'
  );
  assert.equal(
    tiers.stripColorScheme('only screen and (min-width:40em) and (prefers-color-scheme:dark)'),
    'only screen and (min-width:40em)'
  );
});

test('a negated query is left alone rather than rewritten', () => {
  // `not screen and (prefers-color-scheme: dark)` applies when the page is
  // NOT on a dark screen, so it describes the light theme. Promoting it would
  // apply the light rules unconditionally, and there is no way to rewrite the
  // negation that preserves the author's meaning.
  assert.equal(tiers.stripColorScheme('not screen and (prefers-color-scheme: dark)'), null);
  assert.equal(tiers.stripColorScheme('not all and (prefers-color-scheme: dark)'), null);
});

test('a branch with no dark preference is not promoted', () => {
  assert.equal(tiers.stripColorScheme('(min-width: 40em)'), null);
  assert.equal(tiers.stripColorScheme('print'), null);
  // A light-scheme block must never be promoted; that would invert the intent.
  assert.equal(tiers.stripColorScheme('(prefers-color-scheme: light)'), null);
});

test('query lists split at the top level only', () => {
  assert.deepEqual(Array.from(tiers.splitQueryList('print, screen')), ['print', 'screen']);
  assert.deepEqual(
    Array.from(tiers.splitQueryList('(min-width: 10px), (prefers-color-scheme: dark)')),
    ['(min-width: 10px)', '(prefers-color-scheme: dark)']
  );
  // A comma inside parentheses is not a separator.
  assert.deepEqual(
    Array.from(tiers.splitQueryList('(width >= 10px)')),
    ['(width >= 10px)']
  );
});

// --- token classification --------------------------------------------------

test('token names are classified by what they are for', () => {
  const white = color.parse('#ffffff').rgb;
  const dark = color.parse('#111111').rgb;
  assert.equal(tiers.roleForToken('--color-background', white), 'bg');
  assert.equal(tiers.roleForToken('--surface-1', white), 'bg');
  assert.equal(tiers.roleForToken('--card-bg', white), 'bg');
  assert.equal(tiers.roleForToken('--color-text', dark), 'fg');
  assert.equal(tiers.roleForToken('--fg-muted', dark), 'fg');
  assert.equal(tiers.roleForToken('--border-subtle', white), 'border');
  assert.equal(tiers.roleForToken('--divider', white), 'border');
  assert.equal(tiers.roleForToken('--shadow-color', dark), 'shadow');
  assert.equal(tiers.roleForToken('--color-primary', dark), 'accent');
  assert.equal(tiers.roleForToken('--brand-500', dark), 'accent');
});

test('an unnamed token falls back to lightness', () => {
  // Light values are almost always surfaces; dark values are almost always ink.
  assert.equal(tiers.roleForToken('--x1', color.parse('#fafafa').rgb), 'bg');
  assert.equal(tiers.roleForToken('--x2', color.parse('#222222').rgb), 'fg');
});

// --- compound values -------------------------------------------------------

test('gradient stops are remapped and the geometry is untouched', () => {
  const input = 'linear-gradient(to right, rgb(255, 255, 255), rgb(238, 238, 238) 50%)';
  const output = tiers.remapCompound(input, 'bg', t);
  assert.ok(output.startsWith('linear-gradient(to right, '), output);
  assert.ok(output.includes('50%'), 'stop positions must survive');
  assert.ok(!output.includes('rgb(255, 255, 255)'), 'white should have been mapped');
});

test('modern colour syntax inside a compound value is remapped too', () => {
  const output = tiers.remapCompound('linear-gradient(oklch(1 0 0), lab(96 0 2))', 'bg', t);
  assert.ok(!output.includes('oklch(1 0 0)'), output);
  assert.ok(!output.includes('lab(96 0 2)'), output);
  assert.ok(output.includes('rgb('), output);
});

test('a url() in a background is left completely alone', () => {
  /*
   * The fixture has to contain something the colour pattern would match, or
   * the assertion holds with the url-splitting loop deleted and proves
   * nothing. A fragment identifier made of hex digits is exactly the case
   * that motivated the loop: rewriting "#cafe" breaks the reference and the
   * image disappears.
   */
  const input = 'url("sprite.svg#cafe")';
  assert.match(input, /#[0-9a-f]{3,8}\b/i, 'the fixture must contain a colour-shaped token');
  assert.equal(tiers.remapCompound(input, 'bg', t), input);
});

test('colours around a url() are still remapped', () => {
  const input = 'linear-gradient(#ffffff, #000000), url("sprite.svg#cafe")';
  const output = tiers.remapCompound(input, 'bg', t);
  assert.ok(output.includes('url("sprite.svg#cafe")'), output);
  assert.ok(!output.includes('#ffffff'), output);
  assert.ok(!output.includes('#000000'), output);
});

test('every attribute a signal can set is watched on the root', () => {
  const observe = loadLibs(['signals', 'content/observe']).observe;
  const watched = new Set(observe.rootAttributes());
  for (const signal of signals.SIGNALS) {
    if (signal.attr) {
      assert.ok(
        watched.has(signal.attr[0]),
        `signal ${signal.id} sets ${signal.attr[0]}, which nothing watches for removal`
      );
    }
    for (const [name] of signal.extraAttrs || []) {
      assert.ok(watched.has(name), `signal ${signal.id} sets ${name}, which nothing watches`);
    }
  }
  assert.ok(watched.has('class'), 'class-based signals need watching too');
});

test('box-shadow keeps its offsets and its inset keyword', () => {
  const input = 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px, rgb(221, 221, 221) 0px 0px 0px 1px inset';
  const output = tiers.remapCompound(input, 'shadow', t);
  assert.ok(output.includes('0px 1px 2px 0px'), output);
  assert.ok(output.includes('inset'), output);
  assert.ok(output.includes('0.2'), 'alpha must survive');
});

// --- generated CSS ---------------------------------------------------------

/** Build the parts array the read phase produces, in its property order. */
const parts = (o = {}) => [
  o.color || '',
  o.background || '',
  o.borderTop || '',
  o.borderRight || '',
  o.borderBottom || '',
  o.borderLeft || '',
  o.outline || '',
  o.shadow || '',
  o.image || '',
  o.fill || '',
  o.stroke || '',
];

test('one rule is emitted per distinct signature, keyed by index', () => {
  const css = tiers.buildComputeCss(
    [
      parts({ color: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)' }),
      parts({ color: 'rgb(50, 50, 50)', background: 'rgb(238, 238, 238)' }),
    ],
    t
  );
  assert.ok(css.includes('[data-nx="0"]'), css);
  assert.ok(css.includes('[data-nx="1"]'), css);
  assert.equal(css.split('\n').length, 2);
});

test('only the two properties that decide readability are forced', () => {
  // Leaving borders and shadows at normal weight is what lets a page's own
  // :hover and :focus rules keep working.
  const css = tiers.buildComputeCss(
    [
      parts({
        color: 'rgb(0, 0, 0)',
        background: 'rgb(255, 255, 255)',
        borderTop: 'rgb(200, 200, 200)',
      }),
    ],
    t
  );
  assert.ok(/color:[^;]+ !important/.test(css), css);
  assert.ok(/background-color:[^;]+ !important/.test(css), css);
  assert.ok(/border-top-color:[^;!]+(;|})/.test(css), `border should not be forced: ${css}`);
});

test('transparent backgrounds are left transparent', () => {
  // Forcing an opaque colour onto every transparent element destroys layering.
  const css = tiers.buildComputeCss(
    [parts({ color: 'rgb(0, 0, 0)', background: 'rgba(0, 0, 0, 0)' })],
    t
  );
  assert.ok(!css.includes('background-color'), css);
  assert.ok(css.includes('color:'), css);
});

test('a background image that is not a gradient is skipped', () => {
  const css = tiers.buildComputeCss([parts({ image: 'url("photo.png")' })], t);
  assert.equal(css, '', 'photos must never be recoloured');
});

test('text is contrast-corrected against its own mapped background', () => {
  // A grey-on-grey pair that would stay unreadable if each were mapped alone.
  const css = tiers.buildComputeCss(
    [parts({ color: 'rgb(140, 140, 140)', background: 'rgb(160, 160, 160)' })],
    { ...t, minContrast: 4.5 }
  );
  const fg = css.match(/color:(rgba?\([^)]*\))/)[1];
  const bg = css.match(/background-color:(rgba?\([^)]*\))/)[1];
  const ratio = color.contrast(color.parse(fg).rgb, color.parse(bg).rgb);
  assert.ok(ratio >= 4.5, `pair came out at ${ratio.toFixed(2)}:1`);
});

test('an all-empty signature emits nothing', () => {
  assert.equal(tiers.buildComputeCss([parts()], t), '');
});

test('emitted CSS has no unbalanced braces', () => {
  const css = tiers.buildComputeCss(
    [
      parts({ color: 'rgb(0,0,0)', background: 'rgb(255,255,255)' }),
      parts({ shadow: 'rgba(0, 0, 0, 0.2) 0px 1px 2px', image: 'linear-gradient(rgb(1,2,3), rgb(4,5,6))' }),
    ],
    t
  );
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

// --- site signals ----------------------------------------------------------

test('framework dark-theme conventions are detected from selector text', () => {
  const cases = [
    ['html.dark .card { color: red }', 'class-dark'],
    [':root.dark { --x: 1 }', 'class-dark'],
    ['[data-theme="dark"] body { color: red }', 'data-theme-dark'],
    ["[data-bs-theme='dark'] { color: red }", 'data-bs-theme'],
    ['[data-color-mode=dark] { color: red }', 'data-color-mode'],
    ['[data-md-color-scheme="slate"] { color: red }', 'md-color-scheme-slate'],
    ['.theme-dark .x { color: red }', 'class-theme-dark'],
    ['.chakra-ui-dark { color: red }', 'class-chakra-dark'],
  ];
  for (const [selector, expected] of cases) {
    const found = signals.detect(selector).map((s) => s.id);
    assert.ok(found.includes(expected), `${selector} should match ${expected}, got ${found}`);
  }
});

test('a page with no dark convention matches nothing', () => {
  assert.deepEqual(Array.from(signals.detect('.card { color: red } #main a:hover {}')), []);
  // "darkroom" must not be mistaken for the Tailwind dark class.
  assert.deepEqual(Array.from(signals.detect('.darkroom { color: red }')), []);
  // Nor should a light-theme selector.
  assert.deepEqual(Array.from(signals.detect('[data-theme="light"] {}')), []);
});
