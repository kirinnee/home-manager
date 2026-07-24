import { describe, expect, test } from 'bun:test';
import {
  classifyTask,
  inferHarness,
  interactiveHarnessArgs,
  recommendTeam,
  resolveDisplayModel,
  startWaitMsFor,
  usableAgent,
  usageScore,
  type RoleOption,
  type TeamRecommendation,
  type TeamRole,
} from './core';
import type { SessionConfig } from './types';

const config = (harness: 'claude' | 'codex', turn = 1, model?: string): SessionConfig => ({
  id: 'abc',
  name: 'test',
  binary: `${harness}-auto-test`,
  harness,
  modelHint: 'test',
  model,
  cwd: '/tmp',
  mode: 'auto',
  createdAt: '',
  updatedAt: '',
  turn,
  harnessSessionId: '00000000-0000-4000-8000-000000000000',
  tmuxSession: 'kteam-abc-agent',
  watcherSession: 'kteam-abc-watch',
  intervalSeconds: 15,
  stallSeconds: 900,
  timeoutSeconds: 7200,
  maxSnapshots: 200,
  systemPromptFile: '/tmp/system.md',
  originalPromptFile: '/tmp/prompt.md',
});

describe('harness support', () => {
  test('infers supported wrappers', () => {
    expect(inferHarness('claude-auto-mm3')).toBe('claude');
    expect(inferHarness('/x/codex-auto-atomi')).toBe('codex');
  });

  test('uses interactive persistent resume modes without print or exec', () => {
    expect(interactiveHarnessArgs(config('claude', 2))).toContain('--resume');
    expect(interactiveHarnessArgs(config('claude', 2))).not.toContain('--print');
    expect(interactiveHarnessArgs(config('codex', 2))[0]).toBe('resume');
    expect(interactiveHarnessArgs(config('codex', 1))).not.toContain('exec');
  });

  test('omits --model when no model is set', () => {
    expect(interactiveHarnessArgs(config('claude', 1))).not.toContain('--model');
    expect(interactiveHarnessArgs(config('codex', 1))).not.toContain('--model');
    expect(interactiveHarnessArgs(config('codex', 2))).not.toContain('--model');
  });

  test('injects --model for both harnesses when set', () => {
    const claudeArgs = interactiveHarnessArgs(config('claude', 1, 'opus'));
    expect(claudeArgs).toContain('--model');
    expect(claudeArgs[claudeArgs.indexOf('--model') + 1]).toBe('opus');

    // codex fresh start: --model is a top-level option
    const codexNew = interactiveHarnessArgs(config('codex', 1, 'terra'));
    expect(codexNew[codexNew.indexOf('--model') + 1]).toBe('terra');

    // codex resume: `resume` subcommand stays first, then --model
    const codexResume = interactiveHarnessArgs(config('codex', 2, 'terra'));
    expect(codexResume[0]).toBe('resume');
    expect(codexResume[codexResume.indexOf('--model') + 1]).toBe('terra');
  });
});

test('contextWindowForModel: 1m suffix, default, and overrides (turn-020)', () => {
  const { contextWindowForModel } = require('./core');
  expect(contextWindowForModel('claude-fable-5[1m]')).toBe(1_000_000);
  expect(contextWindowForModel('claude-opus-4-8')).toBe(200_000);
  expect(contextWindowForModel(undefined)).toBe(200_000);
  // Overrides match by substring, longest pattern wins.
  expect(contextWindowForModel('glm-5.2', { 'glm-5.2': 131_072 })).toBe(131_072);
  expect(contextWindowForModel('glm-5.2-turbo', { glm: 100_000, 'glm-5.2-turbo': 65_536 })).toBe(65_536);
  expect(contextWindowForModel('claude-fable-5[1m]', { fable: 900_000 })).toBe(900_000);
});

// ---------------------------------------------------------------------------
// `kteam recommend` — doctrine floors (kfleet/skills/kteam/SKILL.md)
// ---------------------------------------------------------------------------

/** The whole installed fleet minus the wrappers doctrine bans outright. */
const FLEET = [
  'claude-auto-kirin',
  'claude-auto-atomi',
  'claude-auto-liftoff',
  'claude-auto-loge',
  'claude-auto-glm52a',
  'claude-auto-glm52b',
  'claude-auto-mm3',
  'claude-auto-dsv4f',
  'claude-auto-dsv4p',
  'codex-auto-loge',
  'codex-auto-loai',
  'codex-auto-loio',
  'codex-auto-ernest',
  'codex-auto-atomi',
  'codex-auto-personal',
];

const MASS_CHORE_TIER = ['glm52', 'mm3', 'dsv4f', 'haiku', 'sonnet5'];
const TOP_TIER = ['sol', 'opus5'];

const role = (team: TeamRecommendation, name: TeamRole) => team.roles.find(item => item.role === name);
const everyone = (team: TeamRecommendation): RoleOption[] =>
  team.roles.flatMap(item => [item.primary, ...item.alternatives]);

describe('recommendTeam: classification axes are explicit', () => {
  test('reports the axes AND the words that drove them', () => {
    const classification = classifyTask('Fix the security bug in the production payment endpoint');
    expect(classification.risk).toBe('critical');
    expect(classification.kind).toBe('debugging');
    const risk = classification.evidence.find(item => item.axis === 'risk');
    expect(risk?.matched).toContain('security');
    expect(risk?.matched.some(word => word.includes('payment'))).toBe(true);
  });

  test('a stated plan removes the ambiguity a hard task would carry', () => {
    expect(classifyTask('Rewrite the scheduler').ambiguity).toBe('high');
    expect(classifyTask('Rewrite the scheduler following the plan in PLAN.md').ambiguity).toBe('low');
  });

  test('"mechanically rename" stays hard when the subject is hard', () => {
    // Mechanical words must not beat hardness evidence — the old regex router
    // classified on whichever pattern it tested first.
    expect(classifyTask('rename a variable').complexity).toBe('mechanical');
    expect(classifyTask('rename the concurrent scheduler protocol handlers').complexity).toBe('hard');
  });

  test('the rendered reasoning names the read and the resulting shape', () => {
    const team = recommendTeam('Redesign the distributed lock protocol', FLEET);
    expect(team.reasoning).toContain('hard');
    expect(team.reasoning).toContain('Team shape:');
  });
});

describe('recommendTeam: table-driven tier floors', () => {
  const cases: Array<{
    name: string;
    task: string;
    expect: (team: TeamRecommendation) => void;
  }> = [
    {
      name: 'frontend tweak',
      task: 'Tweak the CSS on the landing page hero component so it is responsive',
      expect: team => {
        // Product-facing: M3 and DeepSeek are barred from the implementer slot
        // even though frontend is M3's documented niche.
        expect(team.classification.kind).toBe('frontend');
        expect(team.classification.productFacing).toBe(true);
        expect(role(team, 'implementer')!.primary.model).not.toBe('mm3');
        expect(role(team, 'implementer')!.primary.model).not.toBe('dsv4f');
        expect(role(team, 'reviewer')).toBeDefined();
        // …and the top tier is overkill for a mid-difficulty CSS tweak.
        expect(TOP_TIER).not.toContain(role(team, 'implementer')!.primary.model);
      },
    },
    {
      name: 'hard migration',
      task: 'Design and execute a complex migration of the distributed event store to the new protocol',
      expect: team => {
        expect(team.classification.complexity).toBe('hard');
        expect(role(team, 'planner')).toBeDefined();
        expect(MASS_CHORE_TIER).not.toContain(role(team, 'implementer')!.primary.model);
        expect(TOP_TIER).toContain(role(team, 'implementer')!.primary.model);
      },
    },
    {
      name: '40-file rename',
      task: 'Rename the logger helper across 40 files, one file per agent',
      expect: team => {
        expect(team.classification.kind).toBe('bulk-chore');
        expect(team.classification.complexity).toBe('mechanical');
        const fanOut = role(team, 'fan-out');
        expect(fanOut).toBeDefined();
        expect(fanOut!.count).toBeGreaterThanOrEqual(2);
        expect(MASS_CHORE_TIER).toContain(fanOut!.primary.model);
        // The fan-out IS the implementation: no separate top-tier implementer
        // parked next to a 1-file-per-agent swarm.
        expect(role(team, 'implementer')).toBeUndefined();
      },
    },
    {
      name: 'security-critical fix',
      task: 'Fix the auth token leak in the production credential store',
      expect: team => {
        expect(team.classification.risk).toBe('critical');
        // Risky change → cross-family reviewer, never the mass-chore tier.
        const implementer = role(team, 'implementer')!;
        const reviewer = role(team, 'reviewer')!;
        expect(reviewer.primary.family).not.toBe(implementer.primary.family);
        expect(MASS_CHORE_TIER).not.toContain(implementer.primary.model);
      },
    },
    {
      name: 'research this API',
      task: 'Research this API and report how its pagination works',
      expect: team => {
        expect(team.classification.kind).toBe('research');
        expect(role(team, 'researcher')).toBeDefined();
        expect(role(team, 'implementer')).toBeUndefined();
      },
    },
  ];

  for (const item of cases) {
    test(item.name, () => item.expect(recommendTeam(item.task, FLEET)));
  }
});

describe('recommendTeam: the top tier is not the answer to everything', () => {
  // The mirror image of the GLM-for-hard-work bug: an ABSOLUTE "best
  // implementer" score put GPT-5.6-sol on a rename and a CSS tweak. Implementer
  // fitness is complexity-relative in both directions.
  test('mechanical work does not burn the top implementer tier', () => {
    const team = recommendTeam('Reformat and lint the config module', FLEET, { roles: ['implementer'] });
    expect(team.classification.complexity).toBe('mechanical');
    expect(TOP_TIER).not.toContain(team.roles[0]!.primary.model);
    expect(MASS_CHORE_TIER).toContain(team.roles[0]!.primary.model);
  });

  test('mid work lands on the workhorse tier, not the top tier', () => {
    const team = recommendTeam('Implement the reporting service endpoints', FLEET, { roles: ['implementer'] });
    expect(team.classification.complexity).toBe('mid');
    expect(TOP_TIER).not.toContain(team.roles[0]!.primary.model);
    expect(MASS_CHORE_TIER).not.toContain(team.roles[0]!.primary.model);
  });

  test('but critical risk still pulls mid work up above the workhorse floor', () => {
    const team = recommendTeam('Implement the production payment credential rotation', FLEET, {
      roles: ['implementer'],
    });
    expect(team.classification.risk).toBe('critical');
    expect(MASS_CHORE_TIER).not.toContain(team.roles[0]!.primary.model);
  });
});

describe('recommendTeam: account rules', () => {
  test('never recommends the personal daily-driver accounts or DeepSeek V4 Pro', () => {
    const team = recommendTeam('Implement the billing reconciliation service', FLEET);
    const banned = ['claude-auto-kirin', 'codex-auto-personal', 'claude-auto-dsv4p'];
    for (const binary of banned) {
      expect(everyone(team).some(option => option.binary === binary)).toBe(false);
      expect(team.exclusions.some(item => item.binary === binary)).toBe(true);
    }
  });

  test('excludes at-limit and logged-out accounts with the reason', () => {
    const team = recommendTeam('Implement the feature', ['claude-auto-loge', 'codex-auto-atomi', 'claude-auto-atomi'], {
      usage: [
        { binary: 'claude-auto-loge', atLimit: true },
        { binary: 'codex-auto-atomi', authOk: false },
      ],
    });
    expect(everyone(team).some(option => option.binary === 'claude-auto-loge')).toBe(false);
    expect(everyone(team).some(option => option.binary === 'codex-auto-atomi')).toBe(false);
    expect(team.exclusions.find(item => item.binary === 'claude-auto-loge')?.reason).toContain('usage limit');
    expect(team.exclusions.find(item => item.binary === 'codex-auto-atomi')?.reason).toContain('not logged in');
  });

  test('loge-first: same tier, the loge account wins', () => {
    const team = recommendTeam('Implement the hard distributed consensus rewrite', FLEET);
    expect(role(team, 'implementer')!.primary.binary).toBe('codex-auto-loge');
  });
});

describe('recommendTeam: options, alternatives, and the handoff chain', () => {
  test('every role offers a primary plus ranked alternatives with launch commands', () => {
    const team = recommendTeam('Implement the new billing reconciliation service', FLEET);
    expect(team.roles.length).toBeGreaterThanOrEqual(2);
    for (const item of team.roles) {
      expect(item.alternatives.length).toBeGreaterThanOrEqual(2);
      for (const option of [item.primary, ...item.alternatives]) {
        expect(option.command).toContain('kteam start --agent ');
        expect(option.tradeoff.length).toBeGreaterThan(10);
        if (option.modelFlag) expect(option.command).toContain(`--model ${option.modelFlag}`);
      }
      // Alternatives never repeat the primary's model, and anything below the
      // doctrine floor is marked and ranked last.
      expect(item.alternatives.some(option => option.model === item.primary.model)).toBe(false);
      expect(item.primary.caveat).toBeUndefined();
      const preferred = item.alternatives.filter(option => !option.caveat);
      expect([...preferred].sort((a, b) => b.score - a.score)).toEqual(preferred);
      const firstCaveat = item.alternatives.findIndex(option => option.caveat);
      if (firstCaveat >= 0) expect(item.alternatives.slice(firstCaveat).every(option => option.caveat)).toBe(true);
    }
  });

  test('terra/5.5 never plan their own work: choosing them forces a planner', () => {
    // Only codex terra-class accounts available → terra must implement, so the
    // chain requires a planner even though the fleet is thin.
    const team = recommendTeam('Implement the checklist in the ticket', ['codex-auto-loai', 'claude-auto-liftoff']);
    const implementer = role(team, 'implementer')!;
    if (['terra', 'gpt55'].includes(implementer.primary.model)) {
      expect(role(team, 'planner')).toBeDefined();
    }
  });

  test('--budget max always plans and reviews; --budget cheap trims the shape', () => {
    const task = 'Rename a helper across the config module';
    const max = recommendTeam(task, FLEET, { budget: 'max' });
    const cheap = recommendTeam(task, FLEET, { budget: 'cheap' });
    expect(role(max, 'planner')).toBeDefined();
    expect(role(max, 'reviewer')).toBeDefined();
    expect(cheap.roles.length).toBeLessThan(max.roles.length);
  });

  test('the three budgets pick three different tiers for the same mid task', () => {
    const task = 'Implement the reporting service endpoints';
    const primary = (budget: 'cheap' | 'balanced' | 'max') =>
      recommendTeam(task, FLEET, { budget, roles: ['implementer'] }).roles[0]!.primary.model;
    expect(MASS_CHORE_TIER).toContain(primary('cheap'));
    expect(primary('balanced')).toBe('opus48');
    expect(TOP_TIER).toContain(primary('max'));
  });

  test('--budget max does not buy the top tier for a chore', () => {
    // Quality-first raises the eligible tier; it is not "always spend more".
    const primary = recommendTeam('Rename the logger helper in the config module', FLEET, {
      budget: 'max',
      roles: ['implementer'],
    }).roles[0]!.primary.model;
    expect(TOP_TIER).not.toContain(primary);
  });

  test('--roles forces the shape', () => {
    const team = recommendTeam('anything at all', FLEET, { roles: ['reviewer'] });
    expect(team.roles.map(item => item.role)).toEqual(['reviewer']);
  });

  test('a thin fleet warns instead of silently breaking a floor', () => {
    const team = recommendTeam('Design the complex distributed migration', ['claude-auto-glm52a']);
    expect(team.warnings.length).toBeGreaterThan(0);
    expect(team.warnings.join(' ')).toContain('floor');
  });
});

// ---------------------------------------------------------------------------
// Slow-launch support helpers
// ---------------------------------------------------------------------------

describe('slow-provider launch window', () => {
  test('slow wrappers get a longer window, everyone else the base one', () => {
    expect(startWaitMsFor('claude-auto-glm52a')).toBe(90_000);
    expect(startWaitMsFor('claude-auto-mm3')).toBe(90_000);
    expect(startWaitMsFor('claude-auto-dsv4f')).toBe(90_000);
    expect(startWaitMsFor('codex-auto-loge')).toBe(45_000);
    expect(startWaitMsFor('claude-auto-atomi')).toBe(45_000);
  });

  test('the ceiling still bounds the window', () => {
    expect(startWaitMsFor('claude-auto-glm52a', 45_000, 60_000)).toBe(60_000);
  });
});

describe('resolveDisplayModel: show what the pane actually runs', () => {
  test('a GLM wrapper reports glm-5.2, not its `opus` alias', () => {
    expect(resolveDisplayModel('claude-auto-glm52a', 'opus')).toEqual({ model: 'glm-5.2', source: 'wrapper' });
    expect(resolveDisplayModel('claude-auto-mm3', 'opus').model).toBe('minimax-m3');
    expect(resolveDisplayModel('claude-auto-dsv4f', undefined).model).toBe('deepseek-v4-flash');
  });

  test('the harness’s own usage record always wins', () => {
    expect(resolveDisplayModel('claude-auto-glm52a', 'opus', 'glm-5.2-turbo')).toEqual({
      model: 'glm-5.2-turbo',
      source: 'harness',
    });
  });

  test('an explicit full model id is kept as asked', () => {
    expect(resolveDisplayModel('claude-auto-loge', 'claude-opus-4-8').model).toBe('claude-opus-4-8');
    expect(resolveDisplayModel('claude-auto-glm52a', 'glm-4.7').model).toBe('glm-4.7');
  });

  test('an unmapped wrapper falls back to configured, then to default', () => {
    expect(resolveDisplayModel('claude-auto-atomi', 'opus').model).toBe('opus');
    expect(resolveDisplayModel('codex-auto-loge', undefined)).toEqual({ model: 'default', source: 'unknown' });
  });
});
