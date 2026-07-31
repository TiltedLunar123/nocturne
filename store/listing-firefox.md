# Firefox Add-ons (AMO) listing

Verbatim copy for each field on addons.mozilla.org. AMO's fields differ from the
Chrome Web Store's, so this is not the same text as `listing.md`: the summary cap
is 250 characters rather than 132, the description accepts HTML, and there is a
notes-to-reviewer field that matters more than anything else here.

---

## Name

```
Nocturne Dark Mode
```

## Summary

216 of 250 characters.

```
Dark mode for every site. When a site already has its own dark theme, Nocturne switches that on rather than painting over it. When it has none, it builds one and checks the result. No white flash, no inverted photos.
```

## Categories

**Appearance**, and nothing else. Mozilla's own guidance is to avoid a second
category unless it genuinely applies, and this is a theming add-on rather than a
privacy tool, even though it collects nothing.

## Tags

```
dark mode, dark theme, night mode, dark reader, appearance, accessibility, eye strain, privacy, open source, no telemetry
```

## Description

AMO renders a limited set of HTML in this field, so it is written with markup
rather than as a wall of text.

```html
<p>Most dark mode add-ons do one thing to every page. They take every colour on it and flip it. You get a dark page out of that, along with inverted photos, logos that look like negatives, and the site's own dark theme thrown away in the process.</p>

<p><strong>Nocturne looks for that theme first.</strong></p>

<p>Plenty of sites already support dark mode. They're just waiting for you to dig a toggle out of a settings menu, or for your whole operating system to switch over. Nocturne finds the switch and flips it for you. What you're looking at then isn't a guess at how the site might look dark; it's the dark theme its own designers built, exactly as they built it.</p>

<p>When a site really has none, Nocturne builds one. Then it looks at the page it just made and measures whether the thing actually came out dark and readable. If it didn't, that attempt gets thrown away and a different approach gets tried. Nothing is applied on the assumption that it worked. The toolbar popup tells you which of the two happened, so when a site looks especially good (or especially rough) you know why.</p>

<h3>What you get</h3>

<ul>
  <li><strong>No white flash.</strong> Open a link at night and the dark page is what arrives, not half a second of blinding white first. The part that handles this is plain CSS with no script behind it, because anything waiting on JavaScript is already too late.</li>
  <li><strong>Photos stay photos.</strong> Images, video and logos are never inverted. Want them a little softer at night? There's a dimming slider, and dimming is all it does.</li>
  <li><strong>Text you can actually read.</strong> Every piece of text is checked against whatever is behind it and lightened or darkened until it clears a contrast ratio you set.</li>
  <li><strong>Colours keep their identity.</strong> A yellow warning stays yellow. A brand blue stays that blue instead of going muddy or radioactive.</li>
  <li><strong>It's quick.</strong> Six thousand elements on a page, finished in about half a second, using eleven rules to do it.</li>
  <li><strong>It knows when to stop.</strong> A page that's already dark gets left completely alone, because re-theming something a designer already built for the dark is the fastest way there is to ruin it.</li>
</ul>

<h3>Controls</h3>

<p>Five palettes, from a soft deep blue through neutral grey to a high contrast option. Sliders for brightness, contrast and colour intensity, plus a minimum contrast setting. Per-site settings for all of it.</p>

<p>Disagree with what Nocturne picked? There are four methods you can pin instead. Only want it after dark? Run it always, only while your system is in dark mode, or between hours you choose. There are keyboard shortcuts for switching it off on one site and for switching it off everywhere.</p>

<h3>Privacy</h3>

<p><strong>Nocturne makes no network requests. Not in any mode, not ever.</strong> There's no analytics and no account. Nothing is downloaded from anywhere, and no server is involved at any point. Everything it needs ships inside the add-on itself, so there's no fix list to fetch and no update channel to phone home to, and your settings stay in your browser.</p>

<p>That part is checked, not just promised. The build refuses to produce a package if any networking code shows up anywhere in the source. Would you rather see for yourself than take that on trust? The whole project is open source, with nothing minified and nothing obfuscated, so you can run that check yourself.</p>

<p>It asks for no site access when you install it.</p>

<h3>What it cannot do</h3>

<p>Being straight about this seems more useful than the alternative.</p>

<ul>
  <li>Apps that draw to a canvas are pixels rather than text and colours, which covers some document editors, most spreadsheets and plenty of map tools. There's nothing in there to recolour.</li>
  <li>A few sites build their interface in a way that seals it off from every add-on, not only this one. Those parts stay light.</li>
  <li>Some sites hide part of their styling from add-ons entirely. Nocturne notices when that's left a page half done and switches to a method that works instead.</li>
  <li>Firefox blocks add-ons on its own restricted domains, such as addons.mozilla.org and accounts.firefox.com, so pages there stay light.</li>
  <li>Your browser's own interface can still flash. That's Firefox painting, not the page.</li>
</ul>

<p>Free and open source, MIT licensed. Source, technical notes and the full test suite: <a href="https://github.com/TiltedLunar123/nocturne">github.com/TiltedLunar123/nocturne</a></p>
```

---

## Other listing fields

- **Homepage:** `https://github.com/TiltedLunar123/nocturne`
- **Support site:** `https://github.com/TiltedLunar123/nocturne/issues`
- **Privacy policy:** paste the contents of `PRIVACY.md`
- **License:** MIT
- **Screenshots:** reuse `store/assets/screenshot-1..5.png`. AMO takes the same
  1280x800 files and has no no-alpha rule, so nothing needs regenerating.

---

## Notes to reviewer

Paste this into the notes field. **Source code upload is mandatory for this
add-on**: the build concatenates source files, which counts as a preprocessing
step under Mozilla's source code submission policy. Upload
`release/nocturne-source-v1.0.0.zip` alongside the package.

```
SOURCE AND BUILD

The build concatenates plain source files into two scripts. Nothing is minified,
transpiled, bundled by a third-party bundler, or obfuscated. Source is attached
and is also public at https://github.com/TiltedLunar123/nocturne

Requirements: Node.js only. There are no npm dependencies at all, so there is no
package-lock.json and no install step. tools/build.mjs uses only the Node
standard library (node:crypto, node:path, node:url, node:util, node:zlib).

Build (matches your default Ubuntu 24.04 / Node 24 environment):

    unzip nocturne-source-v1.0.0.zip
    cd nocturne
    node tools/build.mjs

That writes dist/firefox, whose contents are the submitted package. The build is
deterministic: running it twice produces byte for byte identical output, and the
zip writer uses a fixed timestamp so archives match too. Verified reproducible on
Node 24.14. There is no platform-specific code in the build, though it was
developed on Windows rather than on Linux.

To reproduce the release archive exactly:

    node tools/build.mjs --zip --check

The --check flag also runs the release gate described below and exits non-zero
if anything fails.

WHAT THE BUILD DOES

src/lib/*.js and src/content/*.js are classic scripts that attach to an NX
global. build.mjs concatenates them in a fixed order into content.js and
background.js, each with a header naming every file included. The manifest is
generated from src/manifest.base.json with the Firefox-specific keys added. Every
line in the package appears verbatim in the source.

NO REMOTE CODE, NO NETWORK

The add-on makes no network requests in any mode. There is no eval, no
new Function, no dynamic import, no remote script, and no downloaded
configuration. The site-convention list it uses is data and ships in the package.

This is enforced by the build, not by convention. tools/build.mjs fails and
refuses to emit a package if fetch, XMLHttpRequest, sendBeacon, WebSocket,
EventSource, importScripts, eval or new Function appears anywhere in src/. The
scanner strips comments, string literals, regex literals and template
interpolations first so a call cannot be hidden inside one. Run
`node tools/build.mjs --check` to see it pass.

PERMISSIONS

storage   settings and per-site preferences, kept locally, never transmitted.

alarms    only for the optional "between set times" schedule. The alarm is
          created only while that schedule is selected and cleared otherwise
          (see syncAlarm in background.js).

scripting used for exactly two calls, scripting.insertCSS and
          scripting.removeCSS, both with origin "USER", and only when the user
          enables the optional "Stubborn sites" setting.
          scripting.executeScript is never called.

content script on <all_urls> at document_start, all_frames
          This is a dark mode add-on, so it has to run on the pages the user
          chooses to visit. document_start is required because preventing the
          flash of white before first paint is a core feature and every later
          injection point runs after that paint. all_frames because iframes
          paint too. It reads colours the page has already rendered and writes
          CSS. It does not read or transmit page text, form data, URLs or
          cookies.

optional_host_permissions <all_urls>
          Optional, not required, and off by default. Requested only when the
          user turns on "Stubborn sites" in the options page. Some pages set
          colours in an inline style attribute marked !important; per the CSS
          cascade no author-origin stylesheet can outrank that, and an important
          user-origin declaration is the only thing that can. insertCSS with
          origin "USER" is the only API that produces one. That is the sole use.

DATA COLLECTION

None. browser_specific_settings.gecko.data_collection_permissions is declared as
{"required": ["none"]}. strict_min_version is 140.0, which is the floor for that
key.

TESTING

    node --test test/*.test.mjs    69 unit tests
    node tools/e2e.mjs             32 checks against a real browser
    node tools/e2e-settings.mjs    9 checks, mode pinning and the CSS cascade
    node tools/e2e-ui.mjs          12 checks, popup and options pages

The end-to-end suites drive a Chromium-based browser because they need
--load-extension; they are not required to build or review the package.
```
