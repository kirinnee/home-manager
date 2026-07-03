// Layered settings: resolve a list of layers (base config files + inline override
// objects) into the single config file an agent's config dir needs. A lone
// file-path layer is emitted verbatim (link/copy → comments & formatting kept);
// any override means parse → deep-merge left→right → re-serialize for the kind
// (codex:TOML claude:JSON). See core/kinds.ts (Asset.format) and core/merge.ts.
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { resolveAsset } from '../deps';
import type { SettingsLayer } from './types';

type Format = 'toml' | 'json';
type Obj = Record<string, unknown>;

/** How the generator should emit the resolved settings file. */
export type SettingsOutput = { kind: 'link' | 'copy'; src: string } | { kind: 'write'; content: string };

const isPlainObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recursively merge `b` onto `a`: nested plain objects merge key-by-key, every
 *  other value (scalars, arrays) is replaced by `b`'s. Pure — inputs untouched. */
export function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, bv] of Object.entries(b)) {
    const av = out[k];
    out[k] = isPlainObject(av) && isPlainObject(bv) ? deepMerge(av, bv) : bv;
  }
  return out;
}

const parseConfig = (text: string, format: Format): Obj =>
  format === 'toml' ? (parseToml(text) as Obj) : (JSON.parse(text) as Obj);

const serializeConfig = (obj: Obj, format: Format): string => {
  // smol-toml already terminates with a newline; JSON.stringify doesn't. Normalize
  // to exactly one trailing newline either way.
  const text = format === 'toml' ? stringifyToml(obj) : JSON.stringify(obj, null, 2);
  return text.endsWith('\n') ? text : `${text}\n`;
};

const requireSrc = (ref: string): string => {
  const src = resolveAsset(ref);
  if (!existsSync(src)) throw new Error(`settings source not found: ${src}`);
  return src;
};

/** Resolve settings layers into an emit instruction. A single file-path layer is
 *  passed through (link/copy per `mode`); anything else is parsed, deep-merged,
 *  and serialized to a written file. */
export function resolveSettings(layers: SettingsLayer[], format: Format, mode: 'link' | 'copy'): SettingsOutput {
  if (layers.length === 1 && typeof layers[0] === 'string') {
    return { kind: mode, src: requireSrc(layers[0]) };
  }
  const merged = layers.reduce<Obj>(
    (acc, layer) =>
      deepMerge(acc, typeof layer === 'string' ? parseConfig(readFileSync(requireSrc(layer), 'utf8'), format) : layer),
    {},
  );
  return { kind: 'write', content: serializeConfig(merged, format) };
}
