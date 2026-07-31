/**
 * Nocturne build.
 *
 * Produces dist/chrome and dist/firefox from one source tree, and optionally
 * zips them. There is no bundler: the libraries are plain classic scripts that
 * attach to an `NX` global, and this script concatenates them into one
 * background script and one content script per target. Store reviewers read
 * exactly what is written here.
 *
 *   node tools/build.mjs            build both targets
 *   node tools/build.mjs --zip      build, then write store zips
 *   node tools/build.mjs --check    build, then run the release gate
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(deflateRaw);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');

const TARGETS = ['chrome', 'firefox'];

/** Order matters: these are concatenated, and there are no forward references. */
const BACKGROUND_MODULES = [
  'lib/color.js',
  'lib/theme.js',
  'lib/settings.js',
  'lib/browser.js',
  'background.main.js',
];

/**
 * The content bundle. Concatenated rather than listed as ten separate entries
 * in the manifest because this runs at document_start on every frame, and ten
 * script loads before first paint is exactly the cost the product exists to
 * avoid.
 */
const CONTENT_MODULES = [
  'lib/color.js',
  'lib/theme.js',
  'lib/settings.js',
  'lib/signals.js',
  'lib/browser.js',
  'content/sheet.js',
  'content/probe.js',
  'content/observe.js',
  'content/tiers.js',
  'content/main.js',
];

/**
 * The popup and options pages load this instead of the content bundle, so the
 * settings schema and colour maths they use are literally the engine's, with
 * none of the DOM-walking code they have no use for.
 */
const UI_MODULES = ['lib/color.js', 'lib/theme.js', 'lib/settings.js', 'lib/browser.js'];

const STATIC_DIRS = ['popup', 'options', 'icons'];

/**
 * The whole product promise is that Nocturne cannot read your browsing and
 * never talks to the network. Both are enforced here rather than by discipline.
 */
const ALLOWED_PERMISSIONS = ['storage', 'alarms', 'scripting'];
const FORBIDDEN_MANIFEST_KEYS = ['host_permissions', 'externally_connectable', 'web_accessible_resources'];

const REQUIRED_ICONS = {
  'icon-16.png': 16,
  'icon-32.png': 32,
  'icon-48.png': 48,
  'icon-96.png': 96,
  'icon-128.png': 128,
  'icon-off-16.png': 16,
  'icon-off-32.png': 32,
  'icon-off-48.png': 48,
  'icon-off-128.png': 128,
};

/**
 * Control characters that must never appear literally in source. Built from
 * escape sequences rather than written as a literal class: a literal class here
 * is itself made of control bytes, which is how one got committed before.
 */
const CONTROL_CHARS = new RegExp(
  '[' + '\x00-\x08\x0b\x0c\x0e-\x1f' + ']'
);

const args = new Set(process.argv.slice(2));
const problems = [];
const fail = (message) => problems.push(message);

async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function walk(dir, fn) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, fn);
    else await fn(full);
  }
}

async function concat(modules, banner) {
  const parts = [banner];
  for (const rel of modules) {
    const body = await fs.readFile(path.join(SRC, rel), 'utf8');
    parts.push(`/* ==== ${rel} ==== */\n${body}`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function manifestFor(target, base) {
  const manifest = JSON.parse(JSON.stringify(base));

  if (target === 'chrome') {
    manifest.background = { service_worker: 'background.js' };
    // Chrome rejects match_about_blank alongside MV3 in some channels and
    // prefers the newer key, which does the same job and more.
    delete manifest.content_scripts[0].match_about_blank;
    manifest.content_scripts[0].match_origin_as_fallback = true;
  } else {
    // Firefox MV3 event page. Service workers exist in Gecko now but event
    // pages remain the better-supported path for a persistent-ish listener set.
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'nocturne@tiltedlunar.github.io',
        // 140 is the floor for data_collection_permissions, which AMO has
        // required on new submissions since 2025-11-03.
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

/**
 * Strip comments, string literals and regex literals before scanning for
 * banned constructs, so a comment explaining why there is no fetch() does not
 * fail the build that proves there is no fetch().
 *
 * Regex literals have to be recognised, not just strings. `src/lib/signals.js`
 * genuinely contains patterns like /\[data-theme=["']?dark/i, and a scanner
 * that only knows about quotes treats that apostrophe as the start of a string
 * and swallows everything up to the next one. Whatever is inside that span
 * stops being scanned, which is a hole in a check that exists to be
 * unfoolable.
 *
 * Telling a regex literal from a division is decided by what came before: a
 * slash following a value (identifier, number, closing bracket) is division,
 * and a slash following an operator or an opening bracket starts a regex.
 */
function stripLiterals(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let previous = ''; // last significant character emitted

  const startsRegex = () => {
    if (!previous) return true;
    if (/[)\]}]/.test(previous)) return false;
    if (/[A-Za-z0-9_$]/.test(previous)) {
      // A keyword can precede a regex; an identifier or number cannot.
      return /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(
        out.replace(/\s+$/, '')
      );
    }
    return true;
  };

  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const ch = source[i];

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
      previous = '"';
      continue;
    }

    /*
     * Template literals keep their ${...} regions.
     *
     * Those regions are code, and stripping the whole template as one string
     * hides anything inside them from the scan. `${fetch(url)}` would sail
     * straight through a gate whose entire purpose is to be unfoolable.
     */
    if (ch === '`') {
      i++;
      let depth = 0;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (depth === 0 && c === '`') break;
        if (depth === 0 && c === '$' && source[i + 1] === '{') {
          depth = 1;
          out += ' ';
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) {
              out += ' ';
              i++;
              continue;
            }
          }
          out += c; // inside an interpolation: keep it as code
        }
        i++;
      }
      i++;
      out += '""';
      previous = '"';
      continue;
    }

    if (ch === '/' && startsRegex()) {
      i++;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // unterminated: treat as division after all
        i++;
      }
      i++;
      while (i < n && /[a-z]/.test(source[i])) i++; // flags
      out += '/RE/';
      previous = '/';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) previous = ch;
    i++;
  }
  return out;
}

const NETWORK_PATTERNS = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bnavigator\s*\.\s*sendBeacon\b/, 'sendBeacon'],
  [/\bnew\s+WebSocket\b/, 'WebSocket'],
  [/\bnew\s+EventSource\b/, 'EventSource'],
  [/\bimportScripts\s*\(/, 'importScripts'],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/\beval\s*\(/, 'eval'],
];

async function gateSource() {
  await walk(SRC, async (full) => {
    if (!/\.(js|mjs)$/.test(full)) return;
    const rel = path.relative(ROOT, full);
    const source = await fs.readFile(full, 'utf8');
    const stripped = stripLiterals(source);
    for (const [pattern, label] of NETWORK_PATTERNS) {
      if (pattern.test(stripped)) fail(`${rel} uses ${label}; Nocturne must make no network calls`);
    }
  });

  // Text files only. PNGs legitimately contain 0x1a and every other byte.
  await walk(SRC, async (full) => {
    if (!/\.(js|mjs|css|html|json|md|svg)$/.test(full)) return;
    const source = await fs.readFile(full, 'utf8');
    if (source.includes('—')) {
      fail(`${path.relative(ROOT, full)} contains an em dash`);
    }
    // A control character smuggled into a regex by an editor is invisible in
    // review and breaks at runtime. Tab, newline and carriage return excepted.
    const bad = source.match(CONTROL_CHARS);
    if (bad) {
      fail(`${path.relative(ROOT, full)} contains a raw control character (0x${bad[0].charCodeAt(0).toString(16)})`);
    }
  });
}

async function gateManifest(target, manifest, dir) {
  const label = `manifest.${target}`;

  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (manifest[key]) fail(`${label} declares ${key}`);
  }

  const permissions = manifest.permissions || [];
  for (const permission of permissions) {
    if (!ALLOWED_PERMISSIONS.includes(permission)) {
      fail(`${label} requests unexpected permission "${permission}"`);
    }
  }
  for (const permission of ALLOWED_PERMISSIONS) {
    if (!permissions.includes(permission)) fail(`${label} is missing permission "${permission}"`);
  }

  if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(['<all_urls>'])) {
    fail(`${label} must request <all_urls> as an OPTIONAL host permission only`);
  }

  const script = (manifest.content_scripts || [])[0];
  if (!script) fail(`${label} has no content script`);
  else {
    if (script.run_at !== 'document_start') {
      fail(`${label} content script must run at document_start or the flash returns`);
    }
    if (!script.css || !script.css.includes('content/guard.css')) {
      fail(`${label} content script must carry guard.css; it is the entire anti-flash story`);
    }
    if (!script.all_frames) fail(`${label} content script must run in all frames`);
  }

  if (manifest.description.length > 132) {
    fail(`${label} description is ${manifest.description.length} chars; the store limit is 132`);
  }

  if (target === 'firefox') {
    const gecko = (manifest.browser_specific_settings || {}).gecko || {};
    if (!gecko.data_collection_permissions) {
      fail(`${label} needs data_collection_permissions; AMO rejects new submissions without it`);
    }
    if (parseInt(gecko.strict_min_version, 10) < 140) {
      fail(`${label} strict_min_version must be at least 140 for data_collection_permissions`);
    }
    if (manifest.background.service_worker) fail(`${label} should use an event page, not a worker`);
  } else if (!manifest.background.service_worker) {
    fail(`${label} should use a service worker`);
  }

  // Every path the manifest names must exist in the built output.
  const referenced = new Set();
  const collect = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|css|html|png)$/.test(value)) referenced.add(value);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(manifest);
  for (const rel of referenced) {
    try {
      await fs.access(path.join(dir, rel));
    } catch {
      fail(`${label} references ${rel}, which is not in the build`);
    }
  }
}

/** PNG dimensions live at a fixed offset in the IHDR chunk. */
async function pngSize(file) {
  const buf = await fs.readFile(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function gateIcons() {
  for (const [name, expected] of Object.entries(REQUIRED_ICONS)) {
    const file = path.join(SRC, 'icons', name);
    let size;
    try {
      size = await pngSize(file);
    } catch {
      fail(`icons/${name} is missing`);
      continue;
    }
    if (!size) fail(`icons/${name} is not a PNG`);
    else if (size.width !== expected || size.height !== expected) {
      fail(`icons/${name} is ${size.width}x${size.height}, expected ${expected}x${expected}`);
    }
  }
}

async function gateVersions(base) {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== base.version) {
    fail(`package.json is v${pkg.version} but the manifest is v${base.version}`);
  }
  const changelog = await fs.readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8').catch(() => '');
  if (changelog && !changelog.includes(base.version)) {
    fail(`CHANGELOG.md has no entry for v${base.version}`);
  }
}

/** Node parses the bundle, so a syntax error fails the build not the browser. */
async function gateSyntax(dir) {
  const { execFile } = await import('node:child_process');
  const run = promisify(execFile);
  for (const name of ['background.js', 'content.js']) {
    try {
      await run(process.execPath, ['--check', path.join(dir, name)]);
    } catch (err) {
      fail(`${path.basename(dir)}/${name} is not valid JavaScript: ${String(err.stderr || err).slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal deflate zip. Store uploads are ordinary archives. */
async function writeZip(sourceDir, zipPath) {
  const files = [];
  await walk(sourceDir, async (full) => {
    files.push({
      name: path.relative(sourceDir, full).split(path.sep).join('/'),
      data: await fs.readFile(full),
    });
  });
  files.sort((a, b) => a.name.localeCompare(b.name));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const compressed = await deflate(f.data, { level: 9 });
    const useDeflate = compressed.length < f.data.length;
    const body = useDeflate ? compressed : f.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // deterministic timestamp
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  return files.length;
}

/**
 * A source archive, which AMO requires whenever the reviewed artefact is not
 * literally the source tree. Ours is concatenated, so it is.
 */
async function writeSourceZip(zipPath) {
  const staging = path.join(DIST, '_source');
  await rmrf(staging);
  await fs.mkdir(staging, { recursive: true });
  for (const entry of ['src', 'tools', 'test', 'test-pages', 'package.json', 'README.md', 'PLAN.md', 'PRIVACY.md', 'LICENSE', 'CHANGELOG.md']) {
    const from = path.join(ROOT, entry);
    try {
      await fs.cp(from, path.join(staging, entry), { recursive: true });
    } catch {
      /* optional entry */
    }
  }
  const count = await writeZip(staging, zipPath);
  await rmrf(staging);
  return count;
}

// ---------------------------------------------------------------------------

async function main() {
  const base = JSON.parse(await fs.readFile(path.join(SRC, 'manifest.base.json'), 'utf8'));
  await rmrf(DIST);

  const banner =
    `/* Nocturne v${base.version} - built from source by tools/build.mjs.\n` +
    ` * Not minified, not obfuscated, no bundler. Every file below is the\n` +
    ` * source file of the same name under src/. */\n`;

  for (const target of TARGETS) {
    const dir = path.join(DIST, target);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(path.join(dir, 'background.js'), await concat(BACKGROUND_MODULES, banner));
    await fs.writeFile(path.join(dir, 'content.js'), await concat(CONTENT_MODULES, banner));

    await fs.mkdir(path.join(dir, 'content'), { recursive: true });
    await fs.copyFile(
      path.join(SRC, 'content', 'guard.css'),
      path.join(dir, 'content', 'guard.css')
    );
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(dir, 'lib', 'ui.js'), await concat(UI_MODULES, banner));
    for (const sub of STATIC_DIRS) {
      await fs.cp(path.join(SRC, sub), path.join(dir, sub), { recursive: true });
    }

    const manifest = manifestFor(target, base);
    await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`built dist/${target}`);

    if (args.has('--check')) {
      await gateManifest(target, manifest, dir);
      await gateSyntax(dir);
    }
  }

  if (args.has('--check')) {
    await gateSource();
    await gateIcons();
    await gateVersions(base);
    if (problems.length) {
      console.error('\nRelease gate failed:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log('release gate passed');
  }

  if (args.has('--zip')) {
    await rmrf(RELEASE);
    for (const target of TARGETS) {
      const zip = path.join(RELEASE, `nocturne-${target}-v${base.version}.zip`);
      const n = await writeZip(path.join(DIST, target), zip);
      const { size } = await fs.stat(zip);
      console.log(`zipped ${target}: ${n} files, ${(size / 1024).toFixed(1)} KB`);
    }
    const sourceZip = path.join(RELEASE, `nocturne-source-v${base.version}.zip`);
    const n = await writeSourceZip(sourceZip);
    console.log(`zipped source: ${n} files`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
