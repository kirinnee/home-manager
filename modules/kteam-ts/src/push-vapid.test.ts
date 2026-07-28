import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VapidKeyStore } from './push-vapid';

const roots: string[] = [];
const key = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString('base64url');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function file(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-push-vapid-'));
  roots.push(root);
  const target = path.join(root, 'daemon', 'push-vapid.json');
  await mkdir(path.dirname(target), { recursive: true });
  return target;
}

describe('VapidKeyStore', () => {
  test('generates once on first use, persists mode 0600, and reuses the pair', async () => {
    const target = await file();
    let generated = 0;
    const generate = () => {
      generated += 1;
      return { publicKey: key(65, 1), privateKey: key(32, 2) };
    };
    const first = new VapidKeyStore(target, generate);
    const [publicKey, pair] = await Promise.all([first.publicKey(), first.keys(), first.keys()]);
    expect(publicKey).toBe(key(65, 1));
    expect(pair.privateKey).toBe(key(32, 2));
    expect(generated).toBe(1);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(target))).mode & 0o777).toBe(0o700);

    const second = new VapidKeyStore(target, () => {
      throw new Error('must not rotate a persisted key');
    });
    expect(await second.publicKey()).toBe(key(65, 1));
    expect(JSON.parse(await readFile(target, 'utf8')).privateKey).toBe(key(32, 2));
  });

  test('a corrupt existing file fails closed instead of invalidating subscriptions with a replacement', async () => {
    const target = await file();
    await writeFile(target, '{"publicKey":"broken"}\n', { mode: 0o644 });
    const store = new VapidKeyStore(target, () => ({ publicKey: key(65, 3), privateKey: key(32, 4) }));
    await expect(store.keys()).rejects.toThrow(/persisted VAPID/);
    expect(await readFile(target, 'utf8')).toContain('broken');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });
});
