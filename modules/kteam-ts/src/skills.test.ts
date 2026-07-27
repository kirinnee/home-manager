import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSkills, MAX_SKILL_MANIFEST_BYTES, parseSkillFrontmatter } from './skills';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-skills-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function skill(relativeDirectory: string, frontmatter: string): Promise<void> {
  const directory = path.join(home, 'skills', relativeDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n# body\n`);
}

describe('parseSkillFrontmatter', () => {
  test('reads quoted, continued, and block descriptions from the first document', () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: quoted\ndescription: 'Does ''quoted'' work?'\n---\n---\nname: ignored\ndescription: ignored\n---",
      ),
    ).toEqual({
      name: 'quoted',
      description: "Does 'quoted' work?",
    });
    expect(
      parseSkillFrontmatter('---\nname: folded\ndescription: >-\n  A folded\n  display description.\n---'),
    ).toEqual({
      name: 'folded',
      description: 'A folded display description.',
    });
    expect(
      parseSkillFrontmatter('---\nname: literal\ndescription: |2-\n  A literal\n  display description.\n---'),
    ).toEqual({
      name: 'literal',
      description: 'A literal display description.',
    });
    expect(parseSkillFrontmatter('---\nname: continued\ndescription: first line\n  second line\n---')).toEqual({
      name: 'continued',
      description: 'first line second line',
    });
  });

  test('refuses missing, blank, malformed, or non-frontmatter manifests', () => {
    for (const manifest of [
      '# no frontmatter',
      '---\nname: no-description\n---',
      '---\nname:   \ndescription: present\n---',
      '---\nname: no-end\ndescription: present',
      '---\nname: bad-quote\ndescription: "unterminated\n---',
    ]) {
      expect(parseSkillFrontmatter(manifest)).toBeUndefined();
    }
  });
});

describe('listSkills', () => {
  test('lists direct and built-in skills, normalizes descriptions, and uses direct precedence', async () => {
    await skill('.system/builtin', 'name: Builtin\ndescription: system skill');
    await skill('.system/duplicate', 'name: Same\ndescription: old system description');
    await skill('account', 'name: same\ndescription: direct name differs by case');
    await skill('override', 'name: Same\ndescription: direct override\n  with continuation');
    await skill('zebra', 'name: zebra\ndescription: Z');
    await skill('alpha', 'name: Alpha\ndescription: A');

    expect(await listSkills(home)).toEqual([
      { name: 'Alpha', description: 'A' },
      { name: 'Builtin', description: 'system skill' },
      { name: 'Same', description: 'direct override with continuation' },
      { name: 'same', description: 'direct name differs by case' },
      { name: 'zebra', description: 'Z' },
    ]);
  });

  test('skips missing frontmatter, unreadable manifest shapes, and absent homes', async () => {
    await skill('missing-description', 'name: missing-description');
    const invalid = path.join(home, 'skills', 'not-a-file');
    await mkdir(path.join(invalid, 'SKILL.md'), { recursive: true });

    expect(await listSkills(home)).toEqual([]);
    expect(await listSkills(path.join(home, 'does-not-exist'))).toEqual([]);
    expect(await listSkills(undefined)).toEqual([]);
  });

  test('hides Codex internal system skills without hiding a direct skill of the same name', async () => {
    await skill('.system/review-agent', 'name: review-agent\ndescription: reserved review-thread helper');
    expect(await listSkills(home)).toEqual([]);

    await skill('review-agent', 'name: review-agent\ndescription: user-selectable account override');
    expect(await listSkills(home)).toEqual([{ name: 'review-agent', description: 'user-selectable account override' }]);
  });

  test('follows Home Manager root and directory links but not a manifest link', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'kteam-skills-outside-'));
    try {
      const catalog = path.join(outside, 'catalog');
      await mkdir(catalog, { recursive: true });
      await mkdir(path.join(outside, 'foreign'), { recursive: true });
      await writeFile(
        path.join(outside, 'foreign', 'SKILL.md'),
        '---\nname: linked\ndescription: Home Manager store entry\n---\n',
      );
      await symlink(catalog, path.join(home, 'skills'));
      await symlink(path.join(outside, 'foreign'), path.join(catalog, 'linked-directory'));
      await mkdir(path.join(catalog, 'linked-file'), { recursive: true });
      await symlink(path.join(outside, 'foreign', 'SKILL.md'), path.join(catalog, 'linked-file', 'SKILL.md'));

      expect(await listSkills(home)).toEqual([{ name: 'linked', description: 'Home Manager store entry' }]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('caps a surprising manifest before reading it', async () => {
    const directory = path.join(home, 'skills', 'too-large');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      `${'x'.repeat(MAX_SKILL_MANIFEST_BYTES)}\n---\nname: ignored\ndescription: ignored\n---`,
    );

    expect(await listSkills(home)).toEqual([]);
  });
});
