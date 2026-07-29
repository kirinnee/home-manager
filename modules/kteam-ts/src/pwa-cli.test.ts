import { describe, expect, test } from 'bun:test';
import path from 'node:path';

describe('PWA identity CLI', () => {
  test('registers show and set commands with the validation-facing options', async () => {
    const child = Bun.spawn([process.execPath, 'src/index.ts', 'pwa', '--help'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, NODE_ENV: 'production', KTEAM_TEST_HERMETIC: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(error);
    expect(output).toContain('Usage: kteam pwa');
    expect(output).toContain('show');
    expect(output).toContain('set');

    const setChild = Bun.spawn([process.execPath, 'src/index.ts', 'pwa', 'set', '--help'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, NODE_ENV: 'production', KTEAM_TEST_HERMETIC: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [setCode, setOutput, setError] = await Promise.all([
      setChild.exited,
      new Response(setChild.stdout).text(),
      new Response(setChild.stderr).text(),
    ]);
    if (setCode !== 0) throw new Error(setError);
    expect(setOutput).toContain('--name <name>');
    expect(setOutput).toContain('--icon <icon>');
  });
});
