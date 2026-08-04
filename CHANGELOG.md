# Changelog

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
