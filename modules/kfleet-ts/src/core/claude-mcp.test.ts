import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_MCP_SIDECAR, mergeClaudeMcpServers } from './claude-mcp';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'kfleet-mcp-'));
const read = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')) as Record<string, any>;
const SLACK = { type: 'http', url: 'http://127.0.0.1:37373/mcp' };

describe('mergeClaudeMcpServers', () => {
  test('replaces a direct same-name entry, keeps other keys and hand-added servers', () => {
    const dir = tmp();
    const file = path.join(dir, '.claude.json');
    writeFileSync(
      file,
      JSON.stringify({
        oauthAccount: { emailAddress: 'x' },
        mcpServers: {
          slack: { type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: 'c' } },
          mine: { type: 'stdio', command: 'x' },
        },
      }),
      { mode: 0o600 },
    );
    expect(mergeClaudeMcpServers(dir, { slack: SLACK })).toBe(true);
    const c = read(dir);
    expect(c.mcpServers).toEqual({ slack: SLACK, mine: { type: 'stdio', command: 'x' } });
    expect(c.oauthAccount).toEqual({ emailAddress: 'x' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(mergeClaudeMcpServers(dir, { slack: SLACK })).toBe(false); // idempotent
  });

  test('creates .claude.json on a fresh home and removes owned servers once dropped', () => {
    const dir = tmp();
    expect(mergeClaudeMcpServers(dir, { slack: SLACK })).toBe(true);
    expect(read(dir).mcpServers).toEqual({ slack: SLACK });
    expect(existsSync(path.join(dir, CLAUDE_MCP_SIDECAR))).toBe(true);
    expect(mergeClaudeMcpServers(dir, {})).toBe(true);
    expect(read(dir).mcpServers).toEqual({});
    expect(existsSync(path.join(dir, CLAUDE_MCP_SIDECAR))).toBe(false);
  });

  test('no-op without servers or ownership; leaves an unparseable file alone', () => {
    const dir = tmp();
    expect(mergeClaudeMcpServers(dir, {})).toBe(false);
    expect(existsSync(path.join(dir, '.claude.json'))).toBe(false);
    writeFileSync(path.join(dir, '.claude.json'), '{not json');
    expect(mergeClaudeMcpServers(dir, { slack: SLACK })).toBe(false);
    expect(readFileSync(path.join(dir, '.claude.json'), 'utf8')).toBe('{not json');
  });
});
