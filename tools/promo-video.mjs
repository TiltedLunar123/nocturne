/**
 * Builds the promo video.
 *
 *   node tools/promo-video.mjs
 *
 * Output: store/video/nocturne-promo.mp4, 1920x1080, h264 + aac, ready to
 * upload.
 *
 * Everything on screen is a real capture. The demo sites are invented (see
 * store/demo) so no third party's trademark ends up in the video, and the
 * "what usually happens" shot is a genuine invert-and-hue-rotate of the real
 * page rather than a mock, because that is literally the transform the naive
 * approach applies.
 *
 * The narration drives the timing, not the other way around. Each scene's
 * voice line is synthesised first, its duration measured, and the visual for
 * that scene built to exactly that length. Nothing has to be hand-tuned when a
 * line is reworded.
 *
 * Pages are captured at 1280x720 with a 1.5 device scale factor, which yields
 * a true 1920x1080 frame while keeping the layout at its 1280px design width.
 * Capturing at 1920 directly would leave the fixed-width layouts stranded in
 * the middle of the frame.
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CDP, deriveExtensionId, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store', 'video');
const WORK = path.join(ROOT, 'dist', '_video');
const PY = 'C:/Users/hilge/.local/media-tools/Scripts/python.exe';
const KOKORO = 'C:/Users/hilge/.local/media-tools/kokoro_tts.py';

const W = 1920;
const H = 1080;
const FPS = 30;
const VOICE = 'af_heart';

const BRAND = { bg: '#0e1116', ink: '#e8eaf0', muted: '#98a0b0', accent: '#7b95f0' };

/**
 * The script. `vo` is spoken and captioned; `build` renders that scene's video
 * to the duration the narration turned out to need.
 *
 * Claims here are the ones the test suite actually backs. Nothing about store
 * availability, because at the time of writing it is not on a store.
 */
const SCENES = [
  { id: 'hook', vo: 'Most dark mode extensions do one thing to every page. They take every colour on it and flip it.' },
  { id: 'problem', vo: 'So your photographs come out as negatives. Brand colours die. And when a site already had a dark theme of its own, that gets thrown away with everything else.' },
  { id: 'turn', vo: 'Nocturne checks first.' },
  { id: 'native', vo: 'Plenty of sites already support dark mode. They are just waiting on a toggle buried in a settings menu. Nocturne finds it and switches it on, so what you get is the theme the people who built the site designed.' },
  { id: 'generated', vo: 'When a site really has none, Nocturne builds one. Then it measures the page it just made, and if the text came out hard to read it throws that attempt away and tries something else.' },
  { id: 'photos', vo: 'And it never touches your pictures. Not once, in any mode.' },
  { id: 'features', vo: 'Five palettes, a contrast floor you set yourself, and per site control over all of it.' },
  { id: 'privacy', vo: 'It makes no network requests. Not one, in any mode. The build refuses to package it if any networking code turns up in the source.' },
  { id: 'cta', vo: 'Nocturne. Free, and open source.' },
];

const sh = async (bin, args) => {
  try {
    return await run(bin, args, { maxBuffer: 1 << 26 });
  } catch (err) {
    throw new Error(`${bin} failed: ${String(err.stderr || err.message).slice(0, 600)}`);
  }
};

const ff = (args) => sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function duration(file) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return parseFloat(stdout.trim());
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function extensionVariant() {
  const to = path.join(ROOT, 'dist', '_video-ext');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(path.join(ROOT, 'dist', 'chrome'), to, { recursive: true });
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const file = path.join(to, 'manifest.json');
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  m.key = der.toString('base64');
  await fs.writeFile(file, JSON.stringify(m, null, 2));
  return { dir: to, id: deriveExtensionId(der) };
}

async function shoot(cdp, url, name, opts = {}) {
  const { width = 1280, height = 720, scale = 1.5, script, waitFn, settle = 900, autoHeight } = opts;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false,
  }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  if (waitFn) {
    await waitFor(name, () => cdp.evaluate(sessionId, waitFn), { timeout: 15000, interval: 120 })
      .catch(() => {});
  }
  await new Promise((r) => setTimeout(r, settle));
  let value;
  if (script) value = await cdp.evaluate(sessionId, script);
  if (autoHeight) {
    const real = await cdp.evaluate(sessionId, `Math.ceil(document.body.getBoundingClientRect().height)`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: real, deviceScaleFactor: scale, mobile: false,
    }, sessionId);
    await new Promise((r) => setTimeout(r, 220));
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  await fs.writeFile(path.join(WORK, `${name}.png`), Buffer.from(shot.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  return value;
}

// ---------------------------------------------------------------------------
// Title cards
// ---------------------------------------------------------------------------

const MARK = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c4cfef"/></linearGradient></defs>
  <circle cx="64" cy="64" r="50" fill="none" stroke="url(#g)" stroke-width="13"/>
  <path d="M64 14 A50 50 0 0 0 64 114 Z" fill="url(#g)"/></svg>`;

const card = (inner, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1280px;height:720px;overflow:hidden;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(900px 460px at 70% -10%, rgba(123,149,240,.20), transparent 62%),
             linear-gradient(158deg,#1a2030 0%,#0c0f14 64%);
  display:flex;align-items:center;justify-content:center;color:${BRAND.ink}}
.wrap{text-align:center;padding:0 90px}
h1{font-size:64px;font-weight:700;letter-spacing:-.032em;line-height:1.08}
h1 em{font-style:normal;color:${BRAND.accent}}
p{margin-top:20px;color:${BRAND.muted};font-size:26px;letter-spacing:-.008em;line-height:1.4}
.row{display:flex;align-items:center;justify-content:center;gap:34px}
.name{font-size:86px;font-weight:700;letter-spacing:-.034em}
.url{margin-top:26px;color:${BRAND.muted};font-size:22px;letter-spacing:.01em}
.pill{display:inline-block;margin-top:26px;padding:9px 22px;border-radius:30px;
  border:1px solid rgba(123,149,240,.45);color:${BRAND.accent};font-size:20px;font-weight:600}
${extra}</style></head><body><div class="wrap">${inner}</div></body></html>`;

/**
 * The upload thumbnail. Built from the same two real captures the video uses
 * for its problem beat and its payoff, so the comparison in the thumbnail is
 * the comparison in the video rather than a promise it does not keep.
 */
const THUMB = (invertedUrl, darkUrl) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1280px;height:720px;overflow:hidden;position:relative;background:#0c0f14;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.half{position:absolute;top:0;height:720px;overflow:hidden}
.half img{position:absolute;top:-30px;left:0;width:1280px}
.rule{position:absolute;top:0;left:640px;width:5px;height:720px;background:#7b95f0;
  box-shadow:0 0 30px rgba(123,149,240,.8);transform:translateX(-2px)}
.lab{position:absolute;top:26px;padding:8px 18px;border-radius:26px;font-size:20px;font-weight:800;
  letter-spacing:.13em;text-transform:uppercase}
.lab.l{left:26px;background:rgba(10,10,12,.9);color:#ff8a7a;border:2px solid rgba(255,138,122,.5)}
.lab.r{right:26px;background:#7b95f0;color:#0d1017}
.scrim{position:absolute;left:0;bottom:0;width:1280px;height:340px;
  background:linear-gradient(180deg,rgba(8,10,14,0) 0%,rgba(8,10,14,.93) 52%,#06080b 100%)}
.copy{position:absolute;left:46px;bottom:36px;right:46px}
h2{color:#fff;font-size:76px;line-height:.98;font-weight:800;letter-spacing:-.038em;
  text-shadow:0 4px 26px rgba(0,0,0,.75)}
h2 em{font-style:normal;color:#8fa8ff}
.who{display:flex;align-items:center;gap:14px;margin-top:20px}
.who .nm{color:#e8eaf0;font-size:33px;font-weight:700;letter-spacing:-.024em}
</style></head><body>
  <div class="half" style="left:0;width:640px"><img src="${invertedUrl}"></div>
  <div class="half" style="left:640px;width:640px"><img src="${darkUrl}" style="left:-640px"></div>
  <div class="rule"></div>
  <span class="lab l">Inverted</span><span class="lab r">Nocturne</span>
  <div class="scrim"></div>
  <div class="copy">
    <h2>Dark mode that leaves<br><em>your photos alone</em></h2>
    <div class="who">${MARK(46)}<span class="nm">Nocturne</span></div>
  </div>
</body></html>`;

const CARDS = {
  'card-turn': card(`<div class="row"><div>${MARK(120)}</div><div class="name">Nocturne</div></div>
    <p style="margin-top:26px">It checks whether the site already has one.</p>`),
  'card-privacy': card(`<h1>No network requests.<br><em>Not one.</em></h1>
    <p>The build refuses to package it if any networking code turns up in the source.</p>`),
  'card-cta': card(`<div class="row"><div>${MARK(132)}</div><div class="name">Nocturne</div></div>
    <div class="pill">Free and open source</div>
    <div class="url">github.com/TiltedLunar123/nocturne</div>`),
};

// ---------------------------------------------------------------------------
// Scene builders
// ---------------------------------------------------------------------------

const P = (n) => path.join(WORK, `${n}.png`);
const V = (n) => path.join(WORK, `${n}.mp4`);

const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

/** A still with a slow push in, so nothing sits perfectly frozen. */
async function stillScene(out, image, secs, { zoom = 1.05 } = {}) {
  const frames = Math.max(2, Math.round(secs * FPS));
  await ff([
    '-loop', '1', '-i', image, '-t', secs.toFixed(3),
    '-filter_complex',
    `[0:v]scale=${W * 2}:-2,zoompan=z='min(1+(${zoom} - 1)*on/${frames},${zoom})':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1[v]`,
    '-map', '[v]', ...ENC, out,
  ]);
}

/** Light to dark, revealed by a wipe. The money shot. */
async function wipeScene(out, before, after, secs, { wipe = 1.15, hold = 0.7 } = {}) {
  const offset = Math.max(0.4, hold);
  await ff([
    '-loop', '1', '-t', (offset + wipe + 0.2).toFixed(3), '-i', before,
    '-loop', '1', '-t', secs.toFixed(3), '-i', after,
    '-filter_complex',
    `[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[a];` +
    `[1:v]scale=${W}:${H},setsar=1,fps=${FPS}[b];` +
    `[a][b]xfade=transition=wiperight:duration=${wipe}:offset=${offset},format=yuv420p[v]`,
    '-map', '[v]', '-t', secs.toFixed(3), ...ENC, out,
  ]);
}

/** A crossfade between two stills, used for the naive-invert reveal. */
async function fadeScene(out, before, after, secs, { fade = 0.5, hold = 1.0 } = {}) {
  await ff([
    '-loop', '1', '-t', (hold + fade + 0.2).toFixed(3), '-i', before,
    '-loop', '1', '-t', secs.toFixed(3), '-i', after,
    '-filter_complex',
    `[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[a];` +
    `[1:v]scale=${W}:${H},setsar=1,fps=${FPS}[b];` +
    `[a][b]xfade=transition=fade:duration=${fade}:offset=${hold},format=yuv420p[v]`,
    '-map', '[v]', '-t', secs.toFixed(3), ...ENC, out,
  ]);
}

/** A themed page with the popup sliding in from the right. */
async function popupScene(out, page, popup, secs, { at = 0.5, slide = 0.55 } = {}) {
  // Popup is captured at 1.5x, so it is 480 wide. Sit it 60px from the edge.
  const restX = W - 480 - 60;
  const x = `if(lt(t,${at}),${W},if(lt(t,${at + slide}),${W}-(${W - restX})*((t-${at})/${slide}),${restX}))`;
  await ff([
    '-loop', '1', '-t', secs.toFixed(3), '-i', page,
    '-loop', '1', '-t', secs.toFixed(3), '-i', popup,
    '-filter_complex',
    `[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[bg];` +
    `[1:v]format=rgba,scale=480:-1[pop];` +
    `[bg][pop]overlay=x='${x}':y=70:format=auto,format=yuv420p[v]`,
    '-map', '[v]', '-t', secs.toFixed(3), ...ENC, out,
  ]);
}

/** Cycle the same page through several palettes. */
async function paletteScene(out, images, secs) {
  const each = secs / images.length;
  const fade = 0.45;
  const inputs = [];
  for (const img of images) inputs.push('-loop', '1', '-t', (each + fade).toFixed(3), '-i', img);

  let chain = images.map((_, i) => `[${i}:v]scale=${W}:${H},setsar=1,fps=${FPS}[s${i}];`).join('');
  let last = 's0';
  for (let i = 1; i < images.length; i++) {
    const offset = (each * i - fade / 2).toFixed(3);
    const label = `x${i}`;
    chain += `[${last}][s${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[${label}];`;
    last = label;
  }
  chain += `[${last}]format=yuv420p[vo]`;

  await ff([...inputs, '-filter_complex', chain, '-map', '[vo]', '-t', secs.toFixed(3), ...ENC, out]);
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

const ts = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};

/**
 * Group word timings into short caption lines.
 *
 * PlayResX/Y must match the render size or libass scales every measurement
 * against the wrong canvas, and the Format line under [Events] has to include
 * Name or libass drops the events entirely.
 */
function buildAss(cues) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Bahnschrift,54,&H00FFFFFF,&H00FFFFFF,&H00101014,&H96000000,-1,0,0,0,100,100,0,0,3,26,0,2,140,140,74,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map(
    (c) => `Dialogue: 0,${ts(c.start)},${ts(c.end)},Main,,0,0,0,,${c.text}`
  );
  return head + lines.join('\n') + '\n';
}

/**
 * Split a scene's word timings into readable caption lines.
 *
 * Kokoro returns `{ w, start, end }` and strips punctuation from `w`, so there
 * is no comma or full stop to break on. The natural boundary that survives is
 * the pause: the gap between two words widens at a clause end. Breaking on
 * that, with a word-count ceiling as a backstop, tracks the delivery.
 */
function cuesFor(words, offset, { maxWords = 6, gap = 0.16 } = {}) {
  const cues = [];
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    cues.push({
      start: offset + bucket[0].start,
      end: offset + bucket[bucket.length - 1].end,
      text: bucket.map((w) => w.w).join(' '),
    });
    bucket = [];
  };
  for (let i = 0; i < words.length; i++) {
    bucket.push(words[i]);
    const next = words[i + 1];
    const pause = next ? next.start - words[i].end : Infinity;
    if (bucket.length >= maxWords || pause > gap) flush();
  }
  flush();
  // A one-word orphan reads as a stutter; fold it back into the line before.
  for (let i = cues.length - 1; i > 0; i--) {
    if (cues[i].text.split(' ').length === 1) {
      cues[i - 1].text += ` ${cues[i].text}`;
      cues[i - 1].end = cues[i].end;
      cues.splice(i, 1);
    }
  }
  return cues;
}

// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.access(path.join(ROOT, 'dist', 'chrome', 'manifest.json')).catch(() => {
    throw new Error('dist/chrome not built. Run: node tools/build.mjs');
  });

  // --- narration first: it decides every duration ------------------------
  console.log('synthesising narration');
  const timing = [];
  for (const scene of SCENES) {
    const wav = path.join(WORK, `vo-${scene.id}.wav`);
    const json = path.join(WORK, `vo-${scene.id}.json`);
    await sh(PY, [KOKORO, '--text', scene.vo, '--out', wav, '--words', json, '--voice', VOICE]);
    const words = JSON.parse(await fs.readFile(json, 'utf8'));
    const secs = await duration(wav);
    timing.push({ ...scene, wav, words, secs });
    console.log(`  ${scene.id.padEnd(10)} ${secs.toFixed(2)}s`);
  }
  let cardRects = null;
  const total = timing.reduce((a, s) => a + s.secs, 0);
  console.log(`narration total ${total.toFixed(1)}s`);

  // --- captures ----------------------------------------------------------
  const variant = await extensionVariant();
  const files = [path.join(ROOT, 'store', 'demo'), WORK];
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    for (const dir of files) {
      try {
        const body = await fs.readFile(path.join(dir, rel));
        res.writeHead(200, {
          'content-type': rel.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8',
        });
        res.end(body);
        return;
      } catch { /* next */ }
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;

  try {
    for (const [name, html] of Object.entries(CARDS)) {
      await fs.writeFile(path.join(WORK, `${name}.html`), html);
    }
    await fs.writeFile(
      path.join(WORK, 'thumb.html'),
      THUMB(`${base}/gallery-inverted.png`, `${base}/gallery-dark.png`)
    );

    console.log('capturing light pages');
    let session = await launch(null, { port: 9471, headless: true, window: '1500,900' });
    try {
      const v = await waitFor('devtools', () => httpJson(9471, '/json/version'));
      const cdp = await CDP.connect(v.webSocketDebuggerUrl);
      await shoot(cdp, `${base}/docs.html`, 'docs-light');
      await shoot(cdp, `${base}/app.html`, 'app-light');
      await shoot(cdp, `${base}/gallery.html`, 'gallery-light');
      for (const name of Object.keys(CARDS)) await shoot(cdp, `${base}/${name}.html`, name);
    } finally {
      await shutdown(session);
    }

    console.log('capturing themed pages');
    session = await launch(variant.dir, { port: 9472, headless: true, window: '1500,900' });
    try {
      const v = await waitFor('devtools', () => httpJson(9472, '/json/version'));
      const cdp = await CDP.connect(v.webSocketDebuggerUrl);
      const themed = `document.documentElement.getAttribute('data-nocturne-tier') !== null`;
      const readTier = `Number(document.documentElement.getAttribute('data-nocturne-tier'))`;

      const docsTier = await shoot(cdp, `${base}/docs.html`, 'docs-dark', { waitFn: themed, script: readTier });
      const appTier = await shoot(cdp, `${base}/app.html`, 'app-dark', { waitFn: themed, script: readTier });
      const galleryTier = await shoot(cdp, `${base}/gallery.html`, 'gallery-dark', { waitFn: themed, script: readTier });
      if (docsTier !== 1) throw new Error(`docs.html reached tier ${docsTier}, expected 1`);
      if (appTier !== 3) throw new Error(`app.html reached tier ${appTier}, expected 3`);
      if (galleryTier !== 3) throw new Error(`gallery.html reached tier ${galleryTier}, expected 3`);
      console.log(`  verified tiers: docs ${docsTier}, app ${appTier}, gallery ${galleryTier}`);

      // The options cards, measured rather than cropped by guesswork.
      cardRects = await shoot(cdp, `chrome-extension://${variant.id}/options/options.html`, 'options', {
        width: 820, height: 1600, scale: 1.5, settle: 1300,
        script: `(() => {
          const pick = (h) => Array.from(document.querySelectorAll('.card'))
            .find((c) => c.querySelector('h2') && c.querySelector('h2').textContent.trim() === h);
          const box = (el) => { const r = el.getBoundingClientRect();
            return { x: Math.round(r.x * 1.5), y: Math.round((r.y + scrollY) * 1.5),
                     w: Math.round(r.width * 1.5), h: Math.round(r.height * 1.5) }; };
          return { theme: box(pick('Theme')), preview: box(pick('Preview')) };
        })()`,
      });

      const stage = (tier, host) => {
        const copy = tier === 1
          ? ['native', "Using this site's own dark theme"]
          : ['generated', 'Generated theme from the page colours'];
        return `(() => {
          const s = document.getElementById('status');
          s.dataset.quality = ${JSON.stringify(copy[0])};
          s.textContent = ${JSON.stringify(copy[1])};
          document.getElementById('site-name').textContent = ${JSON.stringify(host)};
          document.getElementById('site').checked = true;
          return true; })()`;
      };
      await shoot(cdp, `chrome-extension://${variant.id}/popup/popup.html`, 'popup-native', {
        width: 320, height: 700, settle: 1300, script: stage(1, 'meridian.dev'), autoHeight: true,
      });
      await shoot(cdp, `chrome-extension://${variant.id}/popup/popup.html`, 'popup-generated', {
        width: 320, height: 700, settle: 1300, script: stage(3, 'northwind.app'), autoHeight: true,
      });
    } finally {
      await shutdown(session);
    }
  } finally {
    server.close();
    await fs.rm(variant.dir, { recursive: true, force: true });
  }

  /*
   * The "what usually happens" frame: a real invert plus hue rotation, which
   * is exactly the transform the blunt approach applies.
   *
   * It runs on the gallery page rather than the docs page. On text-only pages
   * that transform actually holds up rather well, so pointing it at one
   * produced a shot that quietly contradicted the narration over the top of
   * it. Photographs are where it visibly comes apart, and that is the claim
   * being made.
   */
  console.log('rendering naive-invert frame');
  await ff(['-i', P('gallery-light'), '-vf', 'negate,hue=h=180', P('gallery-inverted')]);

  // Compose the two options cards side by side for the features beat.
  console.log('composing features card');
  for (const [name, r] of Object.entries(cardRects)) {
    await ff(['-i', P('options'), '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, P(`options-${name}`)]);
  }
  await ff([
    '-f', 'lavfi', '-i', `color=c=0x0c0f14:s=${W}x${H}`,
    '-i', P('options-theme'), '-i', P('options-preview'),
    '-filter_complex',
      '[1:v]scale=840:-1[a];[2:v]scale=840:-1[b];' +
      '[0:v][a]overlay=x=68:y=(H-h)/2[t];[t][b]overlay=x=1012:y=(H-h)/2[v]',
    '-map', '[v]', '-frames:v', '1', P('card-features'),
  ]);

  // --- build each scene to its narration length --------------------------
  console.log('building scenes');
  const byId = Object.fromEntries(timing.map((t) => [t.id, t]));
  const seg = (id) => V(`seg-${id}`);

  await stillScene(seg('hook'), P('docs-light'), byId.hook.secs, { zoom: 1.06 });
  await fadeScene(seg('problem'), P('gallery-light'), P('gallery-inverted'), byId.problem.secs,
    { hold: 1.6, fade: 0.5 });
  await stillScene(seg('turn'), P('card-turn'), byId.turn.secs, { zoom: 1.04 });
  await wipeScene(seg('native-wipe'), P('docs-light'), P('docs-dark'), byId.native.secs * 0.55);
  await popupScene(seg('native-popup'), P('docs-dark'), P('popup-native'), byId.native.secs * 0.45);
  await wipeScene(seg('generated-wipe'), P('app-light'), P('app-dark'), byId.generated.secs * 0.55);
  await popupScene(seg('generated-popup'), P('app-dark'), P('popup-generated'), byId.generated.secs * 0.45);
  // The payoff for the problem beat: same page, photographs untouched.
  await wipeScene(seg('photos'), P('gallery-inverted'), P('gallery-dark'), byId.photos.secs,
    { hold: 1.0, wipe: 1.0 });
  await stillScene(seg('features'), P('card-features'), byId.features.secs, { zoom: 1.03 });
  await stillScene(seg('privacy'), P('card-privacy'), byId.privacy.secs, { zoom: 1.03 });
  // The end card outlives its line. Two and a half seconds is not long enough
  // to read a URL, let alone decide to act on it.
  const CTA_TAIL = 2.4;
  await stillScene(seg('cta'), P('card-cta'), byId.cta.secs + CTA_TAIL, { zoom: 1.035 });

  const order = ['hook', 'problem', 'turn', 'native-wipe', 'native-popup',
                 'generated-wipe', 'generated-popup', 'photos', 'features', 'privacy', 'cta'];

  // --- concat video, concat audio, then marry them -----------------------
  console.log('assembling');
  await fs.writeFile(
    path.join(WORK, 'video.txt'),
    order.map((n) => `file '${seg(n).replace(/\\/g, '/')}'`).join('\n')
  );
  await ff(['-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'video.txt'), '-c', 'copy', V('video')]);

  await fs.writeFile(
    path.join(WORK, 'audio.txt'),
    timing.map((t) => `file '${t.wav.replace(/\\/g, '/')}'`).join('\n')
  );
  await ff(['-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'audio.txt'),
    '-af', 'aresample=48000', path.join(WORK, 'voice.wav')]);

  // --- captions, offset by each scene's start ----------------------------
  const cues = [];
  let clock = 0;
  for (const t of timing) {
    cues.push(...cuesFor(t.words, clock));
    clock += t.secs;
  }
  const ass = path.join(WORK, 'captions.ass');
  await fs.writeFile(ass, buildAss(cues), 'utf8');
  console.log(`${cues.length} caption cues over ${clock.toFixed(1)}s`);

  const assPath = ass.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  const finalPath = path.join(OUT, 'nocturne-promo.mp4');
  const videoSecs = await duration(V('video'));

  /*
   * Kokoro lands around -26 dB mean, roughly twelve decibels under what
   * YouTube normalises to, so an untouched upload plays noticeably quieter
   * than everything around it. loudnorm to -14 LUFS with a -1.5 dB true peak
   * is the platform target.
   *
   * Stereo because a mono promo sits oddly on headphones, and apad because the
   * end card now outlives the narration: -shortest would trim the video back
   * to the audio and cut the call to action off again.
   */
  await ff([
    '-i', V('video'), '-i', path.join(WORK, 'voice.wav'),
    '-vf', `subtitles='${assPath}':fontsdir='C\\:/Windows/Fonts'`,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,apad,aresample=48000',
    '-map', '0:v', '-map', '1:a', '-ac', '2', '-t', videoSecs.toFixed(3),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', finalPath,
  ]);

  // Thumbnail last: it composites captures that only exist by this point.
  console.log('rendering thumbnail');
  {
    const session = await launch(null, { port: 9473, headless: true, window: '1400,900' });
    try {
      const v = await waitFor('devtools', () => httpJson(9473, '/json/version'));
      const cdp = await CDP.connect(v.webSocketDebuggerUrl);
      const server2 = http.createServer(async (req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
        try {
          const body = await fs.readFile(path.join(WORK, rel));
          res.writeHead(200, {
            'content-type': rel.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8',
          });
          res.end(body);
        } catch {
          res.writeHead(404).end('nope');
        }
      });
      await new Promise((r) => server2.listen(0, '127.0.0.1', r));
      const thumbBase = `http://localhost:${server2.address().port}`;
      await fs.writeFile(
        path.join(WORK, 'thumb.html'),
        THUMB(`${thumbBase}/gallery-inverted.png`, `${thumbBase}/gallery-dark.png`)
      );
      await shoot(cdp, `${thumbBase}/thumb.html`, 'thumb', { width: 1280, height: 720, scale: 1 });
      server2.close();
    } finally {
      await shutdown(session);
    }
  }
  await ff([
    '-i', P('thumb'), '-vf', 'scale=1280:720',
    '-frames:v', '1', path.join(OUT, 'nocturne-thumbnail-1280x720.png'),
  ]);

  const secs = await duration(finalPath);
  const { size } = await fs.stat(finalPath);
  const { stdout } = await sh('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
    '-of', 'csv=p=0', finalPath,
  ]);
  console.log(`\n${path.relative(ROOT, finalPath)}`);
  console.log(`  ${stdout.trim()}  ${secs.toFixed(1)}s  ${(size / 1048576).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
