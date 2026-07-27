// `kteam pin …` — argv parsing, request building and terminal rendering, all
// pure. index.ts is contended, so its patch is a dispatch of a handful of lines
// (mirroring the `kteam task` patch):
//
//     const command = parsePinCli(argv);
//     const request = pinCliRequest(command, process.env.KTEAM_SESSION_ID);
//     const response = await client.request(request.path, { method, body… });
//     process.stdout.write(renderPinCli(command, response));
//
// DEFAULTS TO SELF, like `kteam signal`: `kteam pin "…"` pins to the calling
// session (KTEAM_SESSION_ID), so the common agent case needs no id. `--session`
// targets another session explicitly (the human's board management); the daemon
// still refuses a cross-session write from an agent (pins-service scope-to-self).
//
// NO I/O, NO HTTP — `pinCliRequest` describes the call; the existing api-client
// makes it, with the `x-kteam-request-id` header it already sends so a retried
// `pin` adds at most one pin.

import { splitTaskArgs } from './tasks-cli';
import { PinError, type Pin, type PinSnapshot } from './pins-types';

export const PIN_CLI_USAGE = `kteam pin <command>

  pin "<note or link>"     add a note pin to THIS session (KTEAM_SESSION_ID)
  pin add "<text>"         same, explicit
  pin ls                   list this session's pins
  pin rm <pinId>           remove a pin by id

  [--session <id>]         target another session (the human's own board;
                           an agent may only pin to its own session)

An agent pin is tagged [agent]; a human pin is untagged — so a reader can always
tell who put a pin there.`;

export type PinCliCommand =
  | { command: 'add'; text: string; session?: string }
  | { command: 'ls'; session?: string }
  | { command: 'rm'; id: string; session?: string };

const invalid = (message: string): never => {
  throw new PinError('invalid', `${message}\n\n${PIN_CLI_USAGE}`);
};

/** Parse `kteam pin …` argv (WITHOUT the leading `pin`). Throws
 *  PinError('invalid') whose message carries the usage block. */
export function parsePinCli(argv: readonly string[]): PinCliCommand {
  const { positional, flags } = splitTaskArgs(argv);
  const session = flags.get('session')?.at(-1);
  const target = session && session.trim().length > 0 ? session.trim() : undefined;
  const head = positional[0];
  if (head === 'ls' || head === 'list') return { command: 'ls', ...(target ? { session: target } : {}) };
  if (head === 'rm' || head === 'remove') {
    const id = positional[1];
    if (id === undefined || id.trim().length === 0) return invalid('rm needs a pin id (see `pin ls`)');
    return { command: 'rm', id: id.trim(), ...(target ? { session: target } : {}) };
  }
  const text = (head === 'add' ? positional.slice(1) : positional).join(' ').trim();
  if (text.length === 0) return invalid('nothing to pin — give a note or link');
  return { command: 'add', text, ...(target ? { session: target } : {}) };
}

export interface PinCliRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** The HTTP call a parsed command needs. `selfSessionId` is KTEAM_SESSION_ID,
 *  read by the wiring; `--session` overrides it. Throws when neither is present
 *  (the human's own shell must name a target). */
export function pinCliRequest(command: PinCliCommand, selfSessionId: string | undefined): PinCliRequest {
  const id = command.session ?? (selfSessionId && selfSessionId.trim().length > 0 ? selfSessionId.trim() : undefined);
  if (id === undefined) {
    throw new PinError('invalid', 'no session id; run inside a kteam session or pass --session <id>');
  }
  const path = `/v1/sessions/${encodeURIComponent(id)}/pins`;
  switch (command.command) {
    case 'ls':
      return { method: 'GET', path };
    case 'add':
      return { method: 'POST', path, body: { action: 'add', kind: 'note', text: command.text } };
    case 'rm':
      return { method: 'POST', path, body: { action: 'remove', id: command.id } };
  }
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

function pinLine(pin: Pin): string {
  const tag = pin.by === 'agent' ? `[agent${pin.createdByName ? ` ${pin.createdByName}` : ''}]` : '';
  const body =
    pin.kind === 'note'
      ? pin.text.replace(/\s+/g, ' ').trim()
      : `${pin.blockKind}: ${pin.preview.replace(/\s+/g, ' ').trim() || '(empty message)'}`;
  const shown = body.length > 80 ? `${body.slice(0, 79)}…` : body;
  return `  ${pad(pin.id.slice(0, 8), 9)} ${pad(pin.kind, 8)} ${pad(tag, 18)} ${shown}`;
}

export function renderPinList(snapshot: PinSnapshot): string {
  if (snapshot.pins.length === 0) return 'No pins.\n';
  const lines = [`${snapshot.pins.length} pin(s) in ${snapshot.sessionId}`];
  for (const pin of snapshot.pins) lines.push(pinLine(pin));
  return `${lines.join('\n')}\n`;
}

/** What a command prints, given the daemon's snapshot response. */
export function renderPinCli(command: PinCliCommand, response: unknown): string {
  const snapshot = response as PinSnapshot;
  switch (command.command) {
    case 'ls':
      return renderPinList(snapshot);
    case 'add':
      return `pinned — ${snapshot.pins.length} pin(s) in ${snapshot.sessionId}\n`;
    case 'rm':
      return `removed ${command.id} — ${snapshot.pins.length} pin(s) in ${snapshot.sessionId}\n`;
  }
}

export { PinError };
