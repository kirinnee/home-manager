import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { expandHome, listWrappers, runtimeModelsForWrapper, scanProjects } from './fleet-inventory';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'kteam-inv-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('listWrappers marks harness + auto/interactive and sorts launchable-first', () => {
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude-auto-loge', 'claude-loge', 'codex-auto-kirin', 'crc-auto-atomi', 'not-an-agent']) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  }
  const wrappers = listWrappers(bin);
  const names = wrappers.map(w => w.name);
  expect(names).toContain('claude-auto-loge');
  expect(names).toContain('claude-loge');
  expect(names).toContain('codex-auto-kirin');
  // crc-* and non-harness entries are excluded.
  expect(names).not.toContain('crc-auto-atomi');
  expect(names).not.toContain('not-an-agent');

  const loge = wrappers.find(w => w.name === 'claude-auto-loge')!;
  expect(loge.harness).toBe('claude');
  expect(loge.mode).toBe('auto');
  expect(loge.launchable).toBe(true);
  expect(loge.runtimeModels?.map(model => model.value)).toEqual([
    'claude-fable-5[1m]',
    'claude-opus-5[1m]',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ]);

  const interactive = wrappers.find(w => w.name === 'claude-loge')!;
  expect(interactive.mode).toBe('interactive');
  expect(interactive.launchable).toBe(false);
  expect(interactive.runtimeModels).toEqual([]); // explicit: current daemon, unsupported wrapper

  const codex = wrappers.find(w => w.name === 'codex-auto-kirin')!;
  expect(codex.runtimeModels).toBeUndefined(); // Codex owns its live native catalog

  // launchable ones sort first.
  expect(wrappers[0]!.launchable).toBe(true);
});

test('runtime model choices are account-aware and never leak Anthropic ids to provider wrappers', () => {
  expect(runtimeModelsForWrapper('claude-auto-atomi').map(model => model.value)).toEqual([
    'fable',
    'opus',
    'sonnet',
    'haiku',
  ]);
  expect(runtimeModelsForWrapper('/fleet/bin/claude-auto-glm52a').map(model => model.value)).toEqual([
    'glm-5.2',
    'glm-5-turbo',
    'glm-4.7',
  ]);
  expect(runtimeModelsForWrapper('claude-auto-mm3').map(model => model.value)).toEqual(['MiniMax-M3']);
  expect(runtimeModelsForWrapper('claude-auto-dsv4f').map(model => model.value)).toEqual([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ]);
  expect(runtimeModelsForWrapper('claude-auto-unknown')).toEqual([]);
  expect(runtimeModelsForWrapper('codex-auto-loge')).toEqual([]);
});

test('listWrappers returns [] for a missing bin dir', () => {
  expect(listWrappers(path.join(tmp, 'nope'))).toEqual([]);
});

test('scanProjects finds git repos one level deep and the root itself', async () => {
  const root = path.join(tmp, 'Workspace');
  mkdirSync(path.join(root, 'repo-a', '.git'), { recursive: true });
  writeFileSync(path.join(root, 'repo-a', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(path.join(root, 'repo-b', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'not-a-repo'), { recursive: true });

  const rootRepo = path.join(tmp, 'soloRepo');
  mkdirSync(path.join(rootRepo, '.git'), { recursive: true });

  const projects = await scanProjects([root, rootRepo]);
  const names = projects.map(p => p.name).sort();
  expect(names).toContain('repo-a');
  expect(names).toContain('repo-b');
  expect(names).toContain('soloRepo'); // a root that is itself a repo
  expect(names).not.toContain('not-a-repo');
  expect(projects.find(p => p.name === 'repo-a')!.path).toBe(path.join(root, 'repo-a'));
});

test('scanProjects skips missing roots without throwing', async () => {
  expect(await scanProjects([path.join(tmp, 'ghost')])).toEqual([]);
});

test('expandHome expands ~ and $HOME', () => {
  expect(expandHome('~/x', '/home/u')).toBe('/home/u/x');
  expect(expandHome('$HOME/y', '/home/u')).toBe('/home/u/y');
  expect(expandHome('/abs', '/home/u')).toBe('/abs');
});
