/**
 * Loads the source libraries into a sandbox that looks enough like a browser
 * global for them to attach to `NX`. They ship as classic scripts, so there is
 * nothing to import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadLibs(names, extraGlobals = {}) {
  const sandbox = { console, Math, JSON, Object, Array, String, Number, ...extraGlobals };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of names) {
    // A bare name is a library; anything with a slash is a path under src/,
    // which is how the content-script helpers get exercised too.
    const rel = name.includes('/') ? `${name}.js` : path.join('lib', `${name}.js`);
    const file = path.join(ROOT, 'src', rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: `${name}.js` });
  }
  return sandbox.NX;
}

/**
 * Round-trip helper: rgb 0..1 triple to 0..255 integers for readable asserts.
 *
 * Array.from rather than .map on purpose. The libraries run inside a vm
 * context, so arrays they build carry that realm's Array.prototype and
 * deepStrictEqual rejects them against an identical-looking local array.
 * Array.from rebuilds the value in this realm.
 */
export const bytes = (rgb) =>
  Array.from(rgb, (c) => Math.round(Math.max(0, Math.min(1, c)) * 255));

export const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
