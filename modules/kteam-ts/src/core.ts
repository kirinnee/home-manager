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

/** Per-binary account health from `kfleet usage` (the kfleet serve /usage feed). */
export interface AgentUsage {
  binary: string;
  atLimit?: boolean;
  authOk?: boolean;
  fiveHourPercent?: number;
  weeklyPercent?: number;
}

/** How "spent" an account is: the tighter of its 5h and weekly windows. */
export function usageScore(usage: AgentUsage | undefined): number {
  if (!usage) return 0;
  return Math.max(usage.fiveHourPercent ?? 0, usage.weeklyPercent ?? 0);
}

export function usableAgent(usage: AgentUsage | undefined): boolean {
  return usage?.atLimit !== true && usage?.authOk !== false;
}

/** Pattern precedence picks the tier; usage load-balances within it: 70% the
 *  least-used candidate, 30% the runner-up, so parallel teams spread across
 *  same-tier accounts instead of hammering whichever sorts first. */
function find(
  agents: string[],
  patterns: RegExp[],
  used: Set<string>,
  usageByBinary: Map<string, AgentUsage>,
  rng: () => number,
): string | undefined {
  for (const pattern of patterns) {
    const matches = agents
      .filter(agent => !used.has(agent) && pattern.test(agent))
      .sort((a, b) => usageScore(usageByBinary.get(a)) - usageScore(usageByBinary.get(b)));
    if (matches.length === 0) continue;
    if (matches.length > 1 && rng() < 0.3) return matches[1];
    return matches[0];
  }
  return undefined;
}

/** Recommend a small, complementary team. This never launches anything.
 *  Binaries that are at their usage limit or logged out are excluded up front. */
export function recommendAgents(
  task: string,
  agents: string[],
  usage: AgentUsage[] = [],
  rng: () => number = Math.random,
): Recommendation[] {
  const text = task.toLowerCase();
  const usageByBinary = new Map(usage.map(item => [item.binary, item]));
  agents = agents.filter(agent => usableAgent(usageByBinary.get(agent)));
  const used = new Set<string>();
  const out: Recommendation[] = [];
  const add = (patterns: RegExp[], role: string, reason: string) => {
    const binary = find(agents, patterns, used, usageByBinary, rng);
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

  const frontier = [
    /codex-auto-(atomi|loge|loai|loio|kirin|ernest|personal)$/,
    // f5-* wrappers are the same accounts as the base ones (shared quota);
    // recommend the base wrapper and reach Fable via `--model fable` instead.
    /claude-auto-(kirin|liftoff|atomi)$/,
    /claude-auto-loge$/,
  ];
  add(
    frontier,
    out.length ? 'independent reviewer' : 'primary implementer',
    out.length
      ? 'use an independent frontier account to review correctness and completion'
      : 'use a frontier account for difficult implementation work',
  );

  // A useful team is implementer + reviewer + one more perspective. Keyword
  // rules above only fire for matching tasks, so generic prompts must still be
  // filled from the remaining pool — preferring the harness family NOT yet on
  // the team, so validation comes from an independent model.
  const fillers = [...frontier, /codex-auto-/, /claude-auto-/];
  while (out.length < Math.min(3, agents.length)) {
    const lastHarness = out.at(-1)?.binary.includes('codex-') ? 'codex' : 'claude';
    const other = lastHarness === 'codex' ? /^claude-auto-(?!.*(mm3|glm52|dsv4))/ : /codex-auto-/;
    const binary = find(agents, [other, ...fillers], used, usageByBinary, rng);
    if (!binary) break;
    used.add(binary);
    out.push({
      binary,
      role: out.length === 0 ? 'primary implementer' : out.length === 1 ? 'independent reviewer' : 'second implementer',
      reason:
        out.length <= 1
          ? 'independent frontier account for implementation and review'
          : 'parallel implementer or extra validation from a different account',
    });
  }

  return out.slice(0, 4);
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
