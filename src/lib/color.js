/**
 * Colour parsing and perceptual transforms.
 *
 * Two things here are load bearing and neither is optional.
 *
 * First, the parser accepts every colour syntax a 2026 browser can hand back
 * from getComputedStyle, not just rgb(). `tools/probe-colors.mjs` proved that
 * oklch(), oklab(), lab(), lch() and color() are returned VERBATIM rather than
 * being converted, and that color-mix() resolves to oklab(). A parser written
 * for the rgb()-only world silently fails on every site built with a modern
 * token pipeline, which today means a very large share of them.
 *
 * Second, all lightness work happens in OKLCh. OKLCh is perceptually uniform,
 * so moving lightness leaves hue and saturation where the designer put them.
 * Doing the same job in HSL is what produces the muddy yellows and shifted
 * brand colours that this whole category is known for.
 *
 * Classic script: attaches to the NX global, no modules, no bundler.
 */
(function (global) {
  'use strict';

  const NX = (global.NX = global.NX || {});

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const cbrt = (x) => Math.cbrt(x);

  // --- small matrix helpers -----------------------------------------------
  // Only forward matrices are written down. Inverses are computed, because a
  // mistyped digit in a hand-copied inverse is invisible until a colour is
  // subtly wrong on one site.

  function mul(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
  }

  function invert(m) {
    const [a, b, c] = m[0];
    const [d, e, f] = m[1];
    const [g, h, i] = m[2];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (!det) return null;
    return [
      [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
  }

  // --- chromatic adaptation ------------------------------------------------

  const D65_TO_D50 = [
    [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
    [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
    [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
  ];
  const D50_TO_D65 = invert(D65_TO_D50);

  // --- rgb working spaces ---------------------------------------------------
  // Each entry: linear-space to XYZ matrix, its white point, and the transfer
  // functions in both directions.

  const srgbTransfer = {
    toLinear: (c) => {
      const s = Math.sign(c) || 1;
      const a = Math.abs(c);
      return a <= 0.04045 ? c / 12.92 : s * Math.pow((a + 0.055) / 1.055, 2.4);
    },
    fromLinear: (c) => {
      const s = Math.sign(c) || 1;
      const a = Math.abs(c);
      return a <= 0.0031308 ? c * 12.92 : s * (1.055 * Math.pow(a, 1 / 2.4) - 0.055);
    },
  };

  const gammaTransfer = (g) => ({
    toLinear: (c) => (Math.sign(c) || 1) * Math.pow(Math.abs(c), g),
    fromLinear: (c) => (Math.sign(c) || 1) * Math.pow(Math.abs(c), 1 / g),
  });

  const prophotoTransfer = {
    toLinear: (c) => {
      const s = Math.sign(c) || 1;
      const a = Math.abs(c);
      return a <= 16 / 512 ? c / 16 : s * Math.pow(a, 1.8);
    },
    fromLinear: (c) => {
      const s = Math.sign(c) || 1;
      const a = Math.abs(c);
      return a >= 0.001953125 ? s * Math.pow(a, 1 / 1.8) : c * 16;
    },
  };

  const REC2020_A = 1.09929682680944;
  const REC2020_B = 0.018053968510807;
  const rec2020Transfer = {
    toLinear: (c) => {
      const s = Math.sign(c) || 1;
      const a = Math.abs(c);
      return a < REC2020_B * 4.5
        ? c / 4.5
        : s * Math.pow((a + REC2020_A - 1) / REC2020_A, 1 / 0.45);
    },
    fromLinear: (c) => {
      const s = Math.sign(c) || 1;
      const a = Math.abs(c);
      return a > REC2020_B ? s * (REC2020_A * Math.pow(a, 0.45) - (REC2020_A - 1)) : c * 4.5;
    },
  };

  const SPACES = {
    srgb: {
      toXyz: [
        [0.4123907992659595, 0.35758433938387796, 0.1804807884018343],
        [0.21263900587151036, 0.7151686787677559, 0.07219231536073371],
        [0.019330818715591851, 0.11919477979462599, 0.9505321522496606],
      ],
      white: 'd65',
      transfer: srgbTransfer,
    },
    'srgb-linear': { alias: 'srgb', linear: true },
    'display-p3': {
      toXyz: [
        [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
        [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
        [0.0, 0.04511338185890264, 1.043944368900976],
      ],
      white: 'd65',
      transfer: srgbTransfer,
    },
    'a98-rgb': {
      toXyz: [
        [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
        [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
        [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
      ],
      white: 'd65',
      transfer: gammaTransfer(563 / 256),
    },
    'prophoto-rgb': {
      toXyz: [
        [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
        [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
        [0.0, 0.0, 0.8251046025104601],
      ],
      white: 'd50',
      transfer: prophotoTransfer,
    },
    rec2020: {
      toXyz: [
        [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
        [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
        [0.0, 0.028072693049087428, 1.060985057710791],
      ],
      white: 'd65',
      transfer: rec2020Transfer,
    },
  };

  for (const key of Object.keys(SPACES)) {
    const space = SPACES[key];
    if (space.alias) continue;
    space.fromXyz = invert(space.toXyz);
  }

  /** Convert a colour in an arbitrary rgb working space to sRGB, 0..1. */
  function spaceToSrgb(name, coords) {
    if (name === 'xyz' || name === 'xyz-d65') return xyzToSrgb(coords);
    if (name === 'xyz-d50') return xyzToSrgb(mul(D50_TO_D65, coords));

    let key = name;
    let linear = false;
    if (SPACES[key] && SPACES[key].alias) {
      linear = !!SPACES[key].linear;
      key = SPACES[key].alias;
    }
    const space = SPACES[key];
    if (!space) return null;

    const lin = linear ? coords.slice() : coords.map(space.transfer.toLinear);
    let xyz = mul(space.toXyz, lin);
    if (space.white === 'd50') xyz = mul(D50_TO_D65, xyz);
    return xyzToSrgb(xyz);
  }

  function xyzToSrgb(xyz) {
    const lin = mul(SPACES.srgb.fromXyz, xyz);
    return lin.map(SPACES.srgb.transfer.fromLinear);
  }

  function srgbToXyz(rgb) {
    return mul(SPACES.srgb.toXyz, rgb.map(SPACES.srgb.transfer.toLinear));
  }

  // --- OKLab / OKLCh --------------------------------------------------------

  function srgbToOklab(rgb) {
    const r = SPACES.srgb.transfer.toLinear(rgb[0]);
    const g = SPACES.srgb.transfer.toLinear(rgb[1]);
    const b = SPACES.srgb.transfer.toLinear(rgb[2]);

    const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabToSrgb(lab) {
    const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    return [
      SPACES.srgb.transfer.fromLinear(
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
      ),
      SPACES.srgb.transfer.fromLinear(
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
      ),
      SPACES.srgb.transfer.fromLinear(
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
      ),
    ];
  }

  const labToLch = (lab) => {
    const c = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
    let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
    if (h < 0) h += 360;
    // Hue is meaningless at zero chroma and a stray value there causes visible
    // drift once chroma is later restored.
    return [lab[0], c, c < 1e-6 ? 0 : h];
  };

  const lchToLab = (lch) => {
    const rad = (lch[2] * Math.PI) / 180;
    return [lch[0], lch[1] * Math.cos(rad), lch[1] * Math.sin(rad)];
  };

  // --- CIE Lab (D50), as used by CSS lab() and lch() -----------------------

  const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  const LAB_E = 216 / 24389;
  const LAB_K = 24389 / 27;

  function cielabToSrgb(lab) {
    const fy = (lab[0] + 16) / 116;
    const fx = lab[1] / 500 + fy;
    const fz = fy - lab[2] / 200;

    const x = fx ** 3 > LAB_E ? fx ** 3 : (116 * fx - 16) / LAB_K;
    const y = lab[0] > LAB_K * LAB_E ? ((lab[0] + 16) / 116) ** 3 : lab[0] / LAB_K;
    const z = fz ** 3 > LAB_E ? fz ** 3 : (116 * fz - 16) / LAB_K;

    const xyzD50 = [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]];
    return xyzToSrgb(mul(D50_TO_D65, xyzD50));
  }

  // --- named colours --------------------------------------------------------
  // Needed despite computed style resolving names to rgb(), because custom
  // property values and raw stylesheet text are NOT resolved.

  const NAMED = {
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
    azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
    blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
    burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
    coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
    darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
    darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00',
    darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
    darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f',
    darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493',
    deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff',
    firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff',
    gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520',
    gray: '808080', green: '008000', greenyellow: 'adff2f', grey: '808080',
    honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082',
    ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5',
    lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080',
    lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
    lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
    lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899',
    lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0',
    lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff',
    maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd',
    mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
    mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
    mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa',
    mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
    oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500',
    orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98',
    paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5',
    peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
    powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000',
    rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072',
    sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d',
    silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
    slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
    tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
    turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
    whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
  };

  // --- parsing ---------------------------------------------------------------

  /**
   * Split the inside of a functional notation on top-level separators.
   * Depth aware, so color-mix(in oklab, rgb(1,2,3), blue) survives.
   */
  function splitArgs(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && (ch === ',' || ch === ' ' || ch === '\t' || ch === '\n')) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /** A component that may be a number, a percentage, or `none`. */
  function num(token, scale) {
    if (token == null) return 0;
    const t = String(token).trim().toLowerCase();
    if (t === 'none') return 0;
    if (t.endsWith('%')) {
      const v = parseFloat(t);
      return Number.isNaN(v) ? 0 : (v / 100) * (scale === undefined ? 1 : scale);
    }
    const v = parseFloat(t);
    return Number.isNaN(v) ? 0 : v;
  }

  /** Hue accepts deg / rad / grad / turn. */
  function hue(token) {
    if (token == null) return 0;
    const t = String(token).trim().toLowerCase();
    if (t === 'none') return 0;
    const v = parseFloat(t);
    if (Number.isNaN(v)) return 0;
    // grad must be tested before rad: "400grad".endsWith("rad") is true, so
    // the obvious ordering silently reads gradians as radians.
    if (t.endsWith('grad')) return v * 0.9;
    if (t.endsWith('rad')) return (v * 180) / Math.PI;
    if (t.endsWith('turn')) return v * 360;
    return v;
  }

  function alphaOf(token) {
    if (token == null) return 1;
    const t = String(token).trim().toLowerCase();
    if (t === 'none') return 1;
    if (t.endsWith('%')) return clamp(parseFloat(t) / 100, 0, 1);
    const v = parseFloat(t);
    return Number.isNaN(v) ? 1 : clamp(v, 0, 1);
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }

  function hwbToRgb(h, w, b) {
    w = clamp(w, 0, 1);
    b = clamp(b, 0, 1);
    if (w + b >= 1) {
      const g = w / (w + b);
      return [g, g, g];
    }
    return hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w);
  }

  /**
   * Parse any CSS colour into { rgb: [r,g,b] in 0..1 (may be out of gamut), a }.
   * Returns null for anything that is not a colour, including `none`,
   * `currentColor` and `inherit`, which callers must handle as "leave alone".
   */
  function parse(input) {
    if (input == null) return null;
    let text = String(input).trim();
    if (!text) return null;

    const lower = text.toLowerCase();
    if (lower === 'transparent') return { rgb: [0, 0, 0], a: 0 };
    if (
      lower === 'currentcolor' ||
      lower === 'inherit' ||
      lower === 'initial' ||
      lower === 'unset' ||
      lower === 'revert' ||
      lower === 'none' ||
      lower === 'auto'
    ) {
      return null;
    }

    if (Object.prototype.hasOwnProperty.call(NAMED, lower)) {
      text = '#' + NAMED[lower];
    }

    if (text[0] === '#') {
      const hex = text.slice(1);
      // Validate length and alphabet together, before any branch parses a
      // digit. Checking inside one branch only lets #zzz through as NaN.
      if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
      if (hex.length <= 4) {
        const expand = (c) => parseInt(c + c, 16) / 255;
        return {
          rgb: [expand(hex[0]), expand(hex[1]), expand(hex[2])],
          a: hex.length === 4 ? expand(hex[3]) : 1,
        };
      }
      const byte = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
      return {
        rgb: [byte(0), byte(2), byte(4)],
        a: hex.length === 8 ? byte(6) : 1,
      };
    }

    const open = text.indexOf('(');
    if (open === -1 || !text.endsWith(')')) return null;
    const fn = text.slice(0, open).trim().toLowerCase();
    const body = text.slice(open + 1, -1);

    /*
     * Relative colour syntax is a derivation, not a list of components.
     *
     * `rgb(from var(--brand) r g b)` means "that colour, rebuilt from its own
     * channels". Split positionally, `from` and the origin colour land in the
     * r and g slots, every channel reads as non-numeric, and the value
     * resolves to black. Custom properties are where it lands: the engine
     * substitutes the var() but does not evaluate the relative form, so the
     * token tier read a brand colour as black and then wrote that back onto
     * :root with !important, which the site's own definition cannot outrank.
     *
     * Refusing it hands callers the same null they already treat as "not a
     * colour I can reason about, leave the value alone", which is the honest
     * answer here.
     */
    if (/^\s*from\b/i.test(body)) return null;

    // Slash-separated alpha, at top level only.
    let alphaToken = null;
    let head = body;
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
      else if (body[i] === '/' && depth === 0) {
        head = body.slice(0, i);
        alphaToken = body.slice(i + 1);
        break;
      }
    }

    const args = splitArgs(head);

    /*
     * A fourth positional component is alpha ONLY in the legacy comma forms.
     *
     * In every modern function alpha arrives after a slash, and the fourth
     * slot means something else entirely: for `color()` it is the third
     * channel, because the space name occupies the first slot. Reading it as
     * alpha turns `color(srgb 1 0 0)` into a fully transparent red, which is
     * then skipped everywhere as "transparent" and never themed at all.
     */
    const LEGACY_POSITIONAL_ALPHA = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
    const a =
      alphaToken != null
        ? alphaOf(alphaToken)
        : LEGACY_POSITIONAL_ALPHA.has(fn) && args.length > 3
          ? alphaOf(args[3])
          : 1;

    switch (fn) {
      case 'rgb':
      case 'rgba': {
        const isPct = String(args[0]).trim().endsWith('%');
        const c = (t) => (isPct ? num(t, 1) : num(t) / 255);
        return { rgb: [c(args[0]), c(args[1]), c(args[2])], a };
      }
      case 'hsl':
      case 'hsla':
        return { rgb: hslToRgb(hue(args[0]), num(args[1], 1), num(args[2], 1)), a };
      case 'hwb':
        return { rgb: hwbToRgb(hue(args[0]), num(args[1], 1), num(args[2], 1)), a };
      case 'oklab':
        return { rgb: oklabToSrgb([num(args[0], 1), num(args[1], 0.4), num(args[2], 0.4)]), a };
      case 'oklch':
        return {
          rgb: oklabToSrgb(
            lchToLab([num(args[0], 1), num(args[1], 0.4), hue(args[2])])
          ),
          a,
        };
      case 'lab':
        return { rgb: cielabToSrgb([num(args[0], 100), num(args[1], 125), num(args[2], 125)]), a };
      case 'lch':
        return {
          rgb: cielabToSrgb(lchToLab([num(args[0], 100), num(args[1], 150), hue(args[2])])),
          a,
        };
      case 'color': {
        const space = String(args[0] || '').toLowerCase();
        const coords = [num(args[1], 1), num(args[2], 1), num(args[3], 1)];
        const rgb = spaceToSrgb(space, coords);
        return rgb ? { rgb, a } : null;
      }
      default:
        // color-mix() and relative colour syntax are resolved by the engine
        // before they ever reach here (the probe showed color-mix computes to
        // oklab). Anything else is not a colour we can reason about.
        return null;
    }
  }

  // --- gamut mapping ---------------------------------------------------------

  const inGamut = (rgb, eps) =>
    rgb.every((c) => c >= -(eps || 1e-5) && c <= 1 + (eps || 1e-5));

  /**
   * Bring an OKLCh colour into sRGB by reducing chroma, never by clipping
   * channels. Clipping shifts hue, which is exactly the artefact this whole
   * module exists to avoid.
   */
  function gamutMap(lch) {
    const l = clamp(lch[0], 0, 1);
    if (l <= 0) return [0, 0, 0];
    if (l >= 1) return [1, 1, 1];

    let rgb = oklabToSrgb(lchToLab([l, lch[1], lch[2]]));
    if (inGamut(rgb)) return rgb.map((c) => clamp(c, 0, 1));

    let lo = 0;
    let hi = lch[1];
    for (let i = 0; i < 24 && hi - lo > 1e-4; i++) {
      const mid = (lo + hi) / 2;
      rgb = oklabToSrgb(lchToLab([l, mid, lch[2]]));
      if (inGamut(rgb)) lo = mid;
      else hi = mid;
    }
    return oklabToSrgb(lchToLab([l, lo, lch[2]])).map((c) => clamp(c, 0, 1));
  }

  // --- conversions exposed to the engine -------------------------------------

  const toOklch = (rgb) => labToLch(srgbToOklab(rgb));
  const fromOklch = (lch) => gamutMap(lch);

  /** Serialise back to a value the browser will accept. */
  function format(rgb, a) {
    const byte = (c) => Math.round(clamp(c, 0, 1) * 255);
    const r = byte(rgb[0]);
    const g = byte(rgb[1]);
    const b = byte(rgb[2]);
    if (a == null || a >= 1) return `rgb(${r}, ${g}, ${b})`;
    return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
  }

  /**
   * Relative luminance, used for the contrast check.
   * WCAG's own formula, because it is what accessibility tooling measures.
   */
  function luminance(rgb) {
    const lin = rgb.map((c) => SPACES.srgb.transfer.toLinear(clamp(c, 0, 1)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  NX.color = {
    parse,
    format,
    toOklch,
    fromOklch,
    gamutMap,
    luminance,
    contrast,
    clamp,
    inGamut,
    // exposed for tests
    _internal: { srgbToOklab, oklabToSrgb, cielabToSrgb, spaceToSrgb, splitArgs, NAMED },
  };
})(typeof self !== 'undefined' ? self : globalThis);
