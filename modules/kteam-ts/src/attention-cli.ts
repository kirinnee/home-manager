// Pure `kteam attention …` parsing, request description and rendering. The
// contended index.ts only needs a small dispatch patch. A bare string is the
// common agent path and defaults to KTEAM_SESSION_ID, exactly like pin/signal.

import { splitTaskArgs } from './tasks-cli';
import {
  AttentionError,
  attentionReference,
  describeAttentionResponse,
  parseAttentionAsk,
  parseAttentionId,
  type AttentionAsk,
  type AttentionId,
  type AttentionResponse,
  type AttentionSnapshot,
  type ResolvedAttentionItem,
} from './attention-types';

export const ATTENTION_CLI_USAGE = `kteam attention <command>

  attention "<the ask>"                 raise a request on THIS session
  attention add "<the ask>"              same, explicit
             [--kind permission|choice|review|open]   what the human DOES:
                permission  approve or reject
                choice      pick one --option (repeat --option, 2+ required)
                review      say your answer is good, or ask you to clarify
                open        write a full answer (the default)
             [--option <label>]... [--context <background>] [--why <why-now>]
             [--resolve <how>]
  attention ls                           list unresolved items, oldest first
  attention done !A3 [--note <text>]
             [--approve | --reject]      answer a permission ask
             [--choice <label>]          answer a multiple-choice ask
             [--good | --clarify <text>] answer an answer-review ask
             [--answer <text>]           answer an open-question ask
                                         an agent may only retract an item it
                                         raised itself; use dismiss otherwise
  attention dismiss !A3 [--note <text>]  explicitly dismiss any item in this
                                         session — recorded with who dismissed
  attention notify "<message>" [--title <t>] [--kind completed|failed]
                                         push a phone notification; NOT an
                                         attention item, nothing to resolve
  attention history                      show recent resolution audit

  [--session <id>]                       target another session; an agent may
                                         only mutate its own session

The reader has NOT been following this session. Write for that reader:
  <the ask>   one line: what the human must decide or do — not backstory
  --context   background they need; EXPAND every codename/term of art
  --why       why this needs them now (what is blocked or at risk)
  --resolve   the concrete action that clears it

All fields render as markdown: use short bullet points, bold the key
point, no walls of text. Defaults to KTEAM_SESSION_ID. Attention items
never expire or auto-clear.`;

export type AttentionCliCommand =
  | {
      command: 'add';
      subject: string;
      why: string;
      context?: string;
      howToResolve: string;
      ask: AttentionAsk;
      session?: string;
    }
  | { command: 'ls'; session?: string }
  | { command: 'history'; session?: string }
  | { command: 'done'; id: AttentionId; note?: string; response?: AttentionResponse; session?: string }
  | { command: 'dismiss'; id: AttentionId; note?: string; session?: string }
  | { command: 'notify'; body: string; title?: string; kind?: 'completed' | 'failed'; session?: string };

const invalid = (message: string): never => {
  throw new AttentionError('invalid', `${message}\n\n${ATTENTION_CLI_USAGE}`);
};

const KIND_ALIASES: Record<string, AttentionAsk['kind']> = {
  permission: 'permission',
  choice: 'multiple-choice',
  'multiple-choice': 'multiple-choice',
  review: 'answer-review',
  'answer-review': 'answer-review',
  open: 'open-question',
  'open-question': 'open-question',
};

function askFromFlags(flags: Map<string, string[]>): AttentionAsk {
  const rawKind = flags.get('kind')?.at(-1)?.trim();
  const options = (flags.get('option') ?? []).map(option => option.trim()).filter(option => option.length > 0);
  const kind = rawKind ? KIND_ALIASES[rawKind] : options.length > 0 ? 'multiple-choice' : 'open-question';
  if (kind === undefined) {
    return invalid(`unknown --kind ${rawKind}; use permission, choice, review or open`);
  }
  if (kind !== 'multiple-choice') {
    if (options.length > 0) return invalid(`--option only makes sense with --kind choice`);
    return { kind };
  }
  const ask = parseAttentionAsk({ kind: 'multiple-choice', options: options.map(label => ({ label })) });
  if (ask === null) {
    return invalid('a choice ask needs 2+ distinct --option labels (each one line, at most 120 characters)');
  }
  return ask;
}

/** A bare flag (--approve) records . When the !A3 positional follows the
 * flag, splitTaskArgs binds it as the flag's value instead — recover it so
 * both `done !A3 --approve` and `done --approve !A3` work. */
function idFrom(positional: readonly string[], flags: Map<string, string[]>): AttentionId | null {
  const direct = parseAttentionId(positional[1]);
  if (direct !== null) return direct;
  for (const name of ['approve', 'reject', 'good']) {
    for (const value of flags.get(name) ?? []) {
      const recovered = parseAttentionId(value);
      if (recovered !== null) return recovered;
    }
  }
  return null;
}

function responseFromFlags(flags: Map<string, string[]>): AttentionResponse | undefined {
  const approve = flags.has('approve');
  const reject = flags.has('reject');
  const good = flags.has('good');
  const choice = flags.get('choice')?.at(-1);
  const clarify = flags.get('clarify')?.at(-1);
  const answer = flags.get('answer')?.at(-1);
  const picked = [approve || reject, choice !== undefined, good || clarify !== undefined, answer !== undefined].filter(
    Boolean,
  ).length;
  if (picked === 0) return undefined;
  if (picked > 1 || (approve && reject) || (good && clarify !== undefined)) {
    return invalid('give exactly one answer: --approve/--reject, --choice, --good/--clarify, or --answer');
  }
  if (approve || reject) return { kind: 'permission', decision: approve ? 'approve' : 'reject' };
  if (choice !== undefined) {
    if (!choice.trim()) return invalid('--choice needs the label of one listed option');
    return { kind: 'multiple-choice', choice };
  }
  if (good) return { kind: 'answer-review', verdict: 'good' };
  if (clarify !== undefined) {
    if (!clarify.trim()) return invalid('--clarify needs the clarification text');
    return { kind: 'answer-review', verdict: 'clarify', clarification: clarify };
  }
  if (!answer || !answer.trim()) return invalid('--answer needs the answer text');
  return { kind: 'open-question', answer };
}

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
    const id = idFrom(positional, flags);
    if (id === null) return invalid('done needs an attention reference like !A3 (see `attention ls`)');
    const note = flags.get('note')?.at(-1);
    const response = responseFromFlags(flags);
    return {
      command: 'done',
      id,
      ...(note && note.trim() ? { note } : {}),
      ...(response === undefined ? {} : { response }),
      ...scoped,
    };
  }
  if (head === 'dismiss') {
    const id = idFrom(positional, flags);
    if (id === null) return invalid('dismiss needs an attention reference like !A3 (see `attention ls`)');
    const note = flags.get('note')?.at(-1);
    return { command: 'dismiss', id, ...(note && note.trim() ? { note } : {}), ...scoped };
  }
  if (head === 'notify') {
    const body = positional.slice(1).join(' ').trim();
    if (!body) return invalid('notify needs the notification text');
    const title = flags.get('title')?.at(-1);
    const rawKind = flags.get('kind')?.at(-1)?.trim();
    if (rawKind !== undefined && rawKind !== 'completed' && rawKind !== 'failed') {
      return invalid('notify --kind must be completed or failed');
    }
    return {
      command: 'notify',
      body,
      ...(title && title.trim() ? { title } : {}),
      ...(rawKind === undefined ? {} : { kind: rawKind }),
      ...scoped,
    };
  }

  const subject = (head === 'add' ? positional.slice(1) : positional).join(' ').trim();
  if (!subject) return invalid('say what you need, or choose ls/done/dismiss/notify/history');
  const whyFlag = flags.get('why')?.at(-1);
  const contextFlag = flags.get('context')?.at(-1);
  const resolveFlag = flags.get('resolve')?.at(-1) ?? flags.get('how')?.at(-1);
  const ask = askFromFlags(flags);
  const why = whyFlag && whyFlag.trim() ? whyFlag : subject;
  const howToResolve =
    resolveFlag && resolveFlag.trim()
      ? resolveFlag
      : 'Answer this item on the attention board (it records who answered).';
  return {
    command: 'add',
    subject,
    why,
    ...(contextFlag && contextFlag.trim() ? { context: contextFlag } : {}),
    howToResolve,
    ask,
    ...scoped,
  };
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
          ...(command.context ? { context: command.context } : {}),
          howToResolve: command.howToResolve,
          ask: command.ask,
        },
      };
    case 'done':
      return {
        method: 'POST',
        path,
        body: {
          action: 'resolve',
          id: command.id,
          ...(command.note ? { note: command.note } : {}),
          ...(command.response ? { response: command.response } : {}),
        },
      };
    case 'dismiss':
      return {
        method: 'POST',
        path,
        body: { action: 'dismiss', id: command.id, ...(command.note ? { note: command.note } : {}) },
      };
    case 'notify':
      return {
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/notify`,
        body: {
          body: command.body,
          ...(command.title ? { title: command.title } : {}),
          ...(command.kind ? { kind: command.kind } : {}),
        },
      };
  }
}

const compact = (value: string, max = 84): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const actorLabel = (by: 'human' | 'agent' | 'daemon', name: string | null): string =>
  by === 'agent' ? `agent${name ? ` ${name}` : ''}` : by;

function askLine(ask: AttentionAsk | undefined): string | null {
  if (ask === undefined) return null;
  switch (ask.kind) {
    case 'permission':
      return 'answer: approve or reject';
    case 'multiple-choice':
      return `answer: pick one of ${ask.options.map(option => `"${compact(option.label, 32)}"`).join(' | ')}`;
    case 'answer-review':
      return 'answer: good, or ask to clarify';
    case 'open-question':
      return 'answer: write a full answer';
  }
}

export function renderAttentionList(snapshot: AttentionSnapshot): string {
  if (snapshot.parseErrors > 0) {
    return `Attention data has ${snapshot.parseErrors} parse error(s); repair the session file before trusting this list.\n`;
  }
  if (snapshot.items.length === 0) return 'Nothing needs attention.\n';
  const lines = [`${snapshot.count} unresolved item(s) in ${snapshot.sessionId} — oldest first`];
  for (const item of snapshot.items) {
    lines.push(`  ${attentionReference(item.id)}  [${item.source}]  ${compact(item.subject)}`);
    const ask = askLine(item.ask);
    if (ask) lines.push(`      ${ask}`);
    if (item.context) lines.push(`      context: ${compact(item.context)}`);
    lines.push(`      why: ${compact(item.why)}`);
    lines.push(`      resolve: ${compact(item.howToResolve)}`);
    lines.push(`      since ${item.waitingSince} · raised by ${actorLabel(item.raisedBy, item.raisedByName)}`);
  }
  return `${lines.join('\n')}\n`;
}

function resolutionLine(item: ResolvedAttentionItem): string {
  const verb = item.disposition === 'dismissed' ? 'dismissed' : 'resolved';
  const answer = item.response ? ` — ${compact(describeAttentionResponse(item.response), 60)}` : '';
  const note = item.resolutionNote ? ` — ${compact(item.resolutionNote, 60)}` : '';
  return `  ${attentionReference(item.id)}  ${compact(item.subject, 56)} · ${verb} by ${actorLabel(item.resolvedBy, item.resolvedByName)} at ${item.resolvedAt}${answer}${note}`;
}

export function renderAttentionHistory(snapshot: AttentionSnapshot): string {
  if (snapshot.resolved.length === 0) return 'No recorded resolutions.\n';
  return `Recent resolutions in ${snapshot.sessionId}\n${snapshot.resolved.map(resolutionLine).join('\n')}\n`;
}

export function renderAttentionCli(command: AttentionCliCommand, response: unknown): string {
  if (command.command === 'notify') {
    const raw = (response ?? {}) as Record<string, unknown>;
    const delivered = Number.isSafeInteger(raw['delivered']) ? (raw['delivered'] as number) : null;
    // Zero devices is worth saying out loud: the message went nowhere.
    return delivered === null
      ? 'notification sent\n'
      : `notification sent to ${delivered} device(s)${delivered === 0 ? ' — no registered device wants this kind' : ''}\n`;
  }
  const snapshot = response as AttentionSnapshot;
  switch (command.command) {
    case 'ls':
      return renderAttentionList(snapshot);
    case 'history':
      return renderAttentionHistory(snapshot);
    case 'add': {
      const recorded = [...snapshot.items]
        .reverse()
        .find(item => item.source === 'agent-raised' && item.subject.trim() === command.subject.trim());
      return `attention${recorded ? ` ${attentionReference(recorded.id)}` : ''} recorded — ${snapshot.count} unresolved item(s) in ${snapshot.sessionId}\n`;
    }
    case 'done':
      return `resolved ${attentionReference(command.id)} — ${snapshot.count} unresolved item(s) in ${snapshot.sessionId}\n`;
    case 'dismiss':
      return `dismissed ${attentionReference(command.id)} — ${snapshot.count} unresolved item(s) in ${snapshot.sessionId}\n`;
  }
}

export { AttentionError };
