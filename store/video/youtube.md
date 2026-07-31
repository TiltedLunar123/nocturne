# YouTube upload

File: `nocturne-promo.mp4` (1920x1080, h264/aac, 61s)
Thumbnail: `nocturne-thumbnail-1280x720.png`

## Title

Pick one. The first is the clearest statement of the difference.

- Dark mode that uses the site's own theme
- I built a dark mode extension that checks before it recolours anything
- Dark mode without the inverted photos

## Description

Nocturne is a dark mode extension for Chrome and Firefox.

Most dark mode extensions do one thing to every page: take every colour and flip
it. Your photographs come out as negatives, brand colours die, and if the site
already had a dark theme of its own, that gets thrown away with everything else.

Nocturne checks first. Plenty of sites already support dark mode and are just
waiting on a toggle buried in a settings menu. Nocturne finds it and switches it
on, so what you get is the theme the people who built the site designed. When a
site really has none, it builds one, then measures the page it just made and
throws the attempt away if the text came out hard to read.

It never touches your pictures. It makes no network requests in any mode, and
the build refuses to package it if any networking code turns up in the source.

Free and open source, MIT licensed.

Source, technical notes and the test suite:
https://github.com/TiltedLunar123/nocturne

Chapters:
0:00 What usually happens
0:15 Checking first
0:16 Sites that already have a dark theme
0:28 Sites that do not
0:39 Your photos
0:42 Settings
0:48 Privacy
0:56 Where to get it

## Notes

- The sites in the video (Fieldnotes, Meridian, Northwind) are invented, and the
  pages live in `store/demo`. No real site appears, which keeps somebody else's
  trademark out of the video.
- The "inverted" shot is a genuine invert plus hue rotation applied to the real
  page, because that is the transform the blunt approach actually uses.
- There is no music. Add a licensed track in the YouTube editor if you want one;
  nothing in the repository is licensed for distribution as audio.
- Regenerate with `npm run video` after changing the product or the script.
