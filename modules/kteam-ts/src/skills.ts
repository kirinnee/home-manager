/**
 * The small, display-safe part of a harness skill manifest.  Keep this separate
 * from the on-disk format: SKILL.md is intentionally not exposed through the
 * daemon merely to power the composer autocomplete.
 */
export interface AvailableSkill {
  name: string;
  description: string;
}

import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

type FrontmatterValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'block'; style: 'literal' | 'folded'; lines: string[]; indent?: number };

const FRONTMATTER_DELIMITER = /^---[ \t]*\r?$/;
const FIELD = /^( *)([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/;
const BLOCK_INDICATOR = /^([|>])([+-]?[1-9]?|[1-9]?[+-]?)$/;

/** Codex installs this manifest beside its public system skills, but reserves it
 * for detached review threads. It is absent from both the model-visible skill
 * catalog and explicit `$review-agent` resolution, so offering it in the human
 * composer would insert a mention the live harness cannot resolve. A direct
 * account skill with the same name remains valid; this filter is system-only. */
const INTERNAL_CODEX_SYSTEM_SKILLS = new Set(['review-agent']);

/** A catalog is metadata, not a document endpoint; do not retain arbitrary files. */
export const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;

/**
 * Read the first YAML frontmatter document only.  This is deliberately not a
 * YAML parser: manifests only need name and description, and accepting a small
 * subset keeps malformed or surprising metadata from affecting the API.
 */
export function parseSkillFrontmatter(markdown: string): AvailableSkill | undefined {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!FRONTMATTER_DELIMITER.test(lines[0] ?? '')) return undefined;

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_DELIMITER.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  if (end < 0) return undefined;

  const fields = new Map<string, FrontmatterValue>();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const field = FIELD.exec(line);
    if (!field) continue;

    const [, indentation, rawKey, rawValue = ''] = field;
    const key = rawKey.toLowerCase();
    const indicator = BLOCK_INDICATOR.exec(rawValue.trim());
    if (indicator) {
      const blockLines: string[] = [];
      const keyIndent = indentation.length;
      let blockIndent: number | undefined;
      let malformed = false;
      let cursor = index + 1;
      for (; cursor < end; cursor += 1) {
        const candidate = lines[cursor]!;
        if (candidate.trim() === '') {
          blockLines.push('');
          continue;
        }
        const candidateIndent = candidate.match(/^ */)?.[0]?.length ?? 0;
        if (candidateIndent <= keyIndent) break;
        blockIndent = blockIndent === undefined ? candidateIndent : Math.min(blockIndent, candidateIndent);
        blockLines.push(candidate);
      }
      // An explicit indentation indicator is a promise about the block.  A
      // smaller continuation is malformed rather than silently reinterpreted.
      const indentDigit = indicator[2].match(/[1-9]/)?.[0];
      const explicitIndent = indentDigit === undefined ? undefined : keyIndent + Number(indentDigit);
      if (
        explicitIndent !== undefined &&
        blockLines.some(line => line.trim() !== '' && (line.match(/^ */)?.[0]?.length ?? 0) < explicitIndent)
      ) {
        malformed = true;
      }
      if (malformed) return undefined;
      fields.set(key, {
        kind: 'block',
        style: indicator[1] === '|' ? 'literal' : 'folded',
        lines: blockLines,
        indent: explicitIndent ?? blockIndent,
      });
      index = cursor - 1;
      continue;
    }

    const continuation: string[] = [rawValue];
    let cursor = index + 1;
    for (; cursor < end; cursor += 1) {
      const candidate = lines[cursor]!;
      if (candidate.trim() === '') {
        continuation.push('');
        continue;
      }
      const candidateIndent = candidate.match(/^ */)?.[0]?.length ?? 0;
      if (candidateIndent <= indentation.length) break;
      continuation.push(candidate.slice(candidateIndent));
    }
    fields.set(key, { kind: 'scalar', value: continuation.join('\n') });
    index = cursor - 1;
  }

  const name = normalizeValue(fields.get('name'));
  const description = normalizeValue(fields.get('description'));
  if (!name || !description) return undefined;
  return { name, description };
}

function normalizeValue(value: FrontmatterValue | undefined): string | undefined {
  if (!value) return undefined;
  const raw =
    value.kind === 'scalar'
      ? parseScalar(value.value)
      : value.lines.map(line => (line.trim() === '' ? '' : line.slice(value.indent ?? 0))).join('\n');
  if (raw === undefined) return undefined;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized === '' ? undefined : normalized;
}

function parseScalar(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'")) {
    const match = /^'((?:''|[^'])*)'[ \t]*(?:#.*)?$/.exec(trimmed);
    return match?.[1]?.replace(/''/g, "'");
  }
  if (trimmed.startsWith('"')) {
    const match = /^("(?:\\.|[^"\\])*")[ \t]*(?:#.*)?$/.exec(trimmed);
    if (!match) return undefined;
    try {
      return JSON.parse(match[1]!);
    } catch {
      return undefined;
    }
  }
  return trimmed.replace(/[ \t]+#.*$/, '').trim();
}

/**
 * List skills installed for exactly one harness account.  A local skill wins
 * over a same-named built-in, so an account can intentionally override a
 * bundled implementation. Home Manager installs the account catalog and many
 * skill directories as symlinks, so those directory links are resolved as a
 * one-level anchor. The manifest itself must be a regular file inside that
 * resolved anchor; there is no recursion or arbitrary-path API here.
 */
export async function listSkills(harnessHome: string | undefined): Promise<AvailableSkill[]> {
  if (!harnessHome?.trim()) return [];
  const skillsRoot = path.join(harnessHome, 'skills');
  const skills = new Map<string, AvailableSkill>();

  // Built-ins first means direct account skills have the documented precedence.
  for (const [directory, system] of [
    [path.join(skillsRoot, '.system'), true],
    [skillsRoot, false],
  ] as const) {
    for (const skill of await listSkillDirectory(directory, system)) skills.set(skill.name, skill);
  }

  return [...skills.values()].sort(compareSkills);
}

async function listSkillDirectory(directory: string, system: boolean): Promise<AvailableSkill[]> {
  let entries: Dirent[];
  let resolvedDirectory: string;
  try {
    resolvedDirectory = await realpath(directory);
    const metadata = await lstat(resolvedDirectory);
    if (!metadata.isDirectory()) return [];
    entries = await readdir(resolvedDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: AvailableSkill[] = [];
  for (const entry of entries) {
    if (system && INTERNAL_CODEX_SYSTEM_SKILLS.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let skillDirectory: string;
    try {
      skillDirectory = await realpath(path.join(resolvedDirectory, entry.name));
      const metadata = await lstat(skillDirectory);
      if (!metadata.isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = path.join(skillDirectory, 'SKILL.md');
    const skill = await readSkillManifest(manifest);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function readSkillManifest(manifest: string): Promise<AvailableSkill | undefined> {
  try {
    const metadata = await lstat(manifest);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const file = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > MAX_SKILL_MANIFEST_BYTES) return undefined;
      return parseSkillFrontmatter(await file.readFile({ encoding: 'utf8' }));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

function compareSkills(left: AvailableSkill, right: AvailableSkill): number {
  const leftFolded = left.name.toLowerCase();
  const rightFolded = right.name.toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}
