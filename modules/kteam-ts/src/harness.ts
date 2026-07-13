import { existsSync } from 'fs';
import { readFile, readdir, realpath, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Harness, SessionConfig } from './types';

const HOME = os.homedir();

export function resolveBinary(binary: string, searchPath = process.env.PATH ?? ''): string | undefined {
  if (binary.includes(path.sep)) return existsSync(binary) ? path.resolve(binary) : undefined;
  for (const dir of searchPath.split(path.delimiter)) {
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function wrapperHome(wrapper: string, harness: Harness): Promise<string | undefined> {
  const source = await readFile(wrapper, 'utf8').catch(() => '');
  const variable = harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const match = source.match(new RegExp(`export\\s+${variable}=["']?([^"'\\n]+)["']?`));
  if (!match?.[1]) return undefined;
  return match[1]
    .replace(/^\$HOME(?=\/|$)/, HOME)
    .replace(/^\$KTEAM_HOME(?=\/|$)/, process.env.KTEAM_HOME ?? path.join(HOME, '.kteam'))
    .replace(/^~(?=\/|$)/, HOME);
}

async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkJsonl(child)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(child);
  }
  return out;
}

export async function codexSessionMeta(file: string): Promise<{ id?: string; cwd?: string }> {
  const head = await Bun.file(file)
    .slice(0, 32_768)
    .text()
    .catch(() => '');
  for (const line of head.split('\n').slice(0, 8)) {
    try {
      const event = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (event.type === 'session_meta') return event.payload ?? {};
      if (event.payload?.id && event.payload?.cwd) return event.payload;
    } catch {}
  }
  return { id: path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] };
}

export async function codexSessionIds(home: string): Promise<string[]> {
  const metas = await Promise.all((await walkJsonl(path.join(home, 'sessions'))).map(codexSessionMeta));
  return metas.flatMap(meta => (meta.id ? [meta.id] : []));
}

async function transcriptContainsAny(file: string, needles: string[]): Promise<boolean> {
  const source = Bun.file(file);
  const window = 1024 * 1024;
  const head = await source
    .slice(0, Math.min(source.size, window))
    .text()
    .catch(() => '');
  if (needles.some(needle => head.includes(needle))) return true;
  if (source.size <= window) return false;
  const tail = await source
    .slice(Math.max(0, source.size - window), source.size)
    .text()
    .catch(() => '');
  return needles.some(needle => tail.includes(needle));
}

export async function discoverCodexSession(
  config: SessionConfig,
  excludedSessionIds: Iterable<string> = [],
): Promise<{ id: string; file: string } | undefined> {
  if (config.harness !== 'codex' || !config.harnessHome) return undefined;
  const baseline = new Set(config.harnessSessionBaseline ?? []);
  const excluded = new Set(excludedSessionIds);
  const canonicalCwd = await realpath(config.cwd).catch(() => path.resolve(config.cwd));
  const candidates: { id: string; file: string; mtime: number }[] = [];
  for (const file of await walkJsonl(path.join(config.harnessHome, 'sessions'))) {
    const meta = await codexSessionMeta(file);
    const candidateCwd = meta.cwd ? await realpath(meta.cwd).catch(() => path.resolve(meta.cwd!)) : undefined;
    if (!meta.id || baseline.has(meta.id) || excluded.has(meta.id) || (candidateCwd && candidateCwd !== canonicalCwd))
      continue;
    const info = await stat(file).catch(() => undefined);
    if (info) candidates.push({ id: meta.id, file, mtime: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const coordinationDirectory = path.dirname(config.systemPromptFile);
  const correlated = [];
  for (const candidate of candidates) {
    if (await transcriptContainsAny(candidate.file, [coordinationDirectory])) correlated.push(candidate);
  }
  if (correlated.length > 0) return { id: correlated[0]!.id, file: correlated[0]!.file };
  // Never guess by cwd or recency: concurrent sessions commonly share both.
  // Reconciliation will retry after Codex flushes the unique injected path.
  return undefined;
}

export function claudeTranscriptPath(config: SessionConfig): string | undefined {
  if (config.harness !== 'claude' || !config.harnessHome || !config.harnessSessionId) return undefined;
  const project = config.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(config.harnessHome, 'projects', project, `${config.harnessSessionId}.jsonl`);
}
