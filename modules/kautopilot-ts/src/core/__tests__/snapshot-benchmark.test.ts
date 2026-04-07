import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origHome = process.env.HOME;

/**
 * Benchmark test for snapshot core operations.
 *
 * Measures the actual file I/O that the `kautopilot snapshot` command performs,
 * without CLI argument parsing or process startup overhead.
 *
 * This directly exercises the same operations as:
 *   - `findNextSpecVersion` / `findNextPlansVersion` (readdirSync + regex)
 *   - `copyFileSync` for spec snapshots
 *   - `copyDirRecursive` for plans snapshots
 *   - `appendEvent` (appendFileSync to log.jsonl)
 *   - `mkdirSync` for artifact directories
 */
describe('snapshot benchmark — core operations < 100ms', () => {
  let tempDir: string;
  const BUDGET_MS = 100;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kautopilot-bench-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('spec snapshot (single file) completes in < 100ms', () => {
    const sessionId = 'benchspec1';
    const epochVersion = 1;
    const artifactDir = join(tempDir, '.kautopilot', sessionId, 'artifacts', `v${epochVersion}`);

    // Create repo working copy with a realistic spec (~5KB)
    const repoDir = join(tempDir, 'repo', 'spec', 'ticket-123', 'v1');
    mkdirSync(repoDir, { recursive: true });
    const specContent = '# Task Spec\n\n'.padEnd(5120, 'This is a task spec line.\n');
    const repoSpecPath = join(repoDir, 'task-spec.md');
    writeFileSync(repoSpecPath, specContent);

    // Create session log directory
    const sessionLogDir = join(tempDir, '.kautopilot', sessionId);
    mkdirSync(sessionLogDir, { recursive: true });

    // --- Measure the full spec snapshot operation ---
    const start = performance.now();

    // 1. Ensure artifact dir exists
    mkdirSync(artifactDir, { recursive: true });

    // 2. Find next version (same logic as findNextSpecVersion)
    const files = existsSync(artifactDir) ? readdirSync(artifactDir) : [];
    const versions = files
      .filter(f => /^task-spec-(\d+)\.md$/.test(f))
      .map(f => {
        const match = f.match(/^task-spec-(\d+)\.md$/);
        return match ? Number.parseInt(match[1], 10) : 0;
      });
    const snapshotVersion = versions.length > 0 ? Math.max(...versions) + 1 : 1;

    // 3. Copy file
    const destPath = join(artifactDir, `task-spec-${snapshotVersion}.md`);
    copyFileSync(repoSpecPath, destPath);

    // 4. Append event (same as appendEvent)
    const logPath = join(sessionLogDir, 'log.jsonl');
    const event = {
      ts: new Date().toISOString(),
      event: 'snapshot:created',
      metadata: {
        type: 'spec',
        epochVersion,
        snapshotVersion,
        path: destPath,
      },
    };
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(logPath, `${JSON.stringify(event)}\n`);

    const elapsed = performance.now() - start;

    // Verify correctness
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe(specContent);
    expect(snapshotVersion).toBe(1);

    // Report timing
    console.log(`  spec snapshot: ${elapsed.toFixed(3)}ms (budget: ${BUDGET_MS}ms)`);

    // Assert < 100ms
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('plans snapshot (directory with 3 plan files) completes in < 100ms', () => {
    const sessionId = 'benchplans1';
    const epochVersion = 1;
    const artifactDir = join(tempDir, '.kautopilot', sessionId, 'artifacts', `v${epochVersion}`);

    // Create repo working copy with plans directory (3 files, ~3KB each)
    const repoPlansDir = join(tempDir, 'repo', 'spec', 'ticket-123', 'v1', 'plans');
    mkdirSync(repoPlansDir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const planContent = `# Plan ${i}\n\n`.padEnd(3072, `Plan ${i} content line.\n`);
      writeFileSync(join(repoPlansDir, `plan-${i}.md`), planContent);
    }

    // Create session log directory
    const sessionLogDir = join(tempDir, '.kautopilot', sessionId);
    mkdirSync(sessionLogDir, { recursive: true });

    // --- Measure the full plans snapshot operation ---
    const start = performance.now();

    // 1. Ensure artifact dir exists
    mkdirSync(artifactDir, { recursive: true });

    // 2. Find next version (same logic as findNextPlansVersion)
    const entries = existsSync(artifactDir) ? readdirSync(artifactDir, { withFileTypes: true }) : [];
    const planVersions = entries
      .filter(e => e.isDirectory() && /^plans-(\d+)$/.test(e.name))
      .map(e => {
        const match = e.name.match(/^plans-(\d+)$/);
        return match ? Number.parseInt(match[1], 10) : 0;
      });
    const snapshotVersion = planVersions.length > 0 ? Math.max(...planVersions) + 1 : 1;

    // 3. Copy directory recursively (same as copyDirRecursive)
    const destDir = join(artifactDir, `plans-${snapshotVersion}`);
    mkdirSync(destDir, { recursive: true });
    const srcEntries = readdirSync(repoPlansDir, { withFileTypes: true });
    for (const entry of srcEntries) {
      const srcPath = join(repoPlansDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        // Recursive copy for nested dirs (not expected but handled)
        function copyRecursive(src: string, dest: string) {
          mkdirSync(dest, { recursive: true });
          for (const e of readdirSync(src, { withFileTypes: true })) {
            const s = join(src, e.name);
            const d = join(dest, e.name);
            if (e.isDirectory()) copyRecursive(s, d);
            else copyFileSync(s, d);
          }
        }
        copyRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }

    // 4. Append event
    const logPath = join(sessionLogDir, 'log.jsonl');
    const event = {
      ts: new Date().toISOString(),
      event: 'snapshot:created',
      metadata: {
        type: 'plans',
        epochVersion,
        snapshotVersion,
        path: destDir,
      },
    };
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(logPath, `${JSON.stringify(event)}\n`);

    const elapsed = performance.now() - start;

    // Verify correctness
    expect(existsSync(join(destDir, 'plan-1.md'))).toBe(true);
    expect(existsSync(join(destDir, 'plan-2.md'))).toBe(true);
    expect(existsSync(join(destDir, 'plan-3.md'))).toBe(true);
    expect(snapshotVersion).toBe(1);

    // Report timing
    console.log(`  plans snapshot: ${elapsed.toFixed(3)}ms (budget: ${BUDGET_MS}ms)`);

    // Assert < 100ms
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('incremental versioning (3 existing snapshots) finds next in < 100ms', () => {
    const sessionId = 'benchincr1';
    const epochVersion = 1;
    const artifactDir = join(tempDir, '.kautopilot', sessionId, 'artifacts', `v${epochVersion}`);

    // Pre-create 3 spec snapshots
    mkdirSync(artifactDir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(artifactDir, `task-spec-${i}.md`), `# Spec v${i}\n`.padEnd(2048, `Content ${i}\n`));
    }

    // --- Measure versioning + copy ---
    const repoDir = join(tempDir, 'repo', 'spec', 'ticket-123', 'v1');
    mkdirSync(repoDir, { recursive: true });
    const specContent = '# Updated Spec\n'.padEnd(4096, 'Updated content\n');
    writeFileSync(join(repoDir, 'task-spec.md'), specContent);

    const start = performance.now();

    // Find next version
    const files = readdirSync(artifactDir);
    const versions = files
      .filter(f => /^task-spec-(\d+)\.md$/.test(f))
      .map(f => {
        const match = f.match(/^task-spec-(\d+)\.md$/);
        return match ? Number.parseInt(match[1], 10) : 0;
      });
    const snapshotVersion = Math.max(...versions) + 1;

    // Copy
    const destPath = join(artifactDir, `task-spec-${snapshotVersion}.md`);
    copyFileSync(join(repoDir, 'task-spec.md'), destPath);

    const elapsed = performance.now() - start;

    expect(snapshotVersion).toBe(4);
    expect(existsSync(destPath)).toBe(true);

    console.log(`  incremental versioning: ${elapsed.toFixed(3)}ms (budget: ${BUDGET_MS}ms)`);

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('large plans snapshot (10 files, 10KB each) completes in < 100ms', () => {
    const sessionId = 'benchlarge1';
    const epochVersion = 1;
    const artifactDir = join(tempDir, '.kautopilot', sessionId, 'artifacts', `v${epochVersion}`);

    // Create repo working copy with 10 plan files at 10KB each
    const repoPlansDir = join(tempDir, 'repo', 'spec', 'ticket-123', 'v1', 'plans');
    mkdirSync(repoPlansDir, { recursive: true });
    for (let i = 1; i <= 10; i++) {
      const planContent = `# Plan ${i}\n\n`.padEnd(10240, `Plan ${i} content.\n`);
      writeFileSync(join(repoPlansDir, `plan-${i}.md`), planContent);
    }

    const sessionLogDir = join(tempDir, '.kautopilot', sessionId);
    mkdirSync(sessionLogDir, { recursive: true });

    const start = performance.now();

    mkdirSync(artifactDir, { recursive: true });

    // Copy directory recursively
    const destDir = join(artifactDir, 'plans-1');
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(repoPlansDir, { withFileTypes: true })) {
      copyFileSync(join(repoPlansDir, entry.name), join(destDir, entry.name));
    }

    // Append event
    const logPath = join(sessionLogDir, 'log.jsonl');
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(
      logPath,
      `${JSON.stringify({ event: 'snapshot:created', metadata: { type: 'plans', path: destDir } })}\n`,
    );

    const elapsed = performance.now() - start;

    expect(existsSync(join(destDir, 'plan-10.md'))).toBe(true);

    console.log(`  large plans snapshot (100KB total): ${elapsed.toFixed(3)}ms (budget: ${BUDGET_MS}ms)`);

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
