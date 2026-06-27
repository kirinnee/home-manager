// Per-kind materialization rules, learned from the live config dirs the old Nix
// modules produced. Each kind knows: its binary, where its config dir lives, the
// env that points the binary at that dir, and which profile assets land where.
import path from 'node:path';
import { home } from '../deps';
import type { Kind, Profile } from './types';

type Field = keyof Profile;

interface Asset {
  /** which resolved-profile field supplies the source path */
  field: Field;
  /** destination name(s) inside the config dir */
  dest: string[];
  type: 'file' | 'dir';
  /** link = symlink to the ~/.kfleet source; copy = independent file the tool may rewrite */
  mode: 'link' | 'copy';
}

interface KindSpec {
  bin: string;
  /** absolute config dir for an agent of this kind */
  configDir: (name: string) => string;
  /** wrapper env that points the binary at its config dir (name, dir) -> exports */
  wrapperEnv: (name: string, dir: string) => Record<string, string>;
  assets: Asset[];
  /** claude-only: bake the auto-accept-trust shell snippet into the wrapper */
  autotrust?: boolean;
}

export const KIND_SPECS: Record<Kind, KindSpec> = {
  claude: {
    bin: 'claude',
    configDir: n => path.join(home, `.claude-${n}`),
    wrapperEnv: (_n, dir) => ({ CLAUDE_CONFIG_DIR: dir }),
    autotrust: true,
    assets: [
      { field: 'settings', dest: ['settings.json'], type: 'file', mode: 'link' },
      { field: 'memory', dest: ['CLAUDE.md'], type: 'file', mode: 'link' },
      { field: 'skills', dest: ['skills'], type: 'dir', mode: 'link' },
      { field: 'mcp', dest: ['.mcp.json'], type: 'file', mode: 'link' },
    ],
  },
  codex: {
    bin: 'codex',
    configDir: n => path.join(home, `.codex-${n}`),
    wrapperEnv: (_n, dir) => ({ CODEX_HOME: dir }),
    assets: [
      // codex rewrites config.toml at runtime, so copy rather than symlink.
      { field: 'settings', dest: ['config.toml'], type: 'file', mode: 'copy' },
      { field: 'memory', dest: ['AGENTS.md'], type: 'file', mode: 'link' },
      { field: 'hooks', dest: ['hooks.json'], type: 'file', mode: 'link' },
      { field: 'hooksDir', dest: ['hooks'], type: 'dir', mode: 'link' },
      { field: 'skills', dest: ['skills'], type: 'dir', mode: 'link' },
    ],
  },
};
