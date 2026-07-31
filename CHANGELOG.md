# Changelog

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
