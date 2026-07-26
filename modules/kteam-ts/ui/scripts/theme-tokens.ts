/* ============================================================================
   Read theme colours out of `src/themes.css` at build time.

   themes.css is the ONLY place literal colours live (its own header says so),
   so the PWA manifests and the offline page must not carry a second copy of the
   palette in TS — they parse it. If a family/mode block or a token this build
   needs is missing, generation FAILS rather than falling back to a default: a
   silently-studio-coloured `mission-dark` manifest is worse than a red build.

   The resolution mirrors `scripts/contrast-audit.ts` — base → family → mode,
   which is the order the cascade resolves — and the two files intentionally
   duplicate a small parser rather than share one, in the same spirit as the
   themes bootstrap being duplicated in index.html. Keep them in step.
   ============================================================================ */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Family, Mode } from './release';

type Block = { selector: string; decls: Map<string, string> };

/** Follow `@import './x.css'` depth-first; import order is cascade order. */
function loadCss(entry: string, seen = new Set<string>()): string {
  const real = entry.replace(/\/+$/, '');
  if (seen.has(real)) return '';
  seen.add(real);
  const css = readFileSync(real, 'utf8');
  return css.replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_m, spec: string) =>
    spec.startsWith('.') || !spec.includes(':') ? loadCss(join(dirname(real), spec), seen) : '',
  );
}

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

export class ThemeTokenError extends Error {}

export type ThemeReader = {
  /** Resolved token map for one family/mode, or `undefined` if the mode block
      does not exist at all. */
  resolve(family: Family, mode: Mode): Map<string, string> | undefined;
  /** Resolve a token to a literal colour, following `var(--x)` aliases.
      Throws when the token is absent or unresolvable. */
  token(family: Family, mode: Mode, name: string): string;
};

export function readThemeTokens(entryCss: string): ThemeReader {
  const blocks = parseBlocks(loadCss(entryCss));
  const isBase = (s: string) => /:root,\s*\[data-swatch\]$/.test(s);

  const resolve = (family: Family, mode: Mode): Map<string, string> | undefined => {
    const isFamily = (s: string) => s.includes(`[data-theme^='${family}-']`);
    const isMode = (s: string) => s.includes(`[data-theme='${family}-${mode}']`);
    // A family/mode pair MUST have its own mode block; otherwise the palette we
    // would emit is some other theme's.
    if (!blocks.some(b => isMode(b.selector))) return undefined;
    const tokens = new Map<string, string>();
    for (const pick of [isBase, isFamily, isMode]) {
      for (const b of blocks) if (pick(b.selector)) for (const [k, v] of b.decls) tokens.set(k, v);
    }
    return tokens;
  };

  const token = (family: Family, mode: Mode, name: string): string => {
    const tokens = resolve(family, mode);
    if (!tokens) {
      throw new ThemeTokenError(
        `themes.css has no [data-theme='${family}-${mode}'] block — cannot generate PWA assets for that theme`,
      );
    }
    let value = tokens.get(name);
    // Flatten var() aliases (e.g. --radius-panel: var(--radius-lg)).
    for (let hops = 0; value !== undefined && hops < 8; hops++) {
      const alias = /^var\(\s*--([A-Za-z0-9-]+)\s*(?:,[^)]*)?\)$/.exec(value.trim());
      if (!alias) break;
      value = tokens.get(alias[1]!);
    }
    if (value === undefined || value.trim() === '') {
      throw new ThemeTokenError(`themes.css: ${family}-${mode} does not define --${name}`);
    }
    return value.trim();
  };

  return { resolve, token };
}

/** Default entry: the stylesheet that `@import`s themes.css. */
export function defaultCssEntry(uiRoot: string): string {
  return join(uiRoot, 'src', 'index.css');
}
