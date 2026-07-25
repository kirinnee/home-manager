import { describe, expect, test } from 'bun:test';
import { displayCallsign } from './callsign';

describe('displayCallsign', () => {
  test('title-cases each hyphen-separated name segment without changing digits', () => {
    expect(displayCallsign('meghan')).toBe('Meghan');
    expect(displayCallsign('mary-jane')).toBe('Mary-Jane');
    expect(displayCallsign('ana-2')).toBe('Ana-2');
    expect(displayCallsign('x')).toBe('X');
  });

  test('returns an empty display name for absent or blank callsigns', () => {
    expect(displayCallsign()).toBe('');
    expect(displayCallsign('')).toBe('');
    expect(displayCallsign('   ')).toBe('');
  });

  test('is idempotent and preserves valid lowercase slugs through display casing', () => {
    for (const slug of ['meghan', 'mary-jane', 'ana-2', 'x', 'jean-luc-2']) {
      const display = displayCallsign(slug);
      expect(displayCallsign(display.toLowerCase())).toBe(display);
      expect(display.toLowerCase()).toBe(slug);
    }
  });

  test('preserves empty hyphen segments without throwing', () => {
    expect(() => displayCallsign('-foo')).not.toThrow();
    expect(() => displayCallsign('foo--bar')).not.toThrow();
    expect(displayCallsign('-foo')).toBe('-Foo');
    expect(displayCallsign('foo--bar')).toBe('Foo--Bar');
  });
});
