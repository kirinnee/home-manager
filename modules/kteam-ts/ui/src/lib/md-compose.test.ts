import { describe, expect, test } from 'bun:test';
import {
  MD_COMPOSE_DEFAULT,
  MD_COMPOSE_KEY,
  parseMdComposePref,
  readMdComposePref,
  writeMdComposePref,
} from './md-compose';

describe('markdown composer preference', () => {
  test('is deliberately off by default and rejects malformed values', () => {
    expect(MD_COMPOSE_DEFAULT).toBe('off');
    expect(parseMdComposePref(null)).toBe('off');
    expect(parseMdComposePref('')).toBe('off');
    expect(parseMdComposePref('true')).toBe('off');
    expect(parseMdComposePref('on')).toBe('on');
    expect(parseMdComposePref('off')).toBe('off');
  });

  test('uses the one versioned storage key', () => {
    expect(MD_COMPOSE_KEY).toBe('kteam-md-compose-v1');
  });

  test('a blocked storage getter never throws and the same-page choice still sticks', () => {
    const root = globalThis as unknown as { localStorage?: Storage };
    const previous = Object.getOwnPropertyDescriptor(root, 'localStorage');
    Object.defineProperty(root, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    try {
      expect(readMdComposePref()).toBe('off');
      expect(() => writeMdComposePref('on')).not.toThrow();
      expect(readMdComposePref()).toBe('on');
      // Leave module state at its product default for other tests in this run.
      writeMdComposePref('off');
    } finally {
      if (previous) Object.defineProperty(root, 'localStorage', previous);
      else delete root.localStorage;
    }
  });

  test('a failed write wins over an older readable stored value in this tab', () => {
    const root = globalThis as unknown as { localStorage?: Storage };
    const previous = Object.getOwnPropertyDescriptor(root, 'localStorage');
    const storage = {
      getItem: () => 'off',
      setItem: () => {
        throw new Error('quota exceeded');
      },
    } as unknown as Storage;
    Object.defineProperty(root, 'localStorage', { configurable: true, value: storage });
    try {
      writeMdComposePref('on');
      expect(readMdComposePref()).toBe('on');
      writeMdComposePref('off');
    } finally {
      if (previous) Object.defineProperty(root, 'localStorage', previous);
      else delete root.localStorage;
    }
  });
});
