// Per-kind materialization rules, learned from the live config dirs the old Nix
// modules produced. Each kind knows: its binary, where its config dir lives, the
// env that points the binary at that dir, and which profile assets land where.
import path from 'node:path';
import { home } from '../deps';
import type { Kind, Profile } from './types';

type Field = keyof Profile;

/** One session-state entry poolable across accounts (see core/shared-history.ts). */
export interface SharedEntry {
  /** entry name inside the config dir (and inside the per-kind pool) */
  name: string;
  type: 'dir' | 'file';
}

interface Asset {
  /** which resolved-profile field supplies the source path */
  field: Field;
  /** destination name(s) inside the config dir */
  dest: string[];
  type: 'file' | 'dir';
  /** link = symlink to the ~/.kfleet source; copy = independent file the tool may rewrite */
  mode: 'link' | 'copy';
  /** structured-config format. When set, the field is a layered settings list:
   *  layers (file paths + inline objects) deep-merge then serialize to `dest`.
   *  A single file-path layer is emitted verbatim per `mode` (no parse → comments
   *  and formatting preserved). */
  format?: 'toml' | 'json';
}

interface KindSpec {
  bin: string;
  /** absolute config dir for an agent of this kind */
  configDir: (name: string) => string;
  /** absolute config dir used by the bare upstream CLI for this kind */
  defaultConfigDir: string;
  /** wrapper env that points the binary at its config dir (name, dir) -> exports */
  wrapperEnv: (name: string, dir: string) => Record<string, string>;
  assets: Asset[];
  /** claude-only: bake the auto-accept-trust shell snippet into the wrapper */
  autotrust?: boolean;
  /** session-state entries pooled across accounts when sharedHistory is on.
   *  Everything `--resume`/`--continue` needs; identity/auth stays per-account. */
  sharedState: SharedEntry[];
}

export const KIND_SPECS: Record<Kind, KindSpec> = {
  claude: {
    bin: 'claude',
    configDir: n => path.join(home, `.claude-${n}`),
    defaultConfigDir: path.join(home, '.claude'),
    wrapperEnv: (_n, dir) => ({ CLAUDE_CONFIG_DIR: dir }),
    autotrust: true,
    assets: [
      { field: 'settings', dest: ['settings.json'], type: 'file', mode: 'link', format: 'json' },
      { field: 'memory', dest: ['CLAUDE.md'], type: 'file', mode: 'link' },
      { field: 'skills', dest: ['skills'], type: 'dir', mode: 'link' },
      { field: 'mcp', dest: ['.mcp.json'], type: 'file', mode: 'link' },
    ],
    // Session transcripts + everything a resumed session references. NOT shared:
    // .claude.json (OAuth/auth/trust), settings, plugins, cache, telemetry.
    sharedState: [
      { name: 'projects', type: 'dir' }, // transcripts (<cwd>/<session-id>.jsonl) + per-project memory
      { name: 'sessions', type: 'dir' }, // per-session working dirs (workflow scripts, scratch)
      { name: 'session-env', type: 'dir' },
      { name: 'file-history', type: 'dir' }, // checkpoints / rewind
      { name: 'plans', type: 'dir' },
      { name: 'tasks', type: 'dir' },
      { name: 'todos', type: 'dir' },
      { name: 'shell-snapshots', type: 'dir' }, // referenced by transcripts at resume
      { name: 'paste-cache', type: 'dir' }, // pasted content referenced by transcripts
      { name: 'history.jsonl', type: 'file' }, // up-arrow prompt history
    ],
  },
  codex: {
    bin: 'codex',
    configDir: n => path.join(home, `.codex-${n}`),
    defaultConfigDir: path.join(home, '.codex'),
    wrapperEnv: (_n, dir) => ({ CODEX_HOME: dir }),
    assets: [
      // codex rewrites config.toml at runtime, so copy rather than symlink.
      { field: 'settings', dest: ['config.toml'], type: 'file', mode: 'copy', format: 'toml' },
      { field: 'memory', dest: ['AGENTS.md'], type: 'file', mode: 'link' },
      { field: 'hooks', dest: ['hooks.json'], type: 'file', mode: 'link' },
      { field: 'hooksDir', dest: ['hooks'], type: 'dir', mode: 'link' },
      { field: 'skills', dest: ['skills'], type: 'dir', mode: 'link' },
    ],
    // Rollout files + prompt history. NOT shared: auth.json, config.toml, sqlite state.
    sharedState: [
      { name: 'sessions', type: 'dir' }, // rollout transcripts (what `codex resume` reads)
      { name: 'archived_sessions', type: 'dir' },
      { name: 'history.jsonl', type: 'file' },
    ],
  },
};
