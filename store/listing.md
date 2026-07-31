# Store listing copy

Everything a submission form asks for. Keep this in sync with the manifest, because
`tools/build.mjs --check` enforces the 132 character description limit but cannot
check what gets pasted into a web form.

---

## Name

Nocturne Dark Mode

## Short description (132 char limit, currently 129)

Dark mode for every site. Uses a site's own dark theme when it has one, so pages look right instead of inverted. No white flash.

## Category

Chrome Web Store: Accessibility
AMO: Appearance

---

## Full description

Most dark mode extensions treat every page the same way. They read the site's CSS,
recolour everything they find, and keep doing it as the page changes. That happens
even on the many sites that already have a good dark theme of their own, which then
gets thrown away and replaced with a guess.

Nocturne checks first.

If a site already has a dark mode, Nocturne switches it on. You get the theme the
site's own designers built, exactly as they built it, and it costs almost nothing to
apply. If the site has no dark mode, Nocturne builds one, and then checks its own
work by measuring the page it just produced.

WHAT MAKES IT DIFFERENT

It uses the site's real dark theme. Sites signal dark mode in a handful of standard
ways, and Nocturne knows them. Turning on the switch a site already has beats
recolouring it from the outside every time.

It checks the result. After each attempt Nocturne samples the page as rendered and
works out how much of your screen is still light and whether the text is still
readable. If the attempt did not work, it undoes it and tries something else. Nothing
is assumed.

It reads modern colour. Sites built in the last few years describe their colours in
formats older extensions cannot parse, and those pages come out broken or half
themed. Nocturne handles all of them.

Colours keep their identity. The maths happens in a perceptually uniform colour
space, so a yellow warning stays yellow and a brand blue stays that blue instead of
turning muddy.

Text stays readable. Every text and background pair is checked against a contrast
ratio you choose, and adjusted until it passes.

Your photos are safe. Images, video and logos are never inverted. If you want them
softer there is a dimming slider, and that is all it does.

No white flash. The first thing that runs is a stylesheet, applied before the page
paints.

Pages that are already dark are left completely alone.

CONTROLS

Five palettes, from a soft deep blue to a neutral grey to a high contrast option.
Brightness, contrast and colour sliders. A minimum contrast setting. Per-site
overrides for everything. Run it always, only when your system is in dark mode, or
between times you set. Keyboard shortcuts for turning it off on the site you are on
and everywhere at once.

PRIVACY

Nocturne makes no network requests. None, in any mode. No analytics, no accounts, no
downloaded configuration, no server anywhere in the picture. The list of site
conventions it recognises is inside the extension.

That is enforced rather than promised: the build refuses to produce a package if any
networking code is present anywhere in the source, and you can run that check
yourself. The whole thing is open source, and nothing is minified or obfuscated.

It asks for no site access when you install it.

WHAT IT CANNOT DO

Apps that draw to a canvas, like some document editors and map tools, are pixels
rather than text and colours, so there is nothing for Nocturne to recolour. Use the
app's own dark theme where it has one.

Components built with closed shadow DOM are sealed off from every extension, not just
this one. They stay light.

Some sites hide part of their styling from extensions entirely. Nocturne notices when
that leaves a page half themed and switches to a method that works.

Source code and full technical notes: https://github.com/TiltedLunar123/nocturne

---

## Permission justifications

Reviewers ask for these in the submission form. Answer plainly.

**Content script matching all sites, at document_start.** The extension changes the
colours of the pages the user visits, which requires running on them. It must run
before the first paint, because preventing the white flash is a core feature and no
later injection point can do it. It runs in all frames because iframes paint too.

**storage.** Persists the user's settings and per-site preferences locally. Nothing
is synced or transmitted.

**alarms.** Wakes the service worker at the boundary of a user-configured schedule so
the theme turns on and off at the right time.

**scripting.** Used only for the optional stubborn-sites feature described below,
which calls `scripting.insertCSS` with `origin: "USER"`.

**Optional host permission for all sites.** Not requested at install, and off by
default. When the user turns on "stubborn sites" in the options page, the extension
asks for it. Some pages set colours in inline style attributes marked `!important`.
Per the CSS cascade an important author declaration of that kind cannot be overridden
by any author-origin stylesheet, only by an important user-origin one, and
`scripting.insertCSS` with `origin: "USER"` is the only API that produces those. The
permission is used for that single call. Turning the option off removes the
permission.

**Remote code.** None. There is no remote code, no downloaded configuration, and no
network request of any kind. The build gate at `tools/build.mjs` fails if any
networking primitive appears in the source.

**Data collection (AMO).** None. `data_collection_permissions` is declared as
`{"required": ["none"]}` in the Firefox manifest.

---

## Screenshot plan

1280x800, generated by `node tools/shots.mjs`.

1. A legacy page, before and after, showing preserved surface depth and a yellow
   note that stays yellow.
2. A site with its own dark theme, with the popup open showing "Using this site's own
   dark theme".
3. The options page with the live preview panel.
4. A page using modern colour syntax, before and after.
5. The popup, showing the palettes and per-site controls.

---

## Answers to the usual review questions

**Why does it need to run on every site?** It is a dark mode extension. The user
installs it so that the sites they visit are dark.

**Why document_start?** Anything later cannot prevent the flash of white, which is
the most-reported failing of this category of extension.

**Does it read page content?** It reads computed colour values from the rendered
page. It does not read or transmit text, form data, URLs or cookies.

**Is anything obfuscated?** No. There is no bundler, no minifier, and no build step
beyond concatenating the source files in a fixed order with a header naming each one.
