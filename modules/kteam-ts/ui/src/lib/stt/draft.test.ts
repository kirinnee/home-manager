import { describe, expect, test } from 'bun:test';
import { insertTranscript, readSelection } from './draft';

describe('insertTranscript — appending', () => {
  test('an empty draft takes the transcript verbatim, caret at the end', () => {
    expect(insertTranscript('', 0, 0, 'hello there')).toEqual({ text: 'hello there', caret: 11 });
  });

  test('appending after a word inserts exactly one space', () => {
    expect(insertTranscript('hello', 5, 5, 'there')).toEqual({ text: 'hello there', caret: 11 });
  });

  test('appending after existing whitespace does NOT add a second space', () => {
    expect(insertTranscript('hello ', 6, 6, 'there')).toEqual({ text: 'hello there', caret: 11 });
  });

  test('appending after a newline keeps the newline and adds nothing', () => {
    expect(insertTranscript('hello\n', 6, 6, 'there')).toEqual({ text: 'hello\nthere', caret: 11 });
  });

  test('appending after an opening bracket adds no space', () => {
    expect(insertTranscript('see (', 5, 5, 'this')).toEqual({ text: 'see (this', caret: 9 });
  });
});

describe('insertTranscript — inserting mid-draft', () => {
  test('spaces on both sides when it lands between two words', () => {
    expect(insertTranscript('one four', 3, 3, 'two three')).toEqual({ text: 'one two three four', caret: 13 });
  });

  test('the caret sits after the words, NOT after a trailing space it added', () => {
    const result = insertTranscript('ab', 1, 1, 'X');
    expect(result.text).toBe('a X b');
    expect(result.text.slice(0, result.caret)).toBe('a X');
  });

  test('adds no trailing space before punctuation', () => {
    expect(insertTranscript('yes.', 3, 3, 'indeed')).toEqual({ text: 'yes indeed.', caret: 10 });
  });

  test('adds no leading space when the transcript starts with punctuation', () => {
    expect(insertTranscript('yes', 3, 3, '!')).toEqual({ text: 'yes!', caret: 4 });
  });
});

describe('insertTranscript — replacing a selection', () => {
  test('a highlighted word is replaced, because that is what highlighting meant', () => {
    expect(insertTranscript('the wrong word', 4, 9, 'right')).toEqual({ text: 'the right word', caret: 9 });
  });

  test('replacing the whole draft', () => {
    expect(insertTranscript('all of it', 0, 9, 'new')).toEqual({ text: 'new', caret: 3 });
  });

  test('a reversed selection is normalised rather than rejected', () => {
    expect(insertTranscript('the wrong word', 9, 4, 'right')).toEqual({ text: 'the right word', caret: 9 });
  });
});

describe('insertTranscript — defensive', () => {
  test('an out-of-range caret clamps instead of losing the utterance', () => {
    expect(insertTranscript('short', 900, 900, 'x')).toEqual({ text: 'short x', caret: 7 });
    expect(insertTranscript('short', -5, -5, 'x')).toEqual({ text: 'x short', caret: 1 });
  });

  test('a NaN caret appends rather than corrupting the draft', () => {
    expect(insertTranscript('short', Number.NaN, Number.NaN, 'x')).toEqual({ text: 'short x', caret: 7 });
  });

  test('an empty or whitespace-only transcript changes nothing', () => {
    expect(insertTranscript('keep me', 3, 3, '')).toEqual({ text: 'keep me', caret: 3 });
    expect(insertTranscript('keep me', 3, 3, '   \n ')).toEqual({ text: 'keep me', caret: 3 });
  });

  test('leading and trailing whitespace in the transcript is trimmed', () => {
    expect(insertTranscript('', 0, 0, '  hello  ')).toEqual({ text: 'hello', caret: 5 });
  });
});

describe('readSelection', () => {
  test('reads a live selection', () => {
    expect(readSelection({ selectionStart: 2, selectionEnd: 5 }, 'abcdefgh')).toEqual([2, 5]);
  });

  test('falls back to the end of the draft when there is no element', () => {
    expect(readSelection(null, 'abcd')).toEqual([4, 4]);
    expect(readSelection(undefined, 'abcd')).toEqual([4, 4]);
  });

  test('falls back when the element reports null offsets, as a non-text input does', () => {
    expect(readSelection({ selectionStart: null, selectionEnd: null }, 'abcd')).toEqual([4, 4]);
  });
});
