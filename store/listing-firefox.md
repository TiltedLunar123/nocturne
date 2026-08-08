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
- **Contributions URL:** `https://buymeacoffee.com/judeh1l`. AMO has a field for
  this and renders it as a "Support this developer" button on the listing.
  Buy Me a Coffee is on its allowed list of services.
- **Privacy policy:** paste the contents of `PRIVACY.md`
- **License:** MIT
- **Screenshots:** reuse `store/assets/screenshot-1..5.png`. AMO takes the same
  1280x800 files and has no no-alpha rule, so nothing needs regenerating.

---

## Notes to reviewer

Paste the block below into the notes field. AMO caps it at 3000 characters and
counts CRLF line endings, so a plain character count understates it by one per
line. This is 2997 as the form counts it.

**Source code upload is mandatory for this add-on**: the build concatenates
source files, which counts as a preprocessing step under Mozilla's source code
submission policy. Upload `release/nocturne-source-v1.3.0.zip` alongside the
package. The release gate checks that this filename matches the version being
shipped, so a stale one fails the build rather than reaching a reviewer.

```
SOURCE AND BUILD

Source is attached, and is also public at github.com/TiltedLunar123/nocturne
Required because the build concatenates plain source files into two scripts.
Nothing is minified, transpiled, obfuscated, or bundled.

Node.js only. There are NO npm dependencies, so no package-lock.json and no
install step. build.mjs uses only the Node standard library, so your default
Ubuntu 24.04 / Node 24 environment needs nothing added.

Step by step:
  1. unzip nocturne-source-v1.3.0.zip
  2. cd nocturne
  3. node tools/build.mjs

Step 3 writes dist/firefox/, which is the submitted package byte for byte. The
build is deterministic: run it twice, get identical output. For the release
archive too, run "node tools/build.mjs --zip --check", which also runs the gate
below and exits non-zero on failure.

What it does: src/lib/*.js and src/content/*.js are classic scripts attaching to
an NX global. build.mjs concatenates them in a fixed order into content.js and
background.js, each headed by the list of files it contains. manifest.json comes
from src/manifest.base.json plus the Gecko keys. Every line in the package
appears verbatim in the source.

NO REMOTE CODE, NO NETWORK

No network requests in any mode. No eval, no new Function, no dynamic import,
no remote script, no downloaded config.

Enforced by the build, not by convention: build.mjs refuses to emit a package if
fetch, XMLHttpRequest, sendBeacon, WebSocket, EventSource, importScripts, eval
or new Function appears anywhere in src/. The scanner strips comments, string
literals, regex literals and template interpolations first, so a call cannot
hide inside one.

PERMISSIONS

storage    settings and per-site preferences. Local only, never transmitted.
alarms     only for the optional "between set times" schedule; the alarm exists
           only while that schedule is selected (syncAlarm, background.js).
scripting  exactly two calls, insertCSS and removeCSS, both origin "USER", and
           only when the user enables "Stubborn sites". executeScript is never
           called.

content_scripts <all_urls>, document_start, all_frames. It is a dark mode
add-on, so it runs on the pages the user chooses to visit. document_start is
required because preventing the flash of white before first paint is a core
feature, and every later injection point runs after that paint. all_frames
because iframes paint too. It reads colours the page already rendered and writes
CSS; it does not read or transmit page text, form data, URLs or cookies.

optional_host_permissions <all_urls>. Optional, off by default, requested only
when the user enables "Stubborn sites". Colours set inline with !important
cannot be overridden by any author-origin stylesheet; only an important
user-origin declaration can, and insertCSS with origin "USER" is the only API
producing one. That is its sole use.

Data collection: none. data_collection_permissions is {"required": ["none"]}.
```
