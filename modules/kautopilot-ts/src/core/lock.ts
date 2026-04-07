import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LockInfo } from './types';

function lockPath(id: string): string {
  return `${process.env.HOME}/.kautopilot/${id}/lock.pid`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(id: string): void {
  const path = lockPath(id);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const existingPid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (isProcessAlive(existingPid)) {
      throw new Error(`Session is already running (PID ${existingPid}). Use \`kautopilot stop\` first.`);
    }
    // Stale lock — auto-cleanup
    console.warn(`Warning: Stale lock detected (PID ${existingPid} not alive). Auto-cleaning.`);
    unlinkSync(path);
  }

  writeFileSync(path, String(process.pid));

  // Install signal handlers to release lock on exit
  const cleanup = () => {
    try {
      if (existsSync(path)) {
        const storedPid = readFileSync(path, 'utf-8').trim();
        if (storedPid === String(process.pid)) {
          unlinkSync(path);
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  process.on('exit', cleanup);
}

export function checkLock(id: string): LockInfo {
  const path = lockPath(id);
  if (!existsSync(path)) {
    return { locked: false, pid: 0, alive: false };
  }

  const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
  const alive = isProcessAlive(pid);

  if (!alive) {
    // Stale lock — auto-cleanup
    console.warn(`Warning: Stale lock detected (PID ${pid} not alive). Auto-cleaning.`);
    try {
      unlinkSync(path);
    } catch {
      // Ignore
    }
    return { locked: false, pid, alive: false };
  }

  return { locked: true, pid, alive: true };
}

export function releaseLock(id: string): void {
  const path = lockPath(id);
  try {
    if (existsSync(path)) {
      const storedPid = readFileSync(path, 'utf-8').trim();
      if (storedPid === String(process.pid)) {
        unlinkSync(path);
      }
    }
  } catch {
    // Ignore errors during release
  }
}
