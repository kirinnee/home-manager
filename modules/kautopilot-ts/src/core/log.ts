import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDir, sessionDir } from './artifacts';
import type { LogEntry } from './types';

// ============================================================================
// Directory-based log operations
// ============================================================================

export function logPathForDir(dir: string): string {
  return join(dir, 'log.jsonl');
}

export function appendEventToDir(dir: string, entry: LogEntry): void {
  const path = logPathForDir(dir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function readLogFromDir(dir: string): LogEntry[] {
  const path = logPathForDir(dir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      console.warn(`Warning: skipping malformed log line: ${trimmed.slice(0, 80)}`);
    }
  }
  return entries;
}

// ============================================================================
// Session log operations (backward compatible)
// ============================================================================

export function logPath(id: string): string {
  return logPathForDir(sessionDir(id));
}

export function appendEvent(id: string, entry: LogEntry): void {
  appendEventToDir(sessionDir(id), entry);
}

export function readLog(id: string): LogEntry[] {
  return readLogFromDir(sessionDir(id));
}

// ============================================================================
// Init log operations
// ============================================================================

export function appendInitEvent(id: string, entry: LogEntry): void {
  appendEventToDir(initDir(id), entry);
}

export function readInitLog(id: string): LogEntry[] {
  return readLogFromDir(initDir(id));
}

// reconstructState() has been replaced by ensureStatus() in ./status.ts
// Use: import { ensureStatus } from '../core/status';
