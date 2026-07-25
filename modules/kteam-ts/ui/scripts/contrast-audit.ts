/* ============================================================================
   WCAG contrast audit for the kteam design tokens.

   Reads `src/index.css` and everything it `@import`s (tokens currently live in
   `src/themes.css`), resolves every theme the way the cascade resolves it, and
   measures each foreground/background token pair the components really use.

       bun run a11y:contrast                     # all 10 themes; exits 1 on a hard fail
       bun run a11y:contrast --theme=mission-dark  # one theme x mode
       bun run a11y:contrast --suggest           # computed fix per failing token
       bun run a11y:contrast --all --json        # every row, machine-readable

   `--help` lists the flags. Run it from `modules/kteam-ts/ui`.

   Why a script and not an eyeball: five families x two modes x ~150 pairs is
   1500 judgements. Two of the themes make an explicit accessibility CLAIM
   (Neo-Brutalism "clears WCAG AA", High Contrast "targets >= 7:1"), and a claim
   in a comment is worth exactly nothing unless something checks it.

   ── HOW A THEME IS RESOLVED ───────────────────────────────────────────────
   Three layers, in cascade order, exactly as index.css declares them:
     1. `:root, [data-swatch]`            — the complete baseline (== studio-light)
     2. `[data-theme^='<family>-']`        — family block (geometry, type, weights)
     3. `[data-theme='<family>-<mode>']`   — mode block (the palette)
   Attribute-qualified blocks outrank the bare `:root`, and family/mode are equal
   specificity so source order (mode last) decides. Layering in that order here
   reproduces the browser's answer without a browser.

   ── WHAT COUNTS AS A FAILURE ──────────────────────────────────────────────
     body   >= 4.5:1   any text at body/chrome size (this UI has no large text
                       tier worth exempting — the biggest chrome is 12px)
     large  >= 3.0:1   >= 18.66px bold / >= 24px
     ui     >= 3.0:1   borders that carry state, focus rings, status fills
                       (WCAG 1.4.11 non-text contrast)
     decor  advisory   purely decorative separators. Measured and printed, never
                       a hard fail — 1.4.11 exempts "pure decoration", and
                       `--border-soft` exists precisely to be a whisper. Listed
                       so the number is visible rather than assumed.

   ── THINGS THIS ACCOUNTS FOR ──────────────────────────────────────────────
   * alpha. Mission Control's borders and status washes are `rgba()`; a token
     with alpha is composited over its actual backdrop before measuring.
   * `var()` aliases. A token may point at another token (`--border-strong:
     var(--border)` in Neo, `--chrome-fg: var(--faint)` in four families). These
     are flattened before measuring — an unflattened alias parses as null, and a
     null foreground is reported UNRESOLVED and then skipped, which silently
     removes the pair from the gate instead of checking it.
   * `.kt-chrome` is NOT a dimmed subtree. It once rendered `--faint` under
     `opacity: var(--chrome-opacity)`; it now uses one contrast-checked ink,
     `--chrome-fg`, because a subtree alpha also dimmed descendants that were
     never sized against it (a TaskName chip measured 1.92:1). One ink, one check.
   * `--bar-bg`. Translucent sticky bars are composited over `--bg`.
   * `--body-wash`. Mission and Ember paint radial gradients over `--bg`; at the
     hot spot the page background is NOT `--bg`. The peak stop of each wash is
     composited and the body-text tiers are re-checked against it (WASH table).
   ============================================================================ */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* ---------- colour maths -------------------------------------------------- */

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): Rgba | null {
  const v = raw.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map(c => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: h.length === 4 ? a! / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const parts = m[1]!.split(/[,/]/).map(p => p.trim());
    if (parts.length < 3) return null;
    const num = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha =
      parts[3] === undefined ? 1 : parts[3]!.endsWith('%') ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!);
    const [r, g, b] = [num(parts[0]!), num(parts[1]!), num(parts[2]!)];
    if ([r, g, b, alpha].some(n => Number.isNaN(n))) return null;
    return { r: r!, g: g!, b: b!, a: alpha };
  }
  return null;
}

/** Source-over composite of `fg` onto an opaque `bg`. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function hex(c: Rgba): string {
  const p = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/* ---------- token extraction --------------------------------------------- */

const FAMILIES = ['studio', 'mission', 'neo', 'ember', 'contrast'] as const;
const MODES = ['light', 'dark'] as const;
type Family = (typeof FAMILIES)[number];
type Mode = (typeof MODES)[number];

const HERE = dirname(new URL(import.meta.url).pathname);
const ENTRY = join(HERE, '..', 'src', 'index.css');

/** Follow `@import './x.css'` from the entry stylesheet, depth-first, and
    concatenate in import order — which is also cascade order, since CSS requires
    @import to precede other rules. The tokens started life inside index.css and
    have since moved to a `themes.css` that index.css imports; resolving the
    graph instead of hardcoding one path means the next move costs nothing. */
function loadCss(entry: string, seen = new Set<string>()): string {
  const real = entry.replace(/\/+$/, '');
  if (seen.has(real)) return '';
  seen.add(real);
  let css: string;
  try {
    css = readFileSync(real, 'utf8');
  } catch {
    console.error(`contrast-audit: cannot read ${real}`);
    process.exit(2);
  }
  return css.replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_m, spec: string) =>
    spec.startsWith('.') || !spec.includes(':') ? loadCss(join(dirname(real), spec), seen) : '',
  );
}

type Block = { selector: string; decls: Map<string, string> };

function parseBlocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Block[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i === -1) continue;
      const name = d.slice(0, i).trim();
      if (!name.startsWith('--')) continue;
      decls.set(name.slice(2), d.slice(i + 1).trim());
    }
    out.push({ selector: m[1]!.replace(/\s+/g, ' ').trim(), decls });
  }
  return out;
}

/* No region cut: only the three theme selectors below are ever consulted, and
   none of the later rules (base elements, `.kt-*` classes, the reduced-motion
   `:root, :root[data-theme]` block) match them. */
const BLOCKS = parseBlocks(loadCss(ENTRY));

function resolveTheme(family: Family, mode: Mode): Map<string, string> {
  // Anchored at the END only: the first block's selector capture also picks up
  // the preceding `@tailwind …;` at-rules, which are not part of the selector.
  const isBase = (s: string) => /:root,\s*\[data-swatch\]$/.test(s);
  const isFamily = (s: string) => s.includes(`[data-theme^='${family}-']`);
  const isMode = (s: string) => s.includes(`[data-theme='${family}-${mode}']`);
  const tokens = new Map<string, string>();
  for (const pick of [isBase, isFamily, isMode]) {
    for (const b of BLOCKS) if (pick(b.selector)) for (const [k, v] of b.decls) tokens.set(k, v);
  }
  return tokens;
}

/* ---------- pair specification ------------------------------------------- */

type Tier = 'body' | 'large' | 'ui' | 'decor';
const THRESHOLD: Record<Tier, number> = { body: 4.5, large: 3, ui: 3, decor: 3 };

type Pair = {
  fg: string;
  bg: string;
  tier: Tier;
  /** Multiply the foreground's alpha by this token's numeric value. */
  fgAlphaToken?: string;
  /** Label suffix, e.g. the component that ships the pair. */
  where: string;
};

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'];
const TOOLS = [
  'tool-bash',
  'tool-read',
  'tool-edit',
  'tool-write',
  'tool-patch',
  'tool-search',
  'tool-plan',
  'tool-wait',
  'tool-generic',
];
const SYNTAX = [
  'syn-comment',
  'syn-keyword',
  'syn-string',
  'syn-type',
  'syn-number',
  'syn-meta',
  'syn-addition',
  'syn-deletion',
];

function buildPairs(): Pair[] {
  const p: Pair[] = [];
  const add = (fg: string, bgs: string[], tier: Tier, where: string, fgAlphaToken?: string) => {
    for (const bg of bgs) p.push({ fg, bg, tier, where, fgAlphaToken });
  };

  /* --- prose + chrome text ------------------------------------------------
     Backgrounds are the ones each ink tier ACTUALLY lands on, not the cross
     product. `--surface-3` is the exception worth spelling out: its only two
     consumers are TaskName's chip (which sets `text-muted`) and the list-page
     progress bar (no text at all), so `muted` is checked against it and
     `faint` is not. Inventing pairs that never render would force the whole
     ink ramp darker to satisfy a combination no user can see. */
  add('fg', [...SURFACES, 'user-bg'], 'body', 'body copy / .md prose');
  add(
    'fg-soft',
    ['bg', 'surface', 'surface-2', 'user-bg', 'code-bg'],
    'body',
    'secondary copy, TerminalView, blockquote',
  );
  add('muted', [...SURFACES, 'user-bg'], 'body', 'text-muted (57x) + TaskName chip on surface-3');
  add('faint', ['bg', 'surface', 'surface-2'], 'body', 'text-faint (58x)');
  /* `.kt-chrome` is no longer a dimmed subtree. It used to be `--faint` under
     `opacity: var(--chrome-opacity)`, and the two lines that modelled it here
     (faint-at-alpha, plus the TaskName chip inheriting that alpha on surface-3)
     described a mechanism that no longer exists: index.css now sets
     `color: var(--chrome-fg)` with no opacity at all, precisely because a subtree
     alpha dimmed descendants it was never sized against. One real ink, one check. */
  add('chrome-fg', ['bg', 'surface', 'surface-2', 'bar-bg'], 'body', '.kt-chrome ink');
  add('code-fg', ['code-bg'], 'body', 'inline code / fenced blocks');
  // Sticky bars are translucent over the page background.
  add('fg', ['bar-bg'], 'body', 'AppBar / SessionHeader title');
  add('muted', ['bar-bg'], 'body', 'AppBar secondary');
  add('faint', ['bar-bg'], 'body', 'AppBar chrome');

  /* --- accent ------------------------------------------------------------- */
  add('accent', [...SURFACES, 'accent-soft', 'user-bg'], 'body', 'links, selected rows, <mark>');
  add('accent-strong', SURFACES, 'body', 'hover/pressed accent text');
  add('accent-fg', ['accent', 'accent-strong'], 'body', 'primary button label');

  /* --- status text -------------------------------------------------------- */
  add('ok', ['ok-bg', 'bg', 'surface', 'surface-2'], 'body', 'Badge ok / RcBadge');
  add('warn', ['warn-bg', 'bg', 'surface', 'surface-2', 'user-bg'], 'body', 'Badge warn / notices');
  add('err', ['err-bg', 'bg', 'surface', 'surface-2'], 'body', 'Badge err / error banners');
  add('pend', ['pend-bg', 'bg', 'surface', 'surface-2'], 'body', 'Badge pend');

  /* --- selection ---------------------------------------------------------- */
  add('selection-fg', ['selection-bg'], 'body', '::selection');

  /* --- per-tool + syntax hues -------------------------------------------- */
  for (const t of TOOLS) add(t, ['surface', 'surface-2', 'bg'], 'body', 'ToolGroup label');
  for (const s of SYNTAX) add(s, ['code-bg'], 'body', 'highlight.css');

  /* --- non-text: the borders that really do carry meaning ----------------
     WCAG 1.4.11 asks for 3:1 on "visual information required to identify user
     interface components and states" — and exempts pure decoration. The split
     below is that sentence applied honestly, not a way to duck the number:

       HARD  --border-strong   the boundary of a control (input, textarea,
                               outline button). Nothing else says "this is a
                               field you can type in", so it must clear 3:1.
       HARD  --accent-border    the SELECTED / current state on sidebar rows and
                               theme cards — a state, explicitly in scope.
       HARD  --focus-color      focus indicator.
       HARD  --ring             the 3px halo on `input:focus` — no outline-offset,
                               so it is adjacent to the field itself.
       HARD  --user-border      the 2.5px rail that identifies a user turn; the
                               only marker that block gets.
       HARD  ok/warn/err/pend   StatusMark's fills, where the dot IS the info.

     Everything in the advisory group below is an edge drawn around something
     already identified by its own fill, its own text, or both. Removing it
     removes prettiness, not meaning. Ratios are still printed. */
  /* THAT FUTURE PASS HAPPENED. The token is split: `--border-strong` draws the
     edge of anything you can operate (`.kt-btn`, `.kt-input`, `.kt-composer`,
     `.kt-tab`, `.kt-navrow`, and the `input, textarea` base rule), so the control
     case sets the bar on that token; `--border` is left to cards, panels and
     table wrappers, which are identified by their own fill and content. So this
     line moves to `--border-strong` and `--border` demotes to `decor`, exactly as
     the previous comment here specified. */
  add('border-strong', SURFACES, 'ui', 'control edge — input/textarea/.kt-btn/.kt-tab/.kt-navrow');
  /* Carries the SELECTED / checked / pressed state on AgentSidebar's rcOnly and
     rail toggles, ThemeToggle's mode + family radios, and NewSessionPage's agent
     picker — a state, so explicitly in 1.4.11's scope.

     STAYS HARD ON PURPOSE, even though the contract now says state edges must use
     `--accent` and this token is decorative tint only. The rule is about the code
     as it stands, not as it is meant to stand: Primitives, ThemeToggle and
     SessionsListPage have been swept, but AgentSidebar (x2), SessionDetails,
     NewSessionPage, WardenVerdicts (x2), QuestionForm and StatusMark still bind
     state to this token, so it still IS a state indicator and must still clear
     3:1. Demote to `decor` only once that sweep is committed — until then a green
     check here would be describing a fix that has not shipped. */
  add('accent-border', ['surface', 'surface-2', 'bg', 'accent-soft'], 'ui', 'SELECTED/checked/pressed border');
  add('user-border', ['user-bg', 'surface', 'bg'], 'ui', 'user-turn 2.5px rail');
  for (const s of ['ok', 'warn', 'err', 'pend']) add(s, ['surface', 'bg', 'surface-2'], 'ui', 'StatusMark fill / dot');
  /* `--focus-color` is checked against the surfaces the ring can sit ON, and
     deliberately NOT against `--accent`: `:focus-visible` carries
     `outline-offset: var(--focus-offset)` (2px, 3px in High Contrast), so a
     focused accent-filled button puts a gap of parent background between fill
     and ring. The colours the ring actually borders are the surfaces. */
  add('focus-color', [...SURFACES, 'user-bg', 'code-bg', 'accent-soft'], 'ui', 'focus ring vs the surface it sits on');
  /* DEMOTED, and the condition the previous comment set is the reason: the
     `outline: none` on `input:focus` is gone (index.css says so explicitly now,
     with the rationale inline), so `:focus-visible` draws a real tokenised
     outline at --focus-width/--focus-color on every field in every theme. This
     3px bloom is no longer the indicator, it is the decorative half sitting
     behind one — and `--focus-color` above is still HARD-checked, so demoting
     this weakens nothing. The old label also asserted "outline is suppressed",
     which is now simply false. */
  add('ring', ['surface', 'bg', 'surface-2'], 'decor', 'input:focus bloom behind the real outline');

  /* --- advisory: decoration around already-identified things ------------- */
  /* Demoted from `ui` now that `--border-strong` carries every control edge:
     what is left on this token is the outline of a card, panel or table wrapper,
     each already identified by its own fill and its own content. Mission's is the
     reference design's own `rgba(151,217,224,.18)` hairline, which is decoration
     by intent. Ratios are still printed. */
  add('border', SURFACES, 'decor', 'card/panel/table edge (fill + content identify it)');
  add('border-soft', SURFACES, 'decor', 'hairline separators');
  add('code-border', ['surface', 'bg', 'code-bg'], 'decor', 'code block edge (mono fill identifies it)');
  for (const s of ['ok', 'warn', 'err', 'pend'])
    add(`${s}-border`, ['surface', 'bg'], 'decor', 'badge outline (fill + label identify it)');
  add('user-rail', ['surface', 'user-bg'], 'decor', 'DEAD TOKEN — declared in all 10 themes, consumed nowhere in src/');

  return p;
}

const PAIRS = buildPairs();

/* Peak stop of each theme's `--body-wash`, transcribed from index.css. The wash
   is a radial gradient, so the page background at the hot spot is this blend —
   always LIGHTER than `--bg`, i.e. always worse for light-on-dark text. */
const WASH_PEAK: Partial<Record<`${Family}-${Mode}`, string[]>> = {
  'mission-dark': ['rgba(71, 243, 255, 0.085)', 'rgba(30, 83, 96, 0.14)'],
  'mission-light': ['rgba(10, 113, 129, 0.07)', 'rgba(255, 173, 85, 0.06)'],
  'ember-light': ['rgba(214, 148, 62, 0.14)', 'rgba(196, 118, 48, 0.08)'],
  'ember-dark': ['rgba(240, 163, 90, 0.1)', 'rgba(158, 84, 32, 0.09)'],
};
const WASH_TIERS = ['fg', 'fg-soft', 'muted', 'faint'];

/* ---------- evaluation ---------------------------------------------------- */

type Row = {
  theme: string;
  fg: string;
  bg: string;
  tier: Tier;
  where: string;
  fgHex: string;
  bgHex: string;
  ratio: number;
  need: number;
  status: 'PASS' | 'FAIL' | 'ADVISORY' | 'UNRESOLVED';
};

/**
 * Flatten whole-value `var()` aliases so every entry holds a literal colour.
 *
 * The token layer legitimately aliases one token to another — `--border-strong:
 * var(--border)` in Neo (its border ink is already max-contrast, so the control
 * edge has nothing to add) and `--chrome-fg: var(--faint)` in the four families
 * whose faint already clears AA. `parseColor('var(--faint)')` returns null, and a
 * null fg is reported UNRESOLVED and then NOT CHECKED — so an alias silently
 * removed a pair from the gate. That is worse than a failure: 40 pairs, including
 * every Neo and High Contrast control edge, were being skipped rather than
 * verified. Flattening once here fixes every call site at once.
 */
function flattenAliases(tokens: Map<string, string>): Map<string, string> {
  const ALIAS = /^var\(\s*--([a-z0-9-]+)\s*\)$/i;
  const out = new Map(tokens);
  for (const key of [...out.keys()]) {
    let value = out.get(key)!;
    const seen = new Set<string>([key]);
    let m = ALIAS.exec(value.trim());
    while (m) {
      const target = m[1]!;
      if (seen.has(target)) break; // cycle guard: --a: var(--b); --b: var(--a)
      seen.add(target);
      const next = out.get(target);
      if (next === undefined) break; // dangling alias — leave it UNRESOLVED
      value = next;
      m = ALIAS.exec(value.trim());
    }
    out.set(key, value);
  }
  return out;
}

/** Resolve a token to an opaque colour, compositing over `--bg` when translucent. */
function opaque(tokens: Map<string, string>, name: string): Rgba | null {
  const raw = tokens.get(name);
  if (raw === undefined) return null;
  const c = parseColor(raw);
  if (!c) return null;
  if (c.a >= 1) return c;
  const page = parseColor(tokens.get('bg') ?? '');
  return page ? over(c, page) : null;
}

function evaluate(family: Family, mode: Mode): Row[] {
  const theme = `${family}-${mode}`;
  const tokens = flattenAliases(resolveTheme(family, mode));
  const rows: Row[] = [];

  const push = (
    fgName: string,
    fgRaw: string | null,
    bgName: string,
    bgC: Rgba | null,
    tier: Tier,
    where: string,
    alphaToken?: string,
  ) => {
    const fgC0 = fgRaw === null ? null : parseColor(fgRaw);
    if (!fgC0 || !bgC) {
      rows.push({
        theme,
        fg: fgName,
        bg: bgName,
        tier,
        where,
        fgHex: fgRaw ?? '(missing)',
        bgHex: bgC ? hex(bgC) : '(missing)',
        ratio: 0,
        need: THRESHOLD[tier],
        status: 'UNRESOLVED',
      });
      return;
    }
    let fgC = fgC0;
    if (alphaToken) {
      const a = parseFloat(tokens.get(alphaToken) ?? '1');
      fgC = { ...fgC, a: fgC.a * (Number.isNaN(a) ? 1 : a) };
    }
    const flat = fgC.a >= 1 ? fgC : over(fgC, bgC);
    const ratio = contrast(flat, bgC);
    const need = THRESHOLD[tier];
    rows.push({
      theme,
      fg: fgName,
      bg: bgName,
      tier,
      where,
      fgHex: hex(flat),
      bgHex: hex(bgC),
      ratio,
      need,
      status: ratio + 1e-9 >= need ? 'PASS' : tier === 'decor' ? 'ADVISORY' : 'FAIL',
    });
  };

  for (const pair of PAIRS) {
    const label = pair.fgAlphaToken ? `${pair.fg}@${pair.fgAlphaToken}` : pair.fg;
    push(
      label,
      tokens.get(pair.fg) ?? null,
      pair.bg,
      opaque(tokens, pair.bg),
      pair.tier,
      pair.where,
      pair.fgAlphaToken,
    );
  }

  // Wash hot-spot re-check: body ink over the brightest point of --body-wash.
  const wash = WASH_PEAK[theme as `${Family}-${Mode}`];
  if (wash) {
    let bgC = parseColor(tokens.get('bg') ?? '');
    if (bgC) {
      for (const layer of wash) {
        const l = parseColor(layer);
        if (l) bgC = over(l, bgC);
      }
      for (const t of WASH_TIERS) push(t, tokens.get(t) ?? null, 'bg+wash', bgC, 'body', 'body-wash hot spot');
      push(
        'faint@chrome-opacity',
        tokens.get('faint') ?? null,
        'bg+wash',
        bgC,
        'body',
        '.kt-chrome over wash hot spot',
        'chrome-opacity',
      );
    }
  }

  return rows;
}

/* ---------- solver --------------------------------------------------------
   `--suggest` answers the only question a failure actually raises: what value
   would pass? For each (theme, token) that fails anywhere, it finds the minimal
   move along the lightness axis — darken toward black on light grounds, lighten
   toward white on dark ones — that clears EVERY failing pair that token is in
   at once. Scaling sRGB channels multiplicatively (or toward 255) keeps the hue
   and most of the chroma, so a theme's identity survives the fix: Mission's
   cyan stays cyan, Ember's amber stays amber.

   It is a suggestion, not an auto-apply. Round numbers, aesthetic judgement and
   "does this still read as the same theme" stay human. -------------------- */

function shift(c: Rgba, t: number): Rgba {
  // t < 0 darkens (scale toward black), t > 0 lightens (scale toward white).
  if (t < 0) return { ...c, r: c.r * (1 + t), g: c.g * (1 + t), b: c.b * (1 + t) };
  return { ...c, r: c.r + (255 - c.r) * t, g: c.g + (255 - c.g) * t, b: c.b + (255 - c.b) * t };
}

function suggestFor(theme: string, token: string, rows: Row[]): string | null {
  const failing = rows.filter(r => r.theme === theme && r.fg === token && r.status === 'FAIL');
  if (!failing.length) return null;
  // Row labels carry an `@alpha-token` suffix; the token name is the part before.
  const name = token.split('@')[0]!;
  const base = parseColor(
    flattenAliases(resolveTheme(theme.split('-')[0] as Family, theme.split('-')[1] as Mode)).get(name) ?? '',
  );
  if (!base) return null;
  const bgs = failing.map(r => ({ c: parseColor(r.bgHex)!, need: r.need })).filter(x => x.c);
  // Which direction? Away from the lightest background we must clear.
  const meanBgL = bgs.reduce((s, x) => s + luminance(x.c), 0) / bgs.length;
  const dir = meanBgL > 0.18 ? -1 : 1;
  const ok = (t: number) => bgs.every(x => contrast(shift(base, t), x.c) + 1e-9 >= x.need);
  let lo = 0;
  let hi = dir;
  if (!ok(hi)) return null; // even pure black/white cannot satisfy it
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  const out = shift(base, hi);
  const worst = Math.min(...bgs.map(x => contrast(out, x.c)));
  return `${hex(base)} -> ${hex(out)}  (${dir < 0 ? 'darken' : 'lighten'} ${(Math.abs(hi) * 100).toFixed(0)}%, worst ${worst.toFixed(2)}:1 over ${failing.length} pair${failing.length > 1 ? 's' : ''})`;
}

/* ---------- report -------------------------------------------------------- */

const argv = process.argv.slice(2);
const args = new Set(argv);
const showAll = args.has('--all');
const asJson = args.has('--json');
const suggest = args.has('--suggest');

if (args.has('--help') || args.has('-h')) {
  console.log(`WCAG contrast audit for the kteam design tokens (src/index.css).

  bun scripts/contrast-audit.ts [options]

  --theme=<f-m>   only this theme; repeatable, and a bare family works too
                  (--theme=mission covers mission-light + mission-dark).
                  Families: ${FAMILIES.join(' | ')}   Modes: ${MODES.join(' | ')}
  --all           print PASS rows too, not just problems
  --suggest       for each failing token, compute the nearest value that clears
                  every pair it fails (hue-preserving lightness move)
  --json          machine-readable rows
  --help

Exit code is 1 if any HARD failure or unresolved token remains, 0 otherwise —
so it works as a CI gate. ADVISORY rows never affect the exit code; see the
tier table at the top of this file for what is hard and what is advisory, and
why.`);
  process.exit(0);
}

/* --theme filter: accepts `studio-light` or a bare family. */
const wanted = argv.filter(a => a.startsWith('--theme=')).flatMap(a => a.slice(8).split(','));
const selected: `${Family}-${Mode}`[] = [];
for (const f of FAMILIES)
  for (const m of MODES)
    if (!wanted.length || wanted.includes(f) || wanted.includes(`${f}-${m}`)) selected.push(`${f}-${m}`);
if (wanted.length && !selected.length) {
  console.error(
    `no theme matched ${wanted.join(', ')} — expected one of ${FAMILIES.join(', ')} (optionally -light/-dark)`,
  );
  process.exit(2);
}

const all: Row[] = [];
for (const t of selected) {
  const [f, m] = t.split('-') as [Family, Mode];
  all.push(...evaluate(f, m));
}

if (asJson) {
  console.log(JSON.stringify(all, null, 2));
} else {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const fmt = (r: Row) =>
    `  ${pad(r.status, 9)} ${pad(`${r.fg} on ${r.bg}`, 34)} ${(r.status === 'UNRESOLVED' ? '  n/a' : r.ratio.toFixed(2)).padStart(6)}:1  need ${r.need.toFixed(1)}  ${pad(r.fgHex, 8)}/${pad(r.bgHex, 8)} ${r.where}`;

  for (const theme of selected) {
    {
      const rows = all.filter(r => r.theme === theme);
      const bad = rows.filter(r => r.status !== 'PASS');
      const worstBody = Math.min(...rows.filter(r => r.tier === 'body' && r.status !== 'UNRESOLVED').map(r => r.ratio));
      console.log(
        `\n${theme}  —  ${rows.length} pairs, ${rows.filter(r => r.status === 'FAIL').length} fail, ` +
          `${rows.filter(r => r.status === 'ADVISORY').length} advisory, ` +
          `${rows.filter(r => r.status === 'UNRESOLVED').length} unresolved, worst body ${worstBody.toFixed(2)}:1`,
      );
      for (const r of showAll ? rows : bad) console.log(fmt(r));
      if (suggest) {
        for (const token of [...new Set(bad.filter(r => r.status === 'FAIL').map(r => r.fg))]) {
          const s = suggestFor(theme, token, rows);
          console.log(
            `  SUGGEST   ${pad(token, 34)} ${s ?? 'no single-axis value clears every pair — needs a design decision'}`,
          );
        }
      }
    }
  }

  const fails = all.filter(r => r.status === 'FAIL');
  const unresolved = all.filter(r => r.status === 'UNRESOLVED');
  console.log(`\n${'='.repeat(78)}`);
  console.log(`TOTAL  ${all.length} pairs across ${selected.length} theme${selected.length === 1 ? '' : 's'}`);
  console.log(`  hard failures : ${fails.length}`);
  console.log(`  advisory      : ${all.filter(r => r.status === 'ADVISORY').length}`);
  console.log(`  unresolved    : ${unresolved.length}`);

  // The two themes that make an explicit promise get their promise checked.
  const CLAIMS = [
    ['neo-light', 4.5, 'AA (>=4.5:1 text)'],
    ['neo-dark', 4.5, 'AA (>=4.5:1 text)'],
    ['contrast-light', 7, 'AAA (>=7:1 text)'],
    ['contrast-dark', 7, 'AAA (>=7:1 text)'],
  ] as const;
  for (const [theme, need, claim] of CLAIMS.filter(c => selected.includes(c[0]))) {
    const body = all.filter(r => r.theme === theme && r.tier === 'body' && r.status !== 'UNRESOLVED');
    const under = body.filter(r => r.ratio + 1e-9 < need);
    console.log(
      `  CLAIM ${pad(theme, 15)} ${claim}: ${under.length === 0 ? 'HOLDS' : `BROKEN in ${under.length}/${body.length}`}` +
        (under.length
          ? ` (worst ${Math.min(...under.map(u => u.ratio)).toFixed(2)}:1 — ${under[0]!.fg} on ${under[0]!.bg})`
          : ''),
    );
  }

  if (fails.length || unresolved.length) process.exitCode = 1;
}
