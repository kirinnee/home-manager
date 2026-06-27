import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { CliDeps } from '../cli';
import { getKloopHome } from '../deps';
import { type KloopData, makeKloopData } from './data';
import { SHELL_HTML } from './page';

// ============================================================================
// Request router for `kloop serve`. /api/* returns JSON/SSE read fresh from
// ~/.kloop on every request; every other GET returns the SPA shell. Paths match
// what the ported viewer client calls (/api/kloop/* + /api/events), so the
// client needs no changes.
// ============================================================================

const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function notFoundJson(): Response {
  return json({ error: 'not found' }, 404);
}

/** Coarse "did the store change?" fingerprint: ~/.kloop dir + index.db mtimes. */
function storeFingerprint(): string {
  const root = getKloopHome();
  let fp = '';
  try {
    fp += statSync(root).mtimeMs;
  } catch {
    /* missing store */
  }
  try {
    fp += `:${statSync(`${root}/index.db`).mtimeMs}`;
  } catch {
    /* no index yet */
  }
  return fp;
}

/** SSE live-reload: emits `reload` when the store fingerprint changes. */
function eventsStream(): Response {
  const encoder = new TextEncoder();
  let last = storeFingerprint();
  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      poll = setInterval(() => {
        try {
          const fp = storeFingerprint();
          if (fp !== last) {
            last = fp;
            controller.enqueue(encoder.encode('data: reload\n\n'));
          }
        } catch {
          /* retry next tick */
        }
      }, POLL_MS);
      beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (poll) clearInterval(poll);
      if (beat) clearInterval(beat);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

/**
 * SSE tail of a log file: full contents once, then only newly-appended bytes per
 * tick (or full on shrink/rotation). Idle ticks only stat(); a StringDecoder
 * carries partial multi-byte chars. Offset advances by bytes actually read (so a
 * short read never silently skips a range).
 */
function kloopTailStream(abs: string): Response {
  const encoder = new TextEncoder();
  let decoder = new StringDecoder('utf8');
  let offset = 0; // bytes consumed
  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const sizeOf = (): number => {
    try {
      return statSync(abs).size;
    } catch {
      return 0;
    }
  };
  // Read [start, end) fully (looping over short reads); returns decoded text and
  // how many bytes were consumed via the out-param.
  const readRange = (start: number, end: number, out: { read: number }): string => {
    out.read = 0;
    const len = end - start;
    if (len <= 0) return '';
    let fd: number | undefined;
    try {
      fd = openSync(abs, 'r');
      let text = '';
      let pos = start;
      while (pos < end) {
        const chunk = Math.min(end - pos, 1 << 20);
        const buf = Buffer.alloc(chunk);
        const n = readSync(fd, buf, 0, chunk, pos);
        if (n <= 0) break;
        text += decoder.write(buf.subarray(0, n));
        pos += n;
        out.read += n;
      }
      return text;
    } catch {
      return '';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      controller.enqueue(encoder.encode(': connected\n\n'));
      const out = { read: 0 };
      const size = sizeOf();
      send({ full: readRange(0, size, out) });
      offset = out.read;
      poll = setInterval(() => {
        try {
          const cur = sizeOf();
          if (cur > offset) {
            const chunk = readRange(offset, cur, out);
            if (out.read > 0) {
              offset += out.read;
              send({ append: chunk });
            }
          } else if (cur < offset) {
            decoder = new StringDecoder('utf8');
            send({ full: readRange(0, cur, out) });
            offset = out.read;
          }
        } catch {
          /* retry next tick */
        }
      }, POLL_MS);
      beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (poll) clearInterval(poll);
      if (beat) clearInterval(beat);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

async function handleApi(data: KloopData, parts: string[], url: URL): Promise<Response | null> {
  if (parts.length === 2 && parts[1] === 'events') return eventsStream();
  if (parts[1] === 'kloop') {
    if (parts.length === 3 && parts[2] === 'runs') return json(await data.listRuns());
    if (parts.length === 4 && parts[2] === 'runs') {
      const d = await data.runDetail(decodeURIComponent(parts[3]));
      return d ? json(d) : notFoundJson();
    }
    if (parts.length === 3 && parts[2] === 'file') {
      const rel = url.searchParams.get('path') ?? '';
      return json({ content: data.readFile(rel) });
    }
    if (parts.length === 3 && parts[2] === 'dir') {
      const rel = url.searchParams.get('path') ?? '';
      return json(data.listDir(rel));
    }
    if (parts.length === 3 && parts[2] === 'stream') {
      const abs = data.resolvePath(url.searchParams.get('path') ?? '');
      return abs ? kloopTailStream(abs) : notFoundJson();
    }
    return notFoundJson();
  }
  return notFoundJson();
}

const metricEsc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// Failed-agent aggregation is heavier (it materializes per-run status), so cache
// it and only scan the most-recent runs. `reason` is the recorded error string
// ("exit_code_N", "timeout", "no_verdict", "interrupted").
const FAILURES_TTL_MS = 60_000;
const FAILURES_SCAN = 50;
let failuresCache: { at: number; lines: string[] } = { at: 0, lines: [] };

/** Collect error-status agent attempts ({binary, reason}) from one materialized
 *  loop. A timed-out agent is status:'error' with error:'timeout' (the status
 *  enum is only pending/running/completed/error), so this captures timeouts too.
 *  Reviewers live under reviewPhases[]/verifyPhases[], not a flat list. */
function loopErrors(loop: unknown): { binary: string; reason: string }[] {
  const out: { binary: string; reason: string }[] = [];
  const add = (a: unknown): void => {
    if (a && typeof a === 'object') {
      const o = a as { status?: string; binary?: string; error?: string };
      if (o.status === 'error' && typeof o.binary === 'string') {
        out.push({ binary: o.binary, reason: typeof o.error === 'string' && o.error ? o.error : 'error' });
      }
    }
  };
  const l = loop as {
    implementer?: unknown;
    synthesis?: unknown;
    checkpoint?: unknown;
    reviewPhases?: { reviewers?: unknown[] }[];
    verifyPhases?: { reviewers?: unknown[] }[];
  };
  add(l.implementer);
  add(l.synthesis);
  add(l.checkpoint);
  for (const phase of l.reviewPhases ?? []) for (const r of phase.reviewers ?? []) add(r);
  for (const phase of l.verifyPhases ?? []) for (const r of phase.reviewers ?? []) add(r);
  return out;
}

async function refreshFailures(data: KloopData): Promise<void> {
  const runs = (await data.listRuns()) as { id: string }[];
  const counts = new Map<string, number>();
  for (const r of runs.slice(0, FAILURES_SCAN)) {
    const detail = (await data.runDetail(r.id)) as { loops?: unknown[] } | null;
    for (const loop of detail?.loops ?? []) {
      for (const e of loopErrors(loop)) {
        const key = `${e.binary}\u0000${e.reason}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const lines = [
    '# HELP kloop_agent_failures Failed agent attempts (exit≠0 / timeout / no_verdict) by binary+reason, across recent runs.',
    '# TYPE kloop_agent_failures gauge',
    ...[...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, n]) => {
        const [binary, reason] = key.split('\u0000');
        return `kloop_agent_failures{binary="${metricEsc(binary!)}",reason="${metricEsc(reason!)}"} ${n}`;
      }),
  ];
  failuresCache = { at: Date.now(), lines };
}

/** Prometheus exposition of kloop's own run stats. Run counts are computed
 *  per-scrape (cheap); failed-agent counts come from a cached, bounded scan. */
async function metricsResponse(data: KloopData): Promise<Response> {
  const runs = (await data.listRuns()) as { status?: string }[];
  const byStatus = new Map<string, number>();
  for (const r of runs) byStatus.set(r.status ?? 'unknown', (byStatus.get(r.status ?? 'unknown') ?? 0) + 1);
  const lines = [
    '# HELP kloop_runs_running Number of currently running kloop runs.',
    '# TYPE kloop_runs_running gauge',
    `kloop_runs_running ${byStatus.get('running') ?? 0}`,
    '# HELP kloop_runs Number of kloop runs by status.',
    '# TYPE kloop_runs gauge',
    ...[...byStatus]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, n]) => `kloop_runs{status="${metricEsc(s)}"} ${n}`),
  ];
  if (Date.now() - failuresCache.at > FAILURES_TTL_MS) {
    try {
      await refreshFailures(data);
    } catch {
      /* keep the previous failure snapshot on a transient read error */
    }
  }
  lines.push(...failuresCache.lines);
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Build the Bun.serve fetch handler bound to a deps-backed data layer. */
export function createFetch(deps: CliDeps): (req: Request) => Promise<Response> {
  const data = makeKloopData(deps);
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      if (url.pathname === '/metrics') return metricsResponse(data);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') {
        return (await handleApi(data, parts, url)) ?? notFoundJson();
      }
      return html(SHELL_HTML);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: 'internal error', message }, 500);
    }
  };
}

export { existsSync };
