import { describe, expect, test } from 'bun:test';
import { createPaths } from './paths';
import { TerminalService, type TerminalServiceClock } from './terminal-service';
import type { TerminalOutputAttachment, TerminalRuntime, TerminalRuntimeRecord } from './terminal-runtime';
import type { TerminalSize } from './terminal-types';

const encoder = new TextEncoder();

class FakeRuntime implements TerminalRuntime {
  records = new Map<string, TerminalRuntimeRecord>();
  relays = new Map<string, { data: (bytes: Uint8Array) => void; exit: (error?: Error) => void }>();
  writes: Array<{ id: string; text: string }> = [];
  resizes: Array<{ id: string; size: TerminalSize }> = [];
  killed: string[] = [];
  detached = 0;
  captureCalls = 0;
  captureHook?: (record: TerminalRuntimeRecord, call: number) => Promise<Uint8Array>;
  attachGate?: Promise<void>;

  async list(): Promise<TerminalRuntimeRecord[]> {
    return [...this.records.values()];
  }

  async create(
    owner: string,
    id: string,
    title: string,
    cwd: string,
    size: TerminalSize,
  ): Promise<TerminalRuntimeRecord> {
    const now = 100_000;
    const record = {
      owner,
      id,
      title,
      root: cwd,
      tmuxSession: `fake-${owner}-${id}`,
      createdAt: now,
      lastActivityAt: now,
      ...size,
    };
    this.records.set(id, record);
    return record;
  }

  async rename(record: TerminalRuntimeRecord, title: string): Promise<void> {
    record.title = title;
  }

  async resize(record: TerminalRuntimeRecord, size: TerminalSize): Promise<void> {
    this.resizes.push({ id: record.id, size });
    Object.assign(record, size);
  }

  async write(record: TerminalRuntimeRecord, bytes: Uint8Array): Promise<void> {
    this.writes.push({ id: record.id, text: new TextDecoder().decode(bytes) });
  }

  async capture(record: TerminalRuntimeRecord): Promise<Uint8Array> {
    this.captureCalls++;
    if (this.captureHook) return await this.captureHook(record, this.captureCalls);
    return encoder.encode(`snapshot:${record.id}`);
  }

  async attachOutput(
    record: TerminalRuntimeRecord,
    onData: (bytes: Uint8Array) => void,
    onExit: (error?: Error) => void,
  ): Promise<TerminalOutputAttachment> {
    this.relays.set(record.id, { data: onData, exit: onExit });
    await this.attachGate;
    return {
      detach: async () => {
        this.detached++;
        this.relays.delete(record.id);
      },
    };
  }

  async kill(record: TerminalRuntimeRecord): Promise<void> {
    this.killed.push(record.id);
    this.records.delete(record.id);
  }

  emit(id: string, text: string): void {
    this.relays.get(id)?.data(encoder.encode(text));
  }
}

class FakeClock implements TerminalServiceClock {
  value = 100_000;
  intervals: Array<() => void> = [];
  now = () => this.value;
  setInterval = (callback: () => void) => {
    this.intervals.push(callback);
    return callback;
  };
  clearInterval = () => undefined;
}

function fixture(options: { perSession?: number; global?: number; idle?: number } = {}) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock();
  const service = new TerminalService(
    createPaths('/tmp/kteam-web-terminal-tests'),
    {
      resolve: async ref =>
        ref === 'teammate' || ref === 'ms-test'
          ? { id: 'ms-test', cwd: '/repo/worktree' }
          : ref === 'ms-other'
            ? { id: 'ms-other', cwd: '/repo/other' }
            : undefined,
    },
    {
      runtime,
      clock,
      maximumPerSession: options.perSession,
      maximumGlobal: options.global,
      idleTimeoutMs: options.idle,
    },
  );
  return { service, runtime, clock };
}

describe('TerminalService', () => {
  test('creates independent cwd-rooted shells and serializes lifecycle caps', async () => {
    const { service, runtime } = fixture({ perSession: 2, global: 3 });
    try {
      const results = await Promise.allSettled([
        service.create('teammate'),
        service.create('teammate'),
        service.create('teammate'),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      const list = await service.list('ms-test');
      expect(list.terminals.map(terminal => terminal.title)).toEqual(['Terminal 1', 'Terminal 2']);
      expect([...runtime.records.values()].every(record => record.root === '/repo/worktree')).toBe(true);
      expect(list.limits).toMatchObject({ perSession: 2, global: 3, runningGlobal: 2 });
    } finally {
      await service.close();
    }
  });

  test('discovers tmux survivors after restart and daemon close does not kill them', async () => {
    const { service, runtime } = fixture();
    runtime.records.set('012345abcdef', {
      id: '012345abcdef',
      owner: 'ms-test',
      title: 'Survivor',
      root: '/repo/worktree',
      tmuxSession: 'fake-survivor',
      createdAt: 1_000,
      lastActivityAt: 2_000,
      cols: 90,
      rows: 28,
    });
    expect((await service.list('ms-test')).terminals[0]).toMatchObject({ title: 'Survivor', cols: 90, rows: 28 });
    await service.close();
    expect(runtime.killed).toEqual([]);
    expect(runtime.records.has('012345abcdef')).toBe(true);
  });

  test('rejects restart metadata whose owner is stale or whose root differs from canonical session cwd', async () => {
    const { service, runtime } = fixture();
    runtime.records.set('111111111111', {
      id: '111111111111',
      owner: 'ms-test',
      title: 'Forged root',
      root: '/tmp/not-the-session-root',
      tmuxSession: 'fake-forged-root',
      createdAt: 1_000,
      lastActivityAt: 2_000,
      cols: 80,
      rows: 24,
    });
    runtime.records.set('222222222222', {
      id: '222222222222',
      owner: 'ms-deleted',
      title: 'Stale owner',
      root: '/repo/deleted',
      tmuxSession: 'fake-stale-owner',
      createdAt: 1_000,
      lastActivityAt: 2_000,
      cols: 80,
      rows: 24,
    });
    try {
      const listed = await service.list('ms-test');
      expect(listed.terminals).toEqual([]);
      expect(listed.limits.runningGlobal).toBe(2);
      expect(await service.terminalsUnder('/tmp/not-the-session-root')).toEqual([]);
      await expect(service.get('ms-test', '111111111111')).rejects.toThrow('terminal not found');
    } finally {
      await service.close();
    }
  });

  test('counts inaccessible survivors against the global cap and reaps them only after a full distrust grace', async () => {
    const { service, runtime, clock } = fixture({ global: 1, idle: 1_000 });
    runtime.records.set('333333333333', {
      id: '333333333333',
      owner: 'ms-deleted',
      title: 'Orphan',
      root: '/repo/deleted',
      tmuxSession: 'fake-orphan',
      createdAt: 1_000,
      lastActivityAt: 2_000,
      cols: 80,
      rows: 24,
    });
    try {
      expect((await service.list('ms-test')).limits.runningGlobal).toBe(1);
      await expect(service.create('ms-test')).rejects.toThrow('global terminal capacity reached');
      expect(runtime.killed).toEqual([]);
      clock.value += 2_000;
      expect(await service.sweepIdle()).toBe(1);
      expect(runtime.killed).toEqual(['333333333333']);
      expect((await service.list('ms-test')).limits.runningGlobal).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('reattaches with a snapshot, streams ANSI, resizes, writes, renames, and explicitly reaps', async () => {
    const { service, runtime } = fixture();
    try {
      const created = await service.create('ms-test');
      const output: string[] = [];
      const attachment = await service.attachViewer('ms-test', created.id, bytes =>
        output.push(new TextDecoder().decode(bytes)),
      );
      expect(output).toEqual([`snapshot:${created.id}`]);
      runtime.emit(created.id, '\u001b[31mred\u001b[0m');
      expect(output.at(-1)).toBe('\u001b[31mred\u001b[0m');
      await service.write('ms-test', created.id, encoder.encode('echo hello\r'));
      expect(runtime.writes.at(-1)?.text).toBe('echo hello\r');
      await service.resize('ms-test', created.id, 111, 37);
      expect(runtime.resizes.at(-1)?.size).toEqual({ cols: 111, rows: 37 });
      expect((await service.rename('ms-test', created.id, 'Build shell')).title).toBe('Build shell');
      attachment.detach();
      await Bun.sleep(0);
      expect(runtime.detached).toBe(1);
      await service.closeTerminal('ms-test', created.id);
      expect(runtime.killed).toEqual([created.id]);
      expect((await service.list('ms-test')).terminals).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test('idle reaping excludes attached viewers and worktree queries use the immutable root', async () => {
    const { service, runtime, clock } = fixture({ idle: 1_000 });
    try {
      const terminal = await service.create('ms-test');
      expect((await service.terminalsUnder('/repo')).map(item => item.id)).toEqual([terminal.id]);
      expect(await service.terminalsUnder('/somewhere-else')).toEqual([]);
      const attachment = await service.attachViewer('ms-test', terminal.id, () => undefined);
      clock.value += 5_000;
      expect(await service.sweepIdle()).toBe(0);
      attachment.detach();
      await Bun.sleep(0);
      expect(await service.sweepIdle()).toBe(1);
      expect(runtime.killed).toEqual([terminal.id]);
    } finally {
      await service.close();
    }
  });

  test('recaptures across concurrent attach output instead of replaying the same delta twice', async () => {
    const { service, runtime } = fixture();
    try {
      const terminal = await service.create('ms-test');
      let releaseFirst!: (bytes: Uint8Array) => void;
      const firstCapture = new Promise<Uint8Array>(resolve => {
        releaseFirst = resolve;
      });
      runtime.captureHook = async (_record, call) =>
        call === 1 ? await firstCapture : encoder.encode(`snapshot:${terminal.id}:same-output`);
      const output: string[] = [];
      const attaching = service.attachViewer('ms-test', terminal.id, chunk =>
        output.push(new TextDecoder().decode(chunk)),
      );
      while (runtime.captureCalls === 0) await Bun.sleep(0);
      runtime.emit(terminal.id, 'same-output');
      releaseFirst(encoder.encode(`snapshot:${terminal.id}:same-output`));
      const attachment = await attaching;
      expect(runtime.captureCalls).toBe(2);
      expect(output).toEqual([`snapshot:${terminal.id}:same-output`]);
      attachment.detach();
    } finally {
      await service.close();
    }
  });

  test('shutdown waits for and detaches a relay that is still starting', async () => {
    const { service, runtime } = fixture();
    const terminal = await service.create('ms-test');
    let releaseRelay!: () => void;
    runtime.attachGate = new Promise<void>(resolve => {
      releaseRelay = resolve;
    });
    const attaching = service.attachViewer('ms-test', terminal.id, () => undefined).catch(error => error);
    while (!runtime.relays.has(terminal.id)) await Bun.sleep(0);
    const closing = service.close();
    releaseRelay();
    const attachError = await attaching;
    await closing;
    expect(attachError).toBeInstanceOf(Error);
    expect(String(attachError)).toContain('shutting down');
    expect(runtime.detached).toBe(1);
    expect(runtime.relays.has(terminal.id)).toBe(false);
  });

  test('discovery waits for and detaches a relay starting on a vanished terminal', async () => {
    const { service, runtime } = fixture();
    const terminal = await service.create('ms-test');
    let releaseRelay!: () => void;
    runtime.attachGate = new Promise<void>(resolve => {
      releaseRelay = resolve;
    });
    const attaching = service.attachViewer('ms-test', terminal.id, () => undefined).catch(error => error);
    while (!runtime.relays.has(terminal.id)) await Bun.sleep(0);
    runtime.records.delete(terminal.id);
    const listing = service.list('ms-test');
    await Bun.sleep(0);
    releaseRelay();
    const [attachError, listed] = await Promise.all([attaching, listing]);
    expect(attachError).toBeInstanceOf(Error);
    expect(String(attachError)).toContain('terminal not found');
    expect(listed.terminals).toEqual([]);
    expect(runtime.detached).toBe(1);
    expect(runtime.relays.has(terminal.id)).toBe(false);
    await service.close();
  });
});
