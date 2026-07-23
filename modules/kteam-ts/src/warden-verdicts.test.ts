import { expect, test } from 'bun:test';
import { classifyVerdict, parseWardenReports } from './warden-verdicts';

test('classifyVerdict prefers the structured marker', () => {
  expect(classifyVerdict('Verdict: KILL\n\nlong prose that also says resume and leave')).toBe('killed');
  expect(classifyVerdict('- **Verdict:** RESUME\nblah')).toBe('revived');
  expect(classifyVerdict('Verdict: NUDGE')).toBe('nudged');
  expect(classifyVerdict('Verdict: LEAVE')).toBe('cleared');
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
      content: 'Verdict: NUDGE\n\n# Warden report — mrxaaaa-11112222\n\n## Summary\nWedged but recoverable.\n',
      mtimeMs: 1,
    },
  ]);
  expect(entry).toMatchObject({
    targetSession: 'mrxaaaa-11112222',
    verdict: 'nudged',
    reason: 'Wedged but recoverable.',
  });
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
