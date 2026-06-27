// Expand each agent across every variant into a flat ResolvedAgent.
//
// For (agent A, variant V) the merge order is, right overriding left:
//   base -> A.profiles -> V.profiles -> V.inline -> A.inline
// Wrapper name: the `default` variant keeps `<name>`; any other variant V infixes
// `V-` (so kind=claude, name=kirin, variant=auto -> resolved name "auto-kirin",
// wrapper claude-auto-kirin, dir ~/.claude-auto-kirin).
import type { Config, Profile, ResolvedAgent, Variant } from './types';

/** Merge `b` onto `a`: env merges, flags concatenate, scalars replace. */
function mergeProfile(a: Profile, b: Profile): Profile {
  return {
    ...a,
    ...b,
    env: a.env || b.env ? { ...a.env, ...b.env } : undefined,
    flags: a.flags || b.flags ? [...(a.flags ?? []), ...(b.flags ?? [])] : undefined,
  };
}

/** Apply named profiles in order onto `acc`. `base` is optional; unknown throws. */
function applyNamed(config: Config, acc: Profile, names: string[], who: string): Profile {
  for (const name of names) {
    if (name === 'base' && !config.profiles.base) continue;
    const p = config.profiles[name];
    if (!p) throw new Error(`${who}: unknown profile "${name}"`);
    acc = mergeProfile(acc, p);
  }
  return acc;
}

/** Resolve every (agent × variant) pair into a flat ResolvedAgent. */
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
      acc = applyNamed(config, acc, ['base', ...aProfiles, ...vProfiles], who);
      acc = mergeProfile(acc, vInline); // variant inline
      acc = mergeProfile(acc, aInline); // agent inline wins
      const fullName = vName === 'default' ? name : `${vName}-${name}`;
      out.push({ name: fullName, kind, ...acc });
    }
  }
  return out;
}
