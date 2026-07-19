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
import { type SettingsOutput, resolveSettings } from './settings';
import { type SharedResult, materializeSharedHistory } from './shared-history';
import type {
  AliasMap,
  CommandDef,
  DefaultHomeMap,
  Kind,
  ResolvedAgent,
  SettingsLayer,
  SharedHistoryMap,
} from './types';

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

// Seed the one-time-prompt flags Claude Code tracks in .claude.json so fresh
// config dirs (new account, new machine/box) never stop to ask. These are
// runtime state, NOT settings.json, so kfleet has to write them itself:
//   - per-project hasTrustDialogAccepted -> skip the folder-trust prompt
//   - hasCompletedOnboarding             -> skip the theme/"let's get started" flow
//   - hasCompletedClaudeInChromeOnboarding -> skip the Chrome onboarding step
//   - claudeInChromeDefaultEnabled        -> the ACTUAL gate for the "Chrome
//       extension detected / use my browser?" prompt: it shows while this is
//       null. Seed it to false ONLY if unset (browser stays off by default;
//       `--chrome`/crc still enables it per session) so a dir where you already
//       chose true is never clobbered.
// Runs on every launch (guarded so it's a no-op once all flags are set), which
// self-heals any dir regardless of how it was created. Toggle with CLAUDE_AUTOTRUST=0.
const AUTOTRUST = `if [ "\${CLAUDE_AUTOTRUST:-1}" = "1" ]; then
  _ct_cfg="$CLAUDE_CONFIG_DIR/.claude.json"
  if command -v jq >/dev/null 2>&1 && ! jq -e --arg d "$PWD" '((.projects[$d].hasTrustDialogAccepted) == true) and (.hasCompletedOnboarding == true) and (.hasCompletedClaudeInChromeOnboarding == true) and (.claudeInChromeDefaultEnabled != null)' "$_ct_cfg" >/dev/null 2>&1; then
    mkdir -p "$CLAUDE_CONFIG_DIR"
    _ct_tmp="$(mktemp)"
    if [ -f "$_ct_cfg" ]; then
      _ct_ok=$(jq --arg d "$PWD" '.projects[$d].hasTrustDialogAccepted = true | .hasCompletedOnboarding = true | .hasCompletedClaudeInChromeOnboarding = true | (if .claudeInChromeDefaultEnabled == null then .claudeInChromeDefaultEnabled = false else . end)' "$_ct_cfg" > "$_ct_tmp" 2>/dev/null && echo y)
    else
      _ct_ok=$(jq -n --arg d "$PWD" '{projects: {($d): {hasTrustDialogAccepted: true}}, hasCompletedOnboarding: true, hasCompletedClaudeInChromeOnboarding: true, claudeInChromeDefaultEnabled: false}' > "$_ct_tmp" 2>/dev/null && echo y)
    fi
    if [ "$_ct_ok" = y ]; then mv "$_ct_tmp" "$_ct_cfg"; else rm -f "$_ct_tmp"; fi
  fi
fi

# Pre-approve the wrapper's own API key: Claude Code's "Detected a custom API
# key … use it?" dialog defaults to No and stalls headless/kteam sessions until
# someone answers it. The wrapper exports the key on purpose, so record it as
# approved (verbatim for short keys, last-20 tail for long ones — matching how
# Claude Code stores an interactive approval) before the TUI ever asks.
if [ "\${CLAUDE_AUTOTRUST:-1}" = "1" ] && [ -n "\${ANTHROPIC_API_KEY:-}" ] && command -v jq >/dev/null 2>&1; then
  _ck_cfg="$CLAUDE_CONFIG_DIR/.claude.json"
  _ck_key="$ANTHROPIC_API_KEY"
  [ "\${#_ck_key}" -gt 20 ] && _ck_key=$(printf %s "$_ck_key" | tail -c 20)
  if ! jq -e --arg k "$_ck_key" '(.customApiKeyResponses.approved // []) | index($k) != null' "$_ck_cfg" >/dev/null 2>&1; then
    mkdir -p "$CLAUDE_CONFIG_DIR"
    _ck_tmp="$(mktemp)"
    if [ -f "$_ck_cfg" ]; then
      _ck_ok=$(jq --arg k "$_ck_key" '.customApiKeyResponses.approved = (((.customApiKeyResponses.approved // []) + [$k]) | unique)' "$_ck_cfg" > "$_ck_tmp" 2>/dev/null && echo y)
    else
      _ck_ok=$(jq -n --arg k "$_ck_key" '{customApiKeyResponses: {approved: [$k]}}' > "$_ck_tmp" 2>/dev/null && echo y)
    fi
    if [ "$_ck_ok" = y ]; then mv "$_ck_tmp" "$_ck_cfg"; else rm -f "$_ck_tmp"; fi
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
function materializeAgent(r: ResolvedAgent, dirOverride?: string): string[] {
  const spec = KIND_SPECS[r.kind];
  const dir = dirOverride ?? spec.configDir(r.name);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  for (const asset of spec.assets) {
    const ref = r[asset.field];
    if (ref === undefined) continue; // asset not provided by this agent

    // Structured-config assets (settings) are a layered list: deep-merge + emit.
    if (asset.format) {
      const layers = (Array.isArray(ref) ? ref : [ref]) as SettingsLayer[];
      const dest = path.join(dir, asset.dest[0]);
      let out: SettingsOutput;
      try {
        out = resolveSettings(layers, asset.format, asset.mode);
      } catch (e) {
        throw new Error(`agent "${r.name}": ${(e as Error).message}`);
      }
      if (out.kind === 'write') replaceWith(dest, () => writeFileSync(dest, out.content));
      else if (out.kind === 'copy') replaceWith(dest, () => copyFileSync(out.src, dest));
      else replaceWith(dest, () => symlinkSync(out.src, dest));
      written.push(dest);
      continue;
    }

    if (typeof ref !== 'string') continue; // non-settings fields are plain paths
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

export interface DefaultHomeTarget {
  kind: Kind;
  target: string;
  agent: ResolvedAgent;
  dir: string;
}

/** Resolve configured default homes to concrete agents before any fs writes. */
export function resolveDefaultHomeTargets(defaultHomes: DefaultHomeMap, agents: ResolvedAgent[]): DefaultHomeTarget[] {
  const out: DefaultHomeTarget[] = [];
  for (const [kind, target] of Object.entries(defaultHomes) as [Kind, string | undefined][]) {
    if (!target) continue;
    const agent = agents.find(a => a.kind === kind && (a.name === target || wrapperName(a) === target));
    if (!agent) {
      throw new Error(`defaultHomes.${kind}: unknown target "${target}"`);
    }
    out.push({ kind, target, agent, dir: KIND_SPECS[kind].defaultConfigDir });
  }
  return out;
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
export function apply(
  agents: ResolvedAgent[],
  commands: CommandDef[] = [],
  defaultHomes: DefaultHomeMap = {},
  sharedHistory: Partial<SharedHistoryMap> = {},
): { agents: number; commands: number; defaultHomes: number; shared: SharedResult } {
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
  const defaultHomeTargets = resolveDefaultHomeTargets(defaultHomes, agents);
  const shared: SharedResult = { migrated: 0, conflicts: 0 };
  const shareInto = (kind: Kind, dir: string): void => {
    if (!sharedHistory[kind]) return;
    const r = materializeSharedHistory(kind, dir);
    shared.migrated += r.migrated;
    shared.conflicts += r.conflicts;
  };
  for (const r of agents) {
    materializeAgent(r);
    writeWrapper(r);
    shareInto(r.kind, KIND_SPECS[r.kind].configDir(r.name));
  }
  for (const d of defaultHomeTargets) {
    materializeAgent(d.agent, d.dir);
    shareInto(d.kind, d.dir); // the bare CLI's home joins the pool too
  }
  for (const c of commands) writeCommand(c);
  return { agents: agents.length, commands: commands.length, defaultHomes: defaultHomeTargets.length, shared };
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
