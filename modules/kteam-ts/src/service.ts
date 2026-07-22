import type { KTeamEvent, SendRequest, SessionConfig, SessionState, StartSessionRequest } from './types';
import type { WardenConfig } from './daemon-config';
import type { WardenAnomaly } from './warden-detect';

export interface SessionView {
  config: SessionConfig;
  state: SessionState;
  directory: string;
}

export interface WardenStatusView {
  config: WardenConfig;
  lastSweepAt?: string;
  anomalies: WardenAnomaly[];
  fingerprint: string;
  /** Id of a currently-live escalation warden session, if any. */
  liveWarden?: string;
  /** When escalation last spawned a warden (from durable warden state). */
  lastSpawnAt?: string;
  /** Newest report on disk: its path and first few lines. */
  lastReport?: { path: string; head: string };
}

export interface WardenRunView {
  sweptAt: string;
  anomalies: WardenAnomaly[];
  /** Session id of a fleet-triage warden spawned by this run, when escalation fired. */
  spawned?: string;
  /** Session ids of per-session ASSIGNED wardens spawned for sus anomalies. */
  assignedWardens?: string[];
  /** Why escalation did not spawn (disabled, gap, no anomalies, live warden…). */
  message?: string;
}

export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  createdAt: string;
}

export interface KTeamService {
  health(): Promise<Record<string, unknown>>;
  list(): Promise<SessionView[]>;
  get(id: string): Promise<SessionView>;
  start(request: StartSessionRequest): Promise<SessionView>;
  send(id: string, request: SendRequest): Promise<SessionView>;
  answer(id: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView>;
  interrupt(id: string): Promise<SessionView>;
  stop(id: string, reason?: string): Promise<SessionView>;
  resume(id: string, message?: string): Promise<SessionView>;
  /** Continue a session on another same-kind account (new wrapper); relaunches
   *  via the resume path under the new wrapper. Cross-kind is rejected. */
  migrate(id: string, agent: string, model?: string): Promise<SessionView>;
  remove(id: string, purge?: boolean, force?: boolean): Promise<void>;
  signal(id: string, kind: 'done' | 'help', message?: string): Promise<SessionView>;
  snapshot(id: string): Promise<string>;
  /** The monitor's most recent pane snapshot, read from disk — no tmux capture,
   *  no session lock. The UI polls this; snapshot() stays for live captures. */
  lastSnapshot(id: string): Promise<string>;
  /** Paginated read of the session's normalized chat.jsonl (both harnesses).
   *  Tail-first: no `before` returns the LAST `limit` records; `before` = the
   *  record index below which to page backwards. */
  chatHistory(
    id: string,
    before?: number,
    limit?: number,
  ): Promise<{ total: number; offset: number; records: unknown[] }>;
  logs(id: string, turn?: number): Promise<string>;
  replay(id: string | undefined, after: number, limit?: number): Promise<KTeamEvent[]>;
  subscribe(listener: (event: KTeamEvent) => void): () => void;
  addAttachment(id: string, filename: string, mime: string, bytes: Uint8Array): Promise<AttachmentView>;
  getAttachment(id: string, attachmentId: string): Promise<{ attachment: AttachmentView; bytes: Uint8Array }>;
  /** True when `capability` matches the per-assignment secret minted for
   *  `targetId`'s active warden assignment — the only case the warden token
   *  may stop a session. */
  wardenMayStop(capability: string, targetId: string): boolean;
  /** Fleet-warden status: config, last sweep, current anomalies, last report. */
  wardenStatus(): Promise<WardenStatusView>;
  /** Force a fleet sweep now; `spawn` forces escalation past the gap/enabled. */
  wardenRun(spawn?: boolean): Promise<WardenRunView>;
}
