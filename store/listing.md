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

## Chrome Web Store submission form

Verbatim answers for each field. Every field is capped at 1000 characters.

### Single purpose description

Nocturne applies a dark colour theme to the web pages the user visits. That is the only thing it does.

On a site that already ships its own dark theme, Nocturne switches that theme on. On a site that has none, it reads the colours the page has already rendered and generates a dark theme from them, then samples the result to confirm the page came out dark and the text is still readable.

Everything else in the extension serves that one purpose. The palettes and sliders adjust the theme, the schedule decides when it is active, and the per-site controls decide which pages it applies to.

It does not block content, change how pages behave, collect data, or contact any server.

### storage justification

Stores the user's own settings on their device through chrome.storage.local: whether Nocturne is on, the chosen palette, the brightness, contrast, colour and minimum-contrast values, the schedule, and any per-site overrides the user has set.

It also keeps a small performance cache recording which theming method succeeded for a hostname, so a repeat visit can skip the measuring step rather than deriving it again. That cache holds a hostname and a small integer, and is capped at the 500 most recent entries.

chrome.storage.session holds one short-lived value: the exact CSS text currently inserted into a tab. scripting.removeCSS requires that exact string, and an MV3 service worker is evicted often enough that an in-memory record is not reliable.

None of this leaves the device. The extension makes no network requests at all.

### alarms justification

Used only by the optional "between set times" schedule, where the user picks an hour for the dark theme to switch on and an hour for it to switch off.

An MV3 service worker is evicted when idle, so without an alarm nothing is running at the moment a scheduled boundary is reached and the theme would not change until the user happened to open a page. The alarm wakes the worker to check whether the current time has crossed the boundary, then updates open tabs.

The alarm exists only while that schedule is selected. On the default setting ("Always") and on the "follow my system" setting there is no alarm at all: the extension clears it. See syncAlarm() in background.js.

### scripting justification

Used for exactly two calls, scripting.insertCSS and scripting.removeCSS, both with origin: "USER", and only when the user has switched on the optional "Stubborn sites" setting.

Some pages set colours in an inline style attribute marked !important. Under the CSS cascade an important author declaration of that kind cannot be overridden by any author-origin stylesheet, which is all a content script can inject, so those pages stay light. An important user-origin declaration does outrank it, and scripting.insertCSS with origin "USER" is the only API that produces one.

The setting is off by default, and the host permission is requested at the moment the user enables it. While it is off, no scripting call is ever made.

This permission is not used to execute JavaScript. scripting.executeScript is never called.

### Host permission justification

Two things fall under this, and neither is requested at install time.

1. The content script matches <all_urls> at document_start. Nocturne is a dark mode extension, so it has to run on whichever pages the user chooses to visit; there is no narrower set that would work. document_start is required because preventing the flash of white before a page paints is a core feature, and every later injection point runs after the first paint. all_frames is set because iframes paint too and would otherwise stay white. The script reads colours the page has already rendered and writes CSS. It does not read or transmit page text, form data, URLs or cookies.

2. <all_urls> is declared as an OPTIONAL host permission, not a required one. It is requested only if the user turns on "Stubborn sites", and is used solely for the scripting.insertCSS call described in that justification.

### Remote code

Answer: **No, I am not using Remote code.**

No remote code. There are no <script> tags pointing at external files, no dynamic imports, no eval(), and no new Function(). The extension makes no network requests of any kind, so there is nothing to fetch and nothing to execute.

The list of site theme conventions it recognises is data, and it ships inside the package. There is no downloaded configuration and no update channel.

This is enforced by the build rather than by convention. tools/build.mjs refuses to produce a package if fetch, XMLHttpRequest, sendBeacon, WebSocket, EventSource, importScripts, eval or new Function appears anywhere in the source. The scan strips comments, string literals, regex literals and template interpolations first, so it cannot be fooled by hiding a call inside one. Run "node tools/build.mjs --check" against the published source to verify it yourself.

### Data usage

Tick **nothing**. The Chrome Web Store defines collection as transmitting data off
the user's device, and Nocturne transmits nothing at all. No network request is made
in any mode, and the release gate fails the build if a networking primitive appears
anywhere in the source.

Settings and the per-hostname method cache are written to the browser's own extension
storage on the device and are never sent anywhere. Both are described in PRIVACY.md.

Certify all three disclosures. All three are true: no user data is sold or transferred
to third parties, none is used for anything outside the single purpose, and none is
used for creditworthiness or lending.

### Other fields

- Homepage URL: https://github.com/TiltedLunar123/nocturne
- Support URL: https://github.com/TiltedLunar123/nocturne/issues
- Privacy policy URL: https://github.com/TiltedLunar123/nocturne/blob/main/PRIVACY.md
- Category: Accessibility

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
