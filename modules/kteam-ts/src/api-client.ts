import { readFile } from 'fs/promises';
import type { AttachmentView, SessionView, UsageFeedView, WardenRunView, WardenStatusView } from './service';
import type { KTeamEvent, SendDisposition, SendRequest, SignalKind, SignalOptions, StartSessionRequest } from './types';
import type { KTeamPaths } from './paths';
import { loadDaemonConfig } from './daemon-config';
import { displayName } from './names';
import { KTEAM_VERSION } from './version';

/** Compare two dotted numeric versions. >0 when `a` is newer, <0 when older,
 *  0 when equal or either is unparseable (treat unknown as "no skew"). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map(n => Number.parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** The one-line skew warning (or undefined when the versions match / the daemon
 *  didn't report one). Names BOTH versions and the direction, so an operator
 *  after a deploy knows whether to restart the daemon or update the CLI. Pure so
 *  it can be unit-tested without a live daemon; the once-per-invocation guard
 *  lives in ApiClient. */
export function versionSkewWarning(cliVersion: string, daemonVersion: string | null | undefined): string | undefined {
  if (!daemonVersion || daemonVersion === cliVersion) return undefined;
  const direction = compareVersions(cliVersion, daemonVersion);
  if (direction > 0)
    return `kteam CLI ${cliVersion} / kteamd ${daemonVersion} — daemon is stale; restart kteamd to pick up new commands.`;
  if (direction < 0)
    return `kteam CLI ${cliVersion} / kteamd ${daemonVersion} — daemon is newer than this CLI; update the kteam CLI to match.`;
  return undefined;
}

/** Message for an unknown-route 404: always names the route (method + path) and
 *  BOTH versions; when the daemon is demonstrably older it frames the route as a
 *  command the CLI shipped that the running daemon predates. Pure for testing. */
export function formatUnknownRouteError(
  route: string,
  cliVersion: string,
  daemonVersion: string | null | undefined,
): string {
  const daemon = daemonVersion ?? 'unknown';
  if (daemonVersion && compareVersions(cliVersion, daemonVersion) > 0)
    return (
      `kteam: this command requires a newer kteamd — the CLI is ${cliVersion} but the running daemon is ${daemon}; ` +
      `restart kteamd to pick up new commands (route ${route} returned 404).`
    );
  return (
    `kteam: daemon returned 404 for ${route} — unknown route; if this command is new, the running daemon ` +
    `predates it (CLI ${cliVersion}, daemon ${daemon}).`
  );
}

/** Hard deadline for one daemon request attempt. Above every legitimate
 *  operation (start caps its own wait at 45 s) and below the caller timeouts
 *  that were SIGTERMing the CLI at exit 143. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Deadline for the "did my lost start actually land?" lookups. Short on
 *  purpose: they run AFTER a request already burned its own deadline, and the
 *  whole point is to answer inside the caller's timeout. */
const RECOVERY_TIMEOUT_MS = 15_000;

export interface ScratchPlanView {
  sessionId: string;
  teammate?: string;
  directory: string;
  bytes: number;
  entries: Array<{ name: string; bytes: number; kind: string }>;
  eligible: boolean;
  reason?: string;
}

export class ApiClient {
  /** Skew is warned about at most once per CLI invocation (a single command
   *  fires many requests). Static so it spans every ApiClient in the process. */
  private static skewWarned = false;

  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** Emit the version-skew warning to stderr once per invocation. Exposed for
   *  tests via the pure `versionSkewWarning`; this just gates + prints. */
  private noteDaemonVersion(daemonVersion: string | null): void {
    if (ApiClient.skewWarned) return;
    const warning = versionSkewWarning(KTEAM_VERSION, daemonVersion);
    if (!warning) return;
    ApiClient.skewWarned = true;
    console.error(warning);
  }

  static async connect(paths: KTeamPaths): Promise<ApiClient> {
    const config = await loadDaemonConfig(paths);
    const baseUrl = process.env.KTEAM_URL ?? config.publicUrl;
    const token = process.env.KTEAM_TOKEN ?? (await readFile(paths.token, 'utf8').catch(() => '')).trim();
    if (!token) throw new Error('kteam daemon token is missing; run `kteam daemon start`');
    return new ApiClient(baseUrl.replace(/\/$/, ''), token);
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
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
        // Every request carries the CLI's version so the daemon (and, via its
        // response header, the CLI) can detect a post-deploy skew.
        'x-kteam-version': KTEAM_VERSION,
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
    let timedOut = false;
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
      if (attempt > 0) await Bun.sleep(250 * attempt);
      try {
        // A DEADLINE, not an open-ended wait. Without one the CLI blocks
        // forever against a daemon that cannot answer, and whoever invoked it
        // eventually SIGTERMs the process — the exit-143 spawn timeouts, where
        // the caller learns nothing while the daemon may well have applied the
        // mutation. Every daemon operation is bounded below this (start caps
        // its own wait at 45 s), so a hit here is a real fault, not slowness.
        response = await fetch(`${this.baseUrl}${path}`, {
          ...options,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
        // Retrying a deadline just multiplies it; a timeout is terminal.
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          timedOut = true;
          break;
        }
      }
    }
    if (!response) {
      const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
      if (timedOut)
        throw new Error(
          `kteam daemon did not answer ${path} within ${Math.round(timeoutMs / 1000)}s${detail}; ` +
            'it may still have applied the request — check `kteam ps` before retrying',
        );
      throw new Error(`kteam daemon is unavailable at ${this.baseUrl}${detail}; run \`kteam daemon start\``);
    }
    // A response — of any status — carries the daemon's version. Surface a skew
    // once so the operator isn't left with an unactionable error after a deploy.
    const daemonVersion = response.headers.get('x-kteam-version');
    this.noteDaemonVersion(daemonVersion);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: response.statusText }))) as {
        error?: string;
        code?: string;
        method?: string;
        path?: string;
      };
      // An unknown-route 404 (as opposed to a "no such session" 404) after a
      // deploy is the classic version-skew symptom. Name the method+path+status
      // AND both versions, and — when the daemon is demonstrably older — say the
      // command the CLI shipped predates the running daemon, not just "skew".
      if (response.status === 404 && payload.code === 'unknown_route') {
        const route = `${payload.method ?? init.method ?? 'GET'} ${payload.path ?? path}`;
        throw new Error(formatUnknownRouteError(route, KTEAM_VERSION, daemonVersion));
      }
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
  usage() {
    return this.request<UsageFeedView>('/v1/usage');
  }
  scratchPlan(limit = 20) {
    return this.request<ScratchPlanView[]>(`/v1/gc?limit=${limit}`);
  }
  scratchSweep(force = false) {
    return this.request<{ sessions: number; bytes: number; failures: number }>('/v1/gc', {
      method: 'POST',
      body: JSON.stringify({ force }),
      headers: { 'content-type': 'application/json' },
    });
  }
  list() {
    return this.request<SessionView[]>('/v1/sessions');
  }
  /** Suggest available teammate names (a suggestion, not a reservation — see
   *  KTeamService.suggestNames). */
  suggestNames(count = 1) {
    return this.request<string[]>(`/v1/names?count=${encodeURIComponent(count)}`);
  }
  get(id: string) {
    return this.request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}`);
  }
  /** Start a session under a caller-owned request id, so a lost response can
   *  be RESOLVED instead of guessed. A `kteam start` whose HTTP answer never
   *  arrived still created the session (2026-07-23: two such calls produced
   *  live controllers a caller believed had failed) — reporting failure there
   *  is what makes a retrying responder duplicate teammates. */
  async start(input: StartSessionRequest, requestId = process.env.KTEAM_REQUEST_ID || crypto.randomUUID()) {
    // Clock-skew grace on the "created after I called" window below.
    const calledAt = Date.now() - 5_000;
    const body = JSON.stringify(input);
    const payload = Bun.hash(body).toString(16);
    try {
      return await this.request<SessionView>('/v1/sessions', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-kteam-request-id': requestId },
      });
    } catch (error) {
      // Only a TRANSPORT failure leaves the outcome unknown; a daemon that
      // answered (bad wrapper, missing prompt) rejected the start outright and
      // there is nothing to recover.
      if (!(error instanceof Error) || !/did not answer|is unavailable/.test(error.message)) throw error;
      // The recovery lookups get their own SHORT deadline: three full-length
      // requests against an unresponsive daemon would take longer than the
      // caller timeouts this whole change exists to stay under.
      const created = await this.request<SessionView>(
        `/v1/sessions/by-request/${requestId}?payload=${payload}`,
        {},
        RECOVERY_TIMEOUT_MS,
      ).catch(() => undefined);
      if (created) return created;
      // Last resort, and the one that works against a daemon too busy (or too
      // old) to answer the lookup: the session row is persisted BEFORE the TUI
      // launch, so a start that "failed" is usually visible in the list. One
      // retry covers the persist landing just after the deadline.
      for (const delay of [0, 1_000]) {
        if (delay) await Bun.sleep(delay);
        const found = await this.findCreatedSession(input, calledAt);
        if (found) return found;
      }
      throw error;
    }
  }

  /** The session THIS start call created: same agent, same derived NAME, same
   *  label, created after the call began — and exactly one candidate.
   *
   *  The name is always compared (the daemon derives one from the prompt when
   *  `--name` is absent, and the client can derive the identical string). A
   *  label alone would not do: labels group a whole team, so a sibling start
   *  on the same agent and label would be adopted as "my" session and the
   *  caller would then talk to someone else's teammate. */
  private async findCreatedSession(input: StartSessionRequest, sinceMs: number): Promise<SessionView | undefined> {
    // Same derivation the daemon uses, including its bare-interactive fallback.
    const derived = input.prompt?.trim() ? input.prompt.trim().split(/\s+/).slice(0, 5).join('-') : 'interactive';
    const expected = displayName(input.name ?? derived);
    if (!expected) return undefined;
    const sessions = await this.request<SessionView[]>('/v1/sessions', {}, RECOVERY_TIMEOUT_MS).catch(
      () => [] as SessionView[],
    );
    const matches = sessions.filter(
      view =>
        view.config.binary === input.agent &&
        view.config.name === expected &&
        (input.label === undefined || view.config.label === input.label) &&
        Date.parse(view.config.createdAt) >= sinceMs,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  send(id: string, input: SendRequest) {
    return this.post<SessionView & { disposition?: SendDisposition }>(id, 'send', input);
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
  rename(id: string, name?: string, teammate?: string, clearParent?: boolean) {
    return this.post<SessionView>(id, 'rename', { name, teammate, clearParent });
  }
  signal(id: string, kind: SignalKind, message?: string, options: SignalOptions = {}) {
    return this.post<SessionView>(id, 'signal', { kind, message, ...options });
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
