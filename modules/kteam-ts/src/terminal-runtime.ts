import { createReadStream, type ReadStream } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './io';
import type { KTeamPaths } from './paths';
import { isSafeSessionId } from './pins-store';
import {
  TERMINAL_REATTACH_LINES,
  TERMINAL_SCROLLBACK_LINES,
  TerminalError,
  isTerminalId,
  type TerminalSize,
} from './terminal-types';

const TMUX_PREFIX = 'kteam-webterm-';
const META_OWNER = '@kteam_terminal_owner';
const META_ID = '@kteam_terminal_id';
const META_TITLE = '@kteam_terminal_title';
const META_CREATED = '@kteam_terminal_created_at';
const META_ROOT = '@kteam_terminal_root_b64';
const LIST_SEPARATOR = '\t';
const textEncoder = new TextEncoder();

export interface TerminalRuntimeRecord extends TerminalSize {
  id: string;
  owner: string;
  title: string;
  /** The owning session cwd at creation time, not the shell's mutable `$PWD`. */
  root: string;
  tmuxSession: string;
  createdAt: number;
  /** tmux's own activity clock survives daemon restarts. */
  lastActivityAt: number;
}

export interface TerminalOutputAttachment {
  detach(): Promise<void>;
}

export interface TerminalRuntime {
  list(): Promise<TerminalRuntimeRecord[]>;
  create(owner: string, id: string, title: string, cwd: string, size: TerminalSize): Promise<TerminalRuntimeRecord>;
  rename(record: TerminalRuntimeRecord, title: string): Promise<void>;
  resize(record: TerminalRuntimeRecord, size: TerminalSize): Promise<void>;
  write(record: TerminalRuntimeRecord, bytes: Uint8Array): Promise<void>;
  capture(record: TerminalRuntimeRecord): Promise<Uint8Array>;
  attachOutput(
    record: TerminalRuntimeRecord,
    onData: (bytes: Uint8Array) => void,
    onExit: (error?: Error) => void,
  ): Promise<TerminalOutputAttachment>;
  kill(record: TerminalRuntimeRecord): Promise<void>;
}

function number(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tmuxName(owner: string, id: string): string {
  const stem = owner.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 28) || 'session';
  const hash = Bun.hash(owner).toString(16).replace(/^-/, 'n').slice(-10);
  return `${TMUX_PREFIX}${stem}-${hash}-${id}`.slice(0, 80);
}

function pane(record: TerminalRuntimeRecord): string {
  return `${record.tmuxSession}:0.0`;
}

function exactSession(record: TerminalRuntimeRecord): string {
  // Generated names include an owner hash + random terminal id and are already
  // exact. Some tmux commands (notably set-option) treat the documented `=`
  // exact-match prefix as a literal session name, so do not pass it here.
  return record.tmuxSession;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function dateMillis(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** tmux is the PTY and persistence layer. The daemon only relays bytes. */
export class TmuxTerminalRuntime implements TerminalRuntime {
  constructor(private readonly paths: KTeamPaths) {}

  private terminalDir(owner: string): string {
    return path.join(this.paths.sessions, owner, 'terminals');
  }

  private launcher(owner: string, id: string): string {
    return path.join(this.terminalDir(owner), `${id}.sh`);
  }

  private fifo(owner: string, id: string): string {
    return path.join(this.terminalDir(owner), `${id}.fifo`);
  }

  async list(): Promise<TerminalRuntimeRecord[]> {
    const format = [
      '#{session_name}',
      `#{${META_OWNER}}`,
      `#{${META_ID}}`,
      `#{${META_TITLE}}`,
      `#{${META_CREATED}}`,
      `#{${META_ROOT}}`,
      '#{session_created}',
      '#{session_activity}',
      '#{window_width}',
      '#{window_height}',
    ].join(LIST_SEPARATOR);
    const result = await run(['tmux', 'list-sessions', '-F', format]);
    if (result.code !== 0) {
      if (/no server running|failed to connect|no sessions/i.test(result.stderr)) return [];
      throw new TerminalError('upstream_failed', `tmux list failed: ${result.stderr.trim()}`, 502);
    }
    const records: TerminalRuntimeRecord[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [
        name = '',
        owner = '',
        id = '',
        title = '',
        createdIso = '',
        rootB64 = '',
        createdSeconds = '',
        activitySeconds = '',
        cols = '',
        rows = '',
      ] = line.split(LIST_SEPARATOR);
      if (!name.startsWith(TMUX_PREFIX) || !owner || !isTerminalId(id)) continue;
      let root: string;
      try {
        root = Buffer.from(rootB64, 'base64url').toString('utf8');
      } catch {
        continue;
      }
      if (!root) continue;
      const createdFallback = number(createdSeconds, Date.now() / 1_000) * 1_000;
      records.push({
        id,
        owner,
        title: title || 'Terminal',
        root,
        tmuxSession: name,
        createdAt: dateMillis(createdIso, createdFallback),
        lastActivityAt: number(activitySeconds, createdFallback / 1_000) * 1_000,
        cols: Math.max(1, number(cols, 100)),
        rows: Math.max(1, number(rows, 30)),
      });
    }
    return records;
  }

  async create(
    owner: string,
    id: string,
    title: string,
    cwd: string,
    size: TerminalSize,
  ): Promise<TerminalRuntimeRecord> {
    if (!isSafeSessionId(owner)) throw new TerminalError('bad_request', 'invalid terminal owner', 400);
    if (!isTerminalId(id)) throw new TerminalError('bad_request', 'invalid terminal id', 400);
    if (!path.isAbsolute(cwd)) throw new TerminalError('bad_request', 'terminal cwd must be absolute', 400);
    const name = tmuxName(owner, id);
    const createdAt = Date.now();
    const directory = this.terminalDir(owner);
    const launcher = this.launcher(owner, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(
      launcher,
      [
        '#!/bin/sh',
        '# generated by kteamd for an independent human web terminal',
        'unset KTEAM_SESSION_ID KTEAM_STOP_CAPABILITY KTEAM_TOKEN CLAUDECODE CLAUDE_CODE_CHILD_SESSION',
        `export KTEAM_TERMINAL_SESSION_ID=${shellQuote(owner)}`,
        `export KTEAM_TERMINAL_ID=${shellQuote(id)}`,
        'if [ -n "${SHELL:-}" ] && [ -x "$SHELL" ]; then exec "$SHELL" -l; fi',
        'exec /bin/sh -l',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );

    // Metadata is queued in the same tmux command sequence as creation, so a
    // daemon crash cannot leave an undiscoverable long-lived shell behind.
    const result = await run([
      'tmux',
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      '-x',
      String(size.cols),
      '-y',
      String(size.rows),
      launcher,
      ';',
      'set-option',
      '-t',
      name,
      META_OWNER,
      owner,
      ';',
      'set-option',
      '-t',
      name,
      META_ID,
      id,
      ';',
      'set-option',
      '-t',
      name,
      META_TITLE,
      title,
      ';',
      'set-option',
      '-t',
      name,
      META_CREATED,
      new Date(createdAt).toISOString(),
      ';',
      'set-option',
      '-t',
      name,
      META_ROOT,
      Buffer.from(cwd).toString('base64url'),
      ';',
      'set-window-option',
      '-t',
      `${name}:0`,
      'automatic-rename',
      'off',
      ';',
      'rename-window',
      '-t',
      `${name}:0`,
      'shell',
      ';',
      'set-window-option',
      '-t',
      `${name}:0`,
      'history-limit',
      String(TERMINAL_SCROLLBACK_LINES),
      ';',
      'set-window-option',
      '-t',
      `${name}:0`,
      'window-size',
      'manual',
    ]);
    if (result.code !== 0) {
      // tmux command lists are ordered, not transactional: if a later metadata
      // or window option ever fails, new-session may already have created the
      // shell. Reap that partial session before reporting the failed create.
      await run(['tmux', 'kill-session', '-t', name]).catch(() => undefined);
      await rm(launcher, { force: true }).catch(() => undefined);
      throw new TerminalError('upstream_failed', `failed to create terminal: ${result.stderr.trim()}`, 502);
    }
    return {
      id,
      owner,
      title,
      root: cwd,
      tmuxSession: name,
      createdAt,
      lastActivityAt: createdAt,
      ...size,
    };
  }

  async rename(record: TerminalRuntimeRecord, title: string): Promise<void> {
    const result = await run(['tmux', 'set-option', '-t', exactSession(record), META_TITLE, title]);
    if (result.code !== 0) throw new TerminalError('not_found', 'terminal no longer exists', 404);
  }

  async resize(record: TerminalRuntimeRecord, size: TerminalSize): Promise<void> {
    const result = await run([
      'tmux',
      'resize-window',
      '-t',
      exactSession(record),
      '-x',
      String(size.cols),
      '-y',
      String(size.rows),
    ]);
    if (result.code !== 0) throw new TerminalError('not_found', 'terminal no longer exists', 404);
  }

  async write(record: TerminalRuntimeRecord, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    // xterm supplies the PTY byte stream, not text. `send-keys -H` preserves
    // control bytes (Enter, C-c, escape sequences, bracketed paste) exactly;
    // paste-buffer would rewrite linefeeds and can turn Enter into inert paste.
    // Bound each argv so a large clipboard payload cannot hit exec limits.
    for (let offset = 0; offset < bytes.byteLength; offset += 512) {
      const keys = [...bytes.subarray(offset, offset + 512)].map(byte => byte.toString(16).padStart(2, '0'));
      const sent = await run(['tmux', 'send-keys', '-H', '-t', pane(record), ...keys]);
      if (sent.code !== 0) throw new TerminalError('not_found', 'terminal no longer exists', 404);
    }
  }

  async capture(record: TerminalRuntimeRecord): Promise<Uint8Array> {
    const [capture, cursor] = await Promise.all([
      run(['tmux', 'capture-pane', '-p', '-e', '-S', `-${TERMINAL_REATTACH_LINES}`, '-t', pane(record)]),
      run(['tmux', 'display-message', '-p', '-t', pane(record), '#{cursor_x}\t#{cursor_y}']),
    ]);
    if (capture.code !== 0 || cursor.code !== 0) {
      throw new TerminalError('not_found', 'terminal no longer exists', 404);
    }
    const [xRaw = '0', yRaw = '0'] = cursor.stdout.trim().split('\t');
    const x = Math.max(0, number(xRaw, 0));
    const y = Math.max(0, number(yRaw, 0));
    const paneText = capture.stdout.replace(/\n$/, '').replace(/\n/g, '\r\n');
    // 3J clears stale scrollback during a backpressure resync. On first attach
    // the xterm is empty, so the same self-contained frame serves both cases.
    return textEncoder.encode(`\u001b[3J\u001b[2J\u001b[H${paneText}\u001b[${y + 1};${x + 1}H`);
  }

  async attachOutput(
    record: TerminalRuntimeRecord,
    onData: (bytes: Uint8Array) => void,
    onExit: (error?: Error) => void,
  ): Promise<TerminalOutputAttachment> {
    if (!isSafeSessionId(record.owner) || !isTerminalId(record.id)) {
      throw new TerminalError('bad_request', 'invalid terminal owner or id', 400);
    }
    const fifo = this.fifo(record.owner, record.id);
    await mkdir(path.dirname(fifo), { recursive: true, mode: 0o700 });
    await rm(fifo, { force: true });
    const made = await run(['mkfifo', fifo]);
    if (made.code !== 0)
      throw new TerminalError('upstream_failed', `terminal relay failed: ${made.stderr.trim()}`, 502);
    await chmod(fifo, 0o600);

    let detached = false;
    let finished = false;
    let stream: ReadStream;
    const ready = new Promise<void>((resolve, reject) => {
      stream = createReadStream(fifo);
      stream.once('open', () => resolve());
      stream.once('error', reject);
      stream.on('data', chunk => {
        if (detached) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        onData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      });
      const finish = (error?: Error) => {
        if (detached || finished) return;
        finished = true;
        onExit(error);
      };
      stream.on('end', () => finish());
      stream.on('close', () => finish());
      stream.on('error', error => finish(error));
    });
    const relayCommand = `exec cat > ${shellQuote(fifo).replaceAll('#', '##')}`;
    const piped = await run(['tmux', 'pipe-pane', '-O', '-t', pane(record), relayCommand]);
    if (piped.code !== 0) {
      detached = true;
      stream!.destroy();
      await rm(fifo, { force: true });
      throw new TerminalError('not_found', 'terminal no longer exists', 404);
    }
    try {
      await Promise.race([
        ready,
        Bun.sleep(5_000).then(() => {
          throw new TerminalError('upstream_failed', 'terminal output relay timed out', 502);
        }),
      ]);
    } catch (error) {
      detached = true;
      stream!.destroy();
      await run(['tmux', 'pipe-pane', '-t', pane(record)]).catch(() => undefined);
      await rm(fifo, { force: true });
      throw error;
    }

    return {
      detach: async () => {
        if (detached) return;
        detached = true;
        await run(['tmux', 'pipe-pane', '-t', pane(record)]).catch(() => undefined);
        stream!.destroy();
        await rm(fifo, { force: true }).catch(() => undefined);
      },
    };
  }

  async kill(record: TerminalRuntimeRecord): Promise<void> {
    const result = await run(['tmux', 'kill-session', '-t', exactSession(record)]);
    if (result.code !== 0 && !/can't find session|no server running/i.test(result.stderr)) {
      throw new TerminalError('upstream_failed', `failed to close terminal: ${result.stderr.trim()}`, 502);
    }
    // Discovery can reap a tmux session whose metadata is rejected as forged.
    // Never feed an untrusted owner into path.join: kill the namespaced tmux
    // target, but remove filesystem artifacts only for a canonical-safe owner.
    if (isSafeSessionId(record.owner) && isTerminalId(record.id)) {
      await Promise.all([
        rm(this.fifo(record.owner, record.id), { force: true }).catch(() => undefined),
        rm(this.launcher(record.owner, record.id), { force: true }).catch(() => undefined),
      ]);
    }
  }
}
