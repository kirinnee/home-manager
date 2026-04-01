import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptsSource = readFileSync(join(import.meta.dir, '..', 'scripts.ts'), 'utf-8');

describe('ticket setup heuristics', () => {
  it('treats acli as needing setup verification', () => {
    expect(scriptsSource).toContain("'acli'");
    expect(scriptsSource).toContain('needsSetupHelp');
  });

  it('includes installed-but-not-logged-in style hints', () => {
    expect(scriptsSource).toContain('not logged in');
    expect(scriptsSource).toContain('installed but');
  });

  it('passes setupAssessment into script generation prompt variables', () => {
    expect(scriptsSource).toContain('setupAssessment: accessSetup.assessment');
  });
});
