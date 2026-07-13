import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeSharedHistory } from './shared-history';

/** Fresh sandbox: a pool root + two fake account config dirs. */
function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kfleet-shared-'));
  const poolRoot = path.join(root, 'shared');
  const a = path.join(root, '.claude-a');
  const b = path.join(root, '.claude-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  return { root, poolRoot, a, b, pool: path.join(poolRoot, 'claude') };
}

const write = (dir: string, rel: string, content: string) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};

describe('materializeSharedHistory', () => {
  test('first account: entries are adopted into the pool and symlinked back', () => {
    const { poolRoot, a, pool } = sandbox();
    write(a, 'projects/-tmp-x/s1.jsonl', 'one\n');
    write(a, 'history.jsonl', '{"display":"hi","timestamp":2}\n');

    const res = materializeSharedHistory('claude', a, poolRoot);

    expect(res.conflicts).toBe(0);
    // every sharedState entry is now a symlink into the pool (created if absent)
    for (const name of ['projects', 'sessions', 'plans', 'history.jsonl']) {
      const dest = path.join(a, name);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(path.join(pool, name));
    }
    expect(readFileSync(path.join(pool, 'projects/-tmp-x/s1.jsonl'), 'utf8')).toBe('one\n');
    // reading through the symlink works
    expect(readFileSync(path.join(a, 'history.jsonl'), 'utf8')).toContain('"hi"');
  });

  test('second account: dirs merge into the pool; both sessions resumable', () => {
    const { poolRoot, a, b, pool } = sandbox();
    write(a, 'projects/-tmp-x/s1.jsonl', 'from-a\n');
    write(b, 'projects/-tmp-x/s2.jsonl', 'from-b\n');
    write(b, 'projects/-tmp-y/s3.jsonl', 'only-b\n');

    materializeSharedHistory('claude', a, poolRoot);
    const res = materializeSharedHistory('claude', b, poolRoot);

    expect(res.conflicts).toBe(0);
    for (const f of ['-tmp-x/s1.jsonl', '-tmp-x/s2.jsonl', '-tmp-y/s3.jsonl']) {
      expect(existsSync(path.join(pool, 'projects', f))).toBe(true);
    }
    // both accounts see the union through their symlink
    expect(existsSync(path.join(a, 'projects/-tmp-y/s3.jsonl'))).toBe(true);
    expect(existsSync(path.join(b, 'projects/-tmp-x/s1.jsonl'))).toBe(true);
  });

  test('conflicting path: newer mtime wins, loser preserved under .migration-conflicts', () => {
    const { poolRoot, a, b, pool } = sandbox();
    const older = write(a, 'projects/-p/memory/MEMORY.md', 'old\n');
    const newer = write(b, 'projects/-p/memory/MEMORY.md', 'new\n');
    utimesSync(older, new Date(1000000), new Date(1000000));
    utimesSync(newer, new Date(2000000), new Date(2000000));

    materializeSharedHistory('claude', a, poolRoot);
    const res = materializeSharedHistory('claude', b, poolRoot);

    expect(res.conflicts).toBe(1);
    expect(readFileSync(path.join(pool, 'projects/-p/memory/MEMORY.md'), 'utf8')).toBe('new\n');
    expect(readFileSync(path.join(pool, '.migration-conflicts/.claude-b/projects/-p/memory/MEMORY.md'), 'utf8')).toBe(
      'old\n',
    );
  });

  test('history.jsonl: union of lines, deduped, sorted by timestamp', () => {
    const { poolRoot, a, b, pool } = sandbox();
    write(a, 'history.jsonl', '{"display":"one","timestamp":1}\n{"display":"three","timestamp":3}\n');
    write(b, 'history.jsonl', '{"display":"two","timestamp":2}\n{"display":"three","timestamp":3}\n');

    materializeSharedHistory('claude', a, poolRoot);
    materializeSharedHistory('claude', b, poolRoot);

    const lines = readFileSync(path.join(pool, 'history.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map(l => (JSON.parse(l) as { display: string }).display)).toEqual(['one', 'two', 'three']);
  });

  test('idempotent: a second run migrates nothing and keeps the links', () => {
    const { poolRoot, a } = sandbox();
    write(a, 'projects/-p/s.jsonl', 'x\n');
    materializeSharedHistory('claude', a, poolRoot);

    const res = materializeSharedHistory('claude', a, poolRoot);

    expect(res).toEqual({ migrated: 0, conflicts: 0 });
    expect(lstatSync(path.join(a, 'projects')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(a, 'projects/-p/s.jsonl'))).toBe(true);
  });

  test('codex kind pools its own entries (sessions, history.jsonl)', () => {
    const { poolRoot, root } = sandbox();
    const c = path.join(root, '.codex-a');
    write(c, 'sessions/2026/r1.jsonl', 'rollout\n');
    write(c, 'history.jsonl', '{"session_id":"s","ts":1,"text":"hi"}\n');

    materializeSharedHistory('codex', c, poolRoot);

    const pool = path.join(poolRoot, 'codex');
    expect(readlinkSync(path.join(c, 'sessions'))).toBe(path.join(pool, 'sessions'));
    expect(existsSync(path.join(pool, 'sessions/2026/r1.jsonl'))).toBe(true);
    expect(readFileSync(path.join(pool, 'history.jsonl'), 'utf8')).toContain('"hi"');
  });
});
