import { describe, expect, test } from 'bun:test';
import {
  applyTokenCase,
  boundedDamerauLevenshtein,
  contextVocabulary,
  enhance,
  fuzzyBudget,
  MAX_DICTIONARY_TERMS,
  parseDictionary,
  type DictionaryEntry,
} from './enhancement';
import { verifyWordOnly } from './word-only-verifier';

const FLEET: DictionaryEntry[] = [
  { term: 'kteam', aliases: ['kteem', 'katim'] },
  { term: 'tmux', aliases: ['teemux'] },
  { term: 'kfleet', aliases: [] },
  { term: 'Parakeet', aliases: ['paraquet'] },
  { term: 'Codex', aliases: [] },
];

function run(text: string, context: string[] = []): string {
  return enhance({ text, dictionary: FLEET, context }).text;
}

describe('boundedDamerauLevenshtein', () => {
  test('counts substitutions, insertions and deletions', () => {
    expect(boundedDamerauLevenshtein('kteam', 'kteam', 2)).toBe(0);
    expect(boundedDamerauLevenshtein('kteem', 'kteam', 2)).toBe(1);
    expect(boundedDamerauLevenshtein('ktea', 'kteam', 2)).toBe(1);
    expect(boundedDamerauLevenshtein('kteamm', 'kteam', 2)).toBe(1);
  });

  test('counts an adjacent transposition as ONE edit, which is the Damerau part', () => {
    expect(boundedDamerauLevenshtein('kteam', 'ktema', 2)).toBe(1);
  });

  test('returns max + 1 rather than the true distance once past the ceiling', () => {
    expect(boundedDamerauLevenshtein('kteam', 'completely-different', 2)).toBe(3);
  });

  test('the length shortcut agrees with the full computation', () => {
    expect(boundedDamerauLevenshtein('a', 'abcdef', 2)).toBe(3);
  });
});

describe('fuzzyBudget', () => {
  test('one edit for short words, two for longer ones', () => {
    expect(fuzzyBudget(4)).toBe(1);
    expect(fuzzyBudget(6)).toBe(1);
    expect(fuzzyBudget(7)).toBe(2);
  });
});

describe('applyTokenCase', () => {
  test('carries a sentence-initial capital onto an all-lowercase canonical', () => {
    expect(applyTokenCase('Kteem', 'kteam')).toBe('Kteam');
  });

  test('leaves a canonical that declares its own casing alone', () => {
    expect(applyTokenCase('paraquet', 'Parakeet')).toBe('Parakeet');
    expect(applyTokenCase('Paraquet', 'Parakeet')).toBe('Parakeet');
  });

  test('an all-caps or mid-word-caps token does not impose its shape', () => {
    expect(applyTokenCase('KTEEM', 'kteam')).toBe('kteam');
  });
});

describe('enhance — the jargon it exists for', () => {
  test('an exact alias becomes the canonical term', () => {
    expect(run('start kteem now')).toBe('start kteam now');
    expect(run('open teemux')).toBe('open tmux');
    expect(run('the paraquet model')).toBe('the Parakeet model');
  });

  test('a near-miss on a dictionary term is repaired', () => {
    expect(run('check kfleat status')).toBe('check kfleet status');
    expect(run('ask Codek about it')).toBe('ask Codex about it');
  });

  test('a token that is already the canonical term is left alone', () => {
    const result = enhance({ text: 'kteam and tmux and kfleet', dictionary: FLEET, context: [] });
    expect(result.text).toBe('kteam and tmux and kfleet');
    expect(result.substitutions).toEqual([]);
  });

  test('reports what it did, by token index and reason', () => {
    const result = enhance({ text: 'run kteem', dictionary: FLEET, context: [] });
    expect(result.substitutions).toEqual([{ index: 1, from: 'kteem', to: 'kteam', reason: 'dictionary-alias' }]);
  });

  test('a sentence-initial mishearing keeps its capital', () => {
    expect(run('Kteem is running.')).toBe('Kteam is running.');
  });
});

describe('enhance — what it refuses to do', () => {
  test('never touches punctuation, spacing or newlines', () => {
    const source = '  kteem,  and\tteemux!\n\nthen paraquet.  ';
    const result = run(source);
    expect(result).toBe('  kteam,  and\ttmux!\n\nthen Parakeet.  ');
    // The separator bytes are what the verifier checks; assert directly too.
    expect(verifyWordOnly(source, result).ok).toBe(true);
  });

  test('abstains when two terms are equally close', () => {
    const ambiguous: DictionaryEntry[] = [
      { term: 'baste', aliases: [] },
      { term: 'paste', aliases: [] },
    ];
    const result = enhance({ text: 'caste it in', dictionary: ambiguous, context: [] });
    expect(result.text).toBe('caste it in');
    expect(result.substitutions).toEqual([]);
  });

  test('never fuzzy-matches a token shorter than the floor', () => {
    const short: DictionaryEntry[] = [{ term: 'cat', aliases: [] }];
    expect(enhance({ text: 'bat hat', dictionary: short, context: [] }).text).toBe('bat hat');
  });

  test('refuses a candidate that would edit punctuation inside the token', () => {
    const punctuated: DictionaryEntry[] = [{ term: "don't", aliases: ['dont'] }];
    const result = enhance({ text: 'dont stop', dictionary: punctuated, context: [] });
    expect(result.text).toBe('dont stop');
    expect(result.substitutions).toEqual([]);
  });

  test('refuses a case-only candidate', () => {
    const cased: DictionaryEntry[] = [{ term: 'Kteam', aliases: ['kteam'] }];
    expect(enhance({ text: 'kteam is up', dictionary: cased, context: [] }).text).toBe('kteam is up');
  });

  test('returns the input untouched past the size ceiling', () => {
    const huge = 'kteem '.repeat(5_000);
    expect(enhance({ text: huge, dictionary: FLEET, context: [] }).text).toBe(huge);
  });

  test('every result it DOES produce passes the independent verifier', () => {
    const samples = [
      'run kteem then teemux',
      'Kteem, paraquet and kfleat.',
      '  kteem\n\nteemux  ',
      'nothing to fix here at all',
    ];
    for (const sample of samples) {
      expect(verifyWordOnly(sample, run(sample)).ok).toBe(true);
    }
  });
});

describe('contextVocabulary', () => {
  test('mines words said at least twice, longest-standing first', () => {
    const vocabulary = contextVocabulary([
      'the nitroso pipeline is red',
      'nitroso again, and diene once',
      'nitroso a third time',
    ]);
    expect(vocabulary).toContain('nitroso');
    expect(vocabulary).not.toContain('diene');
  });

  test('drops stopwords and short words even when they repeat', () => {
    const vocabulary = contextVocabulary(['that thing there', 'that thing there', 'and and and']);
    expect(vocabulary).not.toContain('that');
    expect(vocabulary).not.toContain('there');
    expect(vocabulary).not.toContain('and');
  });

  test('tolerates non-string entries rather than throwing', () => {
    expect(contextVocabulary([null as unknown as string, 'nitroso nitroso'])).toContain('nitroso');
  });

  test('conversation vocabulary repairs a mishearing the dictionary never knew', () => {
    const context = ['deploy nitroso now', 'nitroso is the one that broke', 'roll nitroso back'];
    expect(run('restart nitrosa please', context)).toBe('restart nitroso please');
  });

  test('the dictionary outranks conversation vocabulary', () => {
    // "kteem" is an alias; a similar-looking context word must not win.
    expect(run('run kteem', ['kteen kteen kteen'])).toBe('run kteam');
  });
});

describe('parseDictionary', () => {
  test('reads a bare term and a term with alternatives', () => {
    const { entries, problems } = parseDictionary(['tmux', 'kteam = kteem, katim']);
    expect(entries).toEqual([
      { term: 'tmux', aliases: [] },
      { term: 'kteam', aliases: ['kteem', 'katim'] },
    ]);
    expect(problems).toEqual([]);
  });

  test('ignores blank lines and comments', () => {
    expect(parseDictionary(['', '   ', '# a note', 'tmux']).entries).toEqual([{ term: 'tmux', aliases: [] }]);
  });

  test('REFUSES a multi-word alias, and says so, rather than dropping it silently', () => {
    const { entries, problems } = parseDictionary(['kteam = k team, kteem']);
    expect(entries).toEqual([{ term: 'kteam', aliases: ['kteem'] }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('two words');
  });

  test('refuses a multi-word term', () => {
    const { entries, problems } = parseDictionary(['k team = kteam']);
    expect(entries).toEqual([]);
    expect(problems[0]).toContain('space');
  });

  test('merges duplicate terms and de-duplicates aliases case-insensitively', () => {
    const { entries } = parseDictionary(['kteam = kteem', 'kteam = KTEEM, katim']);
    expect(entries).toEqual([{ term: 'kteam', aliases: ['kteem', 'katim'] }]);
  });

  test('caps the number of terms and reports the overflow', () => {
    const lines = Array.from({ length: MAX_DICTIONARY_TERMS + 3 }, (_, i) => `term${i}`);
    const { entries, problems } = parseDictionary(lines);
    expect(entries).toHaveLength(MAX_DICTIONARY_TERMS);
    expect(problems).toHaveLength(3);
  });

  test('rejects an over-long term', () => {
    const { entries, problems } = parseDictionary(['x'.repeat(100)]);
    expect(entries).toEqual([]);
    expect(problems[0]).toContain('longer than');
  });

  test('a line that is only an equals sign is a problem, not a crash', () => {
    const { entries, problems } = parseDictionary(['= kteam']);
    expect(entries).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});
