import { expect, test } from 'bun:test';
import {
  classifyVerdict,
  parseWardenReports,
  parseWardenVerdictSourceRef,
  wardenVerdictSourceRef,
} from './warden-verdicts';

test('classifyVerdict prefers the structured marker', () => {
  expect(classifyVerdict('Verdict: KILL\n\nlong prose that also says resume and leave')).toBe('killed');
  expect(classifyVerdict('- **Verdict:** RESUME\nblah')).toBe('revived');
  expect(classifyVerdict('Verdict: NUDGE')).toBe('nudged');
  expect(classifyVerdict('Verdict: LEAVE')).toBe('cleared');
  expect(classifyVerdict('Verdict: NEEDS_HUMAN')).toBe('needs_human');
});

test('parseWardenReports carries the compact recommended action and migrate wrapper', () => {
  const [entry] = parseWardenReports([
    {
      path: '/r/assigned.md',
      mtimeMs: 1,
      content:
        'Verdict: NEEDS_HUMAN\n\n# Warden report — target-12345678\n\n' +
        '- **Anomaly kind:** provider_unavailable\n\n' +
        '- **Recommended action:** MIGRATE (claude-auto-loge) — The current account is exhausted.\n',
    },
  ]);
  expect(entry?.recommendation).toEqual({
    action: 'migrate',
    wrapper: 'claude-auto-loge',
    reason: 'The current account is exhausted.',
  });
});

test('only an explicit NEEDS_HUMAN marker is eligible to interrupt a human', () => {
  const [explicit, heuristic] = parseWardenReports([
    {
      path: '/r/explicit.md',
      mtimeMs: 2,
      content: '## Anomaly: target-a â :alpha / proj\n\nVerdict: NEEDS_HUMAN\n',
    },
    {
      path: '/r/heuristic.md',
      mtimeMs: 1,
      content: '## Anomaly: target-b â :beta / proj\n\nNo safe action was taken; this needs a human.\n',
    },
  ]);
  expect(explicit).toMatchObject({ verdict: 'needs_human', explicitNeedsHuman: true });
  expect(heuristic).toMatchObject({ verdict: 'needs_human' });
  expect(heuristic?.explicitNeedsHuman).toBeUndefined();
});

test('Attention source refs round-trip exact report blocks and legacy identities', () => {
  const exact = wardenVerdictSourceRef('/reports/two-blocks.md', 'sus_subprocess');
  expect(exact).toBe('warden:/reports/two-blocks.md#sus_subprocess');
  expect(parseWardenVerdictSourceRef(exact)).toEqual({
    reportPath: '/reports/two-blocks.md',
    anomalyKind: 'sus_subprocess',
  });
  expect(parseWardenVerdictSourceRef('warden:sus_thinking')).toEqual({ anomalyKind: 'sus_thinking' });
  expect(parseWardenVerdictSourceRef('warden:/reports/legacy.md')).toEqual({ reportPath: '/reports/legacy.md' });
});

test('parseWardenReports keeps per-session verdicts distinct in one fleet report', () => {
  const [cleared, human] = parseWardenReports([
    {
      path: '/r/2026-01-02T00-00-00-000Z.md',
      mtimeMs: 2000,
      content:
        '# Fleet Warden Report — sweep 2026-01-02T00:00:00.000Z\n\n' +
        '**Warden verdict:** One session is clear; one needs a human.\n\n' +
        '## Anomaly: `session-a` — alpha / proj-a\n\n' +
        '- **Anomaly kind:** sus_subprocess\n\nVerdict: LEAVE\n\n- **Outcome:** Build is still progressing.\n\n' +
        '## Anomaly: `session-b` — beta / proj-b\n\n' +
        '- **Anomaly kind:** unattended_question\n\nVerdict: NEEDS_HUMAN\n\n' +
        '- **Outcome:** Only the human can choose the rollout path.\n',
    },
  ]);
  expect(cleared).toMatchObject({
    targetSession: 'session-a',
    anomalyKind: 'sus_subprocess',
    verdict: 'cleared',
    reason: 'Build is still progressing.',
  });
  expect(human).toMatchObject({
    targetSession: 'session-b',
    anomalyKind: 'unattended_question',
    verdict: 'needs_human',
    reason: 'Only the human can choose the rollout path.',
  });
});

test('fleet anomaly headers accept prompt-style plain ids and legacy backticks', () => {
  const entries = parseWardenReports([
    {
      path: '/r/2026-01-02T00-00-00-000Z.md',
      mtimeMs: 2000,
      content:
        '## Anomaly: session-a — alpha / proj-a\n\n' +
        '- **Anomaly kind:** sus_subprocess\n\nVerdict: LEAVE\n\n' +
        '## Anomaly: `session-b`\n\n' +
        '- **Anomaly kind:** unattended_question\n\nVerdict: NEEDS_HUMAN\n',
    },
  ]);
  expect(entries).toEqual([
    expect.objectContaining({
      targetSession: 'session-a',
      teammate: 'alpha',
      label: 'proj-a',
      anomalyKind: 'sus_subprocess',
      verdict: 'cleared',
    }),
    expect.objectContaining({
      targetSession: 'session-b',
      anomalyKind: 'unattended_question',
      verdict: 'needs_human',
    }),
  ]);
});

test('same-session fleet blocks retain distinct exact kinds and reject unknown markers', () => {
  const entries = parseWardenReports([
    {
      path: '/r/2026-01-02T00-00-00-000Z.md',
      mtimeMs: 2000,
      content:
        '## Anomaly: `session-a` — alpha / proj\n\n' +
        '- **Anomaly kind:** sus_subprocess\n\nVerdict: LEAVE\n\n' +
        '## Anomaly: `session-a` — alpha / proj\n\n' +
        '- **Anomaly kind:** provider_unavailable\n\nVerdict: NEEDS_HUMAN\n\n' +
        '## Anomaly: `session-a` — alpha / proj\n\n' +
        '- **Anomaly kind:** invented_kind\n\nVerdict: NUDGE\n',
    },
  ]);
  expect(entries.map(entry => entry.anomalyKind)).toEqual(['sus_subprocess', 'provider_unavailable', undefined]);
  expect(entries.map(entry => entry.verdict)).toEqual(['cleared', 'needs_human', 'nudged']);
});

test('a global fleet verdict is never copied onto unclassified blocks', () => {
  const entries = parseWardenReports([
    {
      path: '/r/2026-01-02T00-00-00-000Z.md',
      mtimeMs: 2000,
      content:
        '**Warden verdict:** Session B needs a human.\n\n' +
        '## Anomaly: `session-a` — alpha / proj-a\n\n- **Evidence:** inconclusive\n\n' +
        '## Anomaly: `session-b` — beta / proj-b\n\nVerdict: NEEDS_HUMAN\n',
    },
  ]);
  expect(entries.map(entry => entry.verdict)).toEqual(['unknown', 'needs_human']);
});

test('classifyVerdict needs-human wins over rejected-option prose', () => {
  const prose =
    '**Warden verdict:** No safe warden action taken — the one recovery (kteam resume) has been proven to fail. This session still needs a human.';
  expect(classifyVerdict(prose)).toBe('needs_human');
});

test('classifyVerdict falls back to phrases', () => {
  expect(classifyVerdict('I ran kteam stop; the session was killed.')).toBe('killed');
  expect(classifyVerdict('The long build is progressing; leave it alone.')).toBe('cleared');
  expect(classifyVerdict('nothing conclusive here')).toBe('unknown');
});

test('parseWardenReports extracts target, teammate, reason, verdict, newest-first', () => {
  const files = [
    {
      path: '/r/2026-01-02T00-00-00-000Z-mrwqdd6b-efd590a5.md',
      mtimeMs: 2000,
      content:
        'Verdict: KILL\n\n# Fleet Warden Report — sweep 2026-01-02T00:00:00.000Z\n\n' +
        '## Anomaly: `mrwqdd6b-efd590a5` — lacey / diene-build\n\n' +
        '- **Status at sweep:** `failed`\n' +
        '- **Reported reason:** `stuck at resume menu`\n',
    },
    {
      path: '/r/2026-01-01T00-00-00-000Z.md',
      mtimeMs: 1000,
      content:
        '# Fleet Warden Report — sweep 2026-01-01T00:00:00.000Z\n\n' +
        '**Warden verdict:** No safe action taken; needs a human.\n\n' +
        '## Anomaly: `abc-123` — donovan / proj\n\n- **Reported reason:** `waiting on a question`\n',
    },
  ];
  const out = parseWardenReports(files);
  expect(out.length).toBe(2);
  // newest (mtime 2000) first
  expect(out[0]!.targetSession).toBe('mrwqdd6b-efd590a5');
  expect(out[0]!.teammate).toBe('lacey');
  expect(out[0]!.label).toBe('diene-build');
  expect(out[0]!.verdict).toBe('killed');
  expect(out[0]!.reason).toBe('stuck at resume menu');
  expect(out[0]!.at).toBe('2026-01-02T00:00:00.000Z');
  expect(out[1]!.targetSession).toBe('abc-123');
  expect(out[1]!.verdict).toBe('needs_human');
});

test('parseWardenReports caps the list', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `/r/2026-01-01T00-00-00-${String(i).padStart(3, '0')}Z.md`,
    mtimeMs: i,
    content: `Verdict: LEAVE\n\n## Anomaly: \`s${i}\` — t / l\n`,
  }));
  expect(parseWardenReports(files, 20).length).toBe(20);
});

test('parses the REAL assigned-warden report format (fixture from live daemon, turn-020)', async () => {
  const path = await import('node:path');
  const content = await Bun.file(path.join(import.meta.dir, 'fixtures', 'warden-report-assigned.txt')).text();
  const [entry] = parseWardenReports([
    { path: '/reports/2026-07-23T18-39-40-962Z-mrx35inz-80a08da9.md', content, mtimeMs: 1 },
  ]);
  expect(entry).toMatchObject({
    targetSession: 'mrx35inz-80a08da9',
    teammate: 'matthew',
    label: 'node:go-base',
    verdict: 'cleared', // Verdict: LEAVE
  });
  expect(entry?.spawn).toBeUndefined();
  // The reason must be present and human-meaningful (## Summary sentence).
  expect(entry!.reason).toContain('legitimate');
});

test('parses the REAL sweep report format alongside (fixture from live daemon)', async () => {
  const path = await import('node:path');
  const content = await Bun.file(path.join(import.meta.dir, 'fixtures', 'warden-report-sweep.txt')).text();
  const [entry] = parseWardenReports([{ path: '/reports/2026-07-23T05-12-36-344Z.md', content, mtimeMs: 1 }]);
  expect(entry).toMatchObject({
    targetSession: 'mrwqdd6b-efd590a5',
    teammate: 'lacey',
    verdict: 'needs_human',
  });
  expect(entry!.reason).toBeDefined();
});

test('assigned header without teammate parenthetical still yields the session id', () => {
  const [entry] = parseWardenReports([
    {
      path: '/reports/2026-07-23T00-00-00-000Z-mrxaaaa-11112222.md',
      content:
        'Verdict: NUDGE\n\n# Warden report — mrxaaaa-11112222\n\n' +
        '- **Anomaly kind:** sus_thinking\n\n## Summary\nWedged but recoverable.\n',
      mtimeMs: 1,
    },
  ]);
  expect(entry).toMatchObject({
    targetSession: 'mrxaaaa-11112222',
    anomalyKind: 'sus_thinking',
    verdict: 'nudged',
    reason: 'Wedged but recoverable.',
  });
});

test('summary fallback keeps only its first line, never flattens evidence bullets into a row', () => {
  const [entry] = parseWardenReports([
    {
      path: '/reports/2026-07-23T00-00-00-000Z-mrxaaaa-11112222.md',
      content:
        'Verdict: LEAVE\n\n# Warden report - mrxaaaa-11112222\n\n' +
        '- **Anomaly kind:** sus_thinking\n\n## Summary\n- The build is still progressing.\n- PID and log details belong in the report.\n',
      mtimeMs: 1,
    },
  ]);
  expect(entry?.reason).toBe('The build is still progressing.');
});

test('extracts the reason when the verdict word sits INSIDE the bold marker', async () => {
  const path = await import('node:path');
  // Real live report (constance): "**Verdict: LEAVE.** The 50m ..." with no
  // ## Summary section — the reason is the prose after the closing asterisks.
  const content = await Bun.file(path.join(import.meta.dir, 'fixtures', 'warden-report-assigned-leave.txt')).text();
  const [entry] = parseWardenReports([
    { path: '/reports/2026-07-23T18-49-41-096Z-mrxfco84-4a536642.md', content, mtimeMs: 1 },
  ]);
  expect(entry).toMatchObject({ targetSession: 'mrxfco84-4a536642', teammate: 'constance', verdict: 'cleared' });
  expect(entry!.reason).toContain('proof harness');
});
