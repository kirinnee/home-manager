import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';

function withTempConfig(yaml: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'kf-'));
  try {
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, yaml);
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadConfig', () => {
  test('missing file throws with an init hint', () => {
    expect(() => loadConfig('/no/such/kfleet/config.yaml')).toThrow(/run "kfleet init"/);
  });

  test('parses a valid config and defaults profiles to {}', () => {
    withTempConfig('agents:\n  - { name: x, kind: claude }\n', file => {
      const c = loadConfig(file);
      expect(c.agents[0]?.name).toBe('x');
      expect(c.profiles).toEqual({});
    });
  });

  test('rejects an invalid kind', () => {
    withTempConfig('agents:\n  - { name: x, kind: bogus }\n', file => {
      expect(() => loadConfig(file)).toThrow(/invalid config/);
    });
  });

  test('rejects unknown top-level keys (strict schema)', () => {
    withTempConfig('bogusKey: 1\nagents: []\n', file => {
      expect(() => loadConfig(file)).toThrow(/invalid config/);
    });
  });
});
