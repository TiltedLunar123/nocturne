# Changelog

## Unreleased

- On sites using the stubborn sites option, content that appears after the page
  has loaded is themed like the rest of it. Anything the page painted later,
  which on most modern sites is most of the page, was left light while
  everything around it was dark.

## 1.2.0

More bug fixes, two of which meant whole categories of site were themed the
expensive way when they did not need to be.

- Turning "stubborn sites" back off no longer switches Nocturne off entirely
  on Firefox. Unticking it gave back the permission the extension's own
  content script runs on, so from the next page load there was no dark mode
  anywhere, no way to tell why, and no way to put it back except from
  Firefox's own add-ons page.
- A site's own dark theme is used on sites whose stylesheets write the older
  `only screen and (prefers-color-scheme: dark)` form. Nocturne rebuilt that
  query wrongly, the rewritten block matched nothing, and the page fell all
  the way to a generated theme.
- An embedded frame can no longer decide how the page around it gets themed.
  A widget or advert with no dark theme of its own taught Nocturne that the
  whole site needed a generated one, so the site's real dark theme was never
  tried again. A frame from another site could do it to a site you had never
  opened directly.
- Settings stay where you put them. A page finishing its work in another tab
  could quietly put back the palette, the per-site switch or the main switch
  you had just changed, while the popup went on showing the new value.
- Sites that build their colours with newer CSS are themed properly instead
  of being turned grey. Colours written as a derivation of another colour
  were read as black and then forced onto the page.
- Moving a slider no longer turns a page white on sites using the stubborn
  sites option.
- Clicking a link within a page no longer leaves the stubborn sites
  stylesheet welded to it, where nothing could override it and turning
  Nocturne off could not remove it.
- The popup no longer goes back to describing a site the way it was before
  you changed it.
- A link to buy me a coffee, in the popup footer and on the settings page.
  Optional, and nothing in Nocturne is behind it.

## 1.1.0

Bug fixes throughout, several of them to things that never worked in 1.0.0.

- Per-site settings work at all. The popup could not tell which site it was
  looking at, so it reported that it could not run anywhere, showed no site
  name, and left the per-site switch disabled. The toolbar icon was stuck on
  the off artwork even while a page was themed, and the site shortcut did
  nothing. The page now reports its own address instead of the extension
  trying to read it from outside, which it has never had permission to do.
- Pages no longer wash out a second after they load. A late pass re-read the
  colours Nocturne had already applied and mapped them again, which lightened
  every surface towards grey until raised cards matched the page behind them
  and text contrast fell by more than half.
- A site turned off in the popup can be turned back on in the popup.
- "Site theme only" no longer recolours a site it has already visited.
- Changing a setting in the popup no longer reverts a change made in the
  options page, and the other way round.
- Embedded frames can no longer restyle the page that embeds them.
- Two tabs applying the stubborn-sites upgrade at the same time no longer
  strand a stylesheet that neither can then remove.
- A site's own theme script switching Nocturne back off is now noticed for
  every convention Nocturne knows, not five of the ten.
- Turning Nocturne off on a site with the stubborn-sites option enabled now
  really turns it off. The strongest of its stylesheets was left behind, so
  the page stayed inverted, and nothing on the page could override it.
- A site that keeps putting its own light theme back no longer drags "Site
  theme only" into recolouring the page, and no longer ends in a fight
  neither side stops.
- The scheduling time fields are labelled for screen readers.

## 1.0.0

First release.

- Escalation ladder: activates a site's own dark theme where one exists, promotes
  its `prefers-color-scheme` rules where those exist, remaps its design tokens
  where those exist, and only generates a theme from scratch when none of that
  is available.
- Every rung is verified by measuring the rendered page rather than assumed to
  have worked, so a rung that fails is reverted instead of shipped.
- Colour transform works in OKLCh, and parses `oklch()`, `oklab()`, `lab()`,
  `lch()` and `color()` as well as the legacy syntaxes.
- Text is contrast-corrected against its own background to a configurable floor.
- Anti-flash shell applies before first paint, from CSS with no script behind it.
- Images, video and canvas are never inverted.
- Performance budget with automatic demotion when a page cannot be themed
  affordably.
- Five palettes, per-site overrides, clock and system scheduling, keyboard
  shortcuts.
- No network requests, enforced by the release gate rather than promised.
