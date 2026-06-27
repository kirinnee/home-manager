// The generator: turn resolved agents into wrapper scripts (~/.kfleet/bin) and
// materialized config dirs (~/.claude-<n>, …). Idempotent: only managed wrappers
// and the symlinks/files kfleet owns are touched — sessions, auth, sqlite, etc.
// inside a config dir are never removed.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { binDir, home, resolveAsset } from '../deps';
import { KIND_SPECS } from './kinds';
import type { AliasMap, CommandDef, ResolvedAgent } from './types';

/** Marker line so prune can tell kfleet-owned wrappers from anything else. */
const MARKER = '# kfleet-managed — do not edit (regenerate with `kfleet apply`)';

const homeForm = (abs: string): string =>
  abs === home || abs.startsWith(`${home}${path.sep}`) ? `$HOME${abs.slice(home.length)}` : abs;

/** True if anything exists at `p` — including a broken symlink (lstat, not stat). */
const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Quote for a double-quoted shell string. We escape \ and " only — `$` is left
// INTENTIONALLY unescaped so env values like "$API_CLI_PROXY_TOKEN" and config
// dirs like "$HOME/.claude-x" expand at runtime (exactly as the old Nix wrappers
// did). Configs are user-authored and trusted, so this is not an injection sink.
const shQuote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const wrapperName = (a: { kind: string; name: string }): string => `${a.kind}-${a.name}`;
const wrapperPath = (a: { kind: string; name: string }): string => path.join(binDir, wrapperName(a));

const AUTOTRUST = `if [ "\${CLAUDE_AUTOTRUST:-1}" = "1" ]; then
  _ct_cfg="$CLAUDE_CONFIG_DIR/.claude.json"
  if command -v jq >/dev/null 2>&1 && ! jq -e --arg d "$PWD" '(.projects[$d].hasTrustDialogAccepted) == true' "$_ct_cfg" >/dev/null 2>&1; then
    mkdir -p "$CLAUDE_CONFIG_DIR"
    _ct_tmp="$(mktemp)"
    if [ -f "$_ct_cfg" ]; then
      _ct_ok=$(jq --arg d "$PWD" '.projects[$d].hasTrustDialogAccepted = true' "$_ct_cfg" > "$_ct_tmp" 2>/dev/null && echo y)
    else
      _ct_ok=$(jq -n --arg d "$PWD" '{projects: {($d): {hasTrustDialogAccepted: true}}}' > "$_ct_tmp" 2>/dev/null && echo y)
    fi
    if [ "$_ct_ok" = y ]; then mv "$_ct_tmp" "$_ct_cfg"; else rm -f "$_ct_tmp"; fi
  fi
fi`;

/** Render the wrapper shell script for one resolved agent. */
export function renderWrapper(r: ResolvedAgent): string {
  const spec = KIND_SPECS[r.kind];
  const dir = spec.configDir(r.name);
  const env = { ...spec.wrapperEnv(r.name, homeForm(dir)), ...(r.env ?? {}) };

  const lines = ['#!/bin/sh', MARKER];
  for (const [k, v] of Object.entries(env)) lines.push(`export ${k}=${shQuote(v)}`);
  if (spec.autotrust) lines.push('', AUTOTRUST);
  const flags = (r.flags ?? []).map(shQuote).join(' ');
  lines.push('', `exec ${spec.bin}${flags ? ` ${flags}` : ''} "$@"`, '');
  return lines.join('\n');
}

function replaceWith(dest: string, make: () => void): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (lexists(dest)) rmSync(dest, { recursive: true, force: true });
  make();
}

/** Materialize one agent's config dir assets. Returns the dest paths written. */
function materializeAgent(r: ResolvedAgent): string[] {
  const spec = KIND_SPECS[r.kind];
  const dir = spec.configDir(r.name);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  for (const asset of spec.assets) {
    const ref = r[asset.field];
    if (typeof ref !== 'string') continue; // asset not provided by this agent
    const src = resolveAsset(ref);
    if (!existsSync(src)) throw new Error(`agent "${r.name}": ${asset.field} source not found: ${src}`);
    for (const name of asset.dest) {
      const dest = path.join(dir, name);
      if (asset.mode === 'copy') {
        replaceWith(dest, () => copyFileSync(src, dest));
      } else {
        replaceWith(dest, () => symlinkSync(src, dest));
      }
      written.push(dest);
    }
  }
  return written;
}

/** Write one agent's wrapper script (executable). */
function writeWrapper(r: ResolvedAgent): string {
  mkdirSync(binDir, { recursive: true });
  const p = wrapperPath(r);
  writeFileSync(p, renderWrapper(r), { mode: 0o755 });
  return p;
}

/** Render a command: exec the target agent's wrapper with flags prepended. */
export function renderCommand(c: CommandDef): string {
  const target = homeForm(path.join(binDir, c.target));
  const flags = c.flags.map(shQuote).join(' ');
  return ['#!/bin/sh', MARKER, '', `exec ${shQuote(target)}${flags ? ` ${flags}` : ''} "$@"`, ''].join('\n');
}

function writeCommand(c: CommandDef): string {
  mkdirSync(binDir, { recursive: true });
  const p = path.join(binDir, c.name);
  writeFileSync(p, renderCommand(c), { mode: 0o755 });
  return p;
}

/** Names of all kfleet-managed wrappers currently in binDir. */
function listManagedWrappers(): string[] {
  if (!existsSync(binDir)) return [];
  return readdirSync(binDir).filter(f => {
    try {
      return readFileSync(path.join(binDir, f), 'utf8').includes(MARKER);
    } catch {
      return false;
    }
  });
}

/** Fan an alias map out into concrete commands: one `<alias>-<kind>-<name>` per
 *  agent whose kind the alias lists flags for. Reuses the command pipeline below,
 *  so collision/prune/render all apply uniformly. */
export function expandAliases(aliases: AliasMap, agents: ResolvedAgent[]): CommandDef[] {
  const out: CommandDef[] = [];
  for (const [alias, byKind] of Object.entries(aliases)) {
    for (const a of agents) {
      const raw = byKind[a.kind];
      if (raw === undefined) continue; // this kind not configured for this alias
      const flags = Array.isArray(raw) ? raw : raw.trim().split(/\s+/).filter(Boolean);
      const target = wrapperName(a);
      // alias REPLACES the kind prefix, keeping the variant infix:
      // claude agent "auto-atomi" → yolo-auto-atomi (not yolo-claude-auto-atomi).
      out.push({ name: `${alias}-${a.name}`, target, flags });
    }
  }
  return out;
}

/** Generate wrappers + config dirs for every agent, then command wrappers. */
export function apply(agents: ResolvedAgent[], commands: CommandDef[] = []): { agents: number; commands: number } {
  // Two (agent × variant) pairs can collide — e.g. an agent literally named
  // `auto-kirin` (default variant) and `kirin` under an `auto` variant both map
  // to `claude-auto-kirin`. Catch it instead of silently overwriting.
  const agentWrappers = new Set<string>();
  for (const a of agents) {
    const w = wrapperName(a);
    if (agentWrappers.has(w))
      throw new Error(`duplicate wrapper "${w}" — two agent×variant pairs produce the same name`);
    agentWrappers.add(w);
  }
  const seen = new Set<string>();
  for (const c of commands) {
    if (!agentWrappers.has(c.target)) {
      throw new Error(`command "${c.name}": unknown target "${c.target}" (not a configured agent wrapper)`);
    }
    if (agentWrappers.has(c.name)) {
      throw new Error(`command "${c.name}" collides with an agent wrapper of the same name`);
    }
    if (seen.has(c.name)) throw new Error(`duplicate command name "${c.name}"`);
    seen.add(c.name);
  }
  for (const r of agents) {
    materializeAgent(r);
    writeWrapper(r);
  }
  for (const c of commands) writeCommand(c);
  return { agents: agents.length, commands: commands.length };
}

/** Remove managed wrappers no longer backed by an agent or command. Returns removed names. */
export function prune(agents: ResolvedAgent[], commands: CommandDef[] = []): string[] {
  const keep = new Set([...agents.map(wrapperName), ...commands.map(c => c.name)]);
  const removed: string[] = [];
  for (const f of listManagedWrappers()) {
    if (!keep.has(f)) {
      rmSync(path.join(binDir, f), { force: true });
      removed.push(f);
    }
  }
  return removed;
}
