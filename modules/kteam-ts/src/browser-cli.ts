import { BrowserError, type BrowserActionResult, type BrowserStatusView } from './browser-types';

export const BROWSER_CLI_USAGE = `kteam browser <command>

  open [url]                 start or reuse this session's browser; optionally navigate
  start                      start without navigating
  status                     show lifecycle, viewport, viewers, and last actor
  navigate <url>             navigate the shared browser (alias: goto)
  click <selector>           Playwright click (shell-quote selectors containing spaces)
  type <selector> <text...>  Playwright fill; text is not logged
  read [selector]            print visible text (body by default)
  screenshot <file.png>      save an explicit viewport screenshot to this path
  back                       navigate back
  forward                    navigate forward
  reload                     reload the current page
  resize <width> <height>    resize the Chrome/CDP viewport
  stop                       stop processes; the persistent login profile remains

  [--session <id>]           target another session (human admin only; an agent is
                             always restricted server-side to its own session)
  [--]                       end options (needed when typed text starts with --)

The human screencast viewer and Playwright may act at the same time; status reports who
acted most recently but does not arbitrate input.`;

export type BrowserCliCommand =
  | { command: 'status'; session?: string }
  | { command: 'start'; session?: string }
  | { command: 'open'; url?: string; session?: string }
  | { command: 'stop'; session?: string }
  | { command: 'navigate'; url: string; session?: string }
  | { command: 'click'; selector: string; session?: string }
  | { command: 'type'; selector: string; text: string; session?: string }
  | { command: 'read'; selector?: string; session?: string }
  | { command: 'screenshot'; output: string; session?: string }
  | { command: 'back'; session?: string }
  | { command: 'forward'; session?: string }
  | { command: 'reload'; session?: string }
  | { command: 'resize'; width: number; height: number; session?: string };

const invalid = (message: string): never => {
  throw new BrowserError('bad_request', `${message}\n\n${BROWSER_CLI_USAGE}`, 400);
};

function requireText(value: string | undefined, label: string): string {
  if (!value?.trim()) return invalid(`${label} is required`);
  return value;
}

function withSession<T extends object>(value: T, session: string | undefined): T & { session?: string } {
  return session ? { ...value, session } : value;
}

export function parseBrowserCli(argv: readonly string[]): BrowserCliCommand {
  const positional: string[] = [];
  let session: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (token === '--session') {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith('--')) return invalid('--session needs an id');
      session = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--session=')) {
      session = token.slice('--session='.length).trim() || invalid('--session needs an id');
      continue;
    }
    positional.push(token);
  }
  const command = positional[0];
  switch (command) {
    case 'status':
      return withSession({ command: 'status' as const }, session);
    case 'start':
      return withSession({ command: 'start' as const }, session);
    case 'open': {
      const url = positional[1]?.trim();
      return withSession({ command: 'open' as const, ...(url ? { url } : {}) }, session);
    }
    case 'stop':
    case 'close':
      return withSession({ command: 'stop' as const }, session);
    case 'navigate':
    case 'goto':
      return withSession({ command: 'navigate' as const, url: requireText(positional[1], 'URL') }, session);
    case 'click':
      return withSession({ command: 'click' as const, selector: requireText(positional[1], 'selector') }, session);
    case 'type':
      return withSession(
        {
          command: 'type' as const,
          selector: requireText(positional[1], 'selector'),
          text: positional.slice(2).join(' '),
        },
        session,
      );
    case 'read': {
      const selector = positional[1]?.trim();
      return withSession({ command: 'read' as const, ...(selector ? { selector } : {}) }, session);
    }
    case 'screenshot':
      return withSession(
        { command: 'screenshot' as const, output: requireText(positional[1], 'output file') },
        session,
      );
    case 'back':
      return withSession({ command: 'back' as const }, session);
    case 'forward':
      return withSession({ command: 'forward' as const }, session);
    case 'reload':
      return withSession({ command: 'reload' as const }, session);
    case 'resize': {
      const width = Number(positional[1]);
      const height = Number(positional[2]);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return invalid('resize needs numeric width and height');
      return withSession({ command: 'resize' as const, width, height }, session);
    }
    case undefined:
      return invalid('which browser command?');
    default:
      return invalid(`unknown browser command "${command}"`);
  }
}

export interface BrowserCliRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export function browserCliRequest(command: BrowserCliCommand, selfSessionId: string | undefined): BrowserCliRequest {
  const sessionId = command.session ?? selfSessionId?.trim();
  if (!sessionId) {
    throw new BrowserError('bad_request', 'no session id; run inside a kteam session or pass --session <id>', 400);
  }
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/browser`;
  switch (command.command) {
    case 'status':
      return { method: 'GET', path };
    case 'start':
      return { method: 'POST', path, body: { action: 'start' } };
    case 'open':
      return { method: 'POST', path, body: { action: 'open', ...(command.url ? { url: command.url } : {}) } };
    case 'stop':
      return { method: 'POST', path, body: { action: 'stop' } };
    case 'navigate':
      return { method: 'POST', path, body: { action: 'navigate', url: command.url } };
    case 'click':
      return { method: 'POST', path, body: { action: 'click', selector: command.selector } };
    case 'type':
      return { method: 'POST', path, body: { action: 'type', selector: command.selector, text: command.text } };
    case 'read':
      return {
        method: 'POST',
        path,
        body: { action: 'read', ...(command.selector ? { selector: command.selector } : {}) },
      };
    case 'screenshot':
      return { method: 'POST', path, body: { action: 'screenshot' } };
    case 'back':
      return { method: 'POST', path, body: { action: 'back' } };
    case 'forward':
      return { method: 'POST', path, body: { action: 'forward' } };
    case 'reload':
      return { method: 'POST', path, body: { action: 'reload' } };
    case 'resize':
      return { method: 'POST', path, body: { action: 'resize', width: command.width, height: command.height } };
  }
}

function renderStatus(status: BrowserStatusView): string {
  const lines = [
    `${status.sessionId}  browser ${status.state}  ${status.viewport.width}x${status.viewport.height}  viewers ${status.viewers}/${status.capacity.maximum}`,
    `profile persistent · idle timeout ${status.idleTimeoutSeconds}s${status.idleDeadline ? ` · idle deadline ${status.idleDeadline}` : ''}`,
  ];
  if (status.lastActor)
    lines.push(`last ${status.lastActor.kind}: ${status.lastActor.action} at ${status.lastActor.at}`);
  if (status.error) lines.push(`error: ${status.error}`);
  return `${lines.join('\n')}\n`;
}

export function renderBrowserCli(command: BrowserCliCommand, response: unknown): string {
  const payload = response as BrowserActionResult | BrowserStatusView;
  const status = 'status' in payload ? payload.status : payload;
  if (command.command === 'read' && 'result' in payload) return `${payload.result?.text ?? ''}\n`;
  if (command.command === 'screenshot') return '';
  if ('result' in payload && payload.result?.url) {
    return `${payload.result.title ? `${payload.result.title}\n` : ''}${payload.result.url}\n`;
  }
  return renderStatus(status);
}

/** Decode only an explicit screenshot response; the caller chooses and writes
 * the output path. No automatic screenshots are persisted by the daemon. */
export function browserScreenshotBytes(response: unknown): Uint8Array {
  const encoded = (response as BrowserActionResult).result?.screenshotBase64;
  if (!encoded) throw new BrowserError('upstream_failed', 'daemon returned no screenshot bytes', 502);
  return Uint8Array.from(Buffer.from(encoded, 'base64'));
}
