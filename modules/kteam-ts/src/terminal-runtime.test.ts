import { expect, test } from 'bun:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from './paths';
import { TmuxTerminalRuntime, type TerminalRuntimeRecord } from './terminal-runtime';

const encoder = new TextEncoder();

test('real tmux runtime persists metadata, streams ANSI, resizes, captures, and reaps the shell', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-webterm-test-'));
  const paths = createPaths(root);
  const runtime = new TmuxTerminalRuntime(paths);
  const owner = `msrt-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  let record: TerminalRuntimeRecord | undefined;
  let attachment: { detach(): Promise<void> } | undefined;
  try {
    await expect(runtime.create('../escape', id, 'Unsafe', root, { cols: 80, rows: 24 })).rejects.toThrow(
      'invalid terminal owner',
    );
    await expect(access(path.join(paths.sessions, '..', 'escape', 'terminals'))).rejects.toBeDefined();
    record = await runtime.create(owner, id, 'Smoke shell', root, { cols: 80, rows: 24 });
    expect((await runtime.list()).find(item => item.id === id)).toMatchObject({
      owner,
      title: 'Smoke shell',
      root,
      cols: 80,
      rows: 24,
    });

    const chunks: Uint8Array[] = [];
    attachment = await runtime.attachOutput(
      record,
      bytes => chunks.push(bytes.slice()),
      () => undefined,
    );
    await runtime.write(record, encoder.encode("printf '\\033[31mwebterm-probe\\033[0m\\n'\r"));
    // The real login shell may source direnv/nix before reading input. Bytes
    // are already queued in its PTY; allow that startup to finish.
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      !Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).includes(Buffer.from('\u001b[31m'))
    ) {
      await Bun.sleep(50);
    }
    const output = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
    expect(output.includes('webterm-probe')).toBe(true);
    expect(output.includes(Buffer.from('\u001b[31m'))).toBe(true);

    await runtime.resize(record, { cols: 96, rows: 31 });
    await runtime.rename(record, 'Renamed shell');
    expect((await runtime.list()).find(item => item.id === id)).toMatchObject({
      title: 'Renamed shell',
      cols: 96,
      rows: 31,
    });
    const snapshot = await runtime.capture(record);
    expect(snapshot[0]).toBe(0x1b);
    expect(Buffer.from(snapshot).includes('webterm-probe')).toBe(true);

    await attachment.detach();
    attachment = undefined;
    await runtime.kill(record);
    expect((await runtime.list()).some(item => item.id === id)).toBe(false);
    record = undefined;
  } finally {
    await attachment?.detach().catch(() => undefined);
    if (record) await runtime.kill(record).catch(() => undefined);
    for (const survivor of (await runtime.list().catch(() => [])).filter(item => item.owner === owner)) {
      await runtime.kill(survivor).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
