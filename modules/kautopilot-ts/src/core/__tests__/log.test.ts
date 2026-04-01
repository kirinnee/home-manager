import { describe, it, expect } from 'bun:test';
import { readLog, appendEvent } from '../log';
import type { LogEntry } from '../types';

// Test the log read/write helpers (appendEvent/readLog still in log.ts)
describe('readLog', () => {
  it('returns empty array for nonexistent session', () => {
    const log = readLog('nonexistent-session-id-test');
    expect(log).toEqual([]);
  });
});
