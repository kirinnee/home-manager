import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { atomicJson } from './io';
import { provenancePath, renderProvenanceMarkdown, type WardenSpawnProvenance } from './warden-provenance';
import { readWardenReport, readWardenVerdicts } from './warden-reports';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const tempReports = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kteam-warden-reports-'));
  dirs.push(dir);
  return dir;
};

const spawn = (over: Partial<WardenSpawnProvenance> = {}): WardenSpawnProvenance => ({
  v: 1,
  at: '2026-07-28T12:34:56.789Z',
  wardenSessionId: 'warden-session-1',
  wrapper: 'claude-auto-b',
  model: 'claude-opus-4-8',
  modelSource: 'harness',
  harness: 'claude',
  policy: 'fallback',
  selection: 'failover',
  configuredFirst: 'claude-auto-a',
  skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
  failedOver: true,
  ...over,
});

describe('warden report provenance merge', () => {
  test('old reports without a sidecar remain byte-compatible', async () => {
    const dir = await tempReports();
    const content = await Bun.file(path.join(import.meta.dir, 'fixtures', 'warden-report-assigned.txt')).text();
    const report = path.join(dir, '2026-07-23T18-39-40-962Z-mrx35inz-80a08da9.md');
    await writeFile(report, content);
    expect(await readWardenReport(report)).toBe(content);
  });

  test('prepends the scan-friendly provenance block when a sidecar exists', async () => {
    const dir = await tempReports();
    const report = path.join(dir, '2026-07-28T12-34-56-789Z-target-12345678.md');
    const content = 'Verdict: LEAVE\n\n# Warden report — target-12345678\n';
    const meta = spawn();
    await writeFile(report, content);
    await atomicJson(provenancePath(report), meta);
    expect(await readWardenReport(report)).toBe(`${renderProvenanceMarkdown(meta)}\n\n${content}`);
  });

  test('a corrupt sidecar fails loudly instead of impersonating an old report', async () => {
    const dir = await tempReports();
    const report = path.join(dir, '2026-07-28T12-34-56-789Z-target-12345678.md');
    await writeFile(report, 'Verdict: LEAVE\n');
    await writeFile(provenancePath(report), '{ not json');
    expect(readWardenReport(report)).rejects.toThrow('invalid warden provenance sidecar');
    expect(readWardenVerdicts({ wardenReports: dir })).rejects.toThrow('invalid warden provenance sidecar');
  });
});

describe('warden verdict provenance attachment', () => {
  test('attaches sidecar facts after parsing a real report fixture', async () => {
    const dir = await tempReports();
    const report = path.join(dir, '2026-07-23T18-39-40-962Z-mrx35inz-80a08da9.md');
    const content = await Bun.file(path.join(import.meta.dir, 'fixtures', 'warden-report-assigned.txt')).text();
    const meta = spawn({ target: 'mrx35inz-80a08da9' });
    await writeFile(report, content);
    await atomicJson(provenancePath(report), meta);
    const [verdict] = await readWardenVerdicts({ wardenReports: dir });
    expect(verdict?.verdict).toBe('cleared');
    expect(verdict?.spawn).toEqual({ ...meta, failoverReason: 'at its usage limit (kfleet feed)' });
  });

  test('never feeds the injected block through heuristic verdict parsing', async () => {
    const dir = await tempReports();
    const report = path.join(dir, '2026-07-28T12-34-56-789Z-target-12345678.md');
    await writeFile(report, '# Warden report — target-12345678\n\nNothing conclusive.\n');
    await atomicJson(
      provenancePath(report),
      spawn({
        wardenSessionId: 'kill',
      }),
    );
    const [verdict] = await readWardenVerdicts({ wardenReports: dir });
    expect(verdict?.verdict).toBe('unknown');
    expect(verdict?.spawn?.wardenSessionId).toBe('kill');
  });

  test('keeps spawn absent for an old real sweep report', async () => {
    const dir = await tempReports();
    const report = path.join(dir, '2026-07-23T05-12-36-344Z.md');
    const content = await Bun.file(path.join(import.meta.dir, 'fixtures', 'warden-report-sweep.txt')).text();
    await writeFile(report, content);
    const [verdict] = await readWardenVerdicts({ wardenReports: dir });
    expect(verdict?.verdict).toBe('needs_human');
    expect(verdict?.spawn).toBeUndefined();
  });

  test('defaults to 20 verdicts but permits a larger fleet-attention limit', async () => {
    const dir = await tempReports();
    await Promise.all(
      Array.from({ length: 102 }, (_, index) =>
        writeFile(
          path.join(dir, `2026-07-28T12-34-56-${String(index).padStart(3, '0')}Z.md`),
          `Verdict: LEAVE\n\n## Anomaly: \`target-${index}\` — teammate / label\n`,
        ),
      ),
    );
    expect(await readWardenVerdicts({ wardenReports: dir })).toHaveLength(20);
    expect(await readWardenVerdicts({ wardenReports: dir }, 101)).toHaveLength(101);
  });

  test('an unreadable reports path rejects instead of returning a healthy empty list', async () => {
    const dir = await tempReports();
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'not a directory');
    expect(readWardenVerdicts({ wardenReports: dir })).rejects.toThrow();
  });
});
