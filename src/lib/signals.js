/**
 * How sites express "I am in dark mode".
 *
 * Most sites that support dark mode in 2026 do it with a class or attribute on
 * the root element, toggled by their own script, rather than with a media
 * query. Framework conventions have converged enough that a short list covers
 * an enormous share of the web.
 *
 * Nothing here is trusted blindly. A signal is only a candidate; the ladder
 * applies it, measures whether the page actually went dark, and discards it if
 * not. That is why a wrong guess is cheap and why this list does not need to be
 * exhaustive to be useful.
 *
 * These are structural conventions, not per-site hacks, so the list does not
 * rot the way a site-fix database does.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});

  /**
   * Each signal declares how to spot it in a stylesheet and how to turn it on.
   * `match` is tested against selector text; `apply` and `revert` mutate the
   * root element and nothing else.
   */
  const SIGNALS = [
    {
      id: 'class-dark',
      // Tailwind's default dark variant, and the most common convention overall.
      match: /(^|[\s,>+~])(html|:root)?\.dark(\b|[\s,:.\[])/i,
      attr: null,
      className: 'dark',
    },
    {
      id: 'data-theme-dark',
      // Docusaurus, daisyUI, many hand-rolled implementations.
      match: /\[data-theme\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['data-theme', 'dark'],
    },
    {
      id: 'data-bs-theme',
      // Bootstrap 5.3+.
      match: /\[data-bs-theme\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['data-bs-theme', 'dark'],
    },
    {
      id: 'data-color-mode',
      // GitHub's primer convention: mode plus which dark theme to use.
      match: /\[data-color-mode\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['data-color-mode', 'dark'],
      extraAttrs: [['data-dark-theme', 'dark']],
    },
    {
      id: 'data-color-scheme',
      match: /\[data-color-scheme\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['data-color-scheme', 'dark'],
    },
    {
      id: 'data-mode-dark',
      match: /\[data-mode\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['data-mode', 'dark'],
    },
    {
      id: 'data-scheme-dark',
      match: /\[data-scheme\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['data-scheme', 'dark'],
    },
    {
      id: 'attr-theme-dark',
      match: /\[theme\s*[~|^$*]?=\s*["']?dark/i,
      attr: ['theme', 'dark'],
    },
    {
      id: 'class-theme-dark',
      match: /(^|[\s,>+~])(html|:root)?\.theme-dark(\b|[\s,:.\[])/i,
      className: 'theme-dark',
    },
    {
      id: 'class-dark-mode',
      match: /(^|[\s,>+~])(html|:root)?\.dark-mode(\b|[\s,:.\[])/i,
      className: 'dark-mode',
    },
    {
      id: 'class-darkmode',
      match: /(^|[\s,>+~])(html|:root)?\.darkmode(\b|[\s,:.\[])/i,
      className: 'darkmode',
    },
    {
      id: 'class-chakra-dark',
      match: /\.chakra-ui-dark(\b|[\s,:.\[])/i,
      className: 'chakra-ui-dark',
    },
    {
      id: 'md-color-scheme-slate',
      // MkDocs Material names its dark scheme "slate" rather than "dark".
      match: /\[data-md-color-scheme\s*[~|^$*]?=\s*["']?slate/i,
      attr: ['data-md-color-scheme', 'slate'],
    },
    {
      id: 'attr-dark',
      // Bare boolean attribute, used by several web-component design systems.
      match: /(^|[\s,>+~])(html|:root)?\[dark\]/i,
      attr: ['dark', ''],
    },
    {
      id: 'class-night',
      match: /(^|[\s,>+~])(html|:root)?\.night(-mode)?(\b|[\s,:.\[])/i,
      className: 'night',
    },
  ];

  /** Apply a signal to a root element. Returns an undo function. */
  function apply(signal, root) {
    const undo = [];
    if (signal.className) {
      const had = root.classList.contains(signal.className);
      root.classList.add(signal.className);
      undo.push(() => {
        if (!had) root.classList.remove(signal.className);
      });
    }
    const attrs = [];
    if (signal.attr) attrs.push(signal.attr);
    if (signal.extraAttrs) attrs.push(...signal.extraAttrs);
    for (const [name, value] of attrs) {
      const had = root.hasAttribute(name);
      const previous = had ? root.getAttribute(name) : null;
      root.setAttribute(name, value);
      undo.push(() => {
        if (had) root.setAttribute(name, previous);
        else root.removeAttribute(name);
      });
    }
    return () => undo.forEach((fn) => fn());
  }

  /** Is this signal already switched on by the page itself? */
  function alreadyOn(signal, root) {
    if (signal.className && root.classList.contains(signal.className)) return true;
    if (signal.attr) {
      const [name, value] = signal.attr;
      if (root.getAttribute(name) === value) return true;
      if (value === '' && root.hasAttribute(name)) return true;
    }
    return false;
  }

  /**
   * Which signals does this document's own CSS appear to support?
   * `selectors` is the pooled selector text the caller harvested from readable
   * stylesheets.
   */
  function detect(selectorText) {
    const found = [];
    for (const signal of SIGNALS) {
      if (signal.match.test(selectorText)) found.push(signal);
    }
    return found;
  }

  NX.signals = { SIGNALS, detect, apply, alreadyOn };
})(typeof self !== 'undefined' ? self : globalThis);
