import { basename } from 'node:path';

export type TargetKind = 'claude' | 'codex';

export interface TargetSpec {
  kind: TargetKind;
  command: 'klaude' | 'kodex';
  binary: string;
  missingHint: string;
  display: string;
  agentArgs: (session: string, forwarded: string[]) => string[];
}

export const TARGETS: Record<TargetKind, TargetSpec> = {
  claude: {
    kind: 'claude',
    command: 'klaude',
    binary: 'crc-kirin',
    missingHint: 'is the claude-multi `crc` alias installed? run hms',
    display: 'Claude RC',
    agentArgs: (session, forwarded) => ['-n', session, ...forwarded],
  },
  codex: {
    kind: 'codex',
    command: 'kodex',
    binary: 'codex',
    missingHint: 'is Codex installed and on PATH?',
    display: 'Codex',
    agentArgs: (_session, forwarded) => (forwarded.length ? [...forwarded] : ['hello']),
  },
};

export interface ParsedArgs {
  name?: string;
  detach: boolean;
  rest: string[];
}

export function targetFromRuntime(argv1 = process.argv[1] ?? '', env = process.env): TargetKind {
  if (env.KLAUDE_TARGET === 'codex' || env.KLAUDE_TARGET === 'claude') return env.KLAUDE_TARGET;
  return basename(argv1) === 'kodex' ? 'codex' : 'claude';
}

/** Parse klaude/kodex-owned flags and leave all agent flags untouched. */
export function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let name: string | undefined;
  let detach = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--detach') {
      detach = true;
    } else if (a === '-n' || a === '--name') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error(`flag ${a} requires a session name`);
      name = v;
    } else if (a.startsWith('--name=')) {
      name = a.slice('--name='.length);
    } else if (a.startsWith('-n') && a.length > 2) {
      name = a.slice(2);
    } else {
      rest.push(a);
    }
  }

  return { name, detach, rest };
}
