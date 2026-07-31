# Privacy policy

**Nocturne collects nothing, sends nothing, and contacts no server.**

Last updated 2026-07-31. Applies to Nocturne for Chrome, Edge and Firefox.

## What is collected

Nothing. There is no analytics, no telemetry, no crash reporting, no account, no
identifier of any kind, and no remote configuration.

## What leaves your device

Nothing. Nocturne makes no network requests at all, in any mode, ever.

This is not a promise resting on good intentions. The build enforces it: if any
networking primitive (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`,
`EventSource`, `importScripts`) appears anywhere in the source, the release gate
fails and no package is produced. The check is in `tools/build.mjs` and you can run
it yourself with `node tools/build.mjs --check`.

The list of site theme conventions Nocturne recognises ships inside the extension.
There is no fix list to download and no update channel to phone home to.

## What is stored, and where

Your settings, in your browser's own extension storage, on your device:

- whether Nocturne is on, globally and per site
- your palette, brightness, contrast, colour and contrast-floor choices
- your schedule
- the hostnames you have set your own preferences for
- for each hostname visited, which method worked, so a repeat visit skips the
  measuring step

That last item is a performance cache holding a hostname and a small number. It is
capped at the 500 most recent entries. It is not browsing history, it is not sent
anywhere, and clearing it costs nothing but a moment's extra work on the next visit.

Everything above is removed when you uninstall the extension. You can clear it at any
time from **All settings** with **Reset everything**, and export it as a file with
**Export settings**.

## What Nocturne can see

Nocturne runs a content script on the pages you visit, because it has to change their
colours and it has to do so before the page is first painted. In that content script
it reads the colours the page has already rendered. It does not read, collect,
transmit or store page text, form contents, passwords, cookies, URLs or anything else
about what you are looking at.

It requests **no host permissions at install**.

The optional **stubborn sites** feature asks for access to all sites when you turn it
on, and only then. It is off by default. It is used for exactly one thing: injecting
the generated theme as user-origin CSS, which is the only weight in the CSS cascade
that outranks a page's own inline `!important` styles. You can withdraw the permission
at any time by turning the option off.

## Third parties

There are none. No SDKs, no libraries loaded at runtime, no services.

## Changes

Any change to this policy will appear in this file and in `CHANGELOG.md`, in the
public repository, before the version that changes it is published.

## Contact

Open an issue at https://github.com/TiltedLunar123/nocturne/issues.
