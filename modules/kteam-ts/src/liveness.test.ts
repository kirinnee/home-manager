import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { ledgerAges, reflexAssess, renderLivenessYaml, susFindings, type LivenessLedger } from './liveness';
import { backgroundTerminalCount, foldStallLiveness, type StallLivenessState } from './tmux-controller';

const T0 = Date.parse('2026-07-22T12:00:00.000Z');
const iso = (secondsAgo: number) => new Date(T0 - secondsAgo * 1000).toISOString();
const KNOBS = { nudgeAfterSeconds: 180, killAfterSeconds: 300 };

describe('reflex rule (3/5-min nudge/kill truth table)', () => {
  const assess = (ledger: LivenessLedger, nudgedAtMs?: number) =>
    reflexAssess({ ledger, nowMs: T0, ...KNOBS, nudgedAtMs });

  test('any single life-sign fresh keeps the session alive', () => {
    // Transcript fresh, everything else ancient.
    expect(
      assess({ lastTranscriptAt: iso(10), lastPaneChangeAt: iso(9999), lastSubprocessAt: iso(9999) }).verdict,
    ).toBe('alive');
    // ONLY the pane changed — pane change counts at this layer.
    expect(assess({ lastTranscriptAt: iso(9999), lastPaneChangeAt: iso(5), lastSubprocessAt: iso(9999) }).verdict).toBe(
      'alive',
    );
    // Only a subprocess is active.
    expect(assess({ lastTranscriptAt: iso(9999), lastPaneChangeAt: iso(9999), lastSubprocessAt: iso(3) }).verdict).toBe(
      'alive',
    );
  });

  test('thinking/token counter advances count toward the quietest age (any signal keeps it alive)', () => {
    const result = assess({
      lastTranscriptAt: iso(2400),
      lastPaneChangeAt: iso(2400),
      lastSubprocessAt: iso(2400),
      lastCounterAdvanceAt: iso(1),
    });
    expect(result.verdict).toBe('alive');
  });

  test('a RUNNING subprocess contributes 0 to the quietest age even if its timestamp is a tick old', () => {
    // lastSubprocessAt 45 s ago = within 2×30 s ticks = running now.
    const result = assess({ lastTranscriptAt: iso(2400), lastPaneChangeAt: iso(2400), lastSubprocessAt: iso(45) });
    expect(result.verdict).toBe('alive');
    expect(result.zeroSeconds).toBe(0);
  });

  test('zero life-signs for nudgeAfterSeconds earns exactly one nudge per episode', () => {
    const frozen = { lastTranscriptAt: iso(200), lastPaneChangeAt: iso(200), lastSubprocessAt: iso(200) };
    expect(assess(frozen).verdict).toBe('nudge');
    // Already nudged this episode and below the kill threshold: stay quiet.
    expect(assess(frozen, T0 - 10_000).verdict).toBe('alive');
  });

  test('kill fires only AFTER a nudge episode (normative: nudge precedes kill)', () => {
    const dead = { lastTranscriptAt: iso(301), lastPaneChangeAt: iso(301), lastSubprocessAt: iso(301) };
    // No nudge sent yet: nudge first, never a cold kill.
    expect(assess(dead).verdict).toBe('nudge');
    // Nudged earlier in the episode and still dead past killAfterSeconds: kill.
    expect(assess(dead, T0 - 120_000).verdict).toBe('kill');
  });

  test('boundaries: thresholds fire at exactly >= (with the nudge episode ordering)', () => {
    const at = (s: number) => ({ lastTranscriptAt: iso(s), lastPaneChangeAt: iso(s), lastSubprocessAt: iso(s) });
    expect(assess(at(179)).verdict).toBe('alive');
    expect(assess(at(180)).verdict).toBe('nudge');
    expect(assess(at(299), T0 - 60_000).verdict).toBe('alive'); // nudged, below kill
    expect(assess(at(300), T0 - 60_000).verdict).toBe('kill');
  });

  test("the nudge's own pane repaint neither re-arms the nudge nor postpones the kill", () => {
    // Strong signals dead for 6 min; the pane changed 20 s ago (the injected
    // nudge message repainting the input box). With a nudge already sent the
    // verdict must be kill — pane flicker is not revival.
    const result = reflexAssess({
      ledger: {
        lastTranscriptAt: iso(360),
        lastCounterAdvanceAt: iso(360),
        lastSubprocessAt: iso(360),
        lastPaneChangeAt: iso(20),
      },
      nowMs: T0,
      ...KNOBS,
      nudgedAtMs: T0 - 120_000,
    });
    expect(result.verdict).toBe('kill');
    expect(result.strongSeconds).toBe(360);
  });

  test('a fresh turn anchor floors all signals — new turns are never instantly frozen', () => {
    const result = reflexAssess({ ledger: {}, nowMs: T0, anchorMs: T0 - 30_000, ...KNOBS });
    expect(result.verdict).toBe('alive');
    // Never-seen with no anchor is infinitely frozen: nudge, then kill.
    expect(reflexAssess({ ledger: {}, nowMs: T0, ...KNOBS }).verdict).toBe('nudge');
    expect(reflexAssess({ ledger: {}, nowMs: T0, ...KNOBS, nudgedAtMs: T0 - 120_000 }).verdict).toBe('kill');
  });
});

describe('ledger ages', () => {
  test('reports whole per-signal ages with anchor flooring', () => {
    const ages = ledgerAges({ lastTranscriptAt: iso(100), lastPaneChangeAt: iso(7) }, T0, T0 - 50_000);
    expect(Math.floor(ages.transcript)).toBe(50); // anchored
    expect(Math.floor(ages.paneChange)).toBe(7);
    expect(Math.floor(ages.subprocess)).toBe(50); // never seen -> anchor
  });
});

describe('sus classifiers (alive but weird)', () => {
  const OPTS = { susThinkingSeconds: 900, susSubprocessSeconds: 900 };

  test('sus_thinking: counters actively advancing, transcript silent > 15 min', () => {
    const findings = susFindings(
      { lastCounterAdvanceAt: iso(30), lastTranscriptAt: iso(1000), lastPaneChangeAt: iso(30) },
      T0,
      OPTS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('sus_thinking');
    expect(findings[0]!.forSeconds).toBe(1000);
  });

  test('sus_thinking requires the counters to be CURRENTLY active', () => {
    // Counters last advanced 20 min ago — that is a frozen agent (reflex
    // territory), not a long think.
    expect(susFindings({ lastCounterAdvanceAt: iso(1200), lastTranscriptAt: iso(2000) }, T0, OPTS)).toHaveLength(0);
  });

  test('sus_subprocess: a continuous episode longer than the threshold', () => {
    const findings = susFindings(
      { lastSubprocessAt: iso(5), subprocessSince: iso(1000), lastTranscriptAt: iso(5) },
      T0,
      OPTS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('sus_subprocess');
    expect(findings[0]!.forSeconds).toBe(1000);
  });

  test('a short or finished subprocess episode is not sus', () => {
    // Short episode.
    expect(susFindings({ lastSubprocessAt: iso(5), subprocessSince: iso(300) }, T0, OPTS)).toHaveLength(0);
    // Episode over (subprocess signal stale).
    expect(susFindings({ lastSubprocessAt: iso(1200), subprocessSince: iso(2400) }, T0, OPTS)).toHaveLength(0);
  });

  test('a healthy chatty session is never sus', () => {
    expect(
      susFindings(
        { lastTranscriptAt: iso(5), lastCounterAdvanceAt: iso(5), lastSubprocessAt: iso(5), subprocessSince: iso(60) },
        T0,
        OPTS,
      ),
    ).toHaveLength(0);
  });

  test('both classifiers can fire together', () => {
    const findings = susFindings(
      {
        lastCounterAdvanceAt: iso(10),
        lastTranscriptAt: iso(2000),
        lastSubprocessAt: iso(10),
        subprocessSince: iso(2000),
      },
      T0,
      OPTS,
    );
    expect(findings.map(f => f.kind).sort()).toEqual(['sus_subprocess', 'sus_thinking']);
  });
});

describe('token exemption (turn-008)', () => {
  const OPTS = { susThinkingSeconds: 900, susSubprocessSeconds: 900 };

  test('climbing tokens exempt an arbitrarily long silent think from sus', () => {
    const ledger: LivenessLedger = {
      lastTranscriptAt: iso(4 * 3600), // silent 4 hours
      lastCounterAdvanceAt: iso(10),
      lastTokenAdvanceAt: iso(10), // tokens still climbing
    };
    expect(susFindings(ledger, T0, OPTS)).toHaveLength(0);
  });

  test('duration climbing with tokens FLAT is sus-eligible (claude with frozen tokens, or codex)', () => {
    // Claude: token counter present but stopped climbing 20 min ago.
    expect(
      susFindings(
        { lastTranscriptAt: iso(1000), lastCounterAdvanceAt: iso(10), lastTokenAdvanceAt: iso(1200) },
        T0,
        OPTS,
      ).map(f => f.kind),
    ).toEqual(['sus_thinking']);
    // Codex: no token field at all.
    expect(
      susFindings({ lastTranscriptAt: iso(1000), lastCounterAdvanceAt: iso(10) }, T0, OPTS).map(f => f.kind),
    ).toEqual(['sus_thinking']);
  });

  test('foldStallLiveness moves lastTokenAdvanceAt only when the token count climbs', () => {
    let fold: StallLivenessState = { lastWorkAdvanceAt: 0 };
    fold = foldStallLiveness(fold, '✻ Thinking… (1m 0s · ↓ 2.0k tokens)', T0 - 20_000);
    // Duration climbed, tokens flat: work advance moves, token advance doesn't.
    fold = foldStallLiveness(fold, '✻ Thinking… (1m 10s · ↓ 2.0k tokens)', T0 - 10_000);
    expect(fold.lastWorkAdvanceAt).toBe(T0 - 10_000);
    expect(fold.lastTokenAdvanceAt).toBeUndefined();
    // Tokens climbed: both move.
    fold = foldStallLiveness(fold, '✻ Thinking… (1m 20s · ↓ 2.4k tokens)', T0);
    expect(fold.lastTokenAdvanceAt).toBe(T0);
  });

  test('codex working frame parses duration only (no token field)', () => {
    let fold: StallLivenessState = { lastWorkAdvanceAt: 0 };
    fold = foldStallLiveness(fold, '• Working (18s • esc to interrupt)', T0 - 5000);
    fold = foldStallLiveness(fold, '• Working (23s • esc to interrupt)', T0);
    expect(fold.lastWorkAdvanceAt).toBe(T0);
    expect(fold.lastTokenAdvanceAt).toBeUndefined();
  });

  test('codex background terminal footer parses into a count', () => {
    expect(backgroundTerminalCount('› \n1 background terminal running\nContext 12% used')).toBe(1);
    expect(backgroundTerminalCount('2 background terminals running')).toBe(2);
    expect(backgroundTerminalCount('no terminals here')).toBe(0);
  });
});

describe('liveness.yaml rendering (turn-009)', () => {
  test('renders seconds, nulls for never-seen, and yes/no triggers', () => {
    const yaml = renderLivenessYaml({
      updatedAt: '2026-07-22T12:00:00.000Z',
      secondsSince: {
        transcript: 42.9,
        tokenAdvance: Number.POSITIVE_INFINITY,
        counterAdvance: 7,
        subprocess: 130,
        paneChange: 3,
      },
      triggers: { nudge: false, kill: false, sus: true },
    });
    expect(yaml).toBe(
      [
        'updatedAt: 2026-07-22T12:00:00.000Z',
        'secondsSince:',
        '  conversation: 42',
        '  tokens: null',
        '  thinking: 7',
        '  subprocess: 130',
        '  pane: 3',
        'triggers:',
        '  nudge: no',
        '  kill: no',
        '  sus: yes',
        '',
      ].join('\n'),
    );
  });
});

describe('fixture pair → ledger (the 2026-07-22 wrongful stall-kill)', () => {
  const frame = (name: string) => Bun.file(path.join(import.meta.dir, 'fixtures', name)).text();

  test('a thinking frame pair advances lastCounterAdvanceAt and the pane change keeps the reflex alive', async () => {
    // Real frames from a healthy Fable session the old transcript-only stall
    // timer killed mid-thinking: clock 5m45s → 5m50s, transcript silent.
    let fold: StallLivenessState = { lastWorkAdvanceAt: 0 };
    fold = foldStallLiveness(fold, await frame('claude-thinking-frame-a.txt'), T0 - 5_000);
    fold = foldStallLiveness(fold, await frame('claude-thinking-frame-b.txt'), T0);
    expect(fold.lastWorkAdvanceAt).toBe(T0);

    // The frames differ, so the pane-change life-sign is fresh: reflex alive.
    const reflex = reflexAssess({
      ledger: { lastTranscriptAt: iso(2 * 3600), lastPaneChangeAt: iso(5), lastCounterAdvanceAt: iso(0) },
      nowMs: T0,
      ...KNOBS,
    });
    expect(reflex.verdict).toBe('alive');

    // And after 15 min of that pattern the sweep lists it as sus_thinking for
    // an assigned warden to judge — not a reflex kill.
    expect(
      susFindings({ lastTranscriptAt: iso(2 * 3600), lastPaneChangeAt: iso(5), lastCounterAdvanceAt: iso(0) }, T0, {
        susThinkingSeconds: 900,
        susSubprocessSeconds: 900,
      }).map(f => f.kind),
    ).toEqual(['sus_thinking']);
  });

  test('an identical repeated frame earns no counter advance', async () => {
    const b = await frame('claude-thinking-frame-b.txt');
    let fold: StallLivenessState = { lastWorkAdvanceAt: 0 };
    fold = foldStallLiveness(fold, b, T0 - 60_000);
    fold = foldStallLiveness(fold, b, T0);
    expect(fold.lastWorkAdvanceAt).toBe(0);
  });
});
