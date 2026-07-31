# Nocturne

Dark mode for Chrome and Firefox that starts by asking whether the site already has
one.

Most dark mode extensions do the same thing to every page: parse the CSS, recolour
everything, and keep doing it forever as the page changes. That is the most expensive
strategy available, and it gets applied even to the large and growing number of sites
that ship a perfectly good dark theme of their own, which then gets replaced by an
approximation of itself.

Nocturne is an escalation ladder. It tries the cheapest thing that could work,
**measures whether the page actually came out dark and readable**, and only escalates
when the measurement says it has to.

```
0  shell      dark before first paint, from CSS with no script behind it
1  native     switch on the site's own dark theme, or promote its dark media rules
2  tokens     remap the site's own design tokens
3  compute    sample the rendered colours and rewrite them, deduplicated
4  filter     invert, when nothing better is possible
```

On a site with its own dark mode the ladder stops at rung 1 having done almost no
work, and what you get is that site's theme, authored by the people who designed the
site. On a site without one, it generates a theme, and checks its own result.

## What is actually different

**It uses the site's own dark theme.** Most sites that support dark mode do it with a
class or attribute on the root element rather than a media query: `html.dark`,
`[data-theme="dark"]`, `[data-bs-theme="dark"]` and a dozen similar conventions.
Nocturne recognises them, switches the right one on, and confirms the page went dark.
That is a `classList.add` producing a pixel-perfect result.

**Every rung is measured, not assumed.** After each attempt Nocturne samples the
rendered page on a grid, resolves the colour actually painted at each point, and
computes how much of the screen is still light and whether the text is still legible.
A rung that fails is reverted. This is what makes "try the cheap thing first" safe
rather than a gamble.

**It understands modern colour.** `getComputedStyle` returns `oklch()`, `oklab()`,
`lab()`, `lch()` and `color()` verbatim rather than converting them to `rgb()`. A
parser written for the `rgb()` era silently fails on any site built with a current
token pipeline. Nocturne parses all of them, and does its own work in OKLCh, which is
perceptually uniform, so moving lightness leaves hue and saturation where the designer
put them. Yellows stay yellow.

**Contrast is enforced, not hoped for.** After mapping, every text and background pair
is checked and separated until it clears a configurable ratio.

**It never inverts your images.** Photos, video, canvas and logos are left alone.
Inverted images are the single most common complaint about this category of extension
and the fix is to not do it.

**No white flash.** The anti-flash shell is a stylesheet applied at `document_start`.
It is CSS with no JavaScript behind it on purpose, because every scripted path,
including `scripting.insertCSS` from the service worker, runs strictly after the first
paint.

**It makes no network requests.** Not for stylesheets, not for site fixes, not for
analytics. The build refuses to produce a package if any networking primitive appears
anywhere in the source.

**It gets out of the way.** A page that is already dark is left completely untouched.
A page that cannot be themed within its performance budget is demoted to a cheaper
method automatically and that decision is remembered.

## Permissions

- **No host permissions at install.** Nothing is requested up front.
- **A content script on all sites, at `document_start`.** This is unavoidable: an
  extension that cannot run before the first paint cannot prevent the flash, and that
  is the product. Your browser will tell you this at install and the description above
  does not pretend otherwise.
- **`storage`** for your settings, **`alarms`** for the schedule, **`scripting`** for
  the optional feature below.
- **`<all_urls>`, optional and off by default.** Turning on "stubborn sites" asks for
  it. A page can write `background-color: #fff !important` into an inline style
  attribute, and per the CSS cascade no author-origin stylesheet can outrank that.
  User-origin CSS can, and `scripting.insertCSS` is the only way to produce it. That
  is the whole reason the option exists.

## Install

Not yet on either store. To run it from source:

```bash
git clone https://github.com/TiltedLunar123/nocturne.git
cd nocturne
node tools/build.mjs
```

Chrome or Edge: open `chrome://extensions`, turn on Developer mode, choose **Load
unpacked**, and pick `dist/chrome`.

Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
Add-on**, and pick `dist/firefox/manifest.json`.

## Development

```bash
node tools/build.mjs --check    # build both targets and run the release gate
node --test test/*.test.mjs     # unit tests
node tools/e2e.mjs              # drive a real browser against the fixtures
node tools/e2e-settings.mjs     # mode pinning, and the user-origin cascade claim
node tools/e2e-ui.mjs           # render the popup and options page, fail on any error
node tools/shots.mjs            # before and after screenshots into docs/shots
node tools/probe-platform.mjs   # re-verify the platform facts in PLAN.md
node tools/probe-colors.mjs
```

There is no bundler and nothing is minified. The libraries are plain classic scripts
that attach to an `NX` global, and the build concatenates them. What ships is what is
written here.

The end-to-end suite drives Edge rather than Chrome, because branded Google Chrome
ignores `--load-extension` and the extension would silently never load.

`PLAN.md` holds the architecture, the platform facts each decision rests on, and the
measurements behind them. Read it before changing a tier.

## Known limits

These are real and stated rather than hidden.

- **Closed shadow roots** cannot be reached by any extension without the page
  cooperating. Components built that way stay light.
- **Canvas and WebGL applications** draw pixels, not CSS. Rung 4 can invert the whole
  surface, which is usually worse than leaving it. Use the application's own dark
  theme.
- **Cross-origin stylesheets** cannot be read: `cssRules` throws for them. Rungs 1b
  and 2 therefore see less than the whole page on some sites. The measurement notices
  and escalates. Working around this is why other extensions in this category fetch
  stylesheets over the network, which Nocturne will not do.
- **Rung 3 forces text and background colours**, so a page's own hover tint on those
  two properties is flattened. Borders, outlines and shadows are left at normal weight
  precisely so interaction states on those keep working. Rungs 1 and 2 have no such
  problem, and modern sites reach them.
- **Browser chrome and restored tabs** can still flash. That is the browser painting,
  not the page, and no content script runs early enough to prevent it.

## Licence

MIT.
