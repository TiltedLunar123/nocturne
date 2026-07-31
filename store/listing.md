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

Pasted verbatim into the Chrome Web Store "Detailed description" field.
Plain text, no markdown: that field does not render it.
5347 of 16000 characters.

Nocturne turns the web dark without wrecking how it looks.

Most dark mode extensions work one way. They grab every colour on the page and flip it. You get a dark page out of that, along with inverted photos and logos that look like negatives, and the site's own dark theme (if it had one) gets thrown away in the process.

Nocturne looks for that theme first.

Plenty of sites already support dark mode. They're just waiting for you to dig a toggle out of a settings menu, or for your whole operating system to switch over. Nocturne finds the switch and flips it for you. What you're looking at then isn't a guess at how the site might look dark; it's the dark theme its own designers built, exactly as they built it.

When a site really has none, Nocturne builds one. Then it looks at the page it just made and measures whether the thing actually came out dark and readable. If it didn't, that attempt gets thrown away and a different approach gets tried. Nothing is applied on the assumption that it worked.

The popup tells you which of those two things happened on the page you're on. So when a site looks especially good (or especially rough) you know why.


WHY YOU MIGHT WANT IT

No white flash. Open a link at night and the dark page is what arrives, not half a second of blinding white first. The piece of Nocturne that handles this is plain CSS with no script behind it; anything waiting on JavaScript is already too late.

Photos stay photos. Images, video and logos are never inverted, and that single decision takes out the complaint people make about dark mode extensions more than any other. Want pictures a little softer at night? There's a dimming slider. Dimming is all it does.

Text you can actually read: Nocturne checks every piece of text against whatever is behind it and lightens or darkens it until it clears a contrast ratio you set. Grey text on a grey box doesn't survive that.

A yellow warning stays yellow. A brand blue stays that blue instead of going muddy or radioactive. The colour work happens in a space built to match how human eyes actually perceive lightness, which is why it holds up on saturated colours where simpler methods come apart.

It's quick. Six thousand elements on a page: finished in about half a second, using eleven rules to do it. Your fan should stay quiet.

And it knows when to stop. A page that's already dark gets left completely alone, because re-theming something a designer already built for the dark is the fastest way there is to ruin it, and no shortage of extensions do exactly that. If a page turns out to be too expensive to keep themed, Nocturne drops to a cheaper method on its own and remembers that for next time.


WHAT YOU CAN CHANGE

Five palettes, running from a soft deep blue through neutral grey to a high contrast option.

Sliders for brightness, contrast and colour intensity. There's also a minimum contrast setting if you want text pushed harder than the default.

Per-site settings for all of it. Change something while you're on a site and it applies to that site alone.

Disagree with what Nocturne picked? Four methods you can pin instead. Automatic is the default and measures the page. Site theme only will use a site's real dark mode and nothing else. Generated always builds a theme. Invert is the blunt option for pages nothing else handles.

Only want it after dark? Run it always, only while your computer is in dark mode, or between hours you pick.

Keyboard shortcuts: one switches it off on the site you're reading, one switches it off everywhere.


PRIVACY

Nocturne makes no network requests. Not in any mode, not ever. There's no analytics and no account. Nothing is downloaded from anywhere, and no server is involved at any point. Everything it needs to do the job ships inside the extension itself, so there's no fix list to fetch and no update channel to phone home to, and your settings stay in your browser.

That part is checked, not just promised. The build refuses to produce a package if any networking code shows up anywhere in the source. Would you rather see for yourself than take that on trust? The whole project is open source, with nothing minified and nothing obfuscated, so you can run that check yourself.

It asks for no site access when you install it.


WHAT IT CANNOT DO

Being straight about this seems more useful than the alternative.

Apps that draw to a canvas are pixels, not text and colours: some document editors, most spreadsheets, plenty of map tools. There's nothing in there for Nocturne to recolour. Use those apps' own dark themes where they have them.

A few sites build their interface in a way that seals it off from every extension, not only this one. Those parts stay light. No extension can reach them.

Some sites hide part of their styling from extensions entirely, which is the sort of thing that leaves other extensions rendering half a page dark and the other half glaring white; Nocturne notices when that has happened and switches to a method that works instead.

Your browser's own interface, and tabs the browser reloads from memory, can still flash. That's the browser painting; the page has nothing to do with it, and no extension runs early enough to stop it.


Open source, MIT licensed. Source code, technical notes and the full test suite: https://github.com/TiltedLunar123/nocturne

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
