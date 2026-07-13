import type { KTeamEvent, SendRequest, SessionConfig, SessionState, StartSessionRequest } from './types';

export interface SessionView {
  config: SessionConfig;
  state: SessionState;
  directory: string;
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
  remove(id: string, purge?: boolean, force?: boolean): Promise<void>;
  signal(id: string, kind: 'done' | 'help', message?: string): Promise<SessionView>;
  snapshot(id: string): Promise<string>;
  logs(id: string, turn?: number): Promise<string>;
  replay(id: string | undefined, after: number, limit?: number): Promise<KTeamEvent[]>;
  subscribe(listener: (event: KTeamEvent) => void): () => void;
  addAttachment(id: string, filename: string, mime: string, bytes: Uint8Array): Promise<AttachmentView>;
  getAttachment(id: string, attachmentId: string): Promise<{ attachment: AttachmentView; bytes: Uint8Array }>;
}
