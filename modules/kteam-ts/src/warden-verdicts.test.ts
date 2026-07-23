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
