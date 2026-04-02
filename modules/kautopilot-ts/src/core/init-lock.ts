import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { LockInfo } from './types';
import { initDir } from './artifacts';
import { appendInitEvent } from './log';
import { updateInitOutcome } from './init-db';

// Track whether signal handlers have been registered to prevent accumulation
let signalHandlersRegistered = false;
// Module-level mutable state so signal handlers always reference the current init
let currentInitId: string | null = null;
let currentLockPath: string | null = null;

function initLockPath(id: string): string {
  return join(initDir(id), 'lock.pid');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireInitLock(id: string): void {
  const path = initLockPath(id);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const existingPid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (isProcessAlive(existingPid)) {
      throw new Error(`Init is already running (PID ${existingPid}).`);
    }
    unlinkSync(path);
  }

  writeFileSync(path, String(process.pid));

  // Update module-level state so signal handlers always reference the current init
  currentInitId = id;
  currentLockPath = path;

  const cleanupCurrentLock = () => {
    const lockPath = currentLockPath;
    if (!lockPath) return;
    try {
      if (existsSync(lockPath)) {
        const storedPid = readFileSync(lockPath, 'utf-8').trim();
        if (storedPid === String(process.pid)) {
          unlinkSync(lockPath);
        }
      }
    } catch {
      // Ignore
    }
  };

  // Register signal handlers only once per process lifetime
  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;

    process.on('SIGINT', () => {
      // Emit cancelled event and update DB before cleanup (spec section 6.3)
      const initId = currentInitId;
      if (initId) {
        try {
          appendInitEvent(initId, {
            ts: new Date().toISOString(),
            event: 'init:cancelled',
            metadata: { reason: 'sigint', pid: process.pid },
          });
          updateInitOutcome(initId, 'cancelled');
        } catch {
          // Best-effort — don't block exit if WAL/DB write fails
        }
      }
      cleanupCurrentLock();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      // Emit cancelled event and update DB before cleanup (spec section 6.3)
      const initId = currentInitId;
      if (initId) {
        try {
          appendInitEvent(initId, {
            ts: new Date().toISOString(),
            event: 'init:cancelled',
            metadata: { reason: 'sigterm', pid: process.pid },
          });
          updateInitOutcome(initId, 'cancelled');
        } catch {
          // Best-effort — don't block exit if WAL/DB write fails
        }
      }
      cleanupCurrentLock();
      process.exit(143);
    });
    process.on('exit', cleanupCurrentLock);
  }
}

export function checkInitLock(id: string): LockInfo {
  const path = initLockPath(id);
  if (!existsSync(path)) {
    return { locked: false, pid: 0, alive: false };
  }

  const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
  const alive = isProcessAlive(pid);

  if (!alive) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore
    }
    return { locked: false, pid, alive: false };
  }

  return { locked: true, pid, alive: true };
}

export function releaseInitLock(id: string): void {
  const path = initLockPath(id);
  try {
    if (existsSync(path)) {
      const storedPid = readFileSync(path, 'utf-8').trim();
      if (storedPid === String(process.pid)) {
        unlinkSync(path);
      }
    }
  } catch {
    // Ignore
  }
}
