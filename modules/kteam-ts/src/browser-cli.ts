// TYPE-ONLY on purpose. browser-api pulls in browser-runtime and therefore the
// Playwright client; the CLI must stay a thin HTTP caller that costs nothing to
// start. The value below is mirrored rather than imported for the same reason.
import type { BrowserLoginStatusView } from './browser-api';
import { BrowserError, type BrowserActionResult, type BrowserStatusView } from './browser-types';

/** Mirrors `BROWSER_LOGIN_MAX_MINUTES` in browser-api.ts, which is the
 * authority — the daemon re-validates every request. browser-cli.test.ts
 * asserts the two are equal so they cannot drift apart silently. */
export const BROWSER_LOGIN_CLI_MAX_MINUTES = 60;

export const BROWSER_CLI_USAGE = `kteam browser <command>

  open [url]                 start or reuse this session's browser; optionally navigate
  start                      start without navigating
  status                     show lifecycle, tabs, viewport, viewers, and last actor
  new-page [url]             create and activate a browser tab; optionally navigate
  activate-page <id>         make a browser tab active
  close-page <id>            close a browser tab
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

  login status               human sign-in window: state, deadline, connection
  login start [--minutes N]  open it (default 15, max 60); agents lose the browser
  login confirm              mark the profile signed in, leave the window open
  login stop [--primed]      close it; --primed also marks the profile signed in

  [--session <id>]           target another session (human admin only; an agent is
                             always restricted server-side to its own session)
  [--]                       end options (needed when typed text starts with --)

The login window is daemon-global, not per session, and is human-admin only: a warden
and an agent are both refused server-side. It prints an SSH tunnel command and a
one-shot VNC password; reach it over that tunnel, never over the public UI.

The human screencast viewer and Playwright may act at the same time; status reports who
acted most recently but does not arbitrate input.`;

export type BrowserCliCommand =
  | { command: 'status'; session?: string }
  | { command: 'start'; session?: string }
  | { command: 'open'; url?: string; session?: string }
  | { command: 'new-page'; url?: string; session?: string }
  | { command: 'activate-page'; pageId: string; session?: string }
  | { command: 'close-page'; pageId: string; session?: string }
  | { command: 'stop'; session?: string }
  | { command: 'navigate'; url: string; session?: string }
  | { command: 'click'; selector: string; session?: string }
  | { command: 'type'; selector: string; text: string; session?: string }
  | { command: 'read'; selector?: string; session?: string }
  | { command: 'screenshot'; output: string; session?: string }
  | { command: 'back'; session?: string }
  | { command: 'forward'; session?: string }
  | { command: 'reload'; session?: string }
  | { command: 'resize'; width: number; height: number; session?: string }
  /** Daemon-global; `session` is deliberately absent from this member because
   * the window is about the one shared profile, not about any session. */
  | { command: 'login'; action: 'status' }
  | { command: 'login'; action: 'start'; minutes?: number }
  | { command: 'login'; action: 'stop'; primed?: boolean }
  | { command: 'login'; action: 'confirm' };

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

function loginMinutes(raw: string | undefined): number {
  const minutes = Number(raw);
  if (!raw || !Number.isInteger(minutes) || minutes < 1 || minutes > BROWSER_LOGIN_CLI_MAX_MINUTES) {
    return invalid(`--minutes needs a whole number between 1 and ${BROWSER_LOGIN_CLI_MAX_MINUTES}`);
  }
  return minutes;
}

export function parseBrowserCli(argv: readonly string[]): BrowserCliCommand {
  const positional: string[] = [];
  let session: string | undefined;
  let minutes: number | undefined;
  let primed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    // Login-window options. Like `--session` they are consumed before the
    // positional list, so `--` remains the way to type text that starts with a
    // dash.
    if (token === '--primed') {
      primed = true;
      continue;
    }
    if (token === '--minutes') {
      minutes = loginMinutes(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith('--minutes=')) {
      minutes = loginMinutes(token.slice('--minutes='.length));
      continue;
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
  // `--minutes`/`--primed` belong to the login window and nothing else.
  // Accepting and ignoring them elsewhere would report success for something
  // that never happened.
  if (command !== 'login' && (minutes !== undefined || primed)) {
    return invalid('--minutes and --primed apply only to "browser login"');
  }
  switch (command) {
    case 'login': {
      const action = positional[1]?.trim();
      if (minutes !== undefined && action !== 'start')
        return invalid('--minutes applies only to "browser login start"');
      if (primed && action !== 'stop' && action !== 'close') {
        return invalid('--primed applies only to "browser login stop"');
      }
      switch (action) {
        case 'status':
          return { command: 'login' as const, action: 'status' as const };
        case 'start':
          return { command: 'login' as const, action: 'start' as const, ...(minutes === undefined ? {} : { minutes }) };
        case 'confirm':
          return { command: 'login' as const, action: 'confirm' as const };
        case 'stop':
        case 'close':
          return { command: 'login' as const, action: 'stop' as const, ...(primed ? { primed: true } : {}) };
        case undefined:
          // Deliberately NOT defaulted to `status`. "browser login" reads to
          // one person as "show me" and to another as "open it"; guessing would
          // either open a window nobody asked for or quietly not open one.
          return invalid('browser login needs start, status, stop, or confirm');
        default:
          return invalid(`unknown browser login action "${action}"`);
      }
    }
    case 'status':
      return withSession({ command: 'status' as const }, session);
    case 'start':
      return withSession({ command: 'start' as const }, session);
    case 'open': {
      const url = positional[1]?.trim();
      return withSession({ command: 'open' as const, ...(url ? { url } : {}) }, session);
    }
    case 'new-page': {
      const url = positional[1]?.trim();
      return withSession({ command: 'new-page' as const, ...(url ? { url } : {}) }, session);
    }
    case 'activate-page':
      return withSession({ command: 'activate-page' as const, pageId: requireText(positional[1], 'page id') }, session);
    case 'close-page':
      return withSession({ command: 'close-page' as const, pageId: requireText(positional[1], 'page id') }, session);
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

export const BROWSER_LOGIN_PATH = '/v1/browser/login';

export function browserCliRequest(command: BrowserCliCommand, selfSessionId: string | undefined): BrowserCliRequest {
  // The login window is daemon-global: it is about the one shared profile, not
  // about any session, so it must be built BEFORE the session-id requirement.
  // Demanding a session id for it would be a lie about what the route targets.
  if (command.command === 'login') {
    switch (command.action) {
      case 'status':
        return { method: 'GET', path: BROWSER_LOGIN_PATH };
      case 'start':
        return {
          method: 'POST',
          path: BROWSER_LOGIN_PATH,
          body: { action: 'start', ...(command.minutes === undefined ? {} : { minutes: command.minutes }) },
        };
      case 'stop':
        return {
          method: 'POST',
          path: BROWSER_LOGIN_PATH,
          body: { action: 'stop', ...(command.primed === undefined ? {} : { primed: command.primed }) },
        };
      case 'confirm':
        return { method: 'POST', path: BROWSER_LOGIN_PATH, body: { action: 'confirm' } };
    }
  }
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
    case 'new-page':
      return { method: 'POST', path, body: { action: 'new-page', ...(command.url ? { url: command.url } : {}) } };
    case 'activate-page':
      return { method: 'POST', path, body: { action: 'activate-page', pageId: command.pageId } };
    case 'close-page':
      return { method: 'POST', path, body: { action: 'close-page', pageId: command.pageId } };
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
  if (status.agentPage)
    lines.push(`agent page ${status.agentPage.pageId}: ${status.agentPage.action} at ${status.agentPage.at}`);
  if (status.pages) {
    lines.push(
      ...status.pages.map(
        page => `${page.id === status.activePageId ? '*' : ' '} ${page.id}  ${page.title || '(untitled)'}  ${page.url}`,
      ),
    );
  }
  if (status.pageState) {
    const history =
      status.canGoBack === undefined && status.canGoForward === undefined
        ? ''
        : ` · back ${status.canGoBack ? 'yes' : 'no'} · forward ${status.canGoForward ? 'yes' : 'no'}`;
    lines.push(`page ${status.pageState}${history}`);
  }
  if (status.pageError) lines.push(`page error: ${status.pageError}`);
  if (status.error) lines.push(`error: ${status.error}`);
  return `${lines.join('\n')}\n`;
}

/** ABSENCE RENDERS AS UNKNOWN. A response that carries no `state` is a daemon
 * that did not tell us — not a closed window. Printing "closed" there would
 * teach the human that a live sign-in window had shut, which is the most
 * dangerous lie this feature can tell. Same rule for `profilePrimed`. */
function renderLoginStatus(response: unknown): string {
  const view = (response && typeof response === 'object' ? response : {}) as Partial<BrowserLoginStatusView>;
  const state = typeof view.state === 'string' ? view.state : 'unknown';
  const lines = [`browser login window: ${state}`];
  if (view.openedAt) lines.push(`opened ${view.openedAt}`);
  if (view.expiresAt) lines.push(`closes ${view.expiresAt}`);
  lines.push(`profile primed: ${view.profilePrimed === undefined ? 'unknown' : view.profilePrimed ? 'yes' : 'no'}`);
  const connection = view.connection;
  if (connection) {
    // The daemon substitutes the real port; nobody assembles this by hand.
    lines.push(`tunnel: ${connection.sshTunnel}`);
    lines.push(`then point a VNC viewer at ${connection.host}:${connection.port}`);
    lines.push(`password: ${connection.password}`);
  }
  if (view.error) lines.push(`error: ${view.error}`);
  return `${lines.join('\n')}\n`;
}

export function renderBrowserCli(command: BrowserCliCommand, response: unknown): string {
  if (command.command === 'login') return renderLoginStatus(response);
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
