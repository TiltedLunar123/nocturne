# Nocturne: architecture and the facts it rests on

Dark mode for every site, for Chrome and Firefox (both MV3). This file is the design
record. Read it before changing a tier, because most of the decisions here look
arbitrary until you know which alternative was measured and rejected.

## The thesis

Dark Reader treats every page the same way: parse the CSS, rewrite every colour, repeat
forever on mutation. That is the most expensive possible strategy, and it is applied
even to the large and growing share of sites that already ship a perfectly good dark
theme of their own.

Nocturne is an **escalation ladder**. It starts with the cheapest thing that could work,
**measures whether the page actually came out dark and readable**, and only escalates
when the measurement says it has to. On a modern site the ladder stops at tier 1 having
done almost no work, and the result is the site's own dark theme rather than an
approximation of it.

The measurement is the part that makes this honest. Every tier is followed by a probe
that samples real computed colours and returns a score. Escalation is not guesswork.

## Verified platform facts

Everything in this section was measured on this machine, not recalled. Re-run the
probes after any browser update:

```
node tools/probe-platform.mjs
node tools/probe-colors.mjs
```

Measured on Chromium 150 (Edge), 2026-07-31:

| Question | Answer | Consequence |
| --- | --- | --- |
| Cross-origin `sheet.cssRules` | throws `SecurityError` | Never build on stylesheet text. Dark Reader has to re-fetch sheets over the network to work around this, which is most of why it needs broad host access. Nocturne reads *computed* styles, which are always readable, so it needs no network at all. |
| Same-origin `CSSMediaRule.conditionText` | readable, e.g. `(prefers-color-scheme: dark)` | A site's own dark theme can be promoted out of its media block. This is tier 1b. |
| Custom properties on computed style | enumerable (`Array.from(getComputedStyle(el))` lists `--*`) | A whole design system can be re-themed by rewriting ~30 declarations. This is tier 2. |
| `oklch()` / `oklab()` / `lab()` / `lch()` / `color()` in computed style | returned **verbatim, not converted to `rgb()`** | The single most important finding. A parser that expects `rgb(...)` silently fails on every site built with Tailwind v4 or any modern token pipeline. `color-mix()` resolves to `oklab()`. |
| `light-dark(a, b)` in computed style | resolves against the element's **`color-scheme`**, not the media query | Setting `color-scheme: dark` on the root flips every `light-dark()` on the page for free. |
| `color-scheme: dark` on root | form control background went `rgb(255,255,255)` to `rgb(59,59,59)` | Fixes UA widgets, scrollbars and the default canvas. Fixes nothing the author styled. |
| Author `!important` vs inline `!important` | author **loses** | Only USER-origin `!important` wins. Confirmed against the cascade in css-cascade-5. |
| Computed-style sweep, 5000 elements | **29 ms**, collapsing to 258 distinct colour signatures | The compute tier is affordable, and deduplicating by signature turns O(elements) into O(distinct colours). |
| Attribute write, 5000 elements | **3 ms** batched | Tagging elements is nearly free if reads and writes are not interleaved. |
| Same writes with a read after each | **55 ms for 800** elements | Layout thrash is ~20x worse per element. Read phase and write phase must stay separate. This is enforced in code, not by discipline. |
| Injecting 250 rules | ~1 ms either as `insertRule` or one text blob | CSS injection is not a cost centre. |

Two further facts taken from documentation rather than measured here:

- Forcing `@media (prefers-color-scheme: dark)` to evaluate true for arbitrary pages
  requires `chrome.debugger` and its "started debugging this browser" banner. There is
  no clean API. Nocturne never tries; tier 1 gets the same outcome by other means.
- Firefox `browser_specific_settings.gecko.data_collection_permissions` has been
  mandatory for new AMO submissions since 2025-11-03 and needs Firefox 140+, which is
  why `strict_min_version` is 140.

## The ladder

Each rung runs only if the rung before it did not produce a dark, readable page.
The chosen rung is cached per origin, so the second visit skips straight to it.

### Tier 0: shell (always, no JS)

A static `content_scripts` CSS entry at `document_start`. Sets `color-scheme: dark` and
paints the canvas dark before anything else renders.

This is the entire FOUC story, and it is CSS-only on purpose: any JavaScript path,
including `scripting.insertCSS` from the service worker, is strictly later than the
first paint. It also does two useful things for free, because of the facts above: it
flips every `light-dark()` on the page, and it darkens form controls and scrollbars.

### Tier 1a: the site's own dark theme, by class

Most sites that support dark mode in 2026 do it with a class or attribute on the root
element rather than a media query: `html.dark` (Tailwind), `[data-theme="dark"]`,
`[data-bs-theme="dark"]` (Bootstrap 5.3), `.theme-dark`, and so on. Nocturne scans the
same-origin rules for these selectors, confirms the rules behind them actually declare
dark colours, and sets the winning one on the root element.

The result is the site's own dark theme, authored by the site, pixel perfect, for
roughly the cost of one `classList.add`. Dark Reader does not do this systematically,
and it is the highest-leverage single behaviour in the product.

If the page's own theme script removes the class, an observer re-applies it, with a
hard re-apply cap so a site that genuinely fights back degrades into escalation
instead of into an infinite loop.

Nothing is written to the site's `localStorage`. That would persist after uninstall
and is not ours to change.

### Tier 1b: the site's own dark theme, by media query

For sites that use `@media (prefers-color-scheme: dark)`, the inner rules are re-emitted
with the colour-scheme clause stripped from the condition and any other conditions kept.
Emitted last, so equal-specificity rules win on order.

Cross-origin sheets are invisible here, by the SecurityError fact. That is fine: the
probe notices the page is still light and escalates.

### Tier 2: variable remap

Enumerate the custom properties in effect on the root, keep the ones whose values parse
as colours, and remap each one perceptually. A site with a real design token layer goes
fully dark from about thirty declarations and no DOM traversal at all.

### Tier 3: compute sweep

The general fallback, and still much cheaper than Dark Reader's approach:

1. **Read phase.** One pass over elements collecting computed colour properties. No
   writes, so no forced reflow.
2. **Dedupe.** Group by colour signature. The probe measured 5000 elements collapsing
   to 258 signatures; real pages do far better than that adversarial fixture.
3. **Map.** Transform each distinct signature once.
4. **Write phase.** One `data-nx` attribute per element, then a single stylesheet with
   one rule per signature.

Read and write phases are separate functions that return data to the caller rather than
touching the DOM, which is what keeps the 20x thrash penalty off the table.

### Tier 4: filter

`filter: invert() hue-rotate()` on the root with media counter-inverted. Cheap, works on
anything including canvas, and looks worse. It is a user choice and the automatic
demotion target for pages that blow the performance budget, never the default.

## Colour transform

Colours are converted to **OKLCH**, which is perceptually uniform, so a lightness flip
preserves hue and saturation instead of muddying them. Dark Reader works in HSL, which
is why its output has recognisable systematic failures on yellows and saturated brand
colours.

The transform is not a plain inversion:

- Backgrounds map onto a lightness ramp with a ceiling, so a white page becomes the
  theme's surface colour rather than pure black. Pure black on pure white is an
  accessibility problem, not a goal.
- Foregrounds get a lightness floor, and the pair is then **contrast-corrected**: after
  mapping, the text and background lightnesses are checked and separated until they
  clear a configurable APCA-style threshold. Contrast is enforced rather than hoped for.
- Chroma is attenuated at extreme lightness where sRGB cannot represent it, then the
  result is gamut-mapped back into sRGB by reducing chroma, never by clipping channels,
  because clipping shifts hue.
- Near-neutral colours adopt the theme hue slightly, which is what stops a dark page
  looking like grey television static.

The parser handles `rgb`, `rgba`, `hsl`, `hwb`, hex in 3/4/6/8 digits, named colours,
`oklch`, `oklab`, `lab`, `lch`, `color()` in srgb / srgb-linear / display-p3 / a98-rgb /
prophoto-rgb / rec2020 / xyz, plus `transparent` and `currentColor`. The modern spaces
are not optional: the probe proved they arrive verbatim.

## Media policy

`<img>`, `<picture>`, `<video>`, `<canvas>` and `<svg>` images are **never inverted** by
default. Inverted photographs and mangled logos are the single most-reported Dark Reader
complaint, and the fix is to not do it. CSS background images are left alone unless they
are gradients, whose colour stops are remapped like any other colour.

## Performance budget and demotion

Every tier runs under a time budget and reports what it spent. Sustained mutation churn
above a threshold, or a tier that overruns, demotes the origin one rung and remembers
that. A page that melts under tier 3 lands on tier 4 by itself rather than waiting for
the user to work out that a mode switch exists.

Observers carry loop guards. Rewriting a style attribute that a rich text editor also
rewrites is how you hang ProseMirror, so self-inflicted mutations are recognised and
ignored, and a per-node re-entry counter disables handling for a node that keeps
fighting.

## Permissions

- No `host_permissions` at install.
- A content script matching `<all_urls>` at `document_start`. This is unavoidable: an
  extension that cannot run before first paint cannot prevent the flash, and that is the
  product. The install prompt says so and the listing copy does not pretend otherwise.
- `optional_host_permissions: ["<all_urls>"]`, requested only if the user turns on
  **stubborn sites**, which upgrades the override sheet to USER origin. That is the only
  way to beat a page's inline `!important`, per the cascade fact above, and it is a real
  user-visible capability rather than a permission grab.
- `storage` for settings, `alarms` for scheduling, `scripting` for the USER-origin
  upgrade.

## No network, enforced

Nocturne makes no network requests, in any tier, ever. Site signals ship in the package.
`tools/build.mjs --check` fails the build if any network primitive appears in `src/`,
after stripping comments and string literals so that prose mentioning `fetch` does not
trip it. This is a build gate rather than a promise because promises rot.

This also keeps the extension clear of the Chrome Web Store remote-code policy, which is
a recurring cause of rejection for this category.

## Decisions that came out of finding bugs

These are recorded because in each case the obvious implementation was the wrong one,
and the wrong one looked fine until something measured it.

- **Measurements stand the shell down first.** `guard.css` makes the page dark, so
  measuring while it is in force reported every page as already dark and the ladder
  stopped on rung 1 everywhere. Every probe now sets `data-nocturne-probing` for the
  duration, inside a single synchronous task so nothing paints.
- **The compute tier reads through the shell too.** Reading the shell's forced colours
  back as if the page had chosen them made the root a mid grey that did not match the
  body, leaving a visible seam below the content, and dimmed body text twice.
- **The forced root background retires once the theme lands.** A background on the root
  defeats CSS canvas propagation, so the body's themed colour stops at the edge of its
  own box. Holding it permanently is what produced the seam.
- **Measurement models canvas propagation.** Reading only the root and defaulting to
  white reports a correctly themed page as half light, because every sample below the
  content sits over the canvas rather than over an element.
- **The ladder waits for the document to parse.** Starting at the first sight of
  `document.body` measures an empty page. There is nothing to gain by starting early:
  the shell is already holding the page dark.
- **Surfaces are separated by a curve, not a linear ramp.** Compressing 0..1 into a band
  0.185 wide put a card 0.009 from its page, which reads as flat, and dark ends are
  harder to tell apart than light ones. A power curve below one spends the band where
  page surfaces actually live.
- **A fourth component is alpha only in the legacy comma forms.** `color()` puts the
  space name in the first slot, so its fourth argument is the third channel. Treating
  it as alpha made every opaque `color(srgb r g b)` parse as fully transparent, and
  transparent values are skipped everywhere.
- **Pinned modes are actually pinned.** "Site theme only" fell through to generating a
  theme and then to inverting, which is the opposite of what the option says.
- **A learned filter tier skips the sweep.** The learned rung only gated the two cheap
  rungs, so an origin demoted for being expensive paid the full sweep on every load,
  and a pass that measured well undid the demotion.
- **The signature index persists across sweeps.** Rebuilding it per sweep numbers
  signatures by document order, so an element left tagged from an earlier pass ends up
  pointing at somebody else's colours.
- **Incremental rescans use the dirty batch.** Re-sweeping the whole document per
  mutation makes the cost O(page) per change, which is the failure this project exists
  to avoid.
- **The user-origin mirror is refreshed on every sheet change and survives eviction.**
  `removeCSS` needs the exact string that was inserted, and an MV3 worker is evicted
  constantly, so the record lives in session storage. A demotion that swapped sheets
  without refreshing the mirror left user-origin token rules applying underneath a
  filter.
- **Losing the theme fight escalates.** Capping re-applications stops the loop, but
  stopping there leaves the page light while the engine reports the native rung as a
  success. The cap now hands control back to the ladder.
- **The release gate understands regex and template literals.** `src/lib/signals.js`
  genuinely contains patterns like `/\[data-theme=["']?dark/i`, and a scanner that only
  knows quotes swallows the rest of the file from that apostrophe. Interpolations inside
  template literals are scanned as code, because `${fetch(url)}` is code.
- **Fixtures that build their DOM in script are asserted.** A mangled closing tag left
  the heavy fixture nearly empty, which quietly turned the performance check into a
  measurement of a blank page.

## Known limits, stated rather than hidden

- **Closed shadow roots** cannot be reached. Open roots get an adopted stylesheet;
  closed ones stay light. No extension can do better without page cooperation.
- **Canvas and WebGL applications** render pixels, not CSS. Tier 4 can invert the whole
  surface, which is usually worse. The honest answer is to use the app's own dark theme.
- **Cross-origin stylesheets** are unreadable, so tiers 1b and 2 see less than the whole
  page on some sites. The probe catches the shortfall and escalates.
- **Browser chrome and restored tabs** can still flash. That is the browser's paint, not
  the page's, and no content script runs early enough to prevent it.
