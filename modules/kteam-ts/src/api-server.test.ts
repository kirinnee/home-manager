import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RecentRequestIds, startApiServer } from './api-server';
import { currentActor } from './actor-context';
import type { AttachmentView, KTeamService, SessionView, WardenAttentionView } from './service';
import type { KTeamEvent, RuntimeControlRequest, SendRecord, SendRequest, StartSessionRequest } from './types';
import { WARDEN_LABEL } from './warden-detect';
import { FsError, type FsDiffView, type FsFileView, type FsListing } from './fs';
import { GitError, type GitChangesView } from './git';
import type { SttService } from './stt-service';
import { TaskApi, type TaskApiService } from './tasks-api';
import type {
  TaskActionInput,
  TaskActor,
  TaskCreateInput,
  TaskDetailResponse,
  TaskListResponse,
  TaskView as TaskBoardView,
} from './tasks';
import { TerminalApi } from './terminal-api';
import type { TerminalService } from './terminal-service';
import { BrowserApi, BrowserLoginApi, type BrowserLoginStatusView } from './browser-api';
import { BrowserService, type ManagedBrowserRuntime } from './browser-service';
import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  BrowserError,
  type BrowserInputEvent,
  type BrowserScreencastFrame,
  type BrowserViewport,
} from './browser-types';
import { createPaths } from './paths';
import { RuntimeModelsApi } from './runtime-models-api';
import { AttachmentError } from './attachments';

const view: SessionView = {
  directory: '/tmp/kteam/s1',
  config: {
    id: 's1',
    name: 'test',
    binary: 'claude-auto-mm3',
    harness: 'claude',
    modelHint: 'MiniMax M3',
    mode: 'interactive',
    cwd: '/tmp',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    turn: 1,
    harnessSessionId: '00000000-0000-4000-8000-000000000001',
    tmuxSession: 'kteam-s1-agent',
    watcherSession: 'kteam-s1-watch',
    intervalSeconds: 5,
    stallSeconds: 900,
    timeoutSeconds: 3600,
    maxSnapshots: 20,
    systemPromptFile: '/tmp/system',
    originalPromptFile: '/tmp/prompt',
  },
  state: { id: 's1', status: 'awaiting_user', turn: 1 },
};

class FakeService implements KTeamService {
  listeners = new Set<(event: KTeamEvent) => void>();
  event: KTeamEvent = {
    sequence: 1,
    time: '2026-01-01T00:00:00Z',
    sessionId: 's1',
    turn: 1,
    type: 'chat.assistant.text',
    source: 'claude',
    data: { text: 'hello' },
  };
  health = async () => ({ ok: true });
  list = async () => [view];
  get = async () => {
    this.lastActor = currentActor();
    return view;
  };
  suggestNames = async (count = 1) => ['aaron', 'abel', 'abigail'].slice(0, count);
  start = async (_input: StartSessionRequest) => view;
  send = async (_id: string, _input: SendRequest) => {
    this.lastActor = currentActor();
    return { ...view, disposition: 'delivered' as const };
  };
  listSends = async (_id: string, _options?: { all?: boolean }): Promise<SendRecord[]> => [];
  runtime = async (_id: string, _input: RuntimeControlRequest) => view;
  answer = async (_id: string, _toolUseId: string, _labels: string[], _other?: string, _responses?: string[]) => view;
  interrupt = async (_id: string, _expectedToolUseId?: string) => view;
  stop = async () => {
    this.lastActor = currentActor();
    return view;
  };
  resume = async () => view;
  lastMigrate?: { id: string; agent: string; model?: string; allowContextDowngrade?: boolean };
  migrate = async (id: string, agent: string, model?: string, allowContextDowngrade?: boolean) => {
    this.lastMigrate = { id, agent, model, allowContextDowngrade };
    return view;
  };
  rename = async (_id: string, _name?: string, _teammate?: string, _clearParent?: boolean) => view;
  remove = async () => {};
  signal = async () => view;
  wardenMayStop = (_wardenId: string, _targetId: string) => false;
  snapshot = async () => 'pane';
  chatHistory = async () => ({ total: 0, offset: 0, records: [] });
  lastSnapshot = async () => 'pane (cached)';
  logs = async () => 'log';
  replay = async () => [this.event];
  subscribe = (listener: (event: KTeamEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  addAttachment = async (
    _id: string,
    _filename: string,
    _mime: string,
    _bytes: Uint8Array,
  ): Promise<AttachmentView> => ({
    id: 'att_x',
    filename: 'x.png',
    mime: 'image/png',
    size: 8,
    sha256: 'x',
    path: '/tmp/x',
    createdAt: '2026-01-01T00:00:00Z',
  });
  getAttachment = async () => ({
    attachment: await this.addAttachment('s1', 'x.png', 'image/png', new Uint8Array([1, 2])),
    bytes: new Uint8Array([1, 2]),
  });
  fsList = async (_id: string, relativePath?: string): Promise<FsListing> => ({
    root: '/tmp',
    path: relativePath ?? '',
    entries: [],
  });
  fsFile = async (_id: string, relativePath: string, rev?: 'head'): Promise<FsFileView> => ({
    path: relativePath,
    size: 5,
    content: 'hello',
    ...(rev ? { rev } : {}),
  });
  fsChanges = async (): Promise<GitChangesView> => ({ repo: true, branch: 'main', changes: [] });
  fsDiff = async (_id: string, relativePath: string): Promise<FsDiffView> => ({
    path: relativePath,
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    kind: 'tracked',
  });
  wardenStatus = async () => ({
    config: {
      enabled: false,
      wrapper: 'claude-auto-glm52a',
      intervalMinutes: 5,
      unattendedMinutes: 30,
      minSpawnGapMinutes: 60,
      susThinkingSeconds: 900,
      susSubprocessSeconds: 900,
      maxAssignedWardens: 3,
      assignedCooldownMinutes: 30,
      blessMinutes: 15,
    },
    anomalies: [],
    fingerprint: '',
  });
  wardenRun = async (_spawn?: boolean) => ({ sweptAt: '2026-01-01T00:00:00Z', anomalies: [], message: 'no anomalies' });
  lastWardenConfigPatch: Record<string, unknown> | undefined = undefined;
  wardenConfigView = async () => ({
    config: (await this.wardenStatus()).config,
    accounts: [{ wrapper: 'claude-auto-glm52a' }],
    warnings: [],
  });
  updateWardenConfig = async (patch: Record<string, unknown>) => {
    this.lastWardenConfigPatch = patch;
    return this.wardenConfigView();
  };
  wrappers = async () => [
    {
      name: 'claude-auto-loge',
      harness: 'claude' as const,
      mode: 'auto' as const,
      launchable: true,
      modelHint: 'F5/frontier account',
    },
    {
      name: 'claude-loge',
      harness: 'claude' as const,
      mode: 'interactive' as const,
      launchable: false,
      modelHint: 'loge',
    },
  ];
  projects = async () => [
    { name: 'home-manager', path: '/home/u/.config/home-manager', lastActivity: '2026-01-01T00:00:00Z' },
  ];
  lastActor: string | undefined = undefined;
  wardenVerdicts = async () => {
    this.lastActor = currentActor();
    return [
      {
        at: '2026-01-01T00:00:00Z',
        targetSession: 's1',
        teammate: 'lacey',
        verdict: 'killed' as const,
        reason: 'burning tokens with no progress',
        reportPath: '/home/u/.kteam/daemon/warden/reports/2026-01-01T00-00-00-000Z-s1.md',
      },
    ];
  };
  wardenReport = async (p: string) => `# report ${p}\n\nVerdict: KILL\n`;
  scratchPlan = async () => [];
  scratchSweep = async () => ({ sessions: 0, bytes: 0, failures: 0 });
  usage = async () => ({
    at: '2026-01-01T00:00:00Z',
    stale: false,
    accounts: [
      // The session under test runs claude-auto-mm3, so this one is joinable.
      {
        binary: 'claude-auto-mm3',
        fiveHourPercent: 7,
        weeklyPercent: 49,
        fiveHourResetAt: 1784964000363,
        weeklyResetAt: 1785142800363,
        atLimit: false,
        authOk: true,
      },
      // An exhausted account and a logged-out one: both must survive the wire
      // with their distinguishing field intact rather than collapsing to 0%.
      { binary: 'codex-auto-loai', atLimit: true, authOk: true, fiveHourPercent: 100 },
      { binary: 'claude-auto-dsv4p', authOk: false },
    ],
  });
  search = async (query: string, limit = 30) => ({
    query,
    scanned: 7,
    results: query
      ? [
          {
            sessionId: 's1',
            teammate: 'test',
            turn: 2,
            snippet: `… ${query} matched here …`,
            at: '2026-01-01T00:00:00Z',
          },
        ].slice(0, limit)
      : [],
  });
}

const servers: Server<unknown>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('kteam daemon API', () => {
  test('requires authentication and exposes session commands', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    const response = await fetch(`${base}/v1/sessions/s1/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'continue' }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as SessionView).config.id).toBe('s1');
  });

  test('unknown routes 404 with a structured, skew-diagnosable payload (B1)', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };

    // A route the daemon doesn't know (e.g. a command shipped by a newer CLI).
    const res = await fetch(`${base}/v1/does-not-exist`, { method: 'POST', headers: auth });
    expect(res.status).toBe(404);
    // The daemon advertises its version on every response, including errors.
    expect(res.headers.get('x-kteam-version')).toBeTruthy();
    const payload = (await res.json()) as { error?: string; code?: string; method?: string; path?: string };
    // Structured so the CLI can tell this apart from a "no such session" 404 and
    // name the exact route.
    expect(payload.code).toBe('unknown_route');
    expect(payload.method).toBe('POST');
    expect(payload.path).toBe('/v1/does-not-exist');

    // An unmatched sub-path under /v1/sessions/:id takes the same shape.
    const sub = await fetch(`${base}/v1/sessions/s1/bogus-action`, { method: 'POST', headers: auth });
    expect(sub.status).toBe(404);
    expect(((await sub.json()) as { code?: string }).code).toBe('unknown_route');
  });

  test('successful responses advertise the daemon version header (B1)', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer secret' } });
    expect(health.status).toBe(200);
    expect(health.headers.get('x-kteam-version')).toBeTruthy();
    // Text routes (snapshot) carry it too, so the CLI detects skew on any command.
    const snap = await fetch(`${base}/v1/sessions/s1/snapshot?live=true`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(snap.headers.get('x-kteam-version')).toBeTruthy();
  });

  test('uploads and serves document bytes with extraction metadata and safe download headers', async () => {
    const service = new FakeService();
    let uploaded: { filename: string; mime: string; bytes: number[] } | undefined;
    const document: AttachmentView = {
      id: `att_${'a'.repeat(64)}`,
      filename: 'quarterly-report.pdf',
      mime: 'application/pdf',
      size: 5,
      sha256: 'a'.repeat(64),
      path: '/daemon-only/quarterly-report.pdf',
      createdAt: '2026-07-28T12:00:00.000Z',
      textExtraction: {
        method: 'pdfjs',
        characters: 18,
        truncated: false,
        totalPages: 1,
        pagesRead: 1,
      },
    };
    service.addAttachment = async (_id, filename, mime, bytes) => {
      uploaded = { filename, mime, bytes: Array.from(bytes) };
      return document;
    };
    service.getAttachment = async () => ({ attachment: document, bytes: new TextEncoder().encode('%PDF') });
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/attachments`;
    const form = new FormData();
    form.set('file', new File([new TextEncoder().encode('%PDF')], 'quarterly report.pdf', { type: 'application/pdf' }));
    const upload = await fetch(base, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: form,
    });
    expect(upload.status).toBe(201);
    expect((await upload.json()) as AttachmentView).toEqual(document);
    expect(uploaded).toEqual({
      filename: 'quarterly report.pdf',
      mime: 'application/pdf',
      bytes: Array.from(new TextEncoder().encode('%PDF')),
    });

    const download = await fetch(`${base}/${document.id}`, { headers: { authorization: 'Bearer secret' } });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="quarterly-report.pdf"');
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new TextEncoder().encode('%PDF'));
  });

  test('returns retained extraction failures as successful, downloadable attachments', async () => {
    const service = new FakeService();
    const document: AttachmentView = {
      id: `att_${'c'.repeat(64)}`,
      filename: 'scan.pdf',
      mime: 'application/pdf',
      size: 5,
      sha256: 'c'.repeat(64),
      path: '/daemon-only/scan.pdf',
      createdAt: '2026-07-29T01:00:00.000Z',
      textExtractionFailure: {
        code: 'no_extractable_text',
        message: 'PDF has no extractable text; it looks like a scan',
      },
    };
    service.addAttachment = async () => document;
    service.getAttachment = async () => ({ attachment: document, bytes: new TextEncoder().encode('%PDF') });
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const form = new FormData();
    form.set('file', new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }));
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/attachments`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: form,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(document);

    const download = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/attachments/${document.id}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="scan.pdf"');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new TextEncoder().encode('%PDF'));
  });

  test('keeps the hard attachment-size cap as a typed client error', async () => {
    const service = new FakeService();
    service.addAttachment = async () => {
      throw new AttachmentError('attachment_too_large', 'attachment is larger than the 20971520-byte limit');
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const form = new FormData();
    form.set('file', new File(['too large'], 'large.pdf', { type: 'application/pdf' }));
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/attachments`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: form,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'attachment is larger than the 20971520-byte limit',
      code: 'attachment_too_large',
    });
  });

  test('serves the four read-only filesystem routes with their frozen wire shapes', async () => {
    const service = new FakeService();
    let listedPath: string | undefined;
    let fileCall: { path: string; rev?: 'head' } | undefined;
    let diffPath: string | undefined;
    service.fsList = async (_id, relativePath) => {
      listedPath = relativePath;
      return { root: '/tmp', path: relativePath ?? '', entries: [{ name: 'x.ts', type: 'file', size: 5 }] };
    };
    service.fsFile = async (_id, relativePath, rev) => {
      fileCall = { path: relativePath, ...(rev ? { rev } : {}) };
      return { path: relativePath, size: 5, content: 'hello', ...(rev ? { rev } : {}) };
    };
    service.fsDiff = async (_id, relativePath) => {
      diffPath = relativePath;
      return { path: relativePath, diff: '@@ -1 +1 @@\n-old\n+new\n', kind: 'tracked' };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/fs`;
    const auth = { authorization: 'Bearer secret' };

    const listing = await fetch(`${base}?path=src%2Flib`, { headers: auth });
    expect(listing.status).toBe(200);
    expect(listing.headers.get('cache-control')).toBe('no-store');
    expect(((await listing.json()) as FsListing).entries[0]?.name).toBe('x.ts');
    expect(listedPath).toBe('src/lib');

    // URLSearchParams decodes once; the route must not re-animate a doubly
    // encoded traversal token with a second decodeURIComponent call.
    await fetch(`${base}?path=%252e%252e%2Fsafe`, { headers: auth });
    expect(listedPath).toBe('%2e%2e/safe');

    const file = await fetch(`${base}/file?path=docs%2Fguide.md&rev=head`, { headers: auth });
    expect(file.status).toBe(200);
    expect((await file.json()) as FsFileView).toMatchObject({ path: 'docs/guide.md', rev: 'head', content: 'hello' });
    expect(fileCall).toEqual({ path: 'docs/guide.md', rev: 'head' });

    const changes = await fetch(`${base}/changes`, { headers: auth });
    expect(changes.status).toBe(200);
    expect((await changes.json()) as GitChangesView).toMatchObject({ repo: true, branch: 'main', changes: [] });

    const diff = await fetch(`${base}/diff?path=src%2Fx.ts`, { headers: auth });
    expect(diff.status).toBe(200);
    expect(diff.headers.get('content-type')).toContain('text/plain');
    expect(diff.headers.get('cache-control')).toBe('no-store');
    expect(await diff.text()).toContain('+new');
    expect(diffPath).toBe('src/x.ts');
  });

  test('validates filesystem queries and never serves refused or truncated diffs', async () => {
    const service = new FakeService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/fs`;
    const auth = { authorization: 'Bearer secret' };

    // The no-store boundary is per-ROUTE, not per-error-class: these 400s are
    // thrown as HttpError from query validation, and they took the generic
    // json() path before, which left the filesystem surface's stated cache
    // policy with a hole for the next error message added to these routes.
    for (const path of ['/file', '/file?path=x&rev=main', '/diff', '/nope']) {
      const response = await fetch(`${base}${path}`, { headers: auth });
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }

    service.fsDiff = async (_id, path) => ({ path, diff: '', kind: 'none', denied: true, reason: 'denylist' });
    const denied = await fetch(`${base}/diff?path=.env`, { headers: auth });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { code: string }).toMatchObject({ code: 'denied' });

    service.fsDiff = async (_id, path) => ({ path, diff: '', kind: 'none', ignored: true, reason: 'ignored' });
    expect((await fetch(`${base}/diff?path=build%2Fx.js`, { headers: auth })).status).toBe(403);

    service.fsDiff = async (_id, path) => ({ path, diff: 'PARTIAL MUST NOT LEAK', kind: 'tracked', truncated: true });
    const capped = await fetch(`${base}/diff?path=huge.txt`, { headers: auth });
    expect(capped.status).toBe(413);
    expect(await capped.text()).not.toContain('PARTIAL MUST NOT LEAK');

    service.fsList = async () => {
      throw new FsError('invalid_path', 'bad path');
    };
    const invalid = await fetch(`${base}?path=..`, { headers: auth });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as { code: string }).toMatchObject({ code: 'invalid_path' });

    service.fsList = async () => {
      throw new FsError('not_found', 'no such path');
    };
    expect((await fetch(`${base}?path=missing`, { headers: auth })).status).toBe(404);

    service.fsList = async () => {
      throw new FsError('escapes_root', 'path escapes the session root');
    };
    expect((await fetch(`${base}?path=link`, { headers: auth })).status).toBe(403);

    service.fsChanges = async () => {
      throw new GitError('git_timeout', 'git status timed out');
    };
    expect((await fetch(`${base}/changes`, { headers: auth })).status).toBe(504);

    // Every error shape on the surface, one assertion: no-store regardless of
    // which error class produced it.
    service.fsFile = async () => {
      throw new Error('an unclassified failure');
    };
    const generic = await fetch(`${base}/file?path=x`, { headers: auth });
    expect(generic.status).toBe(409);
    expect(generic.headers.get('cache-control')).toBe('no-store');

    // ...and a non-fs route is unaffected: no-store is scoped to `fs`/`fs/*`.
    const other = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/nonsense`, { headers: auth });
    expect(other.status).toBe(404);
    expect(other.headers.get('cache-control')).toBeNull();
  });

  test('exposes wrappers and projects for the New-session flow', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };
    expect((await fetch(`${base}/v1/wrappers`)).status).toBe(401);
    const wr = await fetch(`${base}/v1/wrappers`, { headers: auth });
    expect(wr.status).toBe(200);
    const wrappers = (await wr.json()) as Array<{ name: string; launchable: boolean }>;
    expect(wrappers.some(w => w.name === 'claude-auto-loge' && w.launchable)).toBe(true);
    const pr = await fetch(`${base}/v1/projects`, { headers: auth });
    expect(pr.status).toBe(200);
    expect(((await pr.json()) as Array<{ name: string }>)[0]!.name).toBe('home-manager');
  });

  // GET /v1/usage is the ONLY way the browser can learn account quota: session
  // views carry usage fields only after that session's own 60s monitor tick,
  // so a fleet list built from state alone shows blanks (the "quota is not in
  // the UI" gap). These assertions pin the wire contract the UI joins against.
  test('exposes the account usage feed, keyed by wrapper binary', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/v1/usage`)).status).toBe(401);

    const res = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      at?: string;
      stale: boolean;
      accounts: Array<{
        binary: string;
        fiveHourPercent?: number;
        weeklyPercent?: number;
        fiveHourResetAt?: number;
        weeklyResetAt?: number;
        atLimit?: boolean;
        authOk?: boolean;
      }>;
    };
    expect(body.stale).toBe(false);
    expect(body.at).toBe('2026-01-01T00:00:00Z');

    // Joinable by the binary a session config already carries.
    const mm3 = body.accounts.find(a => a.binary === 'claude-auto-mm3');
    expect(mm3).toBeDefined();
    expect(mm3!.fiveHourPercent).toBe(7);
    expect(mm3!.weeklyPercent).toBe(49);
    expect(mm3!.fiveHourResetAt).toBe(1784964000363);
    expect(mm3!.weeklyResetAt).toBe(1785142800363);
    expect(mm3!.atLimit).toBe(false);
    expect(mm3!.authOk).toBe(true);

    // atLimit survives distinctly from "100%" — it is what blocks work.
    expect(body.accounts.find(a => a.binary === 'codex-auto-loai')!.atLimit).toBe(true);

    // UNKNOWN IS NOT ZERO: a logged-out wrapper reports authOk:false and NO
    // percentages, so the UI can render "auth!" instead of a confident 0%.
    const loggedOut = body.accounts.find(a => a.binary === 'claude-auto-dsv4p')!;
    expect(loggedOut.authOk).toBe(false);
    expect(loggedOut.fiveHourPercent).toBeUndefined();
    expect(loggedOut.weeklyPercent).toBeUndefined();
  });

  test('the warden-scoped token may READ the usage feed', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      wardenToken: 'warden-secret',
      service: new FakeService(),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer warden-secret' } });
    expect(res.status).toBe(200);
  });

  test('exposes transcript search with a scanned count', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };
    const res = await fetch(`${base}/v1/search?q=hello&limit=10`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scanned: number; results: Array<{ sessionId: string; snippet: string }> };
    expect(body.scanned).toBe(7);
    expect(body.results[0]!.sessionId).toBe('s1');
    expect(body.results[0]!.snippet).toContain('hello');
  });

  test('exposes warden verdicts and a report reader', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };
    const vr = await fetch(`${base}/v1/warden/verdicts`, { headers: auth });
    expect(vr.status).toBe(200);
    const verdicts = (await vr.json()) as Array<{ verdict: string; targetSession: string }>;
    expect(verdicts[0]!.verdict).toBe('killed');
    expect(verdicts[0]!.targetSession).toBe('s1');
    const rep = await fetch(`${base}/v1/warden/report?path=/x/y.md`, { headers: auth });
    expect(rep.status).toBe(200);
    expect(await rep.text()).toContain('Verdict: KILL');
    expect((await fetch(`${base}/v1/warden/report`, { headers: auth })).status).toBe(400);
  });

  test('serves the fleet Warden Attention view to an admin', async () => {
    const expected: WardenAttentionView = {
      generatedAt: '2026-01-01T00:00:00Z',
      outcome: 'items',
      items: [
        {
          sessionId: 's1',
          id: 'A1',
          source: 'question',
          subject: 'Choose a migration target',
          why: 'A decision is waiting.',
          waitingSince: '2026-01-01T00:00:00Z',
          howToResolve: 'Reply with the target.',
          judgement: { state: 'none', reason: 'No warden judgement yet.' },
        },
      ],
      boardsWithParseErrors: [],
      verdictCoverage: { limit: 100, truncated: false },
    };
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service: new FakeService(),
      wardenAttention: { view: async () => expected },
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/warden/attention`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });

  test('returns an honest 404 when the Warden Attention provider is absent', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/warden/attention`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'no route GET /v1/warden/attention',
      code: 'unknown_route',
      method: 'GET',
      path: '/v1/warden/attention',
    });
  });

  test('replays history before live WebSocket events', async () => {
    const service = new FakeService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const received: KTeamEvent[] = [];
    const queryOnly = await fetch(`http://127.0.0.1:${server.port}/v1/events?token=secret`);
    expect(queryOnly.status).toBe(401);
    const BunWebSocket = WebSocket as unknown as {
      new (url: string | URL, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(`ws://127.0.0.1:${server.port}/v1/events?sessionId=s1`, {
      headers: { authorization: 'Bearer secret' },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 3000);
      socket.onmessage = message => {
        received.push(JSON.parse(String(message.data)) as KTeamEvent);
        if (received.length === 1) {
          const live = { ...service.event, sequence: 2, type: 'session.running' };
          for (const listener of service.listeners) listener(live);
        } else {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      };
      socket.onerror = () => reject(new Error('websocket error'));
    });
    expect(received.map(event => event.sequence)).toEqual([1, 2]);
  });
  test('serves the browser shell with the daemon token embedded', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    // Served shell is the built dist app when ui-dist exists, else the legacy
    // single-file shell — both must embed the token for loopback requesters,
    // and the dist path must NOT rename the __KTEAM_TOKEN__ global.
    expect(body).toContain('secret');
    expect(body).not.toContain('window.secret');
    expect(body).not.toContain('"__KTEAM_TOKEN__"');
    expect(body).not.toContain("'__KTEAM_TOKEN__'");
  });

  test('rejects malformed action inputs with 400', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const migrate = await fetch(`${base}/v1/sessions/s1/migrate`, { method: 'POST', headers: admin, body: '{}' });
    expect(migrate.status).toBe(400);
    expect(((await migrate.json()) as { error: string }).error).toBe('agent is required');
    const signal = await fetch(`${base}/v1/sessions/s1/signal`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'nope' }),
    });
    expect(signal.status).toBe(400);
    expect(((await signal.json()) as { error: string }).error).toBe('kind must be one of done, help, waiting, working');
  });

  test('migrate carries --allow-context-downgrade through to the daemon payload (B4)', async () => {
    const service = new FakeService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };

    const on = await fetch(`${base}/v1/sessions/s1/migrate`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ agent: 'claude-auto-glm52b', model: 'glm-5.2', allowContextDowngrade: true }),
    });
    expect(on.status).toBe(200);
    expect(service.lastMigrate).toEqual({
      id: 's1',
      agent: 'claude-auto-glm52b',
      model: 'glm-5.2',
      allowContextDowngrade: true,
    });

    // Omitted flag arrives as undefined (not coerced to true) — the daemon
    // keeps its default context-downgrade refusal.
    await fetch(`${base}/v1/sessions/s1/migrate`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ agent: 'claude-auto-glm52b' }),
    });
    expect(service.lastMigrate?.allowContextDowngrade).toBeUndefined();
  });
});

describe('STT API integration', () => {
  function fakeStt() {
    const publicCalls: Array<{ method: string; path: string; range: string | null }> = [];
    const apiCalls: Array<{ method: string; path: string }> = [];
    const service: SttService = {
      status: async () => {
        throw new Error('status is not used by this routing fake');
      },
      handlePublicModel: async (request, url) => {
        publicCalls.push({ method: request.method, path: url.pathname, range: request.headers.get('range') });
        return new Response(request.method === 'HEAD' ? null : 'model-bytes', { status: 200 });
      },
      handleApi: async (request, url) => {
        apiCalls.push({ method: request.method, path: url.pathname });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
      close: async () => {},
    };
    return { service, publicCalls, apiCalls };
  }

  test('public model GET, HEAD, and range requests bypass the SPA and authentication', async () => {
    const stt = fakeStt();
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service: new FakeService(),
      stt: stt.service,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/stt-models/browser-fixture/vocab.txt`)).status).toBe(200);
    expect((await fetch(`${base}/stt-models/browser-fixture/vocab.txt`, { method: 'HEAD' })).status).toBe(200);
    expect(
      (
        await fetch(`${base}/stt-models/browser-fixture/vocab.txt`, {
          headers: { range: 'bytes=0-3' },
        })
      ).status,
    ).toBe(200);
    expect(stt.publicCalls).toEqual([
      { method: 'GET', path: '/stt-models/browser-fixture/vocab.txt', range: null },
      { method: 'HEAD', path: '/stt-models/browser-fixture/vocab.txt', range: null },
      { method: 'GET', path: '/stt-models/browser-fixture/vocab.txt', range: 'bytes=0-3' },
    ]);
  });

  test('authenticated STT calls reach the service while unauthenticated and warden calls do not', async () => {
    const stt = fakeStt();
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      wardenToken: 'warden',
      service: new FakeService(),
      stt: stt.service,
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/stt/status`;

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer warden' } })).status).toBe(403);
    expect((await fetch(url, { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
    expect(stt.apiCalls).toEqual([{ method: 'GET', path: '/v1/stt/status' }]);
  });

  test('omitting STT returns the structured unknown-route response', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const publicResponse = await fetch(`${base}/stt-models/browser-fixture/vocab.txt`);
    expect(publicResponse.status).toBe(404);
    expect(((await publicResponse.json()) as { code?: string }).code).toBe('unknown_route');

    const apiResponse = await fetch(`${base}/v1/stt/status`, { headers: { authorization: 'Bearer secret' } });
    expect(apiResponse.status).toBe(404);
    expect(((await apiResponse.json()) as { code?: string }).code).toBe('unknown_route');
  });
});

describe('send ledger API routes', () => {
  const authenticatedHeaders = (requestId?: string): Record<string, string> => ({
    authorization: 'Bearer secret',
    'content-type': 'application/json',
    ...(requestId !== undefined ? { 'x-kteam-request-id': requestId } : {}),
  });

  const sendRecord = (sendId: string, overrides: Partial<SendRecord> = {}): SendRecord => ({
    v: 1,
    sendId,
    acceptedAt: '2026-01-01T00:00:00.000Z',
    acceptedTurn: 1,
    path: 'direct',
    message: `message for ${sendId}`,
    attachmentIds: [],
    fate: 'accepted',
    ...overrides,
  });

  test('wraps the send ledger response in the exact { sends } envelope', async () => {
    const service = new FakeService();
    const expected = sendRecord('send-envelope');
    const calls: Array<{ id: string; all?: boolean }> = [];
    service.listSends = async (id, options) => {
      calls.push({ id, all: options?.all });
      return [expected];
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/sends`, {
      headers: authenticatedHeaders(),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as unknown;
    expect(payload).toEqual({ sends: [expected] });
    expect(Object.keys(payload as Record<string, unknown>)).toEqual(['sends']);
    expect(calls).toEqual([{ id: 's1', all: false }]);
  });

  test('uses the bounded default send projection and requests full history only for all=1', async () => {
    const service = new FakeService();
    const open = sendRecord('open-send');
    const withdrawn = sendRecord('withdrawn-tombstone', { withdrawn: true });
    const recent = sendRecord('recent-delivered', {
      acceptedAt: '2026-01-01T00:03:00.000Z',
      fate: 'delivered',
      fateAt: '2026-01-01T00:04:00.000Z',
    });
    const auditOnly = sendRecord('older-audit-row', {
      acceptedAt: '2025-12-01T00:00:00.000Z',
      fate: 'delivered',
      fateAt: '2025-12-01T00:01:00.000Z',
    });
    const defaultProjection = [open, withdrawn, recent];
    const fullProjection = [...defaultProjection, auditOnly];
    const calls: Array<{ id: string; all?: boolean }> = [];
    service.listSends = async (id, options) => {
      calls.push({ id, all: options?.all });
      return options?.all ? fullProjection : defaultProjection;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/sends`;

    const defaultResponse = await fetch(base, { headers: authenticatedHeaders() });
    const allResponse = await fetch(`${base}?all=1`, { headers: authenticatedHeaders() });
    expect(defaultResponse.status).toBe(200);
    expect(allResponse.status).toBe(200);
    const defaultPayload = (await defaultResponse.json()) as { sends: SendRecord[] };
    const allPayload = (await allResponse.json()) as { sends: SendRecord[] };

    expect(defaultPayload).toEqual({ sends: defaultProjection });
    expect(allPayload).toEqual({ sends: fullProjection });
    expect(defaultPayload).not.toEqual(allPayload);
    expect(defaultPayload.sends.map(record => record.sendId)).toEqual([
      'open-send',
      'withdrawn-tombstone',
      'recent-delivered',
    ]);
    expect(allPayload.sends.map(record => record.sendId)).toEqual([
      'open-send',
      'withdrawn-tombstone',
      'recent-delivered',
      'older-audit-row',
    ]);
    expect(calls).toEqual([
      { id: 's1', all: false },
      { id: 's1', all: true },
    ]);
  });

  test('propagates a valid request-id header as the recorded send identity', async () => {
    const service = new FakeService();
    const recorded: SendRecord[] = [];
    const forwarded: Array<{ id: string; input: SendRequest }> = [];
    service.send = async (id, input) => {
      forwarded.push({ id, input: { ...input, attachmentIds: [...(input.attachmentIds ?? [])] } });
      recorded.push(
        sendRecord(input.requestId ?? 'server-generated-fallback', {
          message: input.message,
          attachmentIds: [...(input.attachmentIds ?? [])],
        }),
      );
      return { ...view, disposition: 'delivered' as const };
    };
    service.listSends = async () => [...recorded];
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1`;
    const requestId = 'browser_REQ-123_-';

    const response = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authenticatedHeaders(requestId),
      body: JSON.stringify({ message: 'record this identity', attachmentIds: ['att_x'], now: true }),
    });
    expect(response.status).toBe(200);
    expect(forwarded).toEqual([
      {
        id: 's1',
        input: { message: 'record this identity', attachmentIds: ['att_x'], now: true, requestId },
      },
    ]);

    const ledgerResponse = await fetch(`${base}/sends`, { headers: authenticatedHeaders() });
    expect(ledgerResponse.status).toBe(200);
    expect(await ledgerResponse.json()).toEqual({
      sends: [
        sendRecord(requestId, {
          message: 'record this identity',
          attachmentIds: ['att_x'],
        }),
      ],
    });
  });

  test('ignores body requestId and falls back safely for absent or invalid headers', async () => {
    const service = new FakeService();
    const observed: Array<{ forwardedId: string | undefined; recordedId: string }> = [];
    let fallback = 0;
    service.send = async (_id, input) => {
      const recordedId = input.requestId ?? `server_generated_${++fallback}`;
      observed.push({ forwardedId: input.requestId, recordedId });
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/sessions/s1/send`;
    const attempts = [
      { header: 'trusted_header', bodyId: 'body_override_1' },
      { header: undefined, bodyId: 'body_only_2' },
      { header: 'malformed.header', bodyId: 'body_override_3' },
      { header: 'x'.repeat(129), bodyId: 'body_override_4' },
      { header: '', bodyId: 'body_override_5' },
    ];

    for (const [index, attempt] of attempts.entries()) {
      const response = await fetch(url, {
        method: 'POST',
        headers: authenticatedHeaders(attempt.header),
        body: JSON.stringify({ message: `attempt ${index}`, requestId: attempt.bodyId }),
      });
      expect(response.status).toBe(200);
    }

    expect(observed).toEqual([
      { forwardedId: 'trusted_header', recordedId: 'trusted_header' },
      { forwardedId: undefined, recordedId: 'server_generated_1' },
      { forwardedId: undefined, recordedId: 'server_generated_2' },
      { forwardedId: undefined, recordedId: 'server_generated_3' },
      { forwardedId: undefined, recordedId: 'server_generated_4' },
    ]);
    expect(observed.map(send => send.recordedId)).not.toContain('body_override_1');
    expect(observed.map(send => send.recordedId)).not.toContain('body_only_2');
    expect(observed.map(send => send.recordedId)).not.toContain('body_override_3');
    expect(observed.map(send => send.recordedId)).not.toContain('body_override_4');
    expect(observed.map(send => send.recordedId)).not.toContain('body_override_5');
  });

  test('rejects traversal-shaped request-id headers without writing outside channel/', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'kteam-api-send-traversal-'));
    try {
      const sessionDirectory = join(scratch, 'session');
      const channelDirectory = join(sessionDirectory, 'channel');
      const service = new FakeService();
      const forwardedIds: Array<string | undefined> = [];
      let fallback = 0;
      service.send = async (_id, input) => {
        forwardedIds.push(input.requestId);
        const safeId = input.requestId ?? `fallback_${++fallback}`;
        const queuedFile = join(channelDirectory, `queued-${safeId}.md`);
        await mkdir(dirname(queuedFile), { recursive: true });
        await Bun.write(queuedFile, input.message);
        return { ...view, disposition: 'delivered' as const };
      };
      const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
      servers.push(server);
      const url = `http://127.0.0.1:${server.port}/v1/sessions/s1/send`;
      const traversalHeaders = [
        '../../../escaped-session',
        '../../../../escaped-root',
        '../nested/escape',
        '%2e%2e%2f%2e%2e%2fencoded-escape',
        '%252e%252e%252fdouble-encoded-escape',
        '..\\..\\windows-escape',
      ];

      for (const [index, requestId] of traversalHeaders.entries()) {
        const response = await fetch(url, {
          method: 'POST',
          headers: authenticatedHeaders(requestId),
          body: JSON.stringify({ message: `traversal probe ${index}`, requestId: `../../../../body-escape-${index}` }),
        });
        expect(response.status).toBe(200);
      }

      expect((await readdir(scratch)).sort()).toEqual(['session']);
      expect((await readdir(sessionDirectory)).sort()).toEqual(['channel']);
      expect((await readdir(channelDirectory)).sort()).toEqual(
        traversalHeaders.map((_, index) => `queued-fallback_${index + 1}.md`).sort(),
      );
      expect(await Bun.file(join(sessionDirectory, 'escaped-session.md')).exists()).toBe(false);
      expect(await Bun.file(join(scratch, 'escaped-root.md')).exists()).toBe(false);
      expect(forwardedIds).toEqual(traversalHeaders.map(() => undefined));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('request-id idempotency for retried mutations', () => {
  const admin = (requestId?: string) => ({
    authorization: 'Bearer secret',
    'content-type': 'application/json',
    ...(requestId ? { 'x-kteam-request-id': requestId } : {}),
  });

  test('a duplicate request id does not re-apply a send; the current view is returned', async () => {
    const service = new FakeService();
    let sends = 0;
    service.send = async () => {
      sends++;
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/send`, {
        method: 'POST',
        headers: admin('req-1'),
        body: JSON.stringify({ message: 'continue' }),
      });
    const first = await request();
    expect(first.status).toBe(200);
    const retry = await request();
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as SessionView).config.id).toBe('s1');
    expect(sends).toBe(1);
  });

  test('answer requires and forwards the exact structured-question tool id', async () => {
    const service = new FakeService();
    const calls: Array<{ id: string; toolUseId: string; labels: string[] }> = [];
    service.answer = async (id, toolUseId, labels) => {
      calls.push({ id, toolUseId, labels });
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/answer`;

    const missing = await fetch(base, {
      method: 'POST',
      headers: admin('answer-missing-id'),
      body: JSON.stringify({ labels: ['Enable feature'] }),
    });
    expect(missing.status).toBe(400);
    expect(calls).toEqual([]);

    const accepted = await fetch(base, {
      method: 'POST',
      headers: admin('answer-tool-id'),
      body: JSON.stringify({ toolUseId: 'tool-A', labels: ['Enable feature'] }),
    });
    expect(accepted.status).toBe(200);
    expect(calls).toEqual([{ id: 's1', toolUseId: 'tool-A', labels: ['Enable feature'] }]);
  });

  test('duplicate abandon/interrupt request ids do not send Escape twice', async () => {
    const service = new FakeService();
    let interrupts = 0;
    service.interrupt = async () => {
      interrupts++;
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/interrupt`, {
        method: 'POST',
        headers: admin('abandon-1'),
        body: '{}',
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(interrupts).toBe(1);
  });

  test('interrupt forwards a bound tool id, and stays generic without one', async () => {
    const service = new FakeService();
    const calls: Array<string | undefined> = [];
    service.interrupt = async (_id, expectedToolUseId) => {
      calls.push(expectedToolUseId);
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/interrupt`;

    // A question-specific web abandon names the question it rendered.
    const bound = await fetch(base, {
      method: 'POST',
      headers: admin('abandon-bound'),
      body: JSON.stringify({ toolUseId: 'tool-A' }),
    });
    expect(bound.status).toBe(200);

    // The composer/CLI interrupt sends `{}` and means "whatever is running".
    const generic = await fetch(base, { method: 'POST', headers: admin('interrupt-generic'), body: '{}' });
    expect(generic.status).toBe(200);

    // A bodyless POST is still the generic interrupt, not a 400.
    const bodyless = await fetch(base, { method: 'POST', headers: admin('interrupt-bodyless') });
    expect(bodyless.status).toBe(200);

    expect(calls).toEqual(['tool-A', undefined, undefined]);

    // An unusable binding is refused rather than silently downgraded to generic.
    const blank = await fetch(base, {
      method: 'POST',
      headers: admin('abandon-blank'),
      body: JSON.stringify({ toolUseId: '  ' }),
    });
    expect(blank.status).toBe(400);
    expect(calls).toHaveLength(3);

    const nonObject = await fetch(base, {
      method: 'POST',
      headers: admin('abandon-non-object'),
      body: JSON.stringify('tool-A'),
    });
    expect(nonObject.status).toBe(400);
    expect(calls).toHaveLength(3);
  });

  test('a duplicate effort request id applies the native control only once', async () => {
    const service = new FakeService();
    let controls = 0;
    service.runtime = async () => {
      controls++;
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/runtime`, {
        method: 'POST',
        headers: admin('runtime-gesture-1'),
        body: JSON.stringify({ action: 'effort', effort: 'high' }),
      });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(controls).toBe(1);
  });

  test('runtime endpoint dispatches the compact session command', async () => {
    const service = new FakeService();
    const seen: string[] = [];
    service.runtime = async (_id, input) => {
      seen.push(input.action);
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const post = (action: string, id: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/runtime`, {
        method: 'POST',
        headers: admin(id),
        body: JSON.stringify({ action }),
      });

    expect((await post('compact', 'rt-compact')).status).toBe(200);
    expect(seen).toEqual(['compact']);
  });

  test('runtime endpoint rejects arbitrary native-command actions', async () => {
    const service = new FakeService();
    let controls = 0;
    service.runtime = async () => {
      controls++;
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/runtime`, {
      method: 'POST',
      headers: admin('runtime-invalid'),
      body: JSON.stringify({ action: 'send-keys', command: '/status' }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('runtime action');
    expect(controls).toBe(0);
  });

  test('in-session runtime control is human-admin-only before body parsing or mutation', async () => {
    const service = new FakeService();
    let controls = 0;
    service.runtime = async () => {
      controls++;
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/s1/runtime?actor=admin-ui`;

    const peer = await fetch(base, {
      method: 'POST',
      headers: { ...admin('runtime-peer'), 'x-kteam-session-id': 'peer-session' },
      body: JSON.stringify({ action: 'model', model: 'opus', actor: 'admin-ui' }),
    });
    expect(peer.status).toBe(403);
    expect(await peer.json()).toEqual({
      error: 'in-session runtime control requires the human admin token',
      code: 'forbidden',
    });

    const malformedPeer = await fetch(base, {
      method: 'POST',
      headers: { ...admin('runtime-malformed'), 'x-kteam-session-id': 'peer-session' },
      body: 'not json',
    });
    expect(malformedPeer.status).toBe(403);
    expect(controls).toBe(0);

    const browser = await fetch(base, {
      method: 'POST',
      headers: admin('runtime-peer'),
      body: JSON.stringify({ action: 'model', model: 'opus' }),
    });
    expect(browser.status).toBe(200);

    const cli = await fetch(base, {
      method: 'POST',
      headers: { ...admin('runtime-cli'), 'x-kteam-client': 'cli' },
      body: JSON.stringify({ action: 'model', model: 'opus' }),
    });
    expect(cli.status).toBe(200);
    expect(controls).toBe(2);
  });

  test('mounts the session-scoped runtime model catalog with its real wire shape', async () => {
    const requested: string[] = [];
    const runtimeModels = new RuntimeModelsApi({
      runtimeModels: async id => {
        requested.push(id);
        return {
          harness: 'claude',
          source: 'wrapper-inventory',
          choices: [{ value: 'opus', label: 'Opus 5 · 1M', reasoningEfforts: [] }],
        };
      },
    });
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service: new FakeService(),
      runtimeModels,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const response = await fetch(`${base}/v1/sessions/s1/runtime-models`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      harness: 'claude',
      source: 'wrapper-inventory',
      choices: [{ value: 'opus', label: 'Opus 5 · 1M', reasoningEfforts: [] }],
    });
    expect(requested).toEqual(['s1']);

    // resolveApiActor() turns an in-pane admin-token call into a peer actor;
    // query/body fields cannot promote it back to a human admin.
    const peer = await fetch(`${base}/v1/sessions/s1/runtime-models?actor=admin-ui`, {
      headers: { authorization: 'Bearer secret', 'x-kteam-session-id': 'peer-session' },
    });
    expect(peer.status).toBe(403);
    expect(requested).toEqual(['s1']);
  });

  test('runtime model route rejects traversal-shaped ids and unsupported methods before catalog access', async () => {
    let calls = 0;
    const runtimeModels = new RuntimeModelsApi({
      runtimeModels: async () => {
        calls++;
        return { harness: 'codex', source: 'codex-app-server', choices: [] };
      },
    });
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service: new FakeService(),
      runtimeModels,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: 'Bearer secret' };

    for (const encoded of ['..%2Fsecret', 'session%2Fodd', '%2Ehidden', 'bad%ZZ']) {
      const response = await fetch(`${base}/v1/sessions/${encoded}/runtime-models`, { headers });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code?: string }).code).toBe('unknown_route');
    }
    expect(calls).toBe(0);

    const wrongMethod = await fetch(`${base}/v1/sessions/s1/runtime-models`, { method: 'POST', headers });
    expect(wrongMethod.status).toBe(405);
    expect(calls).toBe(0);
  });

  test('distinct request ids and id-less requests both apply', async () => {
    const service = new FakeService();
    let sends = 0;
    service.send = async () => {
      sends++;
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const body = JSON.stringify({ message: 'continue' });
    await fetch(`${base}/v1/sessions/s1/send`, { method: 'POST', headers: admin('req-a'), body });
    await fetch(`${base}/v1/sessions/s1/send`, { method: 'POST', headers: admin('req-b'), body });
    await fetch(`${base}/v1/sessions/s1/send`, { method: 'POST', headers: admin(), body });
    expect(sends).toBe(3);
  });

  test('a failed attempt stays retryable under the same id', async () => {
    const service = new FakeService();
    let calls = 0;
    service.resume = async () => {
      calls++;
      if (calls === 1) throw new Error('session is already running');
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/resume`, {
        method: 'POST',
        headers: admin('req-r'),
        body: '{}',
      });
    expect((await request()).status).toBe(409);
    expect((await request()).status).toBe(200);
    expect(calls).toBe(2);
  });

  test('a concurrent duplicate shares the in-flight application instead of re-applying', async () => {
    const service = new FakeService();
    let sends = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    service.send = async () => {
      sends++;
      await gate; // hold the first application open until both requests are in flight
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/send`, {
        method: 'POST',
        headers: admin('req-dup'),
        body: JSON.stringify({ message: 'continue' }),
      });
    const first = request();
    const second = request();
    // Both requests are on the wire while service.send is still pending — the
    // exact socket-retry overlap G3 exists for. Only one application may run.
    await Bun.sleep(50);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sends).toBe(1);
    // And a later retry of the same id still answers from the recorded window.
    expect((await request()).status).toBe(200);
    expect(sends).toBe(1);
  });

  test('RecentRequestIds evicts oldest ids beyond capacity, per session', () => {
    const lru = new RecentRequestIds(2);
    lru.record('s1', 'a');
    lru.record('s1', 'b');
    lru.record('s1', 'c');
    expect(lru.seen('s1', 'a')).toBe(false);
    expect(lru.seen('s1', 'b')).toBe(true);
    expect(lru.seen('s1', 'c')).toBe(true);
    // Sessions do not share windows.
    expect(lru.seen('s2', 'b')).toBe(false);
    lru.record('s2', 'b');
    expect(lru.seen('s2', 'b')).toBe(true);
    expect(lru.seen('s1', 'b')).toBe(true);
  });

  test('a seen() hit promotes the id — an actively retried id outlives colder ones', () => {
    const lru = new RecentRequestIds(2);
    lru.record('s1', 'a');
    lru.record('s1', 'b');
    expect(lru.seen('s1', 'a')).toBe(true); // promote a over b
    lru.record('s1', 'c'); // evicts b (now coldest), not a
    expect(lru.seen('s1', 'a')).toBe(true);
    expect(lru.seen('s1', 'b')).toBe(false);
    expect(lru.seen('s1', 'c')).toBe(true);
  });
});

describe('web terminal API integration', () => {
  const terminalId = '012345abcdef';

  class FakeTerminalService {
    readonly terminal = {
      id: terminalId,
      sessionId: 's1',
      title: 'Terminal 1',
      state: 'running' as const,
      cols: 80,
      rows: 24,
      viewers: 0,
      createdAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2026-01-01T00:00:00Z',
    };
    readonly resolveCalls: string[] = [];
    readonly writes: string[] = [];
    lastCreate?: { sessionRef: string; options: { title?: unknown; cols?: number; rows?: number } };
    private viewer?: (bytes: Uint8Array) => void;

    resolveSession = async (ref: string) => {
      this.resolveCalls.push(ref);
      if (ref !== 's1') throw new Error(`unknown kteam session: ${ref}`);
      return { id: 's1', cwd: '/tmp/session-one' };
    };

    list = async (sessionRef: string) => ({
      sessionId: sessionRef,
      terminals: [this.terminal],
      limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 3600, scrollbackLines: 5000 },
    });

    create = async (sessionRef: string, options: { title?: unknown; cols?: number; rows?: number } = {}) => {
      this.lastCreate = { sessionRef, options };
      return this.terminal;
    };

    get = async (_sessionRef: string, _terminalId: string) => this.terminal;
    rename = async (_sessionRef: string, _terminalId: string, title: unknown) => ({
      ...this.terminal,
      title: String(title),
    });
    closeTerminal = async () => undefined;

    attachViewer = async (sessionRef: string, attachedTerminalId: string, onData: (bytes: Uint8Array) => void) => {
      await this.get(sessionRef, attachedTerminalId);
      this.viewer = onData;
      onData(new TextEncoder().encode('stream-ready\n'));
      return {
        id: 'viewer-1',
        detach: () => {
          this.viewer = undefined;
        },
      };
    };

    write = async (_sessionRef: string, _terminalId: string, bytes: Uint8Array) => {
      const value = Buffer.from(bytes).toString('utf8');
      this.writes.push(value);
      this.viewer?.(new TextEncoder().encode(`terminal-output:${value}`));
    };

    resize = async () => ({ cols: 80, rows: 24 });
    snapshot = async () => new TextEncoder().encode('snapshot\n');
  }

  function terminalServer(terminalService: FakeTerminalService, wardenToken?: string) {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      ...(wardenToken ? { wardenToken } : {}),
      service: new FakeService(),
      terminals: new TerminalApi(terminalService as unknown as TerminalService),
    });
    servers.push(server);
    return { server, base: `http://127.0.0.1:${server.port}` };
  }

  test('mounts HTTP routes before generic session actions and enforces resolved admin actors', async () => {
    const terminals = new FakeTerminalService();
    const { base } = terminalServer(terminals, 'warden');
    const admin = { authorization: 'Bearer secret' };

    const listed = await fetch(`${base}/v1/sessions/s1/terminals`, { headers: admin });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ sessionId: 's1', terminals: [{ id: terminalId }] });

    const created = await fetch(`${base}/v1/sessions/s1/terminals`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Build', cols: 100, rows: 35 }),
    });
    expect(created.status).toBe(201);
    expect(terminals.lastCreate).toEqual({
      sessionRef: 's1',
      options: { title: 'Build', cols: 100, rows: 35 },
    });

    const peer = await fetch(`${base}/v1/sessions/s1/terminals`, {
      headers: { ...admin, 'x-kteam-session-id': 'peer-session' },
    });
    expect(peer.status).toBe(403);
    expect(await peer.json()).toMatchObject({ code: 'forbidden' });

    for (const path of ['/v1/sessions/s1/terminals', `/v1/sessions/s1/terminals/${terminalId}/stream`]) {
      const denied = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer warden' } });
      expect(denied.status).toBe(403);
    }

    const callsBeforeTraversal = terminals.resolveCalls.length;
    const traversal = await fetch(`${base}/v1/sessions/..%2Fsecret/terminals`, { headers: admin });
    expect(traversal.status).toBe(404);
    expect(terminals.resolveCalls).toHaveLength(callsBeforeTraversal);
  });

  test('upgrades the terminal stream with query-token auth and carries binary shell bytes both ways', async () => {
    const terminals = new FakeTerminalService();
    const { server } = terminalServer(terminals);
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/v1/sessions/s1/terminals/${terminalId}/stream?token=secret`,
    );
    socket.binaryType = 'arraybuffer';

    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('terminal websocket timeout')), 3000);
      let sent = false;
      socket.onmessage = message => {
        const chunk =
          typeof message.data === 'string' ? message.data : Buffer.from(message.data as ArrayBuffer).toString('utf8');
        received.push(chunk);
        if (!sent && received.join('').includes('stream-ready')) {
          sent = true;
          socket.send(new TextEncoder().encode('probe\r'));
        }
        if (received.join('').includes('terminal-output:probe')) {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('terminal websocket error'));
      };
    });

    expect(received.join('')).toContain('stream-ready');
    expect(received.join('')).toContain('terminal-output:probe');
    expect(terminals.writes).toEqual(['probe\r']);
  });
});

describe('remote browser API integration', () => {
  class FakeBrowserRuntime implements ManagedBrowserRuntime {
    viewport: BrowserViewport = { width: 1280, height: 800 };
    inputs: BrowserInputEvent[] = [];
    listener?: (frame: BrowserScreencastFrame) => void;
    private pages = [{ id: 'page-1', url: 'about:blank', title: '' }];
    private activePageId = 'page-1';

    private snapshot() {
      const active = this.pages.find(page => page.id === this.activePageId)!;
      return {
        url: active.url,
        title: active.title,
        pages: this.pages.map(page => ({ ...page })),
        activePageId: active.id,
        pageState: 'ready' as const,
        canGoBack: false,
        canGoForward: false,
      };
    }

    private actionSnapshot(actedPageId = this.activePageId) {
      return { ...this.snapshot(), actedPageId };
    }

    async resize(viewport: BrowserViewport) {
      this.viewport = viewport;
      return this.actionSnapshot();
    }
    async navigate(url: string) {
      const active = this.pages.find(page => page.id === this.activePageId)!;
      active.url = url;
      active.title = 'Browser fixture';
      return this.actionSnapshot();
    }
    async click() {
      return this.actionSnapshot();
    }
    async type() {
      return this.actionSnapshot();
    }
    async read() {
      return { ...this.actionSnapshot(), text: 'fixture page' };
    }
    async screenshot() {
      return { ...this.actionSnapshot(), screenshotBase64: 'cG5n' };
    }
    async back() {
      const active = this.pages.find(page => page.id === this.activePageId)!;
      active.url = 'https://example.test/back';
      active.title = 'Browser fixture';
      return this.actionSnapshot();
    }
    async forward() {
      const active = this.pages.find(page => page.id === this.activePageId)!;
      active.url = 'https://example.test/forward';
      active.title = 'Browser fixture';
      return this.actionSnapshot();
    }
    async reload() {
      return this.actionSnapshot();
    }
    async location() {
      return this.snapshot();
    }
    async newPage(url = 'about:blank') {
      const id = `page-${this.pages.length + 1}`;
      this.pages.push({ id, url, title: '' });
      this.activePageId = id;
      return this.actionSnapshot(id);
    }
    async activatePage(pageId: string) {
      if (!this.pages.some(page => page.id === pageId)) throw new Error('page not found');
      this.activePageId = pageId;
      return this.actionSnapshot(pageId);
    }
    async closePage(pageId: string) {
      const index = this.pages.findIndex(page => page.id === pageId);
      if (index < 0) throw new Error('page not found');
      this.pages.splice(index, 1);
      if (this.pages.length === 0) this.pages.push({ id: 'page-replacement', url: 'about:blank', title: '' });
      if (this.activePageId === pageId) this.activePageId = this.pages[Math.min(index, this.pages.length - 1)]!.id;
      return this.actionSnapshot(pageId);
    }
    async startScreencast(listener: (frame: BrowserScreencastFrame) => void) {
      this.listener = listener;
      setTimeout(() => {
        if (this.listener === listener) {
          listener({
            dataBase64: Buffer.from('browser-frame').toString('base64'),
            width: this.viewport.width,
            height: this.viewport.height,
            pageId: this.activePageId,
          });
        }
      }, 0);
    }
    async stopScreencast() {
      this.listener = undefined;
    }
    async dispatchInput(input: BrowserInputEvent) {
      this.inputs.push(input);
    }
    async close() {
      this.listener = undefined;
    }
  }

  const browserServices: BrowserService[] = [];
  afterEach(async () => {
    await Promise.allSettled(browserServices.splice(0).map(service => service.close()));
  });

  function browserServer(
    options: {
      runtime?: FakeBrowserRuntime;
      wardenToken?: string;
      launchFailure?: BrowserError;
    } = {},
  ) {
    const runtime = options.runtime ?? new FakeBrowserRuntime();
    const resolveCalls: string[] = [];
    const browserService = new BrowserService(
      createPaths('/tmp/kteam-browser-api-server-test'),
      {
        resolve: async ref => {
          resolveCalls.push(ref);
          return ref === 's1' ? 's1' : undefined;
        },
      },
      {
        runtimeFactory: async () => {
          if (options.launchFailure) throw options.launchFailure;
          return runtime;
        },
      },
    );
    browserServices.push(browserService);
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      ...(options.wardenToken ? { wardenToken: options.wardenToken } : {}),
      service: new FakeService(),
      browser: new BrowserApi(browserService),
    });
    servers.push(server);
    return { server, base: `http://127.0.0.1:${server.port}`, runtime, resolveCalls };
  }

  test('mounts status/start before generic actions and uses only the resolved actor', async () => {
    const { base, resolveCalls } = browserServer({ wardenToken: 'warden' });
    const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };

    const status = await fetch(`${base}/v1/sessions/s1/browser`, { headers: admin });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ sessionId: 's1', state: 'stopped' });

    const started = await fetch(`${base}/v1/sessions/s1/browser`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ action: 'start', actor: 'warden:spoofed' }),
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      status: { sessionId: 's1', state: 'running', lastActor: { kind: 'human', action: 'start' } },
    });

    const owningPeer = await fetch(`${base}/v1/sessions/s1/browser`, {
      headers: { ...admin, 'x-kteam-session-id': 's1' },
    });
    expect(owningPeer.status).toBe(200);
    const otherPeer = await fetch(`${base}/v1/sessions/s1/browser`, {
      headers: { ...admin, 'x-kteam-session-id': 'someone-else' },
    });
    expect(otherPeer.status).toBe(403);

    for (const path of ['/v1/sessions/s1/browser', '/v1/sessions/s1/browser/stream']) {
      const denied = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer warden' } });
      expect(denied.status).toBe(403);
    }

    const callsBeforeTraversal = resolveCalls.length;
    const encodedSeparator = await fetch(`${base}/v1/sessions/..%2Fsecret/browser`, { headers: admin });
    expect(encodedSeparator.status).toBe(404);
    const normalizedEscape = await fetch(`${base}/v1/sessions/s1/browser/%2e%2e/send`, { headers: admin });
    expect(normalizedEscape.status).toBe(404);
    expect(resolveCalls).toHaveLength(callsBeforeTraversal);
  });

  test('carries screencast frames and human input over the mounted WebSocket', async () => {
    const { server, base, runtime } = browserServer();
    const started = await fetch(`${base}/v1/sessions/s1/browser`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    expect(started.status).toBe(200);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/sessions/s1/browser/stream?token=secret`);
    socket.binaryType = 'arraybuffer';
    const frame = await new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('browser websocket timeout')), 3000);
      socket.onopen = () => {
        socket.send(JSON.stringify({ kind: 'insertText', text: 'from-human' }));
      };
      socket.onmessage = message => {
        clearTimeout(timeout);
        resolve(message.data as ArrayBuffer);
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('browser websocket error'));
      };
    });
    const frameBytes = new Uint8Array(frame);
    expect(Buffer.from(frameBytes.subarray(0, 4)).toString('ascii')).toBe('KBRF');
    expect(frameBytes[4]).toBe(1);
    const pageIdLength = new DataView(frame).getUint16(5, false);
    expect(pageIdLength).toBeGreaterThan(0);
    expect(pageIdLength).toBeLessThanOrEqual(BROWSER_MAX_PAGE_ID_LENGTH * 4);
    const jpegOffset = 7 + pageIdLength;
    expect(jpegOffset).toBeLessThan(frameBytes.byteLength);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(frameBytes.subarray(7, jpegOffset))).toBe('page-1');
    expect(Buffer.from(frameBytes.subarray(jpegOffset)).toString('utf8')).toBe('browser-frame');

    for (let attempt = 0; attempt < 20 && runtime.inputs.length === 0; attempt += 1) await Bun.sleep(10);
    expect(runtime.inputs).toEqual([{ kind: 'insertText', text: 'from-human' }]);
    socket.close();
  });

  test('preserves the real launch failure in the response and subsequent status', async () => {
    const missingChrome = new BrowserError(
      'launch_failed',
      'Google Chrome was not found for linux; set KTEAM_CHROME_BIN to its executable',
      503,
    );
    const { base } = browserServer({ launchFailure: missingChrome });
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const start = await fetch(`${base}/v1/sessions/s1/browser`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'start' }),
    });
    expect(start.status).toBe(503);
    expect(await start.json()).toEqual({
      error: missingChrome.message,
      code: 'launch_failed',
    });

    const status = await fetch(`${base}/v1/sessions/s1/browser`, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: 'error', error: missingChrome.message });
  });
});

describe('warden-scoped token authorization', () => {
  const scoped = { authorization: 'Bearer warden', 'content-type': 'application/json' };

  function scopedServer(service: KTeamService = new FakeService()): string {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', wardenToken: 'warden', service });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  test('attributes warden-token requests to the warden actor (admin requests are unattributed)', async () => {
    const service = new FakeService();
    const base = scopedServer(service);
    const r1 = await fetch(`${base}/v1/sessions/s1`, { headers: scoped });
    expect(r1.status).toBe(200);
    expect(service.lastActor).toBe('warden');
    const r2 = await fetch(`${base}/v1/sessions/s1`, { headers: { authorization: 'Bearer secret' } });
    expect(r2.status).toBe(200);
    // An admin-token request with no self-identification headers is the human at
    // the browser UI — attributed 'admin-ui', never unattributed (B6).
    expect(service.lastActor).toBe('admin-ui');
  });

  test('permits reads and the safe-recovery writes', async () => {
    const base = scopedServer();
    expect((await fetch(`${base}/v1/sessions`, { headers: scoped })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions/s1`, { headers: scoped })).status).toBe(200);
    const send = await fetch(`${base}/v1/sessions/s1/send`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ message: 'steer' }),
    });
    expect(send.status).toBe(200);
    const migrate = await fetch(`${base}/v1/sessions/s1/migrate`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ agent: 'claude-auto-glm52b' }),
    });
    expect(migrate.status).toBe(200);
  });

  test('rejects start, stop, interrupt, runtime controls, remove, and the warden oversight routes with 403', async () => {
    const base = scopedServer();
    const post = (path: string) => fetch(`${base}${path}`, { method: 'POST', headers: scoped, body: '{}' });
    expect((await post('/v1/sessions')).status).toBe(403); // start
    expect((await post('/v1/sessions/s1/stop')).status).toBe(403);
    expect((await post('/v1/sessions/s1/interrupt')).status).toBe(403);
    expect((await post('/v1/sessions/s1/runtime')).status).toBe(403);
    expect((await fetch(`${base}/v1/sessions/s1/runtime-models`, { headers: scoped })).status).toBe(403);
    expect((await post('/v1/warden/run')).status).toBe(403);
    expect((await fetch(`${base}/v1/sessions/s1`, { method: 'DELETE', headers: scoped })).status).toBe(403);
    expect((await fetch(`${base}/v1/warden/status`, { headers: scoped })).status).toBe(403);
  });

  test('rejects Warden Attention with the warden-scoped token', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      wardenToken: 'warden',
      service: new FakeService(),
      wardenAttention: {
        view: async () => ({
          generatedAt: '2026-01-01T00:00:00Z',
          outcome: 'no-sweep',
          items: [],
          boardsWithParseErrors: [],
          verdictCoverage: { limit: 100, truncated: false },
        }),
      },
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/warden/attention`, { headers: scoped });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'the warden-scoped token may not use the warden oversight routes' });
  });

  test('rejects every session filesystem read with the warden-scoped token', async () => {
    const base = scopedServer();
    for (const path of [
      '/v1/sessions/s1/fs',
      '/v1/sessions/s1/fs/file?path=README.md',
      '/v1/sessions/s1/fs/changes',
      '/v1/sessions/s1/fs/diff?path=README.md',
    ]) {
      expect((await fetch(`${base}${path}`, { headers: scoped })).status).toBe(403);
    }
  });

  test('an ASSIGNED warden may stop exactly its assigned target, by capability (A6 sus list)', async () => {
    class AssignedService extends FakeService {
      wardenMayStop = (capability: string, targetId: string) => capability === 'cap-secret-9' && targetId === 's1';
    }
    const base = scopedServer(new AssignedService());
    const stop = (target: string, capability?: string) =>
      fetch(`${base}/v1/sessions/${target}/stop`, {
        method: 'POST',
        headers: { ...scoped, ...(capability ? { 'x-kteam-stop-capability': capability } : {}) },
        body: '{}',
      });
    expect((await stop('s1', 'cap-secret-9')).status).toBe(200); // its assignment
    expect((await stop('s1', 'cap-guessed')).status).toBe(403); // wrong capability
    expect((await stop('s1')).status).toBe(403); // no capability at all
    // A client-chosen identity header is NEVER authority (the old spoof hole).
    const spoofed = await fetch(`${base}/v1/sessions/s1/stop`, {
      method: 'POST',
      headers: { ...scoped, 'x-kteam-session-id': 'warden-9' },
      body: '{}',
    });
    expect(spoofed.status).toBe(403);
    // A different target under the same capability stays forbidden.
    expect((await stop('s2', 'cap-secret-9')).status).toBe(403);
  });

  test('signal is gated to warden-labelled sessions only', async () => {
    // Default FakeService session carries no warden label → self-completion denied.
    const unlabelled = scopedServer();
    const denied = await fetch(`${unlabelled}/v1/sessions/s1/signal`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ kind: 'done' }),
    });
    expect(denied.status).toBe(403);

    // A warden-labelled session may signal itself done.
    class WardenLabelledService extends FakeService {
      get = async () => ({ ...view, config: { ...view.config, label: WARDEN_LABEL } }) as SessionView;
    }
    const wardenBase = scopedServer(new WardenLabelledService());
    const allowed = await fetch(`${wardenBase}/v1/sessions/s1/signal`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ kind: 'done' }),
    });
    expect(allowed.status).toBe(200);
  });
});

describe('task API integration', () => {
  const taskView: TaskBoardView = {
    v: 1,
    id: 'F1',
    kind: 'feature',
    title: 'Task API',
    description: 'Wire the daemon route.',
    ask: { text: 'Wire the daemon route.', source: 'session:user#1' },
    clarifications: [],
    workflow: 'quick',
    phase: 'todo',
    dependsOn: [],
    status: 'todo',
    statusReason: null,
    assignee: null,
    repo: '/tmp',
    files: [],
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    createdBy: 'user',
    updatedAt: '2026-07-27T00:00:00.000Z',
    live: {
      assigneeStatus: null,
      assigneeHealth: null,
      assigneeDoneMarker: false,
      assigneeLastActivityAt: null,
      staleness: null,
    },
    blocked: false,
    blockedReason: null,
    blockedSince: null,
    blockedBy: [],
  };

  class CountingTaskService implements TaskApiService {
    creates = 0;
    acts = 0;
    lastCreate: TaskCreateInput | undefined;
    lastAct: (TaskActionInput & TaskActor) | undefined;

    taskList = async (): Promise<TaskListResponse> => ({ tasks: [], parseErrors: 0 });
    taskDetail = async (): Promise<TaskDetailResponse> => ({ task: taskView, activity: [] });
    taskCreate = async (input: TaskCreateInput): Promise<TaskBoardView> => {
      this.creates += 1;
      this.lastCreate = input;
      return taskView;
    };
    taskAct = async (_id: string, input: TaskActionInput & TaskActor): Promise<TaskBoardView> => {
      this.acts += 1;
      this.lastAct = input;
      return taskView;
    };
  }

  function taskServer(
    tasks: CountingTaskService,
    service: KTeamService = new FakeService(),
    wardenToken?: string,
  ): string {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service,
      tasks: new TaskApi(tasks),
      ...(wardenToken ? { wardenToken } : {}),
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  test('one daemon-lifetime TaskApi applies duplicate create and note request ids once', async () => {
    const tasks = new CountingTaskService();
    const base = taskServer(tasks);
    const createBody = {
      kind: 'feature',
      title: 'Task API',
      ask: { text: 'Wire the daemon route.', source: 'session:user#1' },
    };
    const post = (path: string, requestId: string, value: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
          'x-kteam-request-id': requestId,
        },
        body: JSON.stringify(value),
      });

    expect((await post('/v1/tasks', 'create-1', createBody)).status).toBe(201);
    expect((await post('/v1/tasks', 'create-1', createBody)).status).toBe(201);
    expect(tasks.creates).toBe(1);

    expect((await post('/v1/tasks/F1', 'note-1', { action: 'note', text: 'wired' })).status).toBe(200);
    expect((await post('/v1/tasks/F1', 'note-1', { action: 'note', text: 'wired' })).status).toBe(200);
    expect(tasks.acts).toBe(1);
  });

  test('the warden token may read task records but cannot create or mutate them', async () => {
    const tasks = new CountingTaskService();
    const base = taskServer(tasks, new FakeService(), 'warden');
    const headers = { authorization: 'Bearer warden' };

    expect((await fetch(`${base}/v1/tasks`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/tasks/F1`, { headers })).status).toBe(200);
    expect(
      (
        await fetch(`${base}/v1/tasks`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'feature', title: 'forbidden' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/v1/tasks/F1`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'note', text: 'forbidden' }),
        })
      ).status,
    ).toBe(403);
    expect(tasks.creates).toBe(0);
    expect(tasks.acts).toBe(0);
  });

  test('task history attributes panes canonically, humans as user, and ignores body actors', async () => {
    class CallsignedService extends FakeService {
      override get = async () => ({
        ...view,
        config: { ...view.config, id: 's1', teammate: 'lacey' },
      });
    }
    const tasks = new CountingTaskService();
    const base = taskServer(tasks, new CallsignedService());

    const fromPane = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-kteam-session-id': 's1',
      },
      body: JSON.stringify({
        kind: 'feature',
        title: 'Attributed',
        ask: { text: 'Create an attributed task.', source: 'session:user#2' },
        actor: 'forged-session',
        actorName: 'forged-name',
      }),
    });
    expect(fromPane.status).toBe(201);
    expect(tasks.lastCreate?.actor).toBe('s1');
    expect(tasks.lastCreate?.actorName).toBe('lacey');

    const fromHuman = await fetch(`${base}/v1/tasks/F1`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'note', text: 'human note', actor: 'forged', actorName: 'forged' }),
    });
    expect(fromHuman.status).toBe(200);
    expect(tasks.lastAct?.actor).toBe('user');
    expect(tasks.lastAct?.actorName).toBe('user');
  });

  test('malformed task JSON is 400 and unsupported methods use the normal unknown-route 404', async () => {
    const base = taskServer(new CountingTaskService());
    const malformed = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const unsupported = await fetch(`${base}/v1/tasks`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
    });
    expect(unsupported.status).toBe(404);
    expect(((await unsupported.json()) as { code?: string }).code).toBe('unknown_route');
  });
});

describe('actor attribution behind API mutations (B6)', () => {
  function adminServer(service: KTeamService): string {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  test('an admin stop with no self-identification is the human at the web UI', async () => {
    const service = new FakeService();
    const base = adminServer(service);
    const r = await fetch(`${base}/v1/sessions/s1/stop`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(service.lastActor).toBe('admin-ui');
  });

  test('an admin stop carrying x-kteam-client: cli is the human at the CLI', async () => {
    const service = new FakeService();
    const base = adminServer(service);
    const r = await fetch(`${base}/v1/sessions/s1/stop`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'x-kteam-client': 'cli' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(service.lastActor).toBe('admin-cli');
  });

  test('an admin send from inside a teammate pane is attributed to that peer', async () => {
    const service = new FakeService();
    const base = adminServer(service);
    const r = await fetch(`${base}/v1/sessions/s1/send`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-kteam-session-id': 'georgia',
        'x-kteam-client': 'cli',
      },
      body: JSON.stringify({ message: 'steer' }),
    });
    expect(r.status).toBe(200);
    // The session id wins over the client header: this is a teammate, not the lead.
    expect(service.lastActor).toBe('peer:georgia');
  });

  test('an assigned warden stop is attributed to the specific warden by its session id', async () => {
    class AssignedService extends FakeService {
      wardenMayStop = (capability: string, targetId: string) => capability === 'cap-secret-9' && targetId === 's1';
    }
    const service = new AssignedService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', wardenToken: 'warden', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const r = await fetch(`${base}/v1/sessions/s1/stop`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer warden',
        'content-type': 'application/json',
        'x-kteam-stop-capability': 'cap-secret-9',
        'x-kteam-session-id': 'warden-7',
      },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(service.lastActor).toBe('warden:warden-7');
  });
});

describe('create idempotency (exit-143 spawn timeouts, 2026-07-23/24)', () => {
  /** A service that counts starts and hands out a distinct session each time. */
  class CountingStartService extends FakeService {
    starts = 0;
    startDelayMs = 0;
    override start = async (_input: StartSessionRequest) => {
      this.starts += 1;
      const id = `s-${this.starts}`;
      if (this.startDelayMs > 0) await Bun.sleep(this.startDelayMs);
      return { ...view, config: { ...view.config, id }, state: { ...view.state, id } };
    };
    override get = async (...args: unknown[]) => {
      const id = String(args[0] ?? 's1');
      return { ...view, config: { ...view.config, id }, state: { ...view.state, id } };
    };
  }

  const post = (base: string, requestId?: string) =>
    fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        ...(requestId ? { 'x-kteam-request-id': requestId } : {}),
      },
      body: JSON.stringify({ prompt: 'go', agent: 'claude-auto-atomi' }),
    });

  test('a retry carrying the same request id returns the FIRST session, not a second one', async () => {
    const service = new CountingStartService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const first = (await (await post(base, 'req-1')).json()) as SessionView;
    const retry = (await (await post(base, 'req-1')).json()) as SessionView;
    expect(service.starts).toBe(1);
    expect(retry.config.id).toBe(first.config.id);
    // A different request id is a genuinely different start.
    await post(base, 'req-2');
    expect(service.starts).toBe(2);
  });

  test('a retry that OVERLAPS the first attempt shares it instead of launching twice', async () => {
    const service = new CountingStartService();
    service.startDelayMs = 60;
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const [a, b] = await Promise.all([post(base, 'req-overlap'), post(base, 'req-overlap')]);
    const [first, second] = (await Promise.all([a.json(), b.json()])) as SessionView[];
    expect(service.starts).toBe(1);
    expect(second!.config.id).toBe(first!.config.id);
  });

  test('by-request resolves the session a caller never got a response for', async () => {
    const service = new CountingStartService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const created = (await (await post(base, 'req-lost')).json()) as SessionView;
    // The lookup is keyed by request id AND payload, exactly like the create.
    const payload = Bun.hash(JSON.stringify({ prompt: 'go', agent: 'claude-auto-atomi' })).toString(16);

    const found = await fetch(`${base}/v1/sessions/by-request/req-lost?payload=${payload}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(found.status).toBe(200);
    expect(((await found.json()) as SessionView).config.id).toBe(created.config.id);

    const missing = await fetch(`${base}/v1/sessions/by-request/req-never-sent?payload=${payload}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(missing.status).toBe(404);

    // Same id, DIFFERENT task: the lookup must never hand back the first
    // session (an exported KTEAM_REQUEST_ID would otherwise silently alias
    // every start in a shell to the first one).
    const other = Bun.hash(JSON.stringify({ prompt: 'something else' })).toString(16);
    const wrong = await fetch(`${base}/v1/sessions/by-request/req-lost?payload=${other}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(wrong.status).toBe(404);
    expect(service.starts).toBe(1);
  });
});

describe('the human browser login window, mounted (#B31)', () => {
  /** Structural stand-in for browser-login.ts: the route must be provable
   *  without Chrome, x11vnc, or the shared profile lease. */
  class Lifecycle {
    calls: string[] = [];
    open: BrowserLoginStatusView = {
      state: 'open',
      profilePrimed: false,
      openedAt: '2026-07-28T23:10:00.000Z',
      expiresAt: '2026-07-28T23:25:00.000Z',
      connection: {
        host: '127.0.0.1',
        port: 5951,
        password: 'Sq7fXk2p',
        sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 kirin@box',
      },
    };
    async status() {
      this.calls.push('status');
      return this.open;
    }
    async start(options: { minutes?: number }) {
      this.calls.push(`start:${options.minutes ?? 'default'}`);
      return this.open;
    }
    async stop(options: { primed?: boolean }) {
      this.calls.push(`stop:${options.primed === undefined ? 'default' : options.primed}`);
      return { state: 'closed' as const, profilePrimed: options.primed === true };
    }
    async confirm() {
      this.calls.push('confirm');
      return { ...this.open, profilePrimed: true };
    }
  }

  function loginServer() {
    const lifecycle = new Lifecycle();
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      wardenToken: 'warden',
      service: new FakeService(),
      browserLogin: new BrowserLoginApi(lifecycle),
    });
    servers.push(server);
    return { lifecycle, base: `http://127.0.0.1:${server.port}` };
  }

  const LOGIN = '/v1/browser/login';
  const json = { 'content-type': 'application/json' };

  // THE REGRESSION TEST FOR THE LIVE GAP, against a REAL server rather than the
  // helper. `browserWardenDenial` being right is not proof that api-server calls
  // it ABOVE its generic `if (method === 'GET') return undefined` allowance —
  // and that ordering is the entire fix. GET is the dangerous verb here: it is
  // what would have handed a warden the live VNC port and password.
  test('a warden-scoped token is 403 on GET, start, and stop — and reaches no lifecycle', async () => {
    const { lifecycle, base } = loginServer();
    const warden = { authorization: 'Bearer warden' };

    const read = await fetch(`${base}${LOGIN}`, { headers: warden });
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: string }).error).toContain('human browser login window');

    for (const action of ['start', 'stop'] as const) {
      const denied = await fetch(`${base}${LOGIN}`, {
        method: 'POST',
        headers: { ...warden, ...json },
        body: JSON.stringify({ action }),
      });
      expect(denied.status).toBe(403);
    }
    // Denied at the gate: the window was never asked about, let alone opened.
    expect(lifecycle.calls).toEqual([]);
  });

  // The warden gate never sees this caller. A peer presents the SAME shared
  // admin bearer the human does; only the server-resolved actor separates them.
  test('a peer holding the shared admin bearer is 403 on every verb', async () => {
    const { lifecycle, base } = loginServer();
    const peer = { authorization: 'Bearer secret', 'x-kteam-session-id': 'ms59odix-781028bb' };

    expect((await fetch(`${base}${LOGIN}`, { headers: peer })).status).toBe(403);
    for (const action of ['start', 'stop', 'confirm'] as const) {
      const denied = await fetch(`${base}${LOGIN}`, {
        method: 'POST',
        headers: { ...peer, ...json },
        body: JSON.stringify({ action }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'forbidden' });
    }

    // Refused BEFORE the body is parsed: a denied caller must be told it was
    // denied, not that its JSON was malformed.
    const malformed = await fetch(`${base}${LOGIN}`, {
      method: 'POST',
      headers: { ...peer, ...json },
      body: 'not json',
    });
    expect(malformed.status).toBe(403);
    expect(lifecycle.calls).toEqual([]);
  });

  test('a human admin — UI or CLI — drives it, and the actor is never read from the request', async () => {
    const { lifecycle, base } = loginServer();
    // No self-identification header at all => admin-ui (the SPA).
    const ui = await fetch(`${base}${LOGIN}`, { headers: { authorization: 'Bearer secret' } });
    expect(ui.status).toBe(200);
    expect(await ui.json()).toMatchObject({ state: 'open', connection: { port: 5951 } });

    const cli = await fetch(`${base}${LOGIN}`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'x-kteam-client': 'cli', ...json },
      body: JSON.stringify({ action: 'start', minutes: 5 }),
    });
    expect(cli.status).toBe(200);

    // A body/query that CLAIMS to be the human changes nothing: the actor comes
    // from resolveApiActor, and this caller is still a peer.
    const spoofed = await fetch(`${base}${LOGIN}?actor=admin-cli`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'x-kteam-session-id': 'sneaky', ...json },
      body: JSON.stringify({ action: 'start', actor: 'admin-cli' }),
    });
    expect(spoofed.status).toBe(403);

    const closed = await fetch(`${base}${LOGIN}`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', ...json },
      body: JSON.stringify({ action: 'stop', primed: true }),
    });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ state: 'closed', profilePrimed: true });
    expect(lifecycle.calls).toEqual(['status', 'start:5', 'stop:true']);
  });

  // The body carries a live VNC credential. The policy is per-ROUTE: GET, POST,
  // and every error shape alike, so it cannot depend on which branch answered.
  test('every response is no-store, including the 403s and the 400s', async () => {
    const { base } = loginServer();
    const responses = [
      await fetch(`${base}${LOGIN}`, { headers: { authorization: 'Bearer secret' } }),
      await fetch(`${base}${LOGIN}`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', ...json },
        body: JSON.stringify({ action: 'start' }),
      }),
      await fetch(`${base}${LOGIN}`, { headers: { authorization: 'Bearer warden' } }),
      await fetch(`${base}${LOGIN}`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', ...json },
        body: JSON.stringify({ action: 'restart' }),
      }),
    ];
    expect(responses.map(response => response.status)).toEqual([200, 200, 403, 400]);
    for (const response of responses) expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // `/v1/sessions` IS warden-readable — it survives the generic GET allowance
  // by design. Folding the window's state into it (let alone its port) would
  // hand a warden exactly what the separately-gated route exists to withhold,
  // through a payload nobody would think to re-audit.
  test('the open window never leaks into the warden-readable fleet payload', async () => {
    const { base } = loginServer();
    const admin = { authorization: 'Bearer secret' };
    const before = await (await fetch(`${base}/v1/sessions`, { headers: admin })).text();

    const opened = await fetch(`${base}${LOGIN}`, {
      method: 'POST',
      headers: { ...admin, ...json },
      body: JSON.stringify({ action: 'start' }),
    });
    expect(opened.status).toBe(200);

    const after = await (await fetch(`${base}/v1/sessions`, { headers: admin })).text();
    expect(after).toBe(before);
    for (const secret of ['5951', 'Sq7fXk2p', 'sshTunnel', 'browserLogin', 'profilePrimed']) {
      expect(after).not.toContain(secret);
    }
    // ...and a warden reading the fleet sees the same bytes, not a redaction.
    const warden = await fetch(`${base}/v1/sessions`, { headers: { authorization: 'Bearer warden' } });
    expect(warden.status).toBe(200);
    expect(await warden.text()).toBe(before);
  });

  test('an unmounted login window is a truthful 404, not a confident "closed"', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}${LOGIN}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'unknown_route', path: LOGIN });
  });
});
