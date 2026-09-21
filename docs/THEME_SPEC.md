# Administrator theme — specification

**Status:** draft for review. Nothing here is implemented yet.
**Scope:** item D of the six raised after PR #145. Ships as its own pull request.
**Decision markers claimed:** Q49–Q52, S35.

---

## 1. What this has to do

From the request, restated as requirements:

| # | Requirement | Consequence |
|---|---|---|
| R1 | The administrator uploads a theme file in a documented format | A new upload path and a new stored artefact |
| R2 | The file **may be partial** — only the properties the operator wants to change | Unsupplied properties must fall back to the built-in value, **individually**, not all-or-nothing |
| R3 | Every component must be themeable | The hard-coded colours currently sitting in component rules have to become tokens first |
| R4 | The theme is **not** per user | One theme for the installation, owned by the administrator, like the title and the icon |
| R5 | A user keeps only the dark/light switch | The theme must define **both** schemes, and the existing `dt_theme` toggle keeps working untouched |

R2 and R3 are the two that carry real work. R1, R4 and R5 are largely the shape
the icon (Q47) already established.

---

## 2. What is actually there today

Measured, not estimated.

### 2.1 The token surface

`index.html` `:root` declares **20** custom properties; `[data-theme="light"]`
overrides **17** of them (the three geometry tokens — `--header-h`, `--row-h`,
`--radius` — are scheme-independent).

```
--bg  --surface  --surface2  --border  --text  --text-muted  --accent
--critical  --critical-bg  --high  --high-bg  --medium  --medium-bg
--low  --low-bg  --ok  --ok-bg
--header-h  --row-h  --radius
```

`login.html` and `admin.html` reuse the same names, and a test already asserts
the three pages cannot drift apart on ten of them.

### 2.2 The colours that are **not** tokens

CLAUDE.md §8.10 says "never hard-code a colour hex inside a component rule".
That rule is currently enforced by a test on `admin.html` **only** — which is
exactly why `admin.html` is clean and the other two are not:

| Page | Hexes outside the theme blocks | Of which `#fff` |
|---|---|---|
| `index.html` | 17 | 10 |
| `login.html` | 11 | 2 |
| `admin.html` | 4 | 4 |

The **22 non-`#fff`** ones, by what they are:

| Hex | Where | What it is |
|---|---|---|
| `#4f46e5` | `.btn.primary:hover` | a darker accent |
| `#a78bfa` ×2 | `.th-group.operations` | the Operational-risk column-group colour |
| `#06b6d4` ×2 | `.th-group.secpolicy` | the Security-policy column-group colour |
| `#a5f3fc` | a `<pre>` inside a modal | code text |
| `#8899bb`, `#5c6a85` | light-mode scrollbar thumb | `--border` is near-invisible on white |
| `#1d4ed8` | light-mode `.modal code` | code text, light scheme |
| `#6366f1` `#8b5cf6` `#06b6d4` `#3b82f6` | `login.html` `#bgUser .b1–.b4` | the signed-in-user background blobs |
| `#f59e0b` `#ef4444` `#f97316` `#eab308` | `login.html` `#bgAdmin .b1–.b4` | the administrator background blobs |
| `#8b5cf6` | `login.html` logo gradient | the second gradient stop |

The 16 `#fff` occurrences are all one thing: **text drawn on top of a filled
accent or critical surface** (primary buttons, selected rows, toggle knobs,
severity pills). They are not arbitrary — they are "the readable colour against
that fill". If an operator themes `--accent` to pale yellow, every one of them
becomes invisible. So they need a token too, and it is a *different* token from
`--text`.

**This is the real cost of R3 and it is mostly independent of the upload
machinery.** Themeable components come first; the upload is what feeds them.

### 2.3 How a scheme is selected today

`<html data-theme="light">` or the attribute absent (dark). Set by
`toggleTheme()`, persisted in `localStorage` under `dt_theme`, read on boot in
all three pages. **Nothing about this changes.** R5 is satisfied by leaving it
alone.

---

## 3. Design

### 3.1 Q49 — partial overrides need no merge logic at all

The obvious implementation is to load the stored theme, merge it over the
defaults property by property, and emit a complete set. That is a merge
function, a defaults table duplicated outside the stylesheet, and a drift risk
the moment somebody adds a token to `:root` and forgets the table.

None of it is necessary. **The cascade already does exactly this.** If the
built-in `:root` stays in the page and the operator's theme is appended as a
later `<style>` block at the same specificity, then:

- a property the theme supplies wins, because it comes later;
- a property the theme omits keeps the built-in value, because nothing
  overrode it;
- the fallback is **per property**, which is R2 stated precisely.

```html
<style> :root { --bg: #0f1117; --accent: #6366f1; /* …built-in… */ } </style>
...
<style id="adminTheme"> :root { --accent: #b45309; } </style>   <!-- uploaded -->
```

`--accent` is the operator's; `--bg` is ours. No merge, no defaults table, no
drift. Adding a token to `:root` later makes it themeable automatically.

Two things follow and both are load-bearing:

- **The built-in blocks are never removed or rewritten.** They are the fallback.
  A theme that fails to load leaves a correct page, not an unstyled one.
- **The injected block must come after them and must not raise specificity.**
  `:root { … }` and `:root[data-theme="light"] { … }` — matching what the page
  already uses — not `html:root` or `!important`. A theme that wins by force
  cannot be partially overridden by anything later, including the light block.

### 3.2 Q50 — the theme is CSS-shaped, but it is not CSS

The stored artefact is **JSON**, not a stylesheet. The service generates the
`<style>` text from it.

Accepting raw CSS would mean serving operator-authored CSS from our own origin
to unauthenticated visitors on the sign-in page. CSS can load external
resources (`@import`, `url()`), can position and cover elements, and can
exfiltrate attribute values through selector-triggered background fetches. We
already refuse SVG for the icon (S32) for a weaker version of this reason. A
stylesheet is strictly more dangerous than an image.

JSON with a fixed key set and a validated value grammar is not a subset of CSS
that happens to be safe — it is a different thing that we render into CSS
ourselves. Nothing the operator writes reaches the page as syntax.

**Format:**

```json
{
  "version": 1,
  "name": "Contoso",
  "dark":  { "accent": "#7c5cff", "surface": "#141824" },
  "light": { "accent": "#4c3fd0" }
}
```

- `version` — required, currently `1`. Present so a future shape can be told
  apart rather than guessed at.
- `name` — optional, ≤ 60 characters, shown on the administration screen so an
  operator can tell which file is loaded. Never rendered into CSS.
- `dark` / `light` — either may be omitted entirely. Both are partial.
- Keys are the token names **without** the `--` prefix: `accent`, not
  `--accent`. The prefix is ours; requiring the operator to type CSS syntax in a
  JSON file invites them to think the rest of it is CSS too.

**A single-scheme upload is allowed and is the expected common case.** An
operator with a brand colour usually wants it in both, but a colour that reads
on `#0f1117` frequently does not read on `#ffffff`. Asking for both and
accepting one would be a validation that does nothing; asking for both and
*refusing* one would make the honest partial upload the hard path. So: supply
what you have, the rest falls back, and the administration screen says plainly
which scheme you have customised and which is still ours.

**Geometry tokens are out.** `--header-h`, `--row-h` and `--radius` are layout,
not colour — `--row-h` in particular is read by `syncStickyHeader()` and the
table's measured geometry. Theming them turns a colour feature into a layout
feature with its own failure modes. `--radius` alone is tempting and is
deliberately deferred: it is one token, and it can be added to the accepted set
later without any format change, which is what `version` is for.

### 3.3 Q51 — validation refuses, it never repairs

Every value must match one of two grammars:

| Grammar | Pattern | Why |
|---|---|---|
| Hex | `#` + 3, 4, 6 or 8 hex digits | what the page already uses |
| `rgba()` | `rgba(` 0–255, 0–255, 0–255, 0–1 `)` | the `*-bg` tints are all `rgba()` |

Nothing else. No named colours (`rebeccapurple` is valid CSS and a needless
parser), no `hsl()`, no `var()`, no `calc()`, no gradients. A value that does
not match is **rejected with its key named** — not dropped, not coerced. An
operator who typed `#12345` and got a page with one silently-ignored property
would go looking for the bug in the wrong place.

An unknown **key** is likewise refused, listed by name, rather than ignored. The
usual argument for ignoring unknown keys is forward compatibility; here the more
likely cause by far is a typo (`acccent`), and silently discarding it produces a
theme that "didn't work" with nothing to explain why.

Other bounds:

- The file is at most **64 KB**. A complete theme is under 2 KB; the limit
  exists so the route's body reader has one.
- At most **200 properties total** across both schemes, so a pathological file
  cannot generate a large stylesheet.

**S35 — the generated CSS is built from a fixed template, not from the input.**
Key names are looked up in an allow-list and the *allow-list's* spelling is what
gets written; values are re-serialised from the parsed hex/rgba components
rather than echoed. Even if validation were wrong, the emitted text can only be
`--<known-token>: <normalised colour>;`. Nothing the operator supplies is
concatenated into the stylesheet verbatim.

### 3.4 Q52 — the theme is public, and it is the same public as the icon

The sign-in page must be themed, and it renders before any token exists. So
`GET /branding/theme.css` is public, alongside `/branding`,
`/branding/background` and `/branding/icon` (S32). It returns `text/css` and
nothing else — no account, no setting, no count. Same ETag/`immutable` rule as
the icon: the URL carries the theme's own hash, so it is cached until it
changes.

**It is a linked stylesheet, not an inline block.** `<link rel="stylesheet"
href="/branding/theme.css?v=…">` in `<head>`, after the page's own `<style>`.
Two reasons:

- The auth gate runs in `<head>` before the body is parsed (§8.4), and the
  shell is hidden behind `.booting` until it answers. A theme fetched by
  JavaScript after that would repaint the page **after** it became visible,
  which is the flash §8.4 exists to prevent. A `<link>` blocks rendering, which
  is exactly the behaviour wanted here.
- It keeps the theme out of the three pages' source, so no duplication test is
  needed — unlike `applyBrandMark`, this needs no hand-mirroring at all.

A 404 (no theme configured) costs one request and changes nothing, because the
built-in blocks are the fallback by construction (§3.1).

---

## 4. Storage

One new table. `branding_assets` is not reused: its rows are image bytes with a
sniffed mime type and pixel dimensions, and none of those columns mean anything
for a theme.

```sql
-- 017_app_theme.sql
CREATE TABLE IF NOT EXISTS app_themes (
  id           boolean PRIMARY KEY DEFAULT TRUE CHECK (id),   -- singleton, like app_settings
  name         text,
  doc          jsonb       NOT NULL,          -- the validated document
  css          text        NOT NULL,          -- what /branding/theme.css serves
  etag         text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_themes_name_len CHECK (name IS NULL OR char_length(name) <= 60)
);
```

**Both `doc` and `css` are stored, and that is deliberate.** `doc` is what the
administration screen shows back and what a future format migration reads; `css`
is what the hot public route serves. Regenerating the CSS per request would put
a template render on the path every page load takes, and regenerating it at boot
would mean a code change to the generator silently applied itself to a stored
theme nobody re-reviewed. Generated once, on save, by the code that validated it.

No index: one row.

---

## 5. Routes

| Route | Auth | Effect |
|---|---|---|
| `PUT /admin/theme` | administrator | Upload/replace. Body is the JSON document, 64 KB limit |
| `DELETE /admin/theme` | administrator | Restore the built-in theme |
| `GET /admin/theme` | administrator | The stored document + name, for the screen |
| `GET /branding/theme.css` | **public** | The generated CSS, ETag + `immutable` |

`/branding` gains `theme: { name, version } | null` so the pages know whether to
emit the `<link>` at all.

**The administration allow-list goes nine → eleven** (§7.6). The same bar the
previous additions cleared: it changes how the product *looks*, never what an
account is or what it may reach, and it reads no other principal's data. The
test asserting the exact set is edited in the same diff, which is the point of
having it.

---

## 6. The work R3 actually requires

This is the larger half and it lands **first**, in its own commits, because it
is independently correct: it fixes existing §8.10 violations whether or not the
upload feature ships.

### 6.1 New tokens

| Token | Replaces | Dark | Light |
|---|---|---|---|
| `--on-accent` | 13 × `#fff` on accent fills | `#ffffff` | `#ffffff` |
| `--on-critical` | 3 × `#fff` on critical fills | `#ffffff` | `#ffffff` |
| `--accent-hover` | `#4f46e5` | `#4f46e5` | darker of `--accent` |
| `--cat-operations` | `#a78bfa` | `#a78bfa` | a light-scheme equivalent |
| `--cat-secpolicy` | `#06b6d4` | `#06b6d4` | a light-scheme equivalent |
| `--code` | `#a5f3fc` / `#1d4ed8` | `#a5f3fc` | `#1d4ed8` |
| `--scrollbar` | `#8899bb` | `--border` | `#8899bb` |
| `--scrollbar-hover` | `#5c6a85` | `--text-muted` | `#5c6a85` |
| `--login-blob-1…4` | 4 × `#bgUser` blobs | as now | as now |
| `--login-blob-admin-1…4` | 4 × `#bgAdmin` blobs | as now | as now |
| `--logo-gradient-end` | `#8b5cf6` | `#8b5cf6` | as now |

Two notes:

- **`--on-accent` and `--on-critical` default to white and stay white.** They
  exist so a themed installation *can* fix contrast, not so the default changes.
  Nothing renders differently on the day this lands.
- **`--cat-operations` / `--cat-secpolicy` currently have no light-scheme
  value** — the hexes are absolute and the columns are the same purple and cyan
  on white today. Tokenising them surfaces that; giving them a light value is a
  small visual improvement that comes free with the refactor.

That is **23 new tokens**, taking `:root` from 20 to 43, of which 40 are
colours and themeable.

### 6.2 The §8.10 test extends to all three pages

The "no colour hard-coded inside a component rule" test currently runs against
`admin.html` alone. After 6.1 it runs against all three, with `#fff` no longer
exempted — the exemption is what let 16 of them accumulate. That single change
is what stops this recurring: a new component rule with a literal colour in it
fails offline, on the page it was added to.

---

## 7. Administration screen

A new section beside Customization, following the icon's pattern exactly:

- Current state: *Built-in theme* or *"Contoso" — dark and light customised* /
  *— dark customised, light is the built-in*.
- **Upload** (file picker, `.json`) and **Restore built-in**.
- On a rejected file: the specific reason, with the key named — *`dark.acccent`
  is not a theme property* / *`light.surface`: `#12345` is not a colour*. Up to
  ten listed; more than ten is a file with a different problem.
- A **link to a downloadable template** containing every accepted key at its
  built-in value, so an operator starts from something correct rather than from
  the documentation.
- A note that a theme applies to everyone, and that each person still chooses
  dark or light.

---

## 8. Tests

**Offline (`server.test.js`, `dashboard.test.js`):**

- The validator: every accepted grammar; every rejected one (named colour,
  `var()`, `calc()`, `url()`, a gradient, `#12345`, `rgba` out of range); an
  unknown key refused **by name**; the property ceiling; a `dark`-only document,
  a `light`-only document, and `{}`.
- The generator: emits only allow-listed token names; a normalised value; and —
  mutation-checked — that a hostile value cannot escape the declaration, tried
  with `}`, `;`, `/*`, a newline and `</style>` in the input.
- Partial fallback proven as **cascade order**, not as merge output: the
  generated block declares only what was supplied, and the built-in `:root`
  survives in the page ahead of it.
- All three pages emit the `<link>` after their own `<style>`, and the built-in
  `:root` is not removed.
- §8.10 across all three pages, `#fff` no longer exempt.
- The three pages still agree on every custom property (the existing drift test,
  extended from ten names to the full set).

**Database (`db.test.js`):** the singleton CHECK; `doc` and `css` round-trip;
the etag moves when the theme does; delete restores the absent state; and
migration 017 replays cleanly.

**End-to-end (`e2e.test.js`):** upload a theme through the real administration
screen; assert the **computed** value of `--accent` on `document.documentElement`
changes for a *signed-out* visitor on `login.html` (which is the case the public
route exists for); assert an omitted property still computes to the built-in
value — which is the one assertion that proves R2 end to end and that no unit
test can; toggle to light and confirm the light half applies; then restore and
confirm everything computes back.

---

## 9. In scope / out of scope

**In:** the JSON format; validation and CSS generation; the singleton table and
migration; the four routes; the administration section with a downloadable
template; the 23-token refactor across all three pages; extending the §8.10 test
to all three; documentation.

**Out, and each for a reason:**

- **Per-user themes.** R4. Also: the sign-in page has no user.
- **Raw CSS upload.** §3.2.
- **Fonts, spacing, radii, logos.** Colour only. `--radius` can join the
  accepted set later with no format change.
- **A colour picker / in-browser theme editor.** A real feature, several times
  this one's size, and it needs the format to exist first.
- **Contrast checking.** Tempting, and genuinely useful, but "is this readable"
  is a judgement (WCAG AA against *which* background?) and getting it wrong in
  either direction is worse than not offering it. The template starting from
  working values is the cheaper mitigation. Worth revisiting once there is a
  real theme to check.
- **More than one stored theme / scheduling a theme.** No request behind it.

---

## 10. Effort

Assumes the same working method as PRs #143–#146: implementation with tests in
the same pass, mutation-checking the new guards, all four tiers green, and
CLAUDE.md/USER_GUIDE updated in the same diff.

| Part | Work | Est. |
|---|---|---|
| A | Token refactor: 23 tokens, 32 literal sites, 3 pages | 1.25 d |
| B | §8.10 test to all three pages, `#fff` no longer exempt; extend the drift test | 0.25 d |
| C | `lib/theme.js` — validator + generator + S35 hardening | 0.75 d |
| D | Migration 017, storage, four routes, `/branding` field | 0.75 d |
| E | Administration section, template download, error display | 0.75 d |
| F | The `<link>` in three pages | 0.25 d |
| G | Tests: offline, database, end-to-end | 1.0 d |
| H | CLAUDE.md §3/§7.6/§8.10/§10.5/§12, USER_GUIDE, README | 0.5 d |
| | **Total** | **≈ 5.5 days** |

**A+B are ~1.5 days of the total and are worth doing regardless** — they fix
existing §8.10 violations and close the hole that let 22 literals accumulate.
If the upload half is deferred, that work is not wasted and does not need
redoing.

Risks: none technical. The one judgement call that could move the estimate is
the light-scheme values for `--cat-operations` and `--cat-secpolicy`, which is a
design decision rather than an engineering one and can ship as "same as dark"
with no loss.

---

## 11. Open questions

1. **The template download** — every key at its built-in value, or a minimal
   example with four or five? The full template is more useful and also teaches
   the whole surface; the minimal one is less intimidating. Default if nothing
   is said: **full, with the key set grouped and commented in the
   documentation** (JSON has no comments, so the grouping lives in the guide).
2. **Rejecting versus warning on an unknown key.** §3.3 argues for rejecting.
   If an operator is expected to hand-edit files repeatedly, a warning that
   still applies the valid half may suit better. Default: **reject**.
3. **Should a theme be exportable** (download what is currently stored)?
   Cheap — the document is already stored — and it makes "copy this
   installation's theme to another" a supported action rather than a file
   somebody has to keep. Not costed above; roughly +0.25 d if wanted.
