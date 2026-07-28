import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import type { KTeamPaths } from './paths';
import {
  isWardenSpawnProvenance,
  provenancePath,
  renderProvenanceMarkdown,
  type WardenSpawnProvenance,
} from './warden-provenance';
import { parseWardenReports, type WardenVerdict, type WardenVerdictSpawn } from './warden-verdicts';

const isMissingPath = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export async function readWardenProvenance(reportPath: string): Promise<WardenSpawnProvenance | undefined> {
  let raw: string;
  try {
    raw = await readFile(provenancePath(reportPath), 'utf8');
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid warden provenance sidecar for ${path.basename(reportPath)}`, { cause: error });
  }
  if (!isWardenSpawnProvenance(parsed))
    throw new Error(`invalid warden provenance sidecar for ${path.basename(reportPath)}`);
  return parsed;
}

export function mergeWardenReportProvenance(content: string, spawn?: WardenSpawnProvenance): string {
  return spawn ? `${renderProvenanceMarkdown(spawn)}\n\n${content}` : content;
}

export async function readWardenReport(reportPath: string): Promise<string> {
  const content = await readFile(reportPath, 'utf8');
  const spawn = await readWardenProvenance(reportPath);
  return mergeWardenReportProvenance(content, spawn);
}

/** Read and parse raw report markdown, then attach sidecar facts. The rendered
 *  provenance block never enters classifyVerdict()'s legacy phrase scanner. */
export async function readWardenVerdicts(
  paths: Pick<KTeamPaths, 'wardenReports'>,
  limit = 20,
): Promise<WardenVerdict[]> {
  let names: string[];
  try {
    names = (await readdir(paths.wardenReports)).filter(name => name.endsWith('.md'));
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const stats = await Promise.all(
    names.map(async name => {
      const reportPath = path.join(paths.wardenReports, name);
      const details = await stat(reportPath).catch(error => {
        if (isMissingPath(error)) return undefined;
        throw error;
      });
      return details ? { path: reportPath, mtimeMs: details.mtimeMs } : undefined;
    }),
  );
  const recent = stats
    .filter((item): item is { path: string; mtimeMs: number } => item !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(40, limit * 2));
  const files = await Promise.all(
    recent.map(async report => {
      const content = await readFile(report.path, 'utf8').catch(error => {
        if (isMissingPath(error)) return '';
        throw error;
      });
      return { ...report, content };
    }),
  );
  const populated = files.filter(file => file.content);
  const provenance = new Map(
    await Promise.all(populated.map(async file => [file.path, await readWardenProvenance(file.path)] as const)),
  );
  return parseWardenReports(populated, limit).map(verdict => {
    const spawn = provenance.get(verdict.reportPath);
    if (!spawn) return verdict;
    const verdictSpawn: WardenVerdictSpawn = spawn.failedOver
      ? { ...spawn, failoverReason: spawn.skipped[spawn.configuredFirst] }
      : spawn;
    return { ...verdict, spawn: verdictSpawn };
  });
}
