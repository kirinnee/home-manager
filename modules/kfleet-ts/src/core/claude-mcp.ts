// Fleet-wide user-scope MCP servers for Claude homes.
//
// Claude Code reads user-scope servers ONLY from `mcpServers` in
// $CLAUDE_CONFIG_DIR/.claude.json — a `.mcp.json` in the config dir is never
// loaded (that name is project scope: <cwd>/.mcp.json). .claude.json is a
// runtime file (OAuth account, trust, /model…), so kfleet merges just the
// servers it owns into it and records their names in a sidecar; a server
// dropped from the template is removed, anything added by hand
// (`claude mcp add -s user`) is left alone unless it has a fleet-owned name.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CLAUDE_MCP_SIDECAR = '.kfleet-mcp.json';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Source file: `{ "mcpServers": { name: config } }` (or the bare map). */
export function readMcpSource(src: string): Obj {
  const parsed = JSON.parse(readFileSync(src, 'utf8')) as unknown;
  const servers = isObj(parsed) && isObj(parsed.mcpServers) ? parsed.mcpServers : parsed;
  if (!isObj(servers)) throw new Error(`mcp source must be a JSON object of servers: ${src}`);
  return servers;
}

function readOwned(dir: string): string[] {
  try {
    const s = JSON.parse(readFileSync(path.join(dir, CLAUDE_MCP_SIDECAR), 'utf8')) as Obj;
    return Array.isArray(s.servers) ? s.servers.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function atomicWrite(file: string, text: string, mode: number): void {
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.kfleet-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Merge `servers` into `<dir>/.claude.json` mcpServers (fleet entries win),
 * removing previously fleet-owned names no longer present. Returns true when
 * .claude.json changed. An unparseable .claude.json is left untouched.
 */
export function mergeClaudeMcpServers(dir: string, servers: Obj): boolean {
  const configPath = path.join(dir, '.claude.json');
  const sidecar = path.join(dir, CLAUDE_MCP_SIDECAR);
  const owned = readOwned(dir);
  const names = Object.keys(servers);
  if (names.length === 0 && owned.length === 0) return false;

  const existed = existsSync(configPath);
  let config: Obj = {};
  if (existed) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      if (!isObj(parsed)) return false;
      config = parsed;
    } catch {
      return false;
    }
  }
  const before = JSON.stringify(config.mcpServers ?? null);
  const current: Obj = isObj(config.mcpServers) ? { ...config.mcpServers } : {};
  for (const n of owned) if (!(n in servers)) delete current[n];
  for (const [n, v] of Object.entries(servers)) current[n] = v;

  let changed = false;
  if (JSON.stringify(current) !== before && !(before === 'null' && Object.keys(current).length === 0)) {
    config.mcpServers = current;
    const mode = existed ? statSync(configPath).mode & 0o777 : 0o600;
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, mode);
    changed = true;
  }
  if (names.length === 0) rmSync(sidecar, { force: true });
  else if (JSON.stringify([...owned].sort()) !== JSON.stringify([...names].sort()))
    atomicWrite(sidecar, `${JSON.stringify({ version: 1, servers: names }, null, 2)}\n`, 0o644);
  return changed;
}
