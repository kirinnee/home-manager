import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeUsesPatchedImage } from './deploy';
import { DEFAULT_IMAGE, PATCHED_IMAGE, UPSTREAM_IMAGE } from './paths';
import { ensureManagementKey, renderComposeYaml, renderConfigYaml } from './render';

const originalImage = process.env.KLOGE_IMAGE;

afterEach(() => {
  if (originalImage === undefined) delete process.env.KLOGE_IMAGE;
  else process.env.KLOGE_IMAGE = originalImage;
});

describe('renderComposeYaml', () => {
  test('enables host-local Docker management with its separate key', () => {
    const yaml = renderConfigYaml(8317, 'management-test-key');

    expect(yaml).toContain('remote-management:');
    expect(yaml).toContain('  allow-remote: true');
    expect(yaml).toContain('  secret-key: "management-test-key"');
    expect(yaml).toContain('  disable-control-panel: true');
    expect(renderConfigYaml(8317, 'quoted"key')).toContain('  secret-key: "quoted\\"key"');
  });

  test('creates and reuses a random owner-only management key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kloge-key-'));
    const file = join(dir, 'nested', 'management-key');
    try {
      const first = ensureManagementKey(file, {});
      const second = ensureManagementKey(file, {});

      expect(first).toBe(second);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(readFileSync(file, 'utf8')).toBe(`${first}\n`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists an explicit management key for rotation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kloge-key-'));
    const file = join(dir, 'management-key');
    try {
      expect(ensureManagementKey(file, { KLOGE_MANAGEMENT_KEY: 'rotated-secret' })).toBe('rotated-secret');
      expect(readFileSync(file, 'utf8')).toBe('rotated-secret\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses the model-aware maintained image by default', () => {
    delete process.env.KLOGE_IMAGE;
    const yaml = renderComposeYaml(8317);

    expect(yaml).toContain(`    image: ${DEFAULT_IMAGE}`);
    expect(DEFAULT_IMAGE).toBe(PATCHED_IMAGE);
    expect(yaml).toContain('    pull_policy: never');
    expect(yaml).toContain('--local-model');
    expect(composeUsesPatchedImage(yaml)).toBe(true);
  });

  test('uses the local image without pulling and preserves the binary command', () => {
    process.env.KLOGE_IMAGE = PATCHED_IMAGE;
    const configBefore = renderConfigYaml(8399, 'test-management-key');
    const yaml = renderComposeYaml(8399);

    expect(yaml).toContain(`    image: ${PATCHED_IMAGE}`);
    expect(yaml).toContain('    pull_policy: never');
    expect(yaml).toContain('    command:');
    expect(yaml).toContain('      - ./CLIProxyAPI');
    expect(yaml).toContain('      - --local-model');
    expect(yaml).toContain('      - "127.0.0.1:8399:8399"');
    expect(yaml).not.toContain('    pull_policy: always');
    expect(renderConfigYaml(8399, 'test-management-key')).toBe(configBefore);
    expect(configBefore).not.toContain('--local-model');
    expect(composeUsesPatchedImage(yaml)).toBe(true);
  });

  test('keeps arbitrary image overrides pullable and out of local-model mode', () => {
    process.env.KLOGE_IMAGE = 'registry.example.test/cli-proxy-api:pinned';
    const yaml = renderComposeYaml(8317);

    expect(yaml).toContain('    image: registry.example.test/cli-proxy-api:pinned');
    expect(yaml).toContain('    pull_policy: always');
    expect(yaml).not.toContain('    command:');
    expect(yaml).not.toContain('--local-model');
    expect(composeUsesPatchedImage(yaml)).toBe(false);
  });

  test('keeps the upstream image available as an explicit rollback', () => {
    process.env.KLOGE_IMAGE = UPSTREAM_IMAGE;
    const yaml = renderComposeYaml(8317);

    expect(yaml).toContain(`    image: ${UPSTREAM_IMAGE}`);
    expect(yaml).toContain('    pull_policy: always');
    expect(yaml).not.toContain('    command:');
    expect(yaml).not.toContain('--local-model');
    expect(composeUsesPatchedImage(yaml)).toBe(false);
  });
});
