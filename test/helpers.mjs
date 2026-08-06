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

/**
 * Just enough DOM for the popup and the settings page: ids, events, and text.
 *
 * Both are plain scripts that run against `document` the moment they load, so
 * a stub is all it takes to drive them from node. That matters for anything
 * whose behaviour depends on the browser it is running in, or on the ordering
 * of two replies, neither of which the end to end suite can arrange.
 */
export function makeDom(ids) {
  const byId = new Map();

  function makeEl(id) {
    const listeners = {};
    const el = {
      id: id || '',
      children: [],
      style: {},
      dataset: {},
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      type: '',
      href: '',
      download: '',
      title: '',
      setAttribute(name, value) {
        el[`attr:${name}`] = value;
      },
      getAttribute(name) {
        return el[`attr:${name}`] ?? null;
      },
      removeAttribute(name) {
        delete el[`attr:${name}`];
      },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      append(...kids) {
        el.children.push(...kids);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      click() {},
      close() {},
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      /** Deliver an event the way a click or a keystroke would. */
      fire(type, event = {}) {
        const detail = { target: el, ...event };
        return Promise.all((listeners[type] || []).map((fn) => fn(detail)));
      },
      listeners,
    };
    return el;
  }

  for (const id of ids) byId.set(id, makeEl(id));

  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => makeEl(''),
    querySelectorAll: () => [],
    body: makeEl('body'),
  };
  return { document, byId, makeEl };
}

/**
 * Run one of the extension's own pages over that stub, in its own realm.
 *
 * `globals` is merged into the sandbox, which is how a test picks the engine
 * (via navigator.userAgent) or supplies a stub extension API.
 */
export function loadPage(page, { ids, globals = {}, libs = ['color', 'theme', 'settings', 'browser'] }) {
  const { document, byId } = makeDom(ids);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Object, Array, String, Number, Boolean, Date, Promise, Error,
    setTimeout,
    document,
    ...globals,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const name of libs) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'lib', `${name}.js`), 'utf8'), sandbox, {
      filename: `${name}.js`,
    });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', page), 'utf8'), sandbox, {
    filename: page,
  });
  return { byId, NX: sandbox.NX, sandbox };
}
