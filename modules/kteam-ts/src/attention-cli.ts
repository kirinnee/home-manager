// Pure `kteam attention …` parsing, request description and rendering. The
// contended index.ts only needs a small dispatch patch. A bare string is the
// common agent path and defaults to KTEAM_SESSION_ID, exactly like pin/signal.

import { splitTaskArgs } from './tasks-cli';
import {
  AttentionError,
  attentionReference,
  parseAttentionId,
  type AttentionId,
  type AttentionSnapshot,
  type ResolvedAttentionItem,
} from './attention-types';

export const ATTENTION_CLI_USAGE = `kteam attention <command>

  attention "<what you need>"           raise an explicit request on THIS session
  attention add "<subject>"              same, explicit
             [--why <context>] [--resolve <how>]
  attention ls                           list unresolved items, oldest first
  attention done ?A3 [--note <text>]
                                         resolve an item (resolver is recorded)
  attention history                      show recent resolution audit

  [--session <id>]                       target another session; an agent may
                                         only mutate its own session

Defaults to KTEAM_SESSION_ID. Attention items never expire or auto-clear.`;

export type AttentionCliCommand =
  | { command: 'add'; subject: string; why: string; howToResolve: string; session?: string }
  | { command: 'ls'; session?: string }
  | { command: 'history'; session?: string }
  | { command: 'done'; id: AttentionId; note?: string; session?: string };

const invalid = (message: string): never => {
  throw new AttentionError('invalid', `${message}\n\n${ATTENTION_CLI_USAGE}`);
};

export function parseAttentionCli(argv: readonly string[]): AttentionCliCommand {
  const { positional, flags } = splitTaskArgs(argv);
  const rawSession = flags.get('session')?.at(-1);
  if (flags.has('session') && (!rawSession || !rawSession.trim())) {
    return invalid('--session needs a session id');
  }
  const session = rawSession && rawSession.trim() ? rawSession.trim() : undefined;
  const scoped = session ? { session } : {};
  const head = positional[0];
  if (head === 'ls' || head === 'list') return { command: 'ls', ...scoped };
  if (head === 'history' || head === 'resolved') return { command: 'history', ...scoped };
  if (head === 'done' || head === 'resolve') {
    const id = parseAttentionId(positional[1]);
    if (id === null) return invalid('done needs an attention reference like ?A3 (see `attention ls`)');
    const note = flags.get('note')?.at(-1);
    return {
      command: 'done',
      id,
      ...(note && note.trim() ? { note } : {}),
      ...scoped,
    };
  }

  const subject = (head === 'add' ? positional.slice(1) : positional).join(' ').trim();
  if (!subject) return invalid('say what you need, or choose ls/done/history');
  const whyFlag = flags.get('why')?.at(-1);
  const resolveFlag = flags.get('resolve')?.at(-1) ?? flags.get('how')?.at(-1);
  const why = whyFlag && whyFlag.trim() ? whyFlag : subject;
  const howToResolve =
    resolveFlag && resolveFlag.trim() ? resolveFlag : 'Respond in this session, then mark this attention item done.';
  return { command: 'add', subject, why, howToResolve, ...scoped };
}

export interface AttentionCliRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export function attentionCliRequest(
  command: AttentionCliCommand,
  selfSessionId: string | undefined,
): AttentionCliRequest {
  const sessionId = command.session ?? (selfSessionId?.trim() || undefined);
  if (!sessionId) {
    throw new AttentionError('invalid', 'no session id; run inside a kteam session or pass --session <id>');
  }
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;
  switch (command.command) {
    case 'ls':
    case 'history':
      return { method: 'GET', path };
    case 'add':
      return {
        method: 'POST',
        path,
        body: {
          action: 'add',
          source: 'agent-raised',
          subject: command.subject,
          why: command.why,
          howToResolve: command.howToResolve,
        },
      };
    case 'done':
      return {
        method: 'POST',
        path,
        body: { action: 'resolve', id: command.id, ...(command.note ? { note: command.note } : {}) },
      };
  }
}

const compact = (value: string, max = 84): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const actorLabel = (by: 'human' | 'agent' | 'daemon', name: string | null): string =>
  by === 'agent' ? `agent${name ? ` ${name}` : ''}` : by;

export function renderAttentionList(snapshot: AttentionSnapshot): string {
  if (snapshot.parseErrors > 0) {
    return `Attention data has ${snapshot.parseErrors} parse error(s); repair the session file before trusting this list.\n`;
  }
  if (snapshot.items.length === 0) return 'Nothing needs attention.\n';
  const lines = [`${snapshot.count} unresolved item(s) in ${snapshot.sessionId} — oldest first`];
  for (const item of snapshot.items) {
    lines.push(`  ${attentionReference(item.id)}  [${item.source}]  ${compact(item.subject)}`);
    lines.push(`      why: ${compact(item.why)}`);
    lines.push(`      resolve: ${compact(item.howToResolve)}`);
    lines.push(`      since ${item.waitingSince} · raised by ${actorLabel(item.raisedBy, item.raisedByName)}`);
  }
  return `${lines.join('\n')}\n`;
}

function resolutionLine(item: ResolvedAttentionItem): string {
  const note = item.resolutionNote ? ` — ${compact(item.resolutionNote, 60)}` : '';
  return `  ${attentionReference(item.id)}  ${compact(item.subject, 56)} · ${actorLabel(item.resolvedBy, item.resolvedByName)} at ${item.resolvedAt}${note}`;
}

export function renderAttentionHistory(snapshot: AttentionSnapshot): string {
  if (snapshot.resolved.length === 0) return 'No recorded resolutions.\n';
  return `Recent resolutions in ${snapshot.sessionId}\n${snapshot.resolved.map(resolutionLine).join('\n')}\n`;
}

export function renderAttentionCli(command: AttentionCliCommand, response: unknown): string {
  const snapshot = response as AttentionSnapshot;
  switch (command.command) {
    case 'ls':
      return renderAttentionList(snapshot);
    case 'history':
      return renderAttentionHistory(snapshot);
    case 'add':
      const recorded = [...snapshot.items]
        .reverse()
        .find(item => item.source === 'agent-raised' && item.subject.trim() === command.subject.trim());
      return `attention${recorded ? ` ${attentionReference(recorded.id)}` : ''} recorded — ${snapshot.count} unresolved item(s) in ${snapshot.sessionId}\n`;
    case 'done':
      return `resolved ${attentionReference(command.id)} — ${snapshot.count} unresolved item(s) in ${snapshot.sessionId}\n`;
  }
}

export { AttentionError };
