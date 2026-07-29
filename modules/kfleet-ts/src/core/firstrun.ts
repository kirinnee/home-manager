import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Kind } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Seed the one-time Claude prompts that would otherwise block a fresh account
 * before it can reach login. The generated wrapper carries the same safeguards;
 * this TypeScript path also covers wrapper-less and jq-less fresh machines.
 *
 * Existing preferences and unknown fields are preserved. An unreadable config
 * is left untouched rather than being replaced with a guessed shape.
 */
export function seedFirstRunFlags(
  kind: Kind,
  dir: string,
  cwd = process.cwd(),
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  if (kind !== 'claude' || env.CLAUDE_AUTOTRUST === '0') return false;

  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, '.claude.json');
  const existed = existsSync(configPath);
  let config: Record<string, unknown> = {};
  if (existed) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      if (!isRecord(parsed)) return false;
      config = parsed;
    } catch {
      return false;
    }
  }

  const before = JSON.stringify(config);
  config.hasCompletedOnboarding = true;
  config.hasCompletedClaudeInChromeOnboarding = true;
  if (config.claudeInChromeDefaultEnabled == null) config.claudeInChromeDefaultEnabled = false;

  let projects: Record<string, unknown>;
  if (config.projects == null) {
    projects = {};
    config.projects = projects;
  } else if (isRecord(config.projects)) {
    projects = config.projects;
  } else {
    return false;
  }

  let project: Record<string, unknown>;
  if (projects[cwd] == null) {
    project = {};
    projects[cwd] = project;
  } else if (isRecord(projects[cwd])) {
    project = projects[cwd];
  } else {
    return false;
  }
  project.hasTrustDialogAccepted = true;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    let responses: Record<string, unknown> | undefined;
    if (config.customApiKeyResponses == null) {
      responses = {};
      config.customApiKeyResponses = responses;
    } else if (isRecord(config.customApiKeyResponses)) {
      responses = config.customApiKeyResponses;
    }

    if (responses) {
      const approved = responses.approved;
      if (approved == null || Array.isArray(approved)) {
        const storedKey = apiKey.length > 20 ? apiKey.slice(-20) : apiKey;
        const values = approved == null ? [] : [...approved];
        if (!values.includes(storedKey)) values.push(storedKey);
        responses.approved = values;
      }
    }
  }

  if (before === JSON.stringify(config)) return false;

  const tempPath = path.join(dir, `.claude.json.kfleet-${randomUUID()}.tmp`);
  try {
    const mode = existed ? statSync(configPath).mode & 0o777 : 0o600;
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode });
    renameSync(tempPath, configPath);
    return true;
  } catch {
    rmSync(tempPath, { force: true });
    return false;
  }
}
