import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry } from './types';

export function logPath(id: string): string {
  return `${process.env.HOME}/.kautopilot/${id}/log.jsonl`;
}

export function appendEvent(id: string, entry: LogEntry): void {
  const path = logPath(id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

export function readLog(id: string): LogEntry[] {
  const path = logPath(id);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
      console.warn(`Warning: skipping malformed log line: ${trimmed.slice(0, 80)}`);
    }
  }
  return entries;
}

// reconstructState() has been replaced by ensureStatus() in ./status.ts
// Use: import { ensureStatus } from '../core/status';
