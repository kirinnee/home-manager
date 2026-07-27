// PinSheet's DOM-free contract: the pure helpers that decide the trigger label,
// the honest jump copy, the locate-progress wording, the note character budget,
// and how a note's bare URLs split for linkify. Rendering is asserted in the
// browser matrix (this package has no DOM implementation in tests).

import { describe, expect, test } from 'bun:test';
import { MAX_NOTE_LEN } from '../lib/pins';
import { jumpOutcomeCopy, locatingLabel, noteCharsRemaining, pinsTriggerLabel, splitLinkified } from './PinSheet';

describe('pinsTriggerLabel', () => {
  test('names a count only when there is one, and always carries the word Pins', () => {
    expect(pinsTriggerLabel(0)).toBe('Pins');
    expect(pinsTriggerLabel(3)).toBe('Pins (3)');
  });
});

describe('noteCharsRemaining', () => {
  test('counts down from the cap and goes negative when over', () => {
    expect(noteCharsRemaining('')).toBe(MAX_NOTE_LEN);
    expect(noteCharsRemaining('x'.repeat(MAX_NOTE_LEN))).toBe(0);
    expect(noteCharsRemaining('x'.repeat(MAX_NOTE_LEN + 5))).toBe(-5);
  });
});

describe('jumpOutcomeCopy — honest, never a wrong jump', () => {
  test('a not-found says it is older than the loaded history', () => {
    expect(jumpOutcomeCopy('not-found')).toMatch(/older than the loaded history/i);
  });
  test('a missing transcript points the reader at the Chat tab', () => {
    expect(jumpOutcomeCopy('no-transcript')).toMatch(/chat tab/i);
  });
});

describe('locatingLabel', () => {
  test('is bare before any page loads, then reports progress with the cap', () => {
    expect(locatingLabel(0)).toBe('Locating…');
    expect(locatingLabel(1)).toMatch(/1\/10 older page\b/);
    expect(locatingLabel(3)).toMatch(/3\/10 older pages\b/);
  });
});

describe('splitLinkified', () => {
  test('plain text stays one text segment', () => {
    expect(splitLinkified('just a note')).toEqual([{ type: 'text', value: 'just a note' }]);
  });
  test('a bare URL is isolated with its surrounding text', () => {
    expect(splitLinkified('see https://example.com/x now')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'https://example.com/x' },
      { type: 'text', value: ' now' },
    ]);
  });
  test('multiple URLs each split out', () => {
    const segs = splitLinkified('http://a.com and http://b.com');
    expect(segs.filter(s => s.type === 'url').map(s => s.value)).toEqual(['http://a.com', 'http://b.com']);
  });
  test('empty text is still a single (empty) text segment', () => {
    expect(splitLinkified('')).toEqual([{ type: 'text', value: '' }]);
  });
});
