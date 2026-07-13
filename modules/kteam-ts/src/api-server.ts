import type { Server, ServerWebSocket } from 'bun';
import type { KTeamService } from './service';

interface SocketData {
  sessionId?: string;
  after: number;
  replaying: boolean;
  queued: string[];
}

export interface ApiServerOptions {
  host: string;
  port: number;
  token: string;
  service: KTeamService;
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function startApiServer(options: ApiServerOptions): Server<SocketData> {
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const unsubscribe = options.service.subscribe(event => {
    const encoded = JSON.stringify(event);
    for (const socket of sockets) {
      if (!socket.data.sessionId || socket.data.sessionId === event.sessionId) {
        if (socket.data.replaying) socket.data.queued.push(encoded);
        else socket.send(encoded);
      }
    }
  });

  const server = Bun.serve<SocketData>({
    hostname: options.host,
    port: options.port,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);
      const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (bearer !== options.token) return json({ error: 'unauthorized' }, 401);

      try {
        if (url.pathname === '/v1/events' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const upgraded = serverInstance.upgrade(request, {
            data: {
              sessionId: url.searchParams.get('sessionId') ?? undefined,
              after: Number(url.searchParams.get('after') ?? 0),
              replaying: true,
              queued: [],
            },
          });
          return upgraded ? undefined : json({ error: 'websocket upgrade failed' }, 400);
        }
        if (url.pathname === '/v1/health' && request.method === 'GET') return json(await options.service.health());
        if (url.pathname === '/v1/sessions' && request.method === 'GET') return json(await options.service.list());
        if (url.pathname === '/v1/sessions' && request.method === 'POST')
          return json(await options.service.start(await body(request)), 201);

        const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
        if (!match) return json({ error: 'not found' }, 404);
        const id = decodeURIComponent(match[1]!);
        const action = match[2];

        if (!action && request.method === 'GET') return json(await options.service.get(id));
        if (!action && request.method === 'DELETE') {
          await options.service.remove(
            id,
            url.searchParams.get('purge') === 'true',
            url.searchParams.get('force') === 'true',
          );
          return new Response(null, { status: 204 });
        }
        if (action === 'send' && request.method === 'POST')
          return json(await options.service.send(id, await body(request)));
        if (action === 'answer' && request.method === 'POST') {
          const input = await body<{ labels?: string[]; other?: string; responses?: string[] }>(request);
          return json(await options.service.answer(id, input.labels ?? [], input.other, input.responses));
        }
        if (action === 'interrupt' && request.method === 'POST') return json(await options.service.interrupt(id));
        if (action === 'stop' && request.method === 'POST') {
          const input = await body<{ reason?: string }>(request);
          return json(await options.service.stop(id, input.reason));
        }
        if (action === 'resume' && request.method === 'POST') {
          const input = await body<{ message?: string }>(request);
          return json(await options.service.resume(id, input.message));
        }
        if (action === 'signal' && request.method === 'POST') {
          const input = await body<{ kind: 'done' | 'help'; message?: string }>(request);
          if (input.kind !== 'done' && input.kind !== 'help') throw new HttpError(400, 'kind must be done or help');
          return json(await options.service.signal(id, input.kind, input.message));
        }
        if (action === 'snapshot' && request.method === 'GET') {
          return new Response(await options.service.snapshot(id), {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        if (action === 'logs' && request.method === 'GET') {
          const turn = url.searchParams.has('turn') ? Number(url.searchParams.get('turn')) : undefined;
          return new Response(await options.service.logs(id, turn), {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        if (action === 'events' && request.method === 'GET') {
          return json(
            await options.service.replay(
              id,
              Number(url.searchParams.get('after') ?? 0),
              Number(url.searchParams.get('limit') ?? 1000),
            ),
          );
        }
        if (action === 'attachments' && request.method === 'POST') {
          const form = await request.formData();
          const file = form.get('file');
          if (!(file instanceof File)) throw new HttpError(400, 'multipart field "file" is required');
          return json(
            await options.service.addAttachment(id, file.name, file.type, new Uint8Array(await file.arrayBuffer())),
            201,
          );
        }
        const attachment = action?.match(/^attachments\/([^/]+)$/);
        if (attachment && request.method === 'GET') {
          const result = await options.service.getAttachment(id, decodeURIComponent(attachment[1]!));
          return new Response(Uint8Array.from(result.bytes).buffer, {
            headers: {
              'content-type': result.attachment.mime,
              'content-length': String(result.attachment.size),
              'content-disposition': `inline; filename="${result.attachment.filename.replace(/["\\]/g, '_')}"`,
            },
          });
        }
        return json({ error: 'not found' }, 404);
      } catch (error) {
        const status =
          error instanceof HttpError ? error.status : /unknown kteam session/i.test(String(error)) ? 404 : 409;
        return json({ error: error instanceof Error ? error.message : String(error) }, status);
      }
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        void (async () => {
          let cursor = socket.data.after;
          while (true) {
            const events = await options.service.replay(socket.data.sessionId, cursor, 1_000);
            for (const event of events) socket.send(JSON.stringify(event));
            if (events.length > 0) cursor = events.at(-1)!.sequence;
            if (events.length < 1_000) break;
          }
          socket.data.replaying = false;
          for (const encoded of socket.data.queued) {
            const queued = JSON.parse(encoded) as { sequence?: number };
            if ((queued.sequence ?? 0) > cursor) socket.send(encoded);
          }
          socket.data.queued.length = 0;
        })().catch(error => socket.send(JSON.stringify({ type: 'error', error: String(error) })));
      },
      close(socket) {
        sockets.delete(socket);
      },
      message() {},
    },
  });

  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    unsubscribe();
    return originalStop(closeActiveConnections);
  }) as typeof server.stop;
  return server;
}
