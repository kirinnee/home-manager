import { describe, it, expect } from 'bun:test';
import { findLastEvent } from '../machine';
import type { LogEntry } from '../../core/types';

describe('machine helpers', () => {
  describe('findLastEvent', () => {
    const log: LogEntry[] = [
      { ts: '2026-03-24T10:00:00Z', event: 'phase1:started', version: 1 },
      { ts: '2026-03-24T10:00:01Z', event: 'write_spec:started', version: 1, attempt: 1 },
      { ts: '2026-03-24T10:05:00Z', event: 'write_spec:completed', version: 1, attempt: 1 },
      { ts: '2026-03-24T10:05:01Z', event: 'spec_review:started', version: 1, attempt: 1 },
    ];

    it('finds last event matching pattern', () => {
      const result = findLastEvent(log, 'write_spec');
      expect(result?.event).toBe('write_spec:completed');
      expect(result?.attempt).toBe(1);
    });

    it('returns undefined if no match', () => {
      const result = findLastEvent(log, 'nonexistent');
      expect(result).toBeUndefined();
    });

    it('matches event prefix', () => {
      const result = findLastEvent(log, 'spec_review');
      expect(result?.event).toBe('spec_review:started');
    });
  });
});
