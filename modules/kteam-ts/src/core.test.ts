import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_SELECTION_POLICY,
  HARD_ACCOUNT_EXCLUSIONS,
  LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT,
  PRODUCT_FACING_MODEL_GUARD,
  ROUTING_DOCTRINE,
  classifyTask,
  harnessDisplayName,
  inferHarness,
  interactiveHarnessArgs,
  recommendDecisionGuide,
  recommendTeam,
  renderRecommendationDecisionGuide,
  resolveDisplayModel,
  resolveParent,
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

// ---------------------------------------------------------------------------
// Remote Control (the crc shape) — kfleet declares it as
// `aliases.crc.claude: --dangerously-skip-permissions --chrome --rc`, and we add
// those flags to OUR launcher instead of launching the crc-* binary.
// ---------------------------------------------------------------------------
describe('remote control', () => {
  test('adds the crc flag shape and nothing else, without disturbing kteam wiring', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 1, 'fable'), remoteControl: true, teammate: 'mordecai' });
    expect(args).toContain('--rc');
    expect(args).toContain('--chrome');
    // The RC session is LABELLED for its teammate but still auto-named, so
    // relaunching the same session cannot collide on a fixed name.
    expect(args[args.indexOf('--remote-control-session-name-prefix') + 1]).toBe('kteam-mordecai');
    expect(args).not.toContain('--remote-control');
    // Everything kteam correlates on survives: session-id (turn 1), the model
    // flag, and the automode AskUserQuestion ban.
    expect(args[args.indexOf('--session-id') + 1]).toBe('00000000-0000-4000-8000-000000000000');
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(args).toContain('--disallowedTools');
    expect(args[0]).toBe('--dangerously-skip-permissions');
  });

  test('composes with resume (turn 2) — RC never replaces the resume correlation', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 2), remoteControl: true });
    expect(args[args.indexOf('--resume') + 1]).toBe('00000000-0000-4000-8000-000000000000');
    expect(args).toContain('--rc');
  });

  test('interactive + RC keeps AskUserQuestion available (only automode bans it)', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 1), mode: 'interactive', remoteControl: true });
    expect(args).toContain('--rc');
    expect(args).not.toContain('--disallowedTools');
  });

  test('codex has no RC flag: the request is ignored rather than passed on', () => {
    const args = interactiveHarnessArgs({ ...config('codex', 1), remoteControl: true });
    expect(args).not.toContain('--rc');
    expect(args).not.toContain('--chrome');
  });

  test('off by default in the arg builder (the daemon decides the default)', () => {
    expect(interactiveHarnessArgs(config('claude', 1))).not.toContain('--rc');
  });
});

// ---------------------------------------------------------------------------
// Session display name (Claude's --name). kteam names the CLAUDE-side session
// with the same "[Teammate] Task" title as its own TASK column, so the RC
// surface (claude.ai/code + resume picker) is searchable. Codex has no
// launch-time display-name flag, so it gets none.
// ---------------------------------------------------------------------------
describe('harnessDisplayName', () => {
  test('prefixes the Title-Cased teammate onto a bare task title', () => {
    expect(harnessDisplayName({ teammate: 'hayden', name: 'Fix Login' })).toBe('[Hayden] Fix Login');
  });

  test('uses an already-bracketed title verbatim (no doubled prefix)', () => {
    expect(harnessDisplayName({ teammate: 'jessica', name: '[Jessica] Kteam UI Theme Redesign' })).toBe(
      '[Jessica] Kteam UI Theme Redesign',
    );
  });

  test('falls back to the bracketed teammate alone when there is no task title', () => {
    expect(harnessDisplayName({ teammate: 'marlon', name: '' })).toBe('[Marlon]');
    expect(harnessDisplayName({ teammate: 'marlon' })).toBe('[Marlon]');
  });

  test('title-cases each hyphen segment of a compound slug', () => {
    expect(harnessDisplayName({ teammate: 'mary-jane', name: 'Ship It' })).toBe('[Mary-Jane] Ship It');
  });

  test('returns undefined when there is nothing worth naming', () => {
    expect(harnessDisplayName({})).toBeUndefined();
  });
});

describe('resolveParent: interactive sessions do not auto-inherit the caller pane', () => {
  test('auto mode inherits KTEAM_SESSION_ID as parent (teammate trees)', () => {
    expect(resolveParent({ envSessionId: 'lead-1', mode: 'auto' })).toBe('lead-1');
  });

  test('interactive mode does NOT inherit KTEAM_SESSION_ID', () => {
    expect(resolveParent({ envSessionId: 'lead-1', mode: 'interactive' })).toBeUndefined();
  });

  test('auto mode with no env session id has no parent', () => {
    expect(resolveParent({ mode: 'auto' })).toBeUndefined();
    expect(resolveParent({ envSessionId: '', mode: 'auto' })).toBeUndefined();
  });

  test('interactive mode with no env session id has no parent', () => {
    expect(resolveParent({ mode: 'interactive' })).toBeUndefined();
  });

  test('an explicit parent always wins — even for an interactive session', () => {
    expect(resolveParent({ explicit: 'chosen', envSessionId: 'lead-1', mode: 'interactive' })).toBe('chosen');
  });

  test('an explicit parent wins over the inherited env id in auto mode too', () => {
    expect(resolveParent({ explicit: 'chosen', envSessionId: 'lead-1', mode: 'auto' })).toBe('chosen');
  });

  test('an explicit parent is honored with no env id set', () => {
    expect(resolveParent({ explicit: 'chosen', mode: 'interactive' })).toBe('chosen');
    expect(resolveParent({ explicit: 'chosen', mode: 'auto' })).toBe('chosen');
  });

  test('blank/whitespace explicit and env values are ignored', () => {
    expect(resolveParent({ explicit: '   ', envSessionId: 'lead-1', mode: 'auto' })).toBe('lead-1');
    expect(resolveParent({ explicit: '   ', envSessionId: '  ', mode: 'auto' })).toBeUndefined();
  });
});

describe('claude --name wiring', () => {
  const named = { teammate: 'jessica', name: '[Jessica] Kteam UI Theme Redesign' };

  test('first launch (turn 1) passes --name as a SINGLE argv element', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 1), ...named });
    // one element, spaces + brackets intact — this is what makes tmux quote() safe
    expect(args[args.indexOf('--name') + 1]).toBe('[Jessica] Kteam UI Theme Redesign');
    // does not disturb the session-id correlation or the leading skip-permissions
    expect(args[0]).toBe('--dangerously-skip-permissions');
    expect(args[args.indexOf('--session-id') + 1]).toBe('00000000-0000-4000-8000-000000000000');
  });

  test('resume (turn 2) ALSO passes --name (accepted with --resume)', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 2), ...named });
    expect(args[args.indexOf('--name') + 1]).toBe('[Jessica] Kteam UI Theme Redesign');
    expect(args).toContain('--resume');
  });

  test('composes [Teammate] Task from a bare task title', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 1), teammate: 'hayden', name: 'Fix Login' });
    expect(args[args.indexOf('--name') + 1]).toBe('[Hayden] Fix Login');
  });

  test('--name sits before the harnessFlags escape hatch', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 1), ...named, harnessFlags: ['--verbose', '--bare'] });
    expect(args.slice(-2)).toEqual(['--verbose', '--bare']);
    expect(args.indexOf('--name')).toBeLessThan(args.indexOf('--verbose'));
  });

  test('codex gets NO --name (no launch-time display-name flag), on launch or resume', () => {
    expect(interactiveHarnessArgs({ ...config('codex', 1), ...named })).not.toContain('--name');
    expect(interactiveHarnessArgs({ ...config('codex', 2), ...named })).not.toContain('--name');
  });
});

describe('harness-flag escape hatch', () => {
  test('claude: appended verbatim, after everything kteam owns', () => {
    const args = interactiveHarnessArgs({ ...config('claude', 1), harnessFlags: ['--verbose', '--bare'] });
    expect(args.slice(-2)).toEqual(['--verbose', '--bare']);
  });

  test('codex resume: extra flags go BEFORE the positional session id', () => {
    const args = interactiveHarnessArgs({ ...config('codex', 2), harnessFlags: ['--verbose'] });
    expect(args[0]).toBe('resume');
    expect(args.at(-1)).toBe('00000000-0000-4000-8000-000000000000');
    expect(args.at(-2)).toBe('--verbose');
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

test('contextWindowForSession: [1m] on config survives a stripped served model (turn-001 ctx bug)', () => {
  const { contextWindowForSession } = require('./core');
  // THE BUG: a live [1m] session reports message.model without the suffix, so
  // keying the window on the served model gives 200k and inflates ctx% ~5x.
  // The window must still come out 1M because config.model retains [1m].
  expect(contextWindowForSession({ configModel: 'claude-opus-4-8[1m]', servedModel: 'claude-opus-4-8' })).toBe(
    1_000_000,
  );
  // Non-[1m] config with a stripped served model stays at the 200k default.
  expect(contextWindowForSession({ configModel: 'claude-opus-4-8', servedModel: 'claude-opus-4-8' })).toBe(200_000);
  // A harness self-reported window (Codex) is authoritative over everything.
  expect(contextWindowForSession({ configModel: 'gpt-5.6[1m]', servedModel: 'gpt-5.6', reportedWindow: 258_400 })).toBe(
    258_400,
  );
  // An invalid self-reported window is ignored, falling through to the rules.
  expect(
    contextWindowForSession({ configModel: 'claude-opus-4-8[1m]', servedModel: 'claude-opus-4-8', reportedWindow: 0 }),
  ).toBe(1_000_000);
  // Overrides match the SERVED model (aliases resolved) and beat the [1m] rule.
  expect(
    contextWindowForSession({ configModel: 'opus', servedModel: 'glm-5.2', overrides: { 'glm-5.2': 131_072 } }),
  ).toBe(131_072);
  // Nothing known → default.
  expect(contextWindowForSession({})).toBe(200_000);
});

// ---------------------------------------------------------------------------
// `kteam recommend` — decision guide (human doctrine + real account inputs)
// ---------------------------------------------------------------------------

describe('recommendDecisionGuide: teaches the decision without making it', () => {
  test('encodes the human routing table as ordered data with the confirmed terra correction', () => {
    expect(ROUTING_DOCTRINE.map(row => [row.work, row.models.map(model => model.model)])).toEqual([
      [
        'Mission-critical thinking/planning — where a blindspot or missed understanding causes large rework or impact',
        ['Fable 5'],
      ],
      ['Normal planning', ['Opus 5']],
      ['Implementing', ['Opus 5', 'gpt-5.6-sol', 'glm-5.2']],
      ['Review', ['gpt-5.6-terra', 'Opus 5']],
      ['Super-small mechanical', ['MiniMax M3']],
      ['Internal docs/HTML', ['MiniMax M3']],
      ['External docs/HTML', ['gpt-5.6-sol']],
      ['Small/medium mechanical', ['Sonnet 5', 'glm-5.2', 'gpt-5.6-terra']],
    ]);
    expect(ROUTING_DOCTRINE.find(row => row.work === 'Implementing')?.models.at(-1)?.caution).toBe('only if you must');
    expect(JSON.stringify(ROUTING_DOCTRINE)).not.toContain('gpt-5.5');
    expect(PRODUCT_FACING_MODEL_GUARD.rule).toContain('Never route product-facing work');
  });

  test('hands over live quota inputs and evaluates only the named loge cutoff', () => {
    const reset = Date.parse('2026-08-03T00:00:00.000Z');
    const guide = recommendDecisionGuide(
      'Implement the reporting service',
      ['claude-auto-loge1', 'claude-auto-loge2', 'claude-auto-atomi', 'claude-auto-kirin'],
      {
        usageProbed: true,
        usage: [
          {
            binary: 'claude-auto-loge1',
            account: 'loge1',
            provider: 'anthropic',
            ok: true,
            authOk: true,
            atLimit: false,
            fiveHourPercent: 12,
            weeklyPercent: 84,
            weeklyResetAt: reset,
          },
          {
            binary: 'claude-auto-loge2',
            account: 'loge2',
            provider: 'anthropic',
            ok: true,
            authOk: true,
            atLimit: false,
            fiveHourPercent: 20,
            weeklyPercent: LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT,
            weeklyResetAt: reset,
          },
          {
            binary: 'claude-auto-atomi',
            account: 'atomi',
            provider: 'anthropic',
            ok: false,
            authOk: true,
            error: 'http 429',
            // Failed probes must not leak stale values into the guide.
            fiveHourPercent: 99,
            weeklyPercent: 99,
            weeklyResetAt: reset,
          },
        ],
      },
    );
    const byBinary = new Map(guide.accounts.map(account => [account.binary, account]));

    expect(guide.kind).toBe('decision-guide');
    expect(guide.decisionOwner).toBe('calling-agent');
    expect(guide.accountSelection.logeToNonLogeRatio).toEqual({ loge: 9, nonLoge: 1 });
    expect(guide.accountSelection.ownAccountFallbacks).toEqual(['atomi', 'liftoff']);
    expect(byBinary.get('claude-auto-loge1')).toMatchObject({
      pool: 'loge',
      usable: 'usable',
      fiveHourPercent: 12,
      weeklyPercent: 84,
      weeklyRemainingPercent: 16,
      weeklyResetAt: reset,
      logePreferenceEligible: true,
    });
    expect(byBinary.get('claude-auto-loge2')).toMatchObject({
      weeklyPercent: 85,
      weeklyRemainingPercent: 15,
      logePreferenceEligible: false,
    });
    expect(byBinary.get('claude-auto-atomi')).toMatchObject({
      pool: 'own-fallback',
      usable: 'unknown',
      quotaState: 'unknown',
      fiveHourPercent: null,
      weeklyPercent: null,
      probeError: 'http 429',
    });
    expect(byBinary.get('claude-auto-kirin')).toMatchObject({ pool: 'never-route', usable: 'unusable' });
  });

  test('--no-usage stays explicit: quota is missing/unknown and never fabricated as zero', () => {
    const guide = recommendDecisionGuide('Review the change', ['claude-auto-loge1', 'claude-auto-atomi'], {
      usageProbed: false,
      usage: [],
    });
    expect(guide.quota).toMatchObject({ probed: false, source: 'skipped', anyRealNumbers: false });
    expect(guide.warnings.join(' ')).toContain('--no-usage');
    for (const account of guide.accounts) {
      expect(account.quotaState).toBe('skipped');
      expect(account.usable).toBe('unknown');
      expect(account.fiveHourPercent).toBeNull();
      expect(account.weeklyPercent).toBeNull();
      expect(account.weeklyResetAt).toBeNull();
    }
  });

  test('a rejected declared loge token never recommends the excluded login workflow', () => {
    const guide = recommendDecisionGuide('Review the change', ['claude-auto-loge1'], {
      usageProbed: true,
      usage: [
        {
          binary: 'claude-auto-loge1',
          provider: 'anthropic',
          ok: false,
          authOk: false,
          atLimit: false,
          error: 'http 401',
        },
      ],
    });
    expect(guide.accounts[0]).toMatchObject({ usable: 'unusable' });
    expect(guide.accounts[0]?.usabilityReason).toContain('`kloge pull`');
    expect(guide.accounts[0]?.usabilityReason).toContain('`hms`');
    expect(guide.accounts[0]?.usabilityReason).not.toContain('`kfleet login`');
  });

  test('hard exclusions are always called out, and output contains no pick or launch command', () => {
    const guide = recommendDecisionGuide('Plan the migration', ['claude-auto-loge1'], {
      usageProbed: false,
    });
    expect(HARD_ACCOUNT_EXCLUSIONS.map(item => item.binary)).toContain('claude-auto-kirin');
    expect(HARD_ACCOUNT_EXCLUSIONS.map(item => item.binary)).toContain('codex-auto-personal');
    expect(guide.hardExclusions).toEqual(HARD_ACCOUNT_EXCLUSIONS.map(item => ({ ...item })));
    expect(guide).not.toHaveProperty('roles');
    const text = renderRecommendationDecisionGuide(guide);
    expect(text).toContain('Decision owner: calling agent');
    expect(text).toContain('Fable 5');
    expect(text).toContain('5h unknown');
    expect(text).not.toContain('PRIMARY');
    expect(text).not.toContain('kteam start');
  });
});

// ---------------------------------------------------------------------------
// Legacy core recommendation compatibility (the CLI no longer uses this path)
// ---------------------------------------------------------------------------

/** The whole installed fleet minus the wrappers doctrine bans outright. */
const FLEET = [
  'claude-auto-kirin',
  'claude-auto-atomi',
  'claude-auto-liftoff',
  'claude-auto-loge',
  'claude-auto-loge1',
  'claude-auto-loge2',
  'claude-auto-loge3',
  'claude-auto-loge4',
  'claude-auto-loge5',
  'claude-auto-loge6',
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

  test('excludes at-limit and auth-failed accounts with an ACHIEVABLE remedy per account kind', () => {
    const team = recommendTeam(
      'Implement the feature',
      ['claude-auto-loge', 'codex-auto-atomi', 'claude-auto-mm3', 'claude-auto-atomi'],
      {
        usage: [
          { binary: 'claude-auto-loge', atLimit: true },
          { binary: 'codex-auto-atomi', authOk: false, provider: 'codex' }, // OAuth
          { binary: 'claude-auto-mm3', authOk: false, provider: 'minimax' }, // API key
        ],
      },
    );
    expect(everyone(team).some(option => option.binary === 'claude-auto-loge')).toBe(false);
    expect(everyone(team).some(option => option.binary === 'codex-auto-atomi')).toBe(false);
    expect(everyone(team).some(option => option.binary === 'claude-auto-mm3')).toBe(false);
    expect(team.exclusions.find(item => item.binary === 'claude-auto-loge')?.reason).toContain('usage limit');
    // OAuth account → kfleet login is the real fix.
    expect(team.exclusions.find(item => item.binary === 'codex-auto-atomi')?.reason).toContain('kfleet login');
    // API-key account → NEVER kfleet login (a no-op for it); rotate the key in sops.
    const mm3 = team.exclusions.find(item => item.binary === 'claude-auto-mm3')?.reason ?? '';
    expect(mm3).toContain('$MINIMAX_API_KEY');
    expect(mm3).not.toContain('kfleet login');
  });

  test('excludes a proxy-down wrapper with its cause instead of calling it generic quota', () => {
    const team = recommendTeam('Implement the feature', ['claude-auto-loge', 'claude-auto-atomi'], {
      usage: [
        {
          binary: 'claude-auto-loge',
          ok: true,
          unavailable: true,
          unavailableReason: 'spend_limit',
          atLimit: true,
          authOk: true,
        },
      ],
    });
    expect(everyone(team).some(option => option.binary === 'claude-auto-loge')).toBe(false);
    expect(team.exclusions.find(item => item.binary === 'claude-auto-loge')?.reason).toContain('monthly spend limit');
  });

  test('direct loge accounts offer Fable through Anthropic aliases without inheriting proxy semantics', () => {
    for (let n = 1; n <= 6; n += 1) {
      const binary = `claude-auto-loge${n}`;
      const team = recommendTeam('Research how the API pagination works', [binary], { roles: ['researcher'] });
      const options = everyone(team);
      expect(team.exclusions).toEqual([]);
      expect(options.every(option => option.binary === binary)).toBe(true);
      expect(options.find(option => option.model === 'fable5')?.modelFlag).toBe('fable');
      expect(options.find(option => option.model === 'opus5')?.modelFlag).toBeUndefined();
      expect(options.find(option => option.model === 'sonnet5')?.modelFlag).toBe('sonnet');
      expect(options.every(option => !option.command.includes('claude-opus-5'))).toBe(true);
    }

    const fanOut = recommendTeam('Rename one helper across 40 files, one file per agent', ['claude-auto-loge1'], {
      roles: ['fan-out'],
    });
    expect(everyone(fanOut).find(option => option.model === 'haiku')?.modelFlag).toBe('haiku');

    const proxy = recommendTeam('Research how the API pagination works', ['claude-auto-loge'], {
      roles: ['researcher'],
    });
    expect(everyone(proxy).find(option => option.model === 'opus5')?.modelFlag).toBe('claude-opus-5');
    expect(everyone(proxy).some(option => option.model === 'fable5')).toBe(true);
  });

  test('loge-first: same tier, the loge account wins', () => {
    const team = recommendTeam('Implement the hard distributed consensus rewrite', FLEET);
    expect(role(team, 'implementer')!.primary.binary).toContain('loge');
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
    expect(new Set([primary('cheap'), primary('balanced'), primary('max')]).size).toBeGreaterThanOrEqual(2);
    expect(primary('balanced')).not.toBe('opus48');
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
