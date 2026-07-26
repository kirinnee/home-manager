import type {
  KTeamEvent,
  SendDisposition,
  SendRequest,
  SessionConfig,
  SessionState,
  SignalKind,
  SignalOptions,
  StartSessionRequest,
} from './types';
import type { WardenConfig } from './daemon-config';
import type { WardenAnomaly } from './warden-detect';
import type { ProjectInfo, WrapperInfo } from './fleet-inventory';
import type { WardenVerdict } from './warden-verdicts';
import type { ScratchPlan } from './session-manager';

export interface SearchResult {
  sessionId: string;
  teammate?: string;
  turn?: number;
  snippet: string;
  at?: string;
}

export interface SearchResponse {
  query: string;
  /** how many sessions were actually scanned (honesty line in the UI). */
  scanned: number;
  results: SearchResult[];
}

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

/** One wrapper's account quota, as the browser sees it. Keyed by the wrapper
 *  binary a session runs under (`config.binary`), so the UI can join it onto
 *  any session without the daemon having to stamp every session's state.
 *
 *  Absent fields mean UNKNOWN, never zero: a wrapper kfleet has no record for
 *  is simply missing from `accounts`, and a wrapper whose record exists but
 *  carries no usable numbers (auth failure, non-usage-based provider) reports
 *  the fields it does know and omits the rest. */
export interface UsageAccountView {
  binary: string;
  fiveHourPercent?: number;
  weeklyPercent?: number;
  fiveHourResetAt?: number;
  weeklyResetAt?: number;
  atLimit?: boolean;
  authOk?: boolean;
}

export interface UsageFeedView {
  /** When the daemon's cached feed was last refreshed (ISO), when known. */
  at?: string;
  /** True when the daemon has never obtained a snapshot — the UI must render
   *  "no data" rather than an empty (and therefore falsely confident) list. */
  stale: boolean;
  accounts: UsageAccountView[];
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
  /** Suggest `count` teammate names that are free within the resolution window,
   *  for a caller composing a `[Name] Task` title before start. A SUGGESTION,
   *  not a reservation: nothing is persisted, so `start --teammate` may still
   *  collide and the caller retries with the next name. */
  suggestNames(count?: number): Promise<string[]>;
  start(request: StartSessionRequest): Promise<SessionView>;
  /** Returns the view plus a `disposition`: 'delivered' (injected into the
   *  live turn), 'queued' (busy; delivers at the next prompt-ready boundary),
   *  or 'revived' (terminal session relaunched with the message as its next
   *  turn). Additive field — older clients ignore it. */
  send(id: string, request: SendRequest): Promise<SessionView & { disposition: SendDisposition }>;
  answer(id: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView>;
  interrupt(id: string): Promise<SessionView>;
  stop(id: string, reason?: string): Promise<SessionView>;
  resume(id: string, message?: string): Promise<SessionView>;
  /** Continue a session on another same-kind account (new wrapper); relaunches
   *  via the resume path under the new wrapper. Cross-kind is rejected.
   *  `allowContextDowngrade` opts into migrating onto a target whose context
   *  window is smaller than the current one (normally refused because the live
   *  transcript may not fit); optional and additive, so an implementation that
   *  does not yet honour it still satisfies this interface. */
  migrate(id: string, agent: string, model?: string, allowContextDowngrade?: boolean): Promise<SessionView>;
  /** Change a session's task title and/or its teammate callsign, and/or detach
   *  it from its parent (`clearParent`). Accepts a session id or a teammate name.
   *  Persists to config + the metadata index and journals `session.renamed` so
   *  `kteam ps` and the web UI reflect it live. Works on running and terminal
   *  sessions. At least one of name/teammate/clearParent is required; a teammate
   *  change is collision-checked like `start --teammate`; clearing the parent is
   *  a safe no-op when there is none. */
  rename(id: string, name?: string, teammate?: string, clearParent?: boolean): Promise<SessionView>;
  remove(id: string, purge?: boolean, force?: boolean): Promise<void>;
  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView>;
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
  /** Agent wrappers from the kfleet bin (New-session picker). */
  wrappers(): Promise<WrapperInfo[]>;
  /** Git repos under the configured project roots (New-session picker + list grouping). */
  projects(): Promise<ProjectInfo[]>;
  /** Fleet-warden status: config, last sweep, current anomalies, last report. */
  wardenStatus(): Promise<WardenStatusView>;
  /** Force a fleet sweep now; `spawn` forces escalation past the gap/enabled. */
  wardenRun(spawn?: boolean): Promise<WardenRunView>;
  /** Recent warden verdicts parsed from the reports (newest first). */
  wardenVerdicts(): Promise<WardenVerdict[]>;
  /** Raw markdown of one warden report; `path` is validated to live under the
   *  reports directory. */
  wardenReport(path: string): Promise<string>;
  /** What a scratch sweep WOULD reclaim, without touching anything. */
  scratchPlan(limit?: number): Promise<ScratchPlan[]>;
  /** Run a scratch sweep now (bypasses the enabled gate when forced). */
  scratchSweep(force?: boolean): Promise<{ sessions: number; bytes: number; failures: number }>;
  /** Case-insensitive transcript grep across recent sessions (bounded). */
  search(query: string, limit?: number): Promise<SearchResponse>;
  /** The daemon's cached `kfleet usage` feed, per wrapper binary. The browser
   *  joins this onto sessions by `config.binary`; see UsageFeedView. */
  usage(): Promise<UsageFeedView>;
}
