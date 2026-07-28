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
    { value: '@', query: '', start: 0 },
    { value: '@ott', query: 'ott', start: 0 },
    { value: 'see @F12', query: 'F12', start: 4 },
    { value: 'resolve @?A3', query: '?A3', start: 8 },
    { value: 'line\n@#B2', query: '#B2', start: 5 },
  ])('$value opens the unified reference picker', ({ value, query, start }) => {
    expect(detectComposerTrigger(value, caret(value.length))).toMatchObject({
      trigger: '@',
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
    '&',
    '&F12',
    'see &F12',
    '?A3',
    'resolve ?A3',
    'foo#L12',
    'see #L12',
  ])('%s stays ordinary prose or markdown', value => {
    expect(detectComposerTrigger(value, caret(value.length))).toBeNull();
  });

  test.each([
    { value: 'Tom & Jerry', caretAt: 'Tom & Jerry'.length },
    { value: 'Tom & Jerry', caretAt: 'Tom &'.length },
    { value: 'R&D', caretAt: 'R&D'.length },
    { value: '&amp;', caretAt: 1 },
    { value: 'a && b', caretAt: 'a && b'.length },
    { value: 'Is this right?', caretAt: 'Is this right?'.length },
    { value: 'resolve ?A3', caretAt: 'resolve ?A3'.length },
  ])('$value at caret $caretAt does not revive a retired trigger', ({ value, caretAt }) => {
    expect(detectComposerTrigger(value, caret(caretAt))).toBeNull();
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
    expect(detectComposerTrigger('@F12', { start: 1, end: 4 })).toBeNull();
  });

  test('! is ordinary text until an exactly-once recorded shell action exists', () => {
    expect(detectComposerTrigger('!', caret(1))).toBeNull();
    expect(detectComposerTrigger('!git status', caret(11))).toBeNull();
  });

  describe('@ requires the sigil to BEGIN its token', () => {
    test('an email address is not a reference trigger', () => {
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

  test('one @ trigger can insert canonical task and attention references', () => {
    const task = detectComposerTrigger('track @F1', caret(9));
    expect(replaceComposerTrigger('track @F1', task!, '#F12')).toEqual({
      value: 'track #F12 ',
      selection: { start: 11, end: 11 },
    });

    const attention = detectComposerTrigger('resolve @A', caret(10));
    expect(replaceComposerTrigger('resolve @A', attention!, '?A3')).toEqual({
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

  test('small named references stay ahead of filesystem matches', () => {
    const rows = [
      candidate('file', 'ottis.ts', { kind: 'file', replacement: '@ottis.ts' }),
      candidate('agent', 'ottis', { kind: 'agent', rankPriority: 1, replacement: 'agent-ref' }),
    ];
    expect(rankComposerCandidates(rows, 'ottis').map(row => row.id)).toEqual(['agent', 'file']);
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
