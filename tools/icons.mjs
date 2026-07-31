/**
 * Rasterise the icon SVGs into the PNG sizes the browsers and stores want.
 *
 * The PNGs are committed, so a normal build never runs this and ImageMagick is
 * not a build dependency. Run it only after editing an SVG.
 *
 *   node tools/icons.mjs
 *
 * 16 and 32 come from icon-small.svg rather than from a downscale of the full
 * mark. Downscaling loses the split: the ring and the filled half merge into a
 * grey blob at toolbar size.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'src', 'icons');

const JOBS = [
  { svg: 'icon-small.svg', out: 'icon', sizes: [16, 32] },
  { svg: 'icon.svg', out: 'icon', sizes: [48, 96, 128, 256] },
  { svg: 'icon-off.svg', out: 'icon-off', sizes: [16, 32, 48, 128] },
];

async function main() {
  try {
    await run('magick', ['-version']);
  } catch {
    console.error(
      'ImageMagick ("magick") not found. The committed PNGs in src/icons are still\n' +
        'valid; this tool is only needed after editing an SVG.'
    );
    process.exit(1);
  }

  for (const job of JOBS) {
    for (const size of job.sizes) {
      const out = path.join(ICONS, `${job.out}-${size}.png`);
      await run('magick', [
        '-background', 'none',
        path.join(ICONS, job.svg),
        '-resize', `${size}x${size}`,
        // 8-bit RGBA: small files, and no 16-bit PNGs for store validators to
        // complain about.
        '-depth', '8',
        '-define', 'png:color-type=6',
        '-strip',
        out,
      ]);
      const { size: bytes } = await fs.stat(out);
      console.log(`${path.basename(out)} ${bytes} bytes`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
