import { describe, expect, test } from 'bun:test';
import {
  MAX_AUTOCOMPLETE_RESULTS,
  detectComposerTrigger,
  nextComposerCandidateIndex,
  pendingComposerInputSelection,
  rankComposerCandidates,
  replaceComposerTrigger,
  type ComposerAutocompleteCandidate,
} from './composer-autocomplete-engine';

const caret = (at: number) => ({ start: at, end: at });

describe('composer autocomplete trigger detection', () => {
  test('a new input caret is not clamped against the previous controlled value', () => {
    // The hook still renders value="" while the native input event for "/"
    // reports caret 1. Detection clamps against the NEXT value on its render.
    expect(pendingComposerInputSelection({ start: 1, end: 1 })).toEqual({ start: 1, end: 1 });
  });

  test('/ opens only as the first non-whitespace token', () => {
    expect(detectComposerTrigger('/', caret(1))).toMatchObject({ trigger: '/', query: '', start: 0, end: 1 });
    expect(detectComposerTrigger('  /sum', caret(6))).toMatchObject({
      trigger: '/',
      query: 'sum',
      start: 2,
      end: 6,
    });
    expect(detectComposerTrigger('hello /sum', caret(10))).toBeNull();
    expect(detectComposerTrigger('https://example.test', caret(8))).toBeNull();
  });

  test('a space closes / rather than turning prose into a command query', () => {
    expect(detectComposerTrigger('/summary now', caret(12))).toBeNull();
    expect(detectComposerTrigger('/ ', caret(2))).toBeNull();
  });

  test('@ opens anywhere in the whitespace-free token at the caret', () => {
    expect(detectComposerTrigger('@', caret(1))).toMatchObject({ trigger: '@', query: '', start: 0, end: 1 });
    expect(detectComposerTrigger('read @src/app.ts', caret(16))).toMatchObject({
      trigger: '@',
      query: 'src/app.ts',
      start: 5,
      end: 16,
    });
    // "Anywhere" includes a token prefix; only the @ suffix is replaceable.
    expect(detectComposerTrigger('see:@src', caret(8))).toMatchObject({ trigger: '@', start: 4, query: 'src' });
  });

  test('@ closes as soon as whitespace ends the token', () => {
    expect(detectComposerTrigger('read @src next', caret(14))).toBeNull();
  });

  test.each([
    { value: '&', trigger: '&' as const, query: '', start: 0 },
    { value: '&F', trigger: '&' as const, query: 'F', start: 0 },
    { value: 'see &F12', trigger: '&' as const, query: 'F12', start: 4 },
    { value: '(&B2', trigger: '&' as const, query: 'B2', start: 1 },
    { value: 'line\n&', trigger: '&' as const, query: '', start: 5 },
    { value: '?A', trigger: '?' as const, query: 'A', start: 0 },
    { value: 'resolve ?A3', trigger: '?' as const, query: 'A3', start: 8 },
    { value: 'line\n?A12', trigger: '?' as const, query: 'A12', start: 5 },
  ])('$value opens the $trigger reference picker', ({ value, trigger, query, start }) => {
    expect(detectComposerTrigger(value, caret(value.length))).toMatchObject({
      trigger,
      query,
      start,
      end: value.length,
    });
  });

  test.each([
    'Is this right?',
    'Do you know?A3',
    '?',
    '?a3',
    '#',
    '# Heading',
    '## Heading',
    '#fff',
    '#FFF',
    '#123',
    'issue (#123)',
    '#F',
    'see #F12',
    '(#B2',
    'foo#L12',
    'see #L12',
  ])('%s stays ordinary prose or markdown', value => {
    expect(detectComposerTrigger(value, caret(value.length))).toBeNull();
  });

  test.each([
    { value: 'Tom & Jerry', caretAt: 'Tom & Jerry'.length },
    { value: 'Tom & Jerry', caretAt: 'Tom &'.length },
    { value: 'R&D', caretAt: 'R&D'.length },
    { value: 'AT&T', caretAt: 'AT&T'.length },
    { value: '&amp;', caretAt: '&amp;'.length },
    { value: '&amp;', caretAt: 1 },
    { value: '&nbsp;', caretAt: '&nbsp;'.length },
    { value: '&nbsp;', caretAt: 1 },
    { value: '&#39;', caretAt: '&#39;'.length },
    { value: '&#39;', caretAt: 1 },
    { value: '&#x27;', caretAt: 1 },
    { value: '&#X27;', caretAt: 1 },
    { value: 'cmd &', caretAt: 'cmd &'.length },
    { value: 'a && b', caretAt: 'a && b'.length },
    { value: '&&', caretAt: 1 },
    { value: '&&', caretAt: 2 },
  ])('$value at caret $caretAt is not a task trigger', ({ value, caretAt }) => {
    expect(detectComposerTrigger(value, caret(caretAt))).toBeNull();
  });

  test('changing the task sigil does not tighten the existing attention boundary', () => {
    expect(detectComposerTrigger('&?A3', caret(5))).toMatchObject({ trigger: '?', query: 'A3', start: 1 });
  });

  test('reference replacement stops before prose punctuation', () => {
    const task = detectComposerTrigger('see &F12, please', caret(8));
    expect(task).toMatchObject({ trigger: '&', query: 'F12', start: 4, end: 8 });
    const attention = detectComposerTrigger('resolve ?A3.', caret(11));
    expect(attention).toMatchObject({ trigger: '?', query: 'A3', start: 8, end: 11 });
  });

  test('the replace span extends beyond a caret in the middle of a token', () => {
    expect(detectComposerTrigger('read @src/old.ts please', caret(9))).toMatchObject({
      trigger: '@',
      query: 'src',
      start: 5,
      end: 16,
    });
  });

  test('a non-collapsed textarea selection never opens suggestions', () => {
    expect(detectComposerTrigger('/summary', { start: 1, end: 4 })).toBeNull();
    expect(detectComposerTrigger('@src', { start: 0, end: 4 })).toBeNull();
    expect(detectComposerTrigger('&F12', { start: 1, end: 4 })).toBeNull();
    expect(detectComposerTrigger('?A3', { start: 1, end: 3 })).toBeNull();
  });

  test('! is ordinary text until an exactly-once recorded shell action exists', () => {
    expect(detectComposerTrigger('!', caret(1))).toBeNull();
    expect(detectComposerTrigger('!git status', caret(11))).toBeNull();
  });

  describe('@ requires the sigil to BEGIN its token', () => {
    test('an email address is not a file mention', () => {
      // Not merely a cosmetic false positive: `match.start` is the sigil, so
      // accepting here would replace `@example.com` and weld `bob` to a path.
      expect(detectComposerTrigger('mail bob@example.com', caret(20))).toBeNull();
      expect(detectComposerTrigger('a.b@c', caret(5))).toBeNull();
      expect(detectComposerTrigger('user1@x', caret(7))).toBeNull();
    });

    test('a sigil glued to a word is not a mention', () => {
      expect(detectComposerTrigger('foo@bar', caret(7))).toBeNull();
      expect(detectComposerTrigger('@@x', caret(3))).toBeNull();
      expect(detectComposerTrigger('dir/x@y', caret(7))).toBeNull();
    });

    test('whitespace and opening punctuation are still boundaries', () => {
      expect(detectComposerTrigger('@src', caret(4))).toMatchObject({ query: 'src', start: 0 });
      expect(detectComposerTrigger('see @src', caret(8))).toMatchObject({ query: 'src', start: 4 });
      expect(detectComposerTrigger('see:@src', caret(8))).toMatchObject({ query: 'src', start: 4 });
      expect(detectComposerTrigger('(@src', caret(5))).toMatchObject({ query: 'src', start: 1 });
      expect(detectComposerTrigger('line\n@src', caret(9))).toMatchObject({ query: 'src', start: 5 });
      expect(detectComposerTrigger('tab\t@src', caret(8))).toMatchObject({ query: 'src', start: 4 });
    });
  });
});

describe('composer autocomplete token replacement', () => {
  test('a skill replaces the whole token and leaves one separating space', () => {
    const match = detectComposerTrigger('/summry', caret(7));
    expect(match).not.toBeNull();
    expect(replaceComposerTrigger('/summry', match!, '/summary')).toEqual({
      value: '/summary ',
      selection: { start: 9, end: 9 },
    });
  });

  test('Codex can replace the / trigger with its real $skill invocation', () => {
    const match = detectComposerTrigger('/sum', caret(4));
    expect(replaceComposerTrigger('/sum', match!, '$summary')).toEqual({
      value: '$summary ',
      selection: { start: 9, end: 9 },
    });
  });

  test('a directory keeps the @ token open without adding a space', () => {
    const match = detectComposerTrigger('look @sr', caret(8));
    expect(replaceComposerTrigger('look @sr', match!, '@src/', 'none')).toEqual({
      value: 'look @src/',
      selection: { start: 10, end: 10 },
    });
  });

  test('accepting in the middle replaces the suffix instead of duplicating it', () => {
    const value = 'read @src/old.ts please';
    const match = detectComposerTrigger(value, caret(9));
    expect(replaceComposerTrigger(value, match!, '@src/new.ts')).toEqual({
      value: 'read @src/new.ts please',
      selection: { start: 17, end: 17 },
    });
  });

  test('existing whitespace is reused, not doubled', () => {
    const match = detectComposerTrigger('@old file', caret(4));
    expect(replaceComposerTrigger('@old file', match!, '@new.ts')).toEqual({
      value: '@new.ts file',
      selection: { start: 8, end: 8 },
    });
  });

  test('canonical task and attention references replace their whole token', () => {
    const task = detectComposerTrigger('track &F1', caret(9));
    expect(replaceComposerTrigger('track &F1', task!, '#F12')).toEqual({
      value: 'track #F12 ',
      selection: { start: 11, end: 11 },
    });

    const attention = detectComposerTrigger('resolve ?A', caret(10));
    expect(replaceComposerTrigger('resolve ?A', attention!, '?A3')).toEqual({
      value: 'resolve ?A3 ',
      selection: { start: 12, end: 12 },
    });
  });
});

function candidate(
  id: string,
  label: string,
  patch: Partial<ComposerAutocompleteCandidate> = {},
): ComposerAutocompleteCandidate {
  return { id, label, kind: 'skill', replacement: `/${id}`, ...patch };
}

describe('composer autocomplete filtering and navigation', () => {
  test('name matches outrank a description-only match', () => {
    const rows = [
      candidate('description', 'other', { detail: 'Summarize this conversation' }),
      candidate('name', 'summary', { detail: 'Fast recap' }),
    ];
    expect(rankComposerCandidates(rows, 'sum').map(row => row.id)).toEqual(['name', 'description']);
  });

  test('fuzzy subsequences match and absent candidates are dropped', () => {
    const rows = [candidate('front', 'frontend-design'), candidate('summary', 'summary'), candidate('miss', 'deploy')];
    expect(rankComposerCandidates(rows, 'frtd').map(row => row.id)).toEqual(['front']);
  });

  test('empty queries preserve provider order and cap DOM work', () => {
    const rows = Array.from({ length: MAX_AUTOCOMPLETE_RESULTS + 10 }, (_, index) =>
      candidate(String(index), `skill-${index}`),
    );
    const ranked = rankComposerCandidates(rows, '');
    expect(ranked).toHaveLength(MAX_AUTOCOMPLETE_RESULTS);
    expect(ranked[0]!.id).toBe('0');
  });

  test('arrow navigation wraps and skips refused file rows', () => {
    const rows = [candidate('a', 'a'), candidate('blocked', '.env', { disabled: true }), candidate('c', 'c')];
    expect(nextComposerCandidateIndex(rows, 0, 1)).toBe(2);
    expect(nextComposerCandidateIndex(rows, 2, 1)).toBe(0);
    expect(nextComposerCandidateIndex(rows, 0, -1)).toBe(2);
  });

  test('an information-only result has no selectable index', () => {
    expect(nextComposerCandidateIndex([candidate('blocked', '.env', { disabled: true })], -1, 1)).toBe(-1);
    expect(nextComposerCandidateIndex([], -1, 1)).toBe(-1);
  });
});
