import { describe, expect, test } from 'bun:test';
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  TerminalError,
  isTerminalId,
  normalizeTerminalSize,
  normalizeTerminalTitle,
} from './terminal-types';

describe('terminal contracts', () => {
  test('accepts only daemon-minted terminal ids', () => {
    expect(isTerminalId('0123abcdef99')).toBe(true);
    expect(isTerminalId('../0123abcdef')).toBe(false);
    expect(isTerminalId('ABCDEF012345')).toBe(false);
    expect(isTerminalId('short')).toBe(false);
  });

  test('rounds and bounds the shared tmux/xterm geometry', () => {
    expect(normalizeTerminalSize(80.4, 24.7)).toEqual({ cols: 80, rows: 25 });
    expect(normalizeTerminalSize(1, 1)).toEqual({ cols: TERMINAL_MIN_COLS, rows: TERMINAL_MIN_ROWS });
    expect(normalizeTerminalSize(9_999, 9_999)).toEqual({ cols: TERMINAL_MAX_COLS, rows: TERMINAL_MAX_ROWS });
    expect(() => normalizeTerminalSize(Number.NaN, 20)).toThrow(TerminalError);
  });

  test('keeps names human-readable but rejects control payloads', () => {
    expect(normalizeTerminalTitle('  Deploy logs  ')).toBe('Deploy logs');
    expect(() => normalizeTerminalTitle('')).toThrow('cannot be empty');
    expect(() => normalizeTerminalTitle('bad\nname')).toThrow('control characters');
  });
});
