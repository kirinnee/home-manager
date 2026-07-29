import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerSkillsCatalog } from './composer-autocomplete-providers';
import {
  appendSkillInvocation,
  filterSkills,
  groupSkills,
  insertSkillIntoDraft,
  skillBadge,
  SkillsCatalogList,
  SkillsSurface,
  skillsEmptyCopy,
} from './SkillsSurface';

const catalog: ComposerSkillsCatalog = {
  harness: 'codex',
  harnessHomeResolved: true,
  skills: [
    { name: 'frontend-design', description: 'Build polished web interfaces', scope: 'global', origin: 'both' },
    { name: 'summary', description: 'Give an accessible recap', scope: 'project', origin: 'codex' },
  ],
};

describe('skills surface model', () => {
  test('searches names and descriptions without changing catalog order', () => {
    expect(filterSkills(catalog.skills, 'SUMMARY').map(skill => skill.name)).toEqual(['summary']);
    expect(filterSkills(catalog.skills, 'web interfaces').map(skill => skill.name)).toEqual(['frontend-design']);
    expect(filterSkills(catalog.skills, '').map(skill => skill.name)).toEqual(['frontend-design', 'summary']);
  });

  test('distinguishes no skills, unresolved home, version skew, and no search matches', () => {
    expect(skillsEmptyCopy(true, '', 0)).toBe('No skills are installed for this session.');
    expect(skillsEmptyCopy(false, '', 0)).toContain('harness home could not be resolved');
    expect(skillsEmptyCopy(undefined, '', 0)).toContain('daemon cannot confirm');
    expect(skillsEmptyCopy(true, 'nope', 2)).toBe('No skills match “nope”.');
  });

  test('groups filtered skills by scope and never upgrades an unknown origin', () => {
    expect(groupSkills(catalog.skills, '').map(group => [group.label, group.skills.map(skill => skill.name)])).toEqual([
      ['Global', ['frontend-design']],
      ['Project', ['summary']],
    ]);
    expect(groupSkills(catalog.skills, 'summary')[0]!.skills).toEqual([]);
    expect(skillBadge(undefined)).toBe('unknown');
    expect(skillBadge('not-a-real-origin' as never)).toBe('unknown');
    expect(skillBadge('both')).toBe('both');
  });

  test('appends a draft token and preserves existing text', () => {
    expect(appendSkillInvocation('', '$summary')).toBe('$summary ');
    expect(appendSkillInvocation('Review this', '$summary')).toBe('Review this $summary ');
    expect(appendSkillInvocation('Review this\n', '$summary')).toBe('Review this\n$summary ');
  });

  test('delegates insertion syntax to the shared harness helper', () => {
    const inserted: string[] = [];
    expect(insertSkillIntoDraft(value => inserted.push(value), 'codex', 'summary')).toBe('$summary');
    expect(insertSkillIntoDraft(value => inserted.push(value), 'claude', 'summary')).toBe('/summary');
    expect(inserted).toEqual(['$summary', '/summary']);
  });
});

describe('skills surface rendering', () => {
  test('shows invocation plus description as a draft-only tap target', () => {
    const html = renderToStaticMarkup(<SkillsCatalogList catalog={catalog} query="" onInsert={() => undefined} />);
    expect(html).toContain('$summary');
    expect(html).toContain('Give an accessible recap');
    expect(html).toContain('>Global</h3>');
    expect(html).toContain('>Project</h3>');
    expect(html).toContain('>both</span>');
    expect(html).toContain('>codex</span>');
    expect(html).toContain('Insert into draft');
    expect(html).toContain('aria-label="Insert $summary into composer draft. Give an accessible recap"');
    expect(html).not.toContain('<form');
  });

  test('renders missing provenance as an explicit unknown badge', () => {
    const html = renderToStaticMarkup(
      <SkillsCatalogList
        catalog={{ ...catalog, skills: [{ name: 'legacy', description: 'Old daemon response' }] }}
        query=""
        onInsert={() => undefined}
      />,
    );
    expect(html).toContain('>unknown</span>');
    expect(html).toContain('aria-label="Skill origin is unknown"');
  });

  test('opens loading without autofocus or a focus call', async () => {
    const html = renderToStaticMarkup(
      <SkillsSurface
        sessionId="one"
        presentation="pane"
        titleId="skills-title"
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );
    expect(html).toContain('Loading skills');
    expect(html).not.toContain('autofocus');

    const source = await Bun.file(new URL('./SkillsSurface.tsx', import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\.focus\s*\(/);
    expect(code).not.toMatch(/\bautoFocus\b/);
    expect(code).not.toMatch(/\bonSubmit\b/);
  });
});
