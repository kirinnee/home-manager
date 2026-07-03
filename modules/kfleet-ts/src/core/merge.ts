// Expand each agent across every variant into a flat ResolvedAgent.
//
// For (agent A, variant V) the merge order is, right overriding left:
//   base -> A.profiles -> V.profiles -> V.inline -> A.inline
// Wrapper name: the `default` variant keeps `<name>`; any other variant V infixes
// `V-` (so kind=claude, name=kirin, variant=auto -> resolved name "auto-kirin",
// wrapper claude-auto-kirin, dir ~/.claude-auto-kirin).
import type { Config, Kind, Profile, ResolvedAgent, ScopedProfile, SettingsLayer, Variant } from './types';

/** Normalize a settings field (single layer or list, or absent) to a layer list. */
const asLayers = (s: Profile['settings']): SettingsLayer[] | undefined =>
  s === undefined ? undefined : Array.isArray(s) ? s : [s];

/** Merge `b` onto `a` (flat fields only): env merges, flags + settings layers
 *  concatenate (later layers win at deep-merge time), other scalars replace. */
function mergeBase(a: Profile, b: Profile): Profile {
  return {
    ...a,
    ...b,
    env: a.env || b.env ? { ...a.env, ...b.env } : undefined,
    flags: a.flags || b.flags ? [...(a.flags ?? []), ...(b.flags ?? [])] : undefined,
    settings: a.settings || b.settings ? [...(asLayers(a.settings) ?? []), ...(asLayers(b.settings) ?? [])] : undefined,
  };
}

/** Flatten one scoped block for `kind`: overlay its matching-kind sub-profile
 *  onto its flat fields (kind block wins within the block), drop both blocks. */
function flatten(p: ScopedProfile, kind: Kind): Profile {
  const { claude, codex, ...flat } = p;
  const overlay = kind === 'claude' ? claude : codex;
  return overlay ? mergeBase(flat, overlay) : flat;
}

/** Apply named profiles in order onto `acc` (each flattened for `kind` first).
 *  `base` is optional; unknown throws. */
function applyNamed(config: Config, acc: Profile, names: string[], who: string, kind: Kind): Profile {
  for (const name of names) {
    if (name === 'base' && !config.profiles.base) continue;
    const p = config.profiles[name];
    if (!p) throw new Error(`${who}: unknown profile "${name}"`);
    acc = mergeBase(acc, flatten(p, kind));
  }
  return acc;
}

/** Resolve every (agent × variant) pair into a flat ResolvedAgent. Each chain
 *  slot is flattened for the agent's kind as it's applied, so a per-kind overlay
 *  affects only its own slot and normal last-slot-wins ordering still holds. */
export function resolveAll(config: Config): ResolvedAgent[] {
  // `default` always exists (no infix); user-supplied variants override/extend it.
  const variants: Record<string, Variant> = { default: {}, ...config.variants };

  const out: ResolvedAgent[] = [];
  for (const agent of config.agents) {
    const { name, kind, profiles: aProfiles = [], ...aInline } = agent;
    for (const [vName, variant] of Object.entries(variants)) {
      const { profiles: vProfiles = [], ...vInline } = variant;
      const who = `agent "${name}" (variant "${vName}")`;
      let acc: Profile = {};
      acc = applyNamed(config, acc, ['base', ...aProfiles, ...vProfiles], who, kind);
      acc = mergeBase(acc, flatten(vInline, kind)); // variant inline
      acc = mergeBase(acc, flatten(aInline, kind)); // agent inline wins
      const fullName = vName === 'default' ? name : `${vName}-${name}`;
      // settings is already a layer list at runtime; normalize the static type too.
      out.push({ name: fullName, kind, ...acc, settings: asLayers(acc.settings) });
    }
  }
  return out;
}
