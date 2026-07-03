import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deepMerge, resolveSettings } from './settings';

describe('deepMerge', () => {
  test('nested objects merge key-by-key; scalars and arrays are replaced', () => {
    expect(deepMerge({ a: 1, n: { x: 1, y: 2 } }, { a: 2, n: { y: 3, z: 4 } })).toEqual({
      a: 2,
      n: { x: 1, y: 3, z: 4 },
    });
    expect(deepMerge({ list: [1, 2] }, { list: [3] })).toEqual({ list: [3] }); // arrays replace, not concat
  });

  test('inputs are not mutated', () => {
    const a = { n: { x: 1 } };
    const b = { n: { y: 2 } };
    deepMerge(a, b);
    expect(a).toEqual({ n: { x: 1 } });
    expect(b).toEqual({ n: { y: 2 } });
  });
});

describe('resolveSettings', () => {
  const tmpFile = (name: string, body: string): string => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'kfleet-')), name);
    writeFileSync(f, body);
    return f;
  };

  test('a lone file path passes through verbatim (copy/link), never parsed', () => {
    const f = tmpFile('base.toml', 'service_tier = "x"\n');
    expect(resolveSettings([f], 'toml', 'copy')).toEqual({ kind: 'copy', src: f });
    expect(resolveSettings([f], 'toml', 'link')).toEqual({ kind: 'link', src: f });
  });

  test('file base + inline override is parsed, deep-merged, re-serialized (toml)', () => {
    const f = tmpFile('base.toml', 'approval_policy = "never"\n[features]\nhooks = true\n');
    const out = resolveSettings([f, { service_tier: 'fast' }], 'toml', 'copy');
    expect(out.kind).toBe('write');
    if (out.kind === 'write') {
      expect(out.content).toContain('service_tier = "fast"'); // override applied
      expect(out.content).toContain('approval_policy = "never"'); // base preserved
      expect(out.content).toContain('hooks = true'); // nested table preserved
    }
  });

  test('inline-only layers merge and serialize as json', () => {
    const out = resolveSettings([{ a: 1 }, { b: 2 }], 'json', 'link');
    expect(out).toEqual({ kind: 'write', content: `${JSON.stringify({ a: 1, b: 2 }, null, 2)}\n` });
  });

  test('inline-only layers serialize as toml', () => {
    const out = resolveSettings([{ service_tier: 'fast' }], 'toml', 'copy');
    expect(out.kind).toBe('write'); // a lone inline object still goes through serialize, not passthrough
    if (out.kind === 'write') expect(out.content).toBe('service_tier = "fast"\n');
  });

  test('a missing file source throws', () => {
    expect(() => resolveSettings(['/no/such/file.toml'], 'toml', 'copy')).toThrow(/settings source not found/);
  });
});
