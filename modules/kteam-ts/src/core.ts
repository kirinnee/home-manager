import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { Harness, Recommendation, SessionConfig } from './types';

export function inferHarness(binary: string): Harness {
  const base = path.basename(binary);
  if (base.startsWith('claude-')) return 'claude';
  if (base.startsWith('codex-')) return 'codex';
  throw new Error(`unsupported harness wrapper "${binary}"; expected claude-* or codex-*`);
}

export function modelHint(binary: string): string {
  const base = path.basename(binary).replace(/^(claude|codex)-auto-/, '');
  if (base === 'mm3') return 'MiniMax M3';
  if (base.startsWith('glm52')) return 'GLM-5.2';
  if (base.startsWith('dsv4f')) return 'DeepSeek V4 Flash';
  if (base.startsWith('dsv4p')) return 'DeepSeek V4 Pro';
  if (base.startsWith('f5-') || base === 'loge') return 'F5/frontier account';
  return base;
}

export function discoverAutoAgents(binDir: string): string[] {
  if (!existsSync(binDir)) return [];
  return readdirSync(binDir)
    .filter(name => /^(claude|codex)-auto-/.test(name))
    .filter(name => {
      try {
        return existsSync(path.join(binDir, name));
      } catch {
        return false;
      }
    })
    .sort();
}

function find(agents: string[], patterns: RegExp[], used: Set<string>): string | undefined {
  for (const pattern of patterns) {
    const match = agents.find(agent => !used.has(agent) && pattern.test(agent));
    if (match) return match;
  }
  return undefined;
}

/** Recommend a small, complementary team. This never launches anything. */
export function recommendAgents(task: string, agents: string[]): Recommendation[] {
  const text = task.toLowerCase();
  const used = new Set<string>();
  const out: Recommendation[] = [];
  const add = (patterns: RegExp[], role: string, reason: string) => {
    const binary = find(agents, patterns, used);
    if (!binary) return;
    used.add(binary);
    out.push({ binary, role, reason });
  };

  if (/front.?end|\bui\b|react|css|design|landing|dashboard|svg|screenshot/.test(text)) {
    add(
      [/claude-auto-mm3$/],
      'frontend implementer',
      'MiniMax M3 is fast and especially strong at UI, visual, and SVG work',
    );
  }

  if (/research|inventory|search|scan|triage|mechanical|rename|format/.test(text)) {
    add(
      [/claude-auto-dsv4f$/, /claude-auto-mm3$/],
      'fast scout',
      'use a fast account for repository discovery and bounded mechanical work',
    );
  }

  if (/cheap|cost|long|migration|large|refactor|hard|complex/.test(text)) {
    add(
      [/claude-auto-glm52a$/, /claude-auto-glm52b$/],
      'cost-efficient implementer',
      'GLM-5.2 is slower but well suited to difficult, cost-sensitive work',
    );
  }

  add(
    [
      /codex-auto-(atomi|loge|loai|loio|kirin|ernest|personal)$/,
      // f5-* wrappers are the same accounts as the base ones (shared quota);
      // recommend the base wrapper and reach Fable via `--model fable` instead.
      /claude-auto-(kirin|liftoff|atomi)$/,
      /claude-auto-loge$/,
    ],
    out.length ? 'independent reviewer' : 'primary implementer',
    out.length
      ? 'use an independent frontier account to review correctness and completion'
      : 'use a frontier account for difficult implementation work',
  );

  if (out.length < 2) {
    add(
      [/claude-auto-mm3$/, /claude-auto-glm52[ab]$/, /codex-auto-/, /claude-auto-/],
      'second perspective',
      'add a different harness or model family for independent validation',
    );
  }

  return out.slice(0, 3);
}

export function interactiveHarnessArgs(config: SessionConfig): string[] {
  // Both harnesses take `--model <alias|id>`. When set it's the user override or
  // the wrapper's kfleet default (KTEAM_MODEL); when unset, omit it entirely.
  const model = config.model ? ['--model', config.model] : [];

  if (config.harness === 'claude') {
    const sessionFlag = config.turn === 1 ? '--session-id' : '--resume';
    const args = ['--dangerously-skip-permissions', sessionFlag, config.harnessSessionId, ...model];
    if (config.mode === 'auto') args.push('--disallowedTools', 'AskUserQuestion');
    return args;
  }

  if (config.turn === 1) {
    return [...model, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'];
  }
  // `resume` is a subcommand and must stay first; the model flag follows it.
  return ['resume', ...model, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', config.harnessSessionId];
}

export function shellSafeSessionName(id: string, suffix: string): string {
  return `kteam-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${suffix}`.slice(0, 80);
}
