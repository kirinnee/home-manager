import { describe, expect, test } from 'bun:test';
import { innerPunctuation, isWholeWord, MAX_VERIFY_CHARS, segmentWords, verifyWordOnly } from './word-only-verifier';

/** Shorthand: the rejection reason, or `'ok'`. Keeps the tables below readable
 *  as a specification rather than as assertions. */
function verdict(before: string, after: string): string {
  const outcome = verifyWordOnly(before, after);
  return outcome.ok ? 'ok' : (outcome.reason as string);
}

describe('segmentWords', () => {
  test('alternates separators and words with one more separator than words', () => {
    const { words, separators } = segmentWords('  hello, world!  ');
    expect(words).toEqual(['hello', 'world']);
    expect(separators).toEqual(['  ', ', ', '!  ']);
    expect(separators.length).toBe(words.length + 1);
  });

  test('keeps inner punctuation inside a word so identifiers stay one token', () => {
    expect(segmentWords("don't sherpa-onnx tool_use").words).toEqual(["don't", 'sherpa-onnx', 'tool_use']);
  });

  test('an empty string is one empty separator and no words', () => {
    expect(segmentWords('')).toEqual({ words: [], separators: [''] });
  });

  test('reassembles losslessly', () => {
    const source = '\n  Hey — “kteam”, don’t you think?\t42 🎉\n';
    const { words, separators } = segmentWords(source);
    let rebuilt = separators[0] as string;
    for (let i = 0; i < words.length; i += 1) rebuilt += (words[i] as string) + (separators[i + 1] as string);
    expect(rebuilt).toBe(source);
  });
});

describe('isWholeWord / innerPunctuation', () => {
  test('recognises a complete token and rejects one with a space or a stray comma', () => {
    expect(isWholeWord('kteam')).toBe(true);
    expect(isWholeWord('sherpa-onnx')).toBe(true);
    expect(isWholeWord('k team')).toBe(false);
    expect(isWholeWord('kteam,')).toBe(false);
    expect(isWholeWord('')).toBe(false);
  });

  test('extracts the ordered punctuation skeleton of a token', () => {
    expect(innerPunctuation('kteam')).toBe('');
    expect(innerPunctuation("don't")).toBe("'");
    expect(innerPunctuation('don’t')).toBe('’');
    expect(innerPunctuation('sherpa-onnx')).toBe('-');
    expect(innerPunctuation('a-b_c')).toBe('-_');
  });
});

describe('verifyWordOnly — accepts only whole-word substitutions', () => {
  test('identity is legal and reports no changes', () => {
    const outcome = verifyWordOnly('run kteam now', 'run kteam now');
    expect(outcome.ok).toBe(true);
    expect(outcome.changes).toEqual([]);
  });

  test('a single word swap is allowed and reported by token index', () => {
    const outcome = verifyWordOnly('run kteem now', 'run kteam now');
    expect(outcome.ok).toBe(true);
    expect(outcome.changes).toEqual([{ index: 1, from: 'kteem', to: 'kteam' }]);
  });

  test('several independent swaps in one pass', () => {
    const outcome = verifyWordOnly('open team ux and kay fleet', 'open tmux and kay fleet');
    // token count changed (team ux -> tmux), so this is refused, not merged.
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('token-count-changed');
  });

  test('the empty string, and whitespace-only input, verify against themselves', () => {
    expect(verdict('', '')).toBe('ok');
    expect(verdict('   \n\t', '   \n\t')).toBe('ok');
  });
});

describe('verifyWordOnly — the rejection matrix', () => {
  const cases: Array<[label: string, before: string, after: string, reason: string]> = [
    ['a full LLM-style paraphrase', 'run kteam now', 'Please run the kteam command now.', 'token-count-changed'],
    ['a word inserted', 'run kteam', 'run kteam now', 'token-count-changed'],
    ['a word removed', 'run kteam now', 'run kteam', 'token-count-changed'],
    ['two words joined into one', 'k team is up', 'kteam is up', 'token-count-changed'],
    ['one word split into two', 'kteam is up', 'k team is up', 'token-count-changed'],
    ['a comma added', 'run kteam now', 'run kteam, now', 'separator-changed'],
    ['a period added', 'run kteam now', 'run kteam now.', 'separator-changed'],
    ['a period changed to a question mark', 'is it up.', 'is it up?', 'separator-changed'],
    ['double space collapsed', 'run  kteam', 'run kteam', 'separator-changed'],
    ['a trailing newline added', 'run kteam', 'run kteam\n', 'separator-changed'],
    ['a leading space trimmed', ' run kteam', 'run kteam', 'separator-changed'],
    ['a straight quote turned into a smart quote BETWEEN words', 'he said "hi"', 'he said “hi”', 'separator-changed'],
    // An emoji is not word material, so it lands in the separator stream and
    // is caught there — a different reason than "a word appeared", and the
    // right one.
    ['an emoji inserted', 'run kteam', 'run kteam 🎉', 'separator-changed'],
    ['an apostrophe added inside a word', 'dont stop', "don't stop", 'punctuation-changed'],
    ['an ASCII apostrophe swapped for a smart one', "don't stop", 'don’t stop', 'punctuation-changed'],
    ['a hyphen removed from inside a word', 'use sherpa-onnx here', 'use sherpaonnx here', 'punctuation-changed'],
    // An EN DASH is not word material either (only the ASCII hyphen is), so
    // swapping one in splits `sherpa-onnx` into two tokens. Caught by the
    // count rule before the punctuation rule ever sees it — refused either way.
    ['a hyphen turned into an en dash', 'use sherpa-onnx here', 'use sherpa–onnx here', 'token-count-changed'],
    ['a capitalisation-only change', 'run kteam now', 'run Kteam now', 'case-only-change'],
    ['a sentence-initial capital added', 'run kteam', 'Run kteam', 'case-only-change'],
  ];

  for (const [label, before, after, reason] of cases) {
    test(`refuses ${label}`, () => {
      expect(verdict(before, after)).toBe(reason);
      expect(verifyWordOnly(before, after).changes).toEqual([]);
    });
  }

  test('a punctuation edit inside a token that ALSO changes letters is still refused', () => {
    expect(verdict('kteem-ts', "kteam'ts")).toBe('punctuation-changed');
  });

  test('but changing letters around untouched punctuation is allowed', () => {
    const outcome = verifyWordOnly('kteeem-ts is up', 'kteam-ts is up');
    expect(outcome.ok).toBe(true);
    expect(outcome.changes).toEqual([{ index: 0, from: 'kteeem-ts', to: 'kteam-ts' }]);
  });

  test('one bad change voids the whole result, not just itself', () => {
    // First swap is legal, second adds a comma. Nothing is salvaged.
    const outcome = verifyWordOnly('kteem and tmax', 'kteam and, tmux');
    expect(outcome.ok).toBe(false);
    expect(outcome.changes).toEqual([]);
  });
});

describe('verifyWordOnly — bounds', () => {
  test('refuses input beyond the ceiling rather than scanning it', () => {
    const huge = 'word '.repeat(MAX_VERIFY_CHARS);
    expect(verdict(huge, huge)).toBe('input-too-large');
  });

  test('handles a large-but-legal transcript in bounded time', () => {
    const before = `${'the quick brown fox '.repeat(250)}kteem`;
    const after = `${'the quick brown fox '.repeat(250)}kteam`;
    const started = performance.now();
    const outcome = verifyWordOnly(before, after);
    expect(outcome.ok).toBe(true);
    expect(outcome.changes.length).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
