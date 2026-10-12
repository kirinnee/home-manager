import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_SELECTION_POLICY,
  HARD_ACCOUNT_EXCLUSIONS,
  LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT,
  MODEL_ALLOWLIST_GUARD,
  ROUTING_DOCTRINE,
  ROUTING_MODELS,
  harnessDisplayName,
  inferHarness,
  interactiveHarnessArgs,
  psStatusLabel,
  recommendDecisionGuide,
  renderRecommendationDecisionGuide,
  resolveDisplayModel,
  resolveParent,
  routingExclusionReason,
  startWaitMsFor,
  usableAgent,
  usageScore,
} from './core';
import type { SessionConfig, SessionState } from './types';

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

  test('a claude conversation that was never persisted is CREATED, not resumed', () => {
    // `--resume <id>` of a conversation Claude never wrote dies with "No
    // conversation found"; the daemon marks a freshly minted id instead.
    const args = interactiveHarnessArgs({
      ...config('claude', 4),
      harnessSessionId: 'fresh-id',
      harnessSessionFresh: true,
    });
    expect(args).not.toContain('--resume');
    expect(args[args.indexOf('--session-id') + 1]).toBe('fresh-id');
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
  expect(contextWindowForModel('claude-fable-5-1[1m]')).toBe(1_000_000);
  expect(contextWindowForModel('claude-opus-4-8')).toBe(200_000);
  expect(contextWindowForModel(undefined)).toBe(200_000);
  // Overrides match by substring, longest pattern wins.
  expect(contextWindowForModel('glm-5.3', { 'glm-5.3': 131_072 })).toBe(131_072);
  expect(contextWindowForModel('glm-5.3-flashx', { glm: 100_000, 'glm-5.3-flashx': 65_536 })).toBe(65_536);
  expect(contextWindowForModel('claude-fable-5-1[1m]', { fable: 900_000 })).toBe(900_000);
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
    contextWindowForSession({ configModel: 'opus', servedModel: 'glm-5.3', overrides: { 'glm-5.3': 131_072 } }),
  ).toBe(131_072);
  // Nothing known → default.
  expect(contextWindowForSession({})).toBe(200_000);
});

// ---------------------------------------------------------------------------
// `kteam recommend` — decision guide (human doctrine + real account inputs)
// ---------------------------------------------------------------------------

describe('recommendDecisionGuide: teaches the decision without making it', () => {
  test('encodes the owner routing table: Opus 5.5 / Sonnet 5.5 / Haiku 5.5 only', () => {
    expect(ROUTING_DOCTRINE.map(row => [row.work, row.models.map(model => model.model)])).toEqual([
      ['Planning — normal and mission-critical (where a blindspot causes large rework or impact)', ['Opus 5.5']],
      ['Hardest / most critical implementation', ['Opus 5.5']],
      ['Review', ['Opus 5.5']],
      ['Generic implementation and mid-complexity work (incl. research, docs/HTML)', ['Sonnet 5.5', 'Opus 5.5']],
      ['Trivial / mechanical', ['Haiku 5.5', 'Sonnet 5.5']],
    ]);
    expect(ROUTING_MODELS.map(item => item.model)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(MODEL_ALLOWLIST_GUARD.models).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  });

  test('recommend never yields a model or wrapper outside Opus/Sonnet/Haiku 5.5', () => {
    const allowed = new Set<string>(ROUTING_MODELS.map(item => item.model));
    for (const row of ROUTING_DOCTRINE) for (const model of row.models) expect(allowed.has(model.model)).toBe(true);
    const banned = /fable|astra|gpt|\bsol\b|luna|terra|glm|minimax|\bm3\b|deepseek|dsv4/i;
    const fleet = [
      'claude-auto-loge',
      'claude-auto-loge1',
      'claude-auto-liftoff',
      'claude-auto-atomi',
      'claude-auto-kirin',
      'claude-auto-glm52a',
      'claude-auto-glm52b',
      'claude-auto-mm3',
      'claude-auto-dsv4f',
      'claude-auto-dsv4p',
      'codex-auto-loai',
      'codex-auto-atomi',
      'codex-auto-personal',
    ];
    const guide = recommendDecisionGuide('Implement the reporting service', fleet, {
      usage: fleet.map(binary => ({
        binary,
        ok: true,
        authOk: true,
        atLimit: false,
        availability: 'available' as const,
      })),
    });
    // Only Claude 5.5 accounts are offered; everything else is an exclusion.
    expect(guide.accounts.map(account => account.binary)).toEqual([
      'claude-auto-atomi',
      'claude-auto-liftoff',
      'claude-auto-loge',
      'claude-auto-loge1',
    ]);
    expect(guide.accounts.every(account => routingExclusionReason(account.binary) === undefined)).toBe(true);
    expect(guide.hardExclusions.map(item => item.binary).sort()).toEqual(
      [
        'claude-auto-dsv4f',
        'claude-auto-dsv4p',
        'claude-auto-glm52a',
        'claude-auto-glm52b',
        'claude-auto-kirin',
        'claude-auto-mm3',
        'codex-auto-atomi',
        'codex-auto-loai',
        'codex-auto-personal',
      ].sort(),
    );
    expect(JSON.stringify(guide.doctrine.rows)).not.toMatch(banned);
    // The only model ids the guide tells the caller to pass are the Claude 5.5 ones.
    expect(guide.accountSelection.rules.join(' ')).toContain('claude-sonnet-5-5[1m]');
    expect(guide.accountSelection.rules.join(' ')).not.toMatch(/fable|gpt-|glm-|minimax-|deepseek-/i);
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
    // The daily driver is not offered at all — only listed as an exclusion.
    expect(byBinary.has('claude-auto-kirin')).toBe(false);
    expect(guide.hardExclusions.map(item => item.binary)).toContain('claude-auto-kirin');
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
    expect(guide.schemaVersion).toBe(2);
    expect(guide).not.toHaveProperty('roles');
    const text = renderRecommendationDecisionGuide(guide);
    expect(text).toContain('Decision owner: calling agent');
    expect(text).toContain('Opus 5.5');
    expect(text).toContain('Model guard: Route ONLY to Opus 5.5, Sonnet 5.5 or Haiku 5.5');
    expect(text).toContain('5h unknown');
    expect(text).not.toContain('PRIMARY');
    expect(text).not.toContain('kteam start');
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
  test('a GLM wrapper reports glm-5.3, not its `opus` alias', () => {
    expect(resolveDisplayModel('claude-auto-glm52a', 'opus')).toEqual({ model: 'glm-5.3', source: 'wrapper' });
    expect(resolveDisplayModel('claude-auto-mm3', 'opus').model).toBe('minimax-m3');
    expect(resolveDisplayModel('claude-auto-dsv4f', undefined).model).toBe('deepseek-flash');
  });

  test('the harness’s own usage record always wins', () => {
    expect(resolveDisplayModel('claude-auto-glm52a', 'opus', 'glm-5.3-flashx')).toEqual({
      model: 'glm-5.3-flashx',
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

describe('psStatusLabel', () => {
  const state = (patch: Partial<SessionState>) => ({ status: 'running', ...patch }) as SessionState;

  test('a session detached by a daemon restart reads as resumable, not lost', () => {
    expect(psStatusLabel(state({ status: 'failed', resumable: true }))).toBe('failed (resumable)');
    expect(psStatusLabel(state({ status: 'failed' }))).toBe('failed');
    // A stale flag on a session that has since moved on is ignored.
    expect(psStatusLabel(state({ status: 'running', resumable: true }))).toBe('running');
  });

  test('declared parks keep their marker and peer target', () => {
    expect(psStatusLabel(state({ status: 'waiting', waiting: { since: 'x' } }))).toBe('waiting PARKED');
    expect(psStatusLabel(state({ status: 'waiting', waiting: { since: 'x', peer: 'p1', peerName: 'mordecai' } }))).toBe(
      'waiting PARKED←mordecai',
    );
  });
});

describe('overage-billed Anthropic accounts (no 5h/weekly windows)', () => {
  const reset = Date.parse('2026-11-01T00:00:00.000Z');
  const overage = (binary: string, over: Record<string, unknown> = {}) => ({
    binary,
    account: binary.replace(/^claude-auto-/, ''),
    provider: 'anthropic',
    ok: true,
    authOk: true,
    usageBased: true,
    atLimit: false,
    overagePercent: 10,
    overageResetAt: reset,
    overageInUse: true,
    ...over,
  });

  test('an in-use overage reading is positive headroom and drives the loge cutoff', () => {
    const guide = recommendDecisionGuide('Fix a bug', ['claude-auto-loge1', 'claude-auto-loge2', 'claude-auto-loge4'], {
      usage: [
        overage('claude-auto-loge1'),
        overage('claude-auto-loge2', { overagePercent: LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT }),
        {
          binary: 'claude-auto-loge4',
          account: 'loge4',
          provider: 'anthropic',
          ok: false,
          authOk: true,
          usageBased: true,
          unavailable: true,
          atLimit: true,
          error: 'disabled by admin (member_zero_credit_limit)',
        },
      ],
    });
    const byBinary = new Map(guide.accounts.map(account => [account.binary, account]));
    expect(byBinary.get('claude-auto-loge1')).toMatchObject({
      usable: 'usable',
      quotaState: 'live',
      fiveHourPercent: null,
      weeklyPercent: null,
      overagePercent: 10,
      overageResetAt: reset,
      logePreferenceEligible: true,
    });
    expect(byBinary.get('claude-auto-loge2')).toMatchObject({ usable: 'usable', logePreferenceEligible: false });
    expect(byBinary.get('claude-auto-loge4')).toMatchObject({
      usable: 'unusable',
      usabilityReason: 'disabled by admin (member_zero_credit_limit)',
    });
    expect(guide.quota.anyRealNumbers).toBe(true);
    const rendered = renderRecommendationDecisionGuide(guide);
    expect(rendered).toContain('overage 10% used (reset 2026-11-01T00:00:00.000Z)');
  });

  test('a rejected overage is at-limit, and overage not in use is ignored', () => {
    const guide = recommendDecisionGuide('Fix a bug', ['claude-auto-loge1', 'claude-auto-loge2'], {
      usage: [
        overage('claude-auto-loge1', { atLimit: true, overagePercent: 100 }),
        overage('claude-auto-loge2', { overageInUse: false }),
      ],
    });
    const byBinary = new Map(guide.accounts.map(account => [account.binary, account]));
    expect(byBinary.get('claude-auto-loge1')).toMatchObject({ usable: 'unusable' });
    expect(byBinary.get('claude-auto-loge2')).toMatchObject({ usable: 'unknown', overagePercent: null });
    expect(usageScore(overage('claude-auto-loge1', { overagePercent: 40 }))).toBe(40);
    expect(usageScore(overage('claude-auto-loge1', { overagePercent: 40, overageInUse: false }))).toBe(0);
  });
});
