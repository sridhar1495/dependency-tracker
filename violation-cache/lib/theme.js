// SPDX-License-Identifier: MIT
//
// The administrator's colour theme: validation, and the CSS it becomes.
//
// ── Q50: the stored artefact is JSON, not a stylesheet ───────────────────────
// Accepting raw CSS would mean serving operator-authored CSS from our own
// origin to unauthenticated visitors on the sign-in page. CSS can load external
// resources (@import, url()), can position and cover elements, and can leak
// attribute values through selector-triggered background fetches. We already
// refuse SVG for the icon (S32) for a weaker version of this reason — a
// stylesheet is strictly more dangerous than an image.
//
// So this module never parses CSS and never echoes input. It validates a fixed
// key set against a narrow value grammar and RENDERS the stylesheet from an
// allow-list (S35 below).
//
// ── Q49: partial overrides need no merge logic ───────────────────────────────
// The obvious implementation merges the operator's document over a table of
// defaults and emits a complete set. That is a merge function, a defaults table
// duplicated outside the stylesheet, and a drift risk the moment somebody adds
// a token to :root and forgets the table.
//
// None of it is necessary: the cascade already does exactly this. The pages
// keep their built-in :root and [data-theme="light"] blocks and link the
// generated stylesheet AFTER them, at the same specificity. A property the
// theme supplies wins because it comes later; a property it omits keeps the
// built-in value because nothing overrode it. The fallback is per property,
// which is the requirement stated precisely — and a token added to :root later
// becomes themeable with no change here.
//
// Two consequences are load-bearing:
//   - The built-in blocks are never removed or rewritten. They ARE the
//     fallback, so a theme that fails to load leaves a correct page rather
//     than an unstyled one.
//   - The generated block must not raise specificity. `:root` and
//     `:root[data-theme="light"]`, never `html:root` and never `!important`:
//     a theme that wins by force could not itself be partially overridden by
//     the light block that follows it.

'use strict';

// ── The token surface ────────────────────────────────────────────────────────
// Keys are the token names WITHOUT the `--` prefix. The prefix is ours;
// requiring an operator to type CSS syntax inside a JSON file invites them to
// think the rest of it is CSS too.
//
// Geometry (--header-h, --row-h, --radius) is deliberately absent. It is
// layout, not colour: --row-h is read by the table's measured geometry and
// --header-h by the sticky header, so theming them turns a colour feature into
// a layout feature with its own failure modes. --radius alone could be added
// later with no format change, which is what `version` is for.
const TOKENS = Object.freeze({
  // Surfaces and text
  bg:            '#0f1117',
  surface:       '#1a1d27',
  surface2:      '#21253a',
  border:        '#2e3352',
  text:          '#e2e8f0',
  'text-muted':  '#8892a4',
  accent:        '#6366f1',
  'accent-hover': '#4f46e5',
  'on-accent':   '#ffffff',
  'on-critical': '#ffffff',

  // Severity
  critical:      '#ef4444',
  'critical-bg': 'rgba(239,68,68,0.12)',
  high:          '#f97316',
  'high-bg':     'rgba(249,115,22,0.12)',
  medium:        '#eab308',
  'medium-bg':   'rgba(234,179,8,0.12)',
  low:           '#3b82f6',
  'low-bg':      'rgba(59,130,246,0.12)',
  ok:            '#22c55e',
  'ok-bg':       'rgba(34,197,94,0.08)',

  // Table column groups, code blocks, scrollbars
  'cat-operations':  '#a78bfa',
  'cat-secpolicy':   '#06b6d4',
  code:              '#a5f3fc',
  scrollbar:         '#2e3352',
  'scrollbar-hover': '#8892a4',

  // Q54: the tree's three row kinds (§8.7, Q39/Q53) — a group row, a leaf
  // the roll-up counts, and a leaf it does not.
  'tree-group-bg':     'rgba(99,102,241,0.035)',
  'tree-counted-bg':   'rgba(99,102,241,0.09)',
  'tree-uncounted-bg': 'rgba(148,163,184,0.10)',

  // The sign-in page
  'login-blob-1':       '#6366f1',
  'login-blob-2':       '#8b5cf6',
  'login-blob-3':       '#06b6d4',
  'login-blob-4':       '#3b82f6',
  'login-blob-admin-1': '#f59e0b',
  'login-blob-admin-2': '#ef4444',
  'login-blob-admin-3': '#f97316',
  'login-blob-admin-4': '#eab308',
  'logo-gradient-end':  '#8b5cf6',
});

// The built-in light scheme, for the downloadable template. Only the tokens
// that actually differ from the dark ones are listed; the rest are identical
// and the template repeats them so an operator sees the whole surface.
const LIGHT_OVERRIDES = Object.freeze({
  bg:            '#f0f2f8',
  surface:       '#ffffff',
  surface2:      '#e8ecf5',
  border:        '#c8d0e0',
  text:          '#1a2035',
  'text-muted':  '#5c6a85',
  accent:        '#4f52d9',
  'accent-hover': '#4043c4',
  critical:      '#dc2626',
  'critical-bg': 'rgba(220,38,38,0.10)',
  high:          '#ea6500',
  'high-bg':     'rgba(234,101,0,0.10)',
  medium:        '#b45309',
  'medium-bg':   'rgba(180,83,9,0.10)',
  low:           '#1d4ed8',
  'low-bg':      'rgba(29,78,216,0.10)',
  ok:            '#15803d',
  'ok-bg':       'rgba(21,128,61,0.08)',
  'cat-operations':  '#7c3aed',
  'cat-secpolicy':   '#0e7490',
  code:              '#1d4ed8',
  scrollbar:         '#8899bb',
  'scrollbar-hover': '#5c6a85',
  'tree-group-bg':     'rgba(79,82,217,0.05)',
  'tree-counted-bg':   'rgba(79,82,217,0.11)',
  'tree-uncounted-bg': 'rgba(92,106,133,0.10)',
});

const SCHEMES = Object.freeze(['dark', 'light']);
const FORMAT_VERSION = 1;

// Q4: tuneable bounds at the top of the file.
const MAX_NAME = 60;
// A complete theme is under 2 KB. The ceiling exists so the route's body
// reader has one and so a pathological file cannot generate a large sheet.
const MAX_BYTES = 64 * 1024;
const MAX_PROPERTIES = 200;
// How many problems a rejection lists. More than this is a file with a
// different kind of problem, and a wall of errors reads as a crash.
const MAX_ERRORS = 10;

// ── The value grammar ────────────────────────────────────────────────────────
// Two forms and nothing else. No named colours (`rebeccapurple` is valid CSS
// and a needless lookup table), no hsl(), no var(), no calc(), no gradients.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGBA = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/;

/**
 * Normalise one colour, or return null if it is not one.
 *
 * S35: the return value is rebuilt from the parsed components rather than the
 * input string, so what reaches the stylesheet can only ever be a colour this
 * function constructed. Even a validation mistake could not carry a `}` or a
 * `</style>` through.
 */
function normaliseColour(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();

  if (HEX.test(v)) return '#' + v.slice(1).toLowerCase();

  const m = RGBA.exec(v);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  if ([r, g, b].some(n => n > 255)) return null;
  if (m[4] === undefined) return `rgb(${r},${g},${b})`;
  const a = Number(m[4]);
  if (!(a >= 0 && a <= 1)) return null;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Validate an uploaded theme document.
 *
 * Returns { ok: true, doc } with a normalised document, or
 * { ok: false, errors: string[] } naming every problem it found.
 *
 * Q51: it refuses, it never repairs. A value that does not match is rejected
 * with its key named — not dropped, not coerced. An operator who typed
 * `#12345` and got a page with one silently-ignored property would go looking
 * for the bug in the wrong place. An unknown KEY is refused for the same
 * reason: the usual argument for ignoring one is forward compatibility, but
 * here the far more likely cause is a typo (`acccent`), and discarding it
 * silently produces a theme that "didn't work" with nothing to explain why.
 */
function validate(input) {
  const errors = [];
  const push = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['The file must contain a single JSON object.'] };
  }

  if (input.version !== FORMAT_VERSION) {
    push(`"version" must be ${FORMAT_VERSION} — got ${JSON.stringify(input.version)}.`);
  }

  let name = null;
  if (input.name !== undefined && input.name !== null && input.name !== '') {
    if (typeof input.name !== 'string') push('"name" must be text.');
    else if (input.name.length > MAX_NAME) push(`"name" is longer than ${MAX_NAME} characters.`);
    else name = input.name.trim();
  }

  for (const key of Object.keys(input)) {
    if (key !== 'version' && key !== 'name' && !SCHEMES.includes(key)) {
      push(`"${key}" is not part of a theme — expected ${SCHEMES.join(', ')}, version or name.`);
    }
  }

  // The property ceiling is checked FIRST, and returns on its own. Left until
  // after per-key validation it was unreachable: a document with more than 200
  // properties necessarily contains keys the allow-list does not know, so the
  // error list filled with ten "not a theme property" lines and the size — the
  // actual problem — was never mentioned. Size is about work, not spelling,
  // so it is answered before any spelling is looked at.
  let count = 0;
  for (const scheme of SCHEMES) {
    const block = input[scheme];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      count += Object.keys(block).length;
    }
  }
  if (count > MAX_PROPERTIES) {
    return { ok: false, errors: [
      `A theme may set at most ${MAX_PROPERTIES} properties; this one sets ${count}.`,
    ] };
  }

  const doc = { version: FORMAT_VERSION, name };

  for (const scheme of SCHEMES) {
    const block = input[scheme];
    if (block === undefined || block === null) continue;
    if (typeof block !== 'object' || Array.isArray(block)) {
      push(`"${scheme}" must be an object of colour properties.`);
      continue;
    }
    const out = {};
    for (const [key, value] of Object.entries(block)) {
      if (!Object.prototype.hasOwnProperty.call(TOKENS, key)) {
        push(`${scheme}.${key} is not a theme property.`);
        continue;
      }
      const colour = normaliseColour(value);
      if (colour === null) {
        push(`${scheme}.${key}: ${JSON.stringify(value)} is not a colour `
             + '(use #rgb, #rrggbb or rgba(r,g,b,a)).');
        continue;
      }
      out[key] = colour;
    }
    if (Object.keys(out).length > 0) doc[scheme] = out;
  }

  if (!doc.dark && !doc.light && errors.length === 0) {
    push('The theme sets nothing — supply at least one property under "dark" or "light".');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc };
}

/**
 * Render a validated document as the stylesheet `/branding/theme.css` serves.
 *
 * S35: built from a fixed template, never from the input. The key written is
 * the ALLOW-LIST's spelling, not the document's, and the value has already
 * been re-serialised by `normaliseColour`. Nothing the operator supplied is
 * concatenated into the output verbatim.
 */
function toCss(doc) {
  const lines = [
    '/* Generated from the administrator\'s theme. Do not edit by hand. */',
  ];
  const block = (selector, values) => {
    const keys = Object.keys(values || {}).filter(k => k in TOKENS).sort();
    if (keys.length === 0) return;
    lines.push(`${selector} {`);
    for (const key of keys) {
      const colour = normaliseColour(values[key]);
      if (colour === null) continue;   // unreachable for a validated doc
      lines.push(`  --${key}: ${colour};`);
    }
    lines.push('}');
  };
  // Q49 correction: the dark block is scoped with :not([data-theme="light"]),
  // and that scoping is load-bearing, not cosmetic. A bare `:root { --x: … }`
  // matches <html> regardless of data-theme, and this stylesheet as a whole
  // loads AFTER the page's own <style> — so in light mode, an unscoped dark
  // rule and the page's own `[data-theme="light"] { --x: … }` have EQUAL
  // specificity and the theme file, being later in the document, wins
  // unconditionally. A dark-only theme (explicitly documented as "fine and
  // common" — §USER_GUIDE) would then silently overwrite every LIGHT-mode
  // colour it never mentioned, for every visitor in light mode: the opposite
  // of "an omitted property keeps its built-in value". `:not()` closes that
  // by making the two blocks mutually exclusive outright, so neither can
  // shadow the other's own scheme's fallback — no specificity race to win.
  block(':root:not([data-theme="light"])', doc && doc.dark);
  block(':root[data-theme="light"]', doc && doc.light);
  return lines.join('\n') + '\n';
}

/**
 * The downloadable template: every accepted key at its built-in value.
 *
 * The full surface rather than a four-key example, because it teaches what can
 * be changed and edits down to whatever the operator actually wants. JSON has
 * no comments, so the grouping is explained in the user guide instead.
 */
function template() {
  const dark = {};
  const light = {};
  for (const [key, value] of Object.entries(TOKENS)) {
    dark[key] = value;
    light[key] = Object.prototype.hasOwnProperty.call(LIGHT_OVERRIDES, key)
      ? LIGHT_OVERRIDES[key]
      : value;
  }
  return { version: FORMAT_VERSION, name: 'My theme', dark, light };
}

/** Which schemes a stored document actually customises, for the admin screen. */
function schemesOf(doc) {
  return SCHEMES.filter(s => doc && doc[s] && Object.keys(doc[s]).length > 0);
}

module.exports = {
  validate,
  toCss,
  template,
  schemesOf,
  normaliseColour,
  TOKENS,
  SCHEMES,
  FORMAT_VERSION,
  MAX_BYTES,
  MAX_NAME,
  MAX_PROPERTIES,
};
