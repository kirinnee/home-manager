import { afterEach, describe, expect, test } from 'bun:test';
import { composeUsesPatchedImage } from './deploy';
import { DEFAULT_IMAGE, PATCHED_IMAGE } from './paths';
import { renderComposeYaml, renderConfigYaml } from './render';

const originalImage = process.env.KLOGE_IMAGE;

afterEach(() => {
  if (originalImage === undefined) delete process.env.KLOGE_IMAGE;
  else process.env.KLOGE_IMAGE = originalImage;
});

describe('renderComposeYaml', () => {
  test('keeps the pullable upstream image as the default behavior', () => {
    delete process.env.KLOGE_IMAGE;
    const yaml = renderComposeYaml(8317);

    expect(yaml).toContain(`    image: ${DEFAULT_IMAGE}`);
    expect(yaml).toContain('    pull_policy: always');
    expect(yaml).not.toContain('--local-model');
    expect(yaml).not.toContain('    command:');
    expect(composeUsesPatchedImage(yaml)).toBe(false);
  });

  test('uses the local image without pulling and preserves the binary command', () => {
    process.env.KLOGE_IMAGE = PATCHED_IMAGE;
    const configBefore = renderConfigYaml(8399);
    const yaml = renderComposeYaml(8399);

    expect(yaml).toContain(`    image: ${PATCHED_IMAGE}`);
    expect(yaml).toContain('    pull_policy: never');
    expect(yaml).toContain('    command:');
    expect(yaml).toContain('      - ./CLIProxyAPI');
    expect(yaml).toContain('      - --local-model');
    expect(yaml).toContain('      - "127.0.0.1:8399:8399"');
    expect(yaml).not.toContain('    pull_policy: always');
    expect(renderConfigYaml(8399)).toBe(configBefore);
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
});
