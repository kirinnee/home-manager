// Where kslack-proxy keeps state and which knobs the environment can turn.
import os from 'node:os';
import path from 'node:path';

/** Slack's official hosted MCP server — the only upstream this proxy talks to. */
export const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';
/** Claude Code's registered Slack MCP OAuth client (public client, PKCE, no secret). */
export const SLACK_CLIENT_ID = '1601185624273.8899143856786';
/** The client's registered redirect is http://localhost:3118/callback. */
export const CALLBACK_PORT = 3118;
/** Fixed fleet port: every claude-* / codex-* account points at 127.0.0.1:37373/mcp. */
export const DEFAULT_PORT = 37373;
/** Proactive refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface ProxyConfig {
  stateDir: string;
  tokenPath: string;
  port: number;
  upstream: string;
  allowWrites: boolean;
}

export function loadConfig(env: Readonly<NodeJS.ProcessEnv> = process.env): ProxyConfig {
  const home = env.HOME ?? os.homedir();
  const stateDir = env.KSLACK_PROXY_STATE_DIR ?? path.join(home, '.local', 'state', 'kslack-proxy');
  const port = Number(env.KSLACK_PROXY_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`invalid KSLACK_PROXY_PORT: ${env.KSLACK_PROXY_PORT}`);
  return {
    stateDir,
    tokenPath: path.join(stateDir, 'token.json'),
    port,
    upstream: env.KSLACK_PROXY_UPSTREAM ?? SLACK_MCP_URL,
    allowWrites: env.KSLACK_PROXY_ALLOW_WRITES === '1',
  };
}
