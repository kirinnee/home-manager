import { readFile } from 'fs/promises';
import type { AttachmentView, SessionView, WardenRunView, WardenStatusView } from './service';
import type { KTeamEvent, SendRequest, StartSessionRequest } from './types';
import type { KTeamPaths } from './paths';
import { loadDaemonConfig } from './daemon-config';

export class ApiClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static async connect(paths: KTeamPaths): Promise<ApiClient> {
    const config = await loadDaemonConfig(paths);
    const baseUrl = process.env.KTEAM_URL ?? config.publicUrl;
    const token = process.env.KTEAM_TOKEN ?? (await readFile(paths.token, 'utf8').catch(() => '')).trim();
    if (!token) throw new Error('kteam daemon token is missing; run `kteam daemon start`');
    return new ApiClient(baseUrl.replace(/\/$/, ''), token);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // One transient socket error must not fail an otherwise-healthy call
    // (background/automation shells hit this constantly while the daemon is
    // demonstrably up), so retry briefly before declaring the daemon
    // unavailable. One requestId spans ALL attempts of this logical call: if
    // the socket died AFTER the daemon applied a mutation, the retry carries
    // the same id and the daemon returns the current view instead of applying
    // the mutation twice (duplicate-send guard, see api-server dedup).
    const options: RequestInit = {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-kteam-request-id': crypto.randomUUID(),
        // Assigned wardens carry an unguessable per-assignment stop
        // capability in their pane env; the api-server authorizes
        // `stop <assigned target>` by capability match, never by a
        // client-chosen identity.
        ...(process.env.KTEAM_STOP_CAPABILITY ? { 'x-kteam-stop-capability': process.env.KTEAM_STOP_CAPABILITY } : {}),
        ...init.headers,
      },
    };
    let response: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
      if (attempt > 0) await Bun.sleep(250 * attempt);
      try {
        response = await fetch(`${this.baseUrl}${path}`, options);
      } catch (error) {
        lastError = error;
      }
    }
    if (!response) {
      const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
      throw new Error(`kteam daemon is unavailable at ${this.baseUrl}${detail}; run \`kteam daemon start\``);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new Error(payload.error ?? `daemon returned HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    return (contentType.includes('application/json') ? await response.json() : await response.text()) as T;
  }

  health() {
    return this.request<Record<string, unknown>>('/v1/health');
  }
  wardenStatus() {
    return this.request<WardenStatusView>('/v1/warden/status');
  }
  wardenRun(spawn = false) {
    return this.request<WardenRunView>('/v1/warden/run', {
      method: 'POST',
      body: JSON.stringify({ spawn }),
      headers: { 'content-type': 'application/json' },
    });
  }
  list() {
    return this.request<SessionView[]>('/v1/sessions');
  }
  get(id: string) {
    return this.request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}`);
  }
  start(input: StartSessionRequest) {
    return this.request<SessionView>('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
    });
  }
  send(id: string, input: SendRequest) {
    return this.post<SessionView>(id, 'send', input);
  }
  answer(id: string, labels: string[], other?: string, responses?: string[]) {
    return this.post<SessionView>(id, 'answer', { labels, other, responses });
  }
  interrupt(id: string) {
    return this.post<SessionView>(id, 'interrupt', {});
  }
  stop(id: string, reason?: string) {
    return this.post<SessionView>(id, 'stop', { reason });
  }
  resume(id: string, message?: string) {
    return this.post<SessionView>(id, 'resume', { message });
  }
  migrate(id: string, agent: string, model?: string) {
    return this.post<SessionView>(id, 'migrate', { agent, model });
  }
  signal(id: string, kind: 'done' | 'help', message?: string) {
    return this.post<SessionView>(id, 'signal', { kind, message });
  }
  remove(id: string, purge = false, force = false) {
    return this.request<void>(`/v1/sessions/${encodeURIComponent(id)}?purge=${purge}&force=${force}`, {
      method: 'DELETE',
    });
  }
  snapshot(id: string) {
    // CLI semantics stay LIVE (fresh tmux capture); the web UI uses the cached
    // default route instead.
    return this.request<string>(`/v1/sessions/${encodeURIComponent(id)}/snapshot?live=true`);
  }
  logs(id: string, turn?: number) {
    return this.request<string>(`/v1/sessions/${encodeURIComponent(id)}/logs${turn ? `?turn=${turn}` : ''}`);
  }
  events(id: string, after = 0, limit = 1000) {
    return this.request<KTeamEvent[]>(`/v1/sessions/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`);
  }

  async history(id: string, after = 0, limit?: number): Promise<KTeamEvent[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error('limit must be a positive integer');
    const events: KTeamEvent[] = [];
    let cursor = after;
    while (limit === undefined || events.length < limit) {
      const pageSize = Math.min(1000, limit === undefined ? 1000 : limit - events.length);
      const page = await this.events(id, cursor, pageSize);
      events.push(...page);
      if (page.length < pageSize) break;
      cursor = page.at(-1)!.sequence;
    }
    return events;
  }

  async upload(id: string, file: string): Promise<AttachmentView> {
    const bytes = await Bun.file(file).arrayBuffer();
    const form = new FormData();
    form.set('file', new File([bytes], file.split('/').at(-1) ?? 'image', { type: Bun.file(file).type }));
    return this.request<AttachmentView>(`/v1/sessions/${encodeURIComponent(id)}/attachments`, {
      method: 'POST',
      body: form,
    });
  }

  async stream(sessionId: string | undefined, after: number, onEvent: (event: KTeamEvent) => void): Promise<void> {
    const url = new URL(this.baseUrl.replace(/^http/, 'ws') + '/v1/events');
    url.searchParams.set('after', String(after));
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    await new Promise<void>((resolve, reject) => {
      const BunWebSocket = WebSocket as unknown as {
        new (url: string | URL, options: Bun.WebSocketOptions): WebSocket;
      };
      const socket = new BunWebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
      socket.addEventListener('message', event => {
        try {
          onEvent(JSON.parse(String(event.data)) as KTeamEvent);
        } catch {}
      });
      socket.addEventListener('close', () => resolve());
      socket.addEventListener('error', () => reject(new Error('WebSocket stream failed')));
    });
  }

  private post<T>(id: string, action: string, value: unknown): Promise<T> {
    return this.request<T>(`/v1/sessions/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(value),
      headers: { 'content-type': 'application/json' },
    });
  }
}
