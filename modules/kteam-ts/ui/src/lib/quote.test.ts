import { describe, expect, test } from 'bun:test';
import { composeQuotedDraft, toBlockquote } from './quote';

describe('toBlockquote', () => {
  test('prefixes a single line', () => {
    expect(toBlockquote('hello world')).toBe('> hello world');
  });

  test('prefixes every line of a multi-line selection', () => {
    expect(toBlockquote('one\ntwo\nthree')).toBe('> one\n> two\n> three');
  });

  test('a blank interior line becomes a bare marker, not "> "', () => {
    expect(toBlockquote('a\n\nb')).toBe('> a\n>\n> b');
  });

  test('trailing whitespace/newlines are trimmed before quoting', () => {
    expect(toBlockquote('line\n\n   ')).toBe('> line');
  });

  test('empty or whitespace-only selection yields an empty string', () => {
    expect(toBlockquote('')).toBe('');
    expect(toBlockquote('   \n  \t')).toBe('');
  });

  test('leading indentation inside a line is preserved after the marker', () => {
    expect(toBlockquote('  indented')).toBe('>   indented');
  });
});

describe('composeQuotedDraft', () => {
  test('into an empty draft: just the quote block plus a trailing blank line', () => {
    expect(composeQuotedDraft('', 'quote me')).toBe('> quote me\n\n');
  });

  test('a whitespace-only draft counts as empty', () => {
    expect(composeQuotedDraft('   \n', 'quote me')).toBe('> quote me\n\n');
  });

  test('appends after an existing draft with a blank-line separator, never clobbers it', () => {
    expect(composeQuotedDraft('my reply', 'quoted')).toBe('my reply\n\n> quoted\n\n');
  });

  test('collapses the existing draft trailing whitespace into exactly one blank line', () => {
    expect(composeQuotedDraft('reply\n\n\n', 'quoted')).toBe('reply\n\n> quoted\n\n');
  });

  test('an empty selection leaves the draft untouched', () => {
    expect(composeQuotedDraft('keep me', '   ')).toBe('keep me');
    expect(composeQuotedDraft('', '')).toBe('');
  });

  test('multi-line selection is quoted as one block below the draft', () => {
    expect(composeQuotedDraft('hi', 'a\nb')).toBe('hi\n\n> a\n> b\n\n');
  });
});
