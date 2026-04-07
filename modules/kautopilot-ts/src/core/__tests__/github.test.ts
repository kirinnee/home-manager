import { describe, expect, it } from 'bun:test';
import { withBotSignature } from '../github';

describe('github helpers', () => {
  describe('withBotSignature', () => {
    it('appends signature to a plain string', () => {
      expect(withBotSignature('Fixed the bug')).toBe('Fixed the bug\n\nBy Claude Code Kautopilot');
    });

    it('handles multiline bodies', () => {
      const body = 'Great catch!\n\nI have addressed this in commit abc123.';
      expect(withBotSignature(body)).toBe(`${body}\n\nBy Claude Code Kautopilot`);
    });

    it('handles empty string', () => {
      expect(withBotSignature('')).toBe('\n\nBy Claude Code Kautopilot');
    });

    it('preserves trailing whitespace in body', () => {
      const body = 'Done.  ';
      expect(withBotSignature(body)).toBe('Done.  \n\nBy Claude Code Kautopilot');
    });

    it('signature is constant', () => {
      const sig = '\n\nBy Claude Code Kautopilot';
      expect(withBotSignature('x').endsWith(sig)).toBe(true);
      expect(withBotSignature('y').endsWith(sig)).toBe(true);
      // Same signature for all calls
      const expected = `test${sig}`;
      expect(withBotSignature('test')).toBe(expected);
    });
  });
});
