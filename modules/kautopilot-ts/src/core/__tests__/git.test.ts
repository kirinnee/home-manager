import { describe, expect, it } from 'bun:test';
import { extractOrg, normalizeGitRoot } from '../git';

describe('normalizeGitRoot', () => {
  it('strips git@ protocol', () => {
    expect(normalizeGitRoot('git@github.com:atomi/api-server.git')).toBe('github.com/atomi/api-server');
  });

  it('strips https:// protocol', () => {
    expect(normalizeGitRoot('https://github.com/atomi/api-server.git')).toBe('github.com/atomi/api-server');
  });

  it('lowercases', () => {
    expect(normalizeGitRoot('git@GitHub.com:Atomi/API-Server.git')).toBe('github.com/atomi/api-server');
  });

  it('strips .git suffix', () => {
    expect(normalizeGitRoot('git@github.com:atomi/api-server')).toBe('github.com/atomi/api-server');
  });

  it('handles no protocol', () => {
    expect(normalizeGitRoot('github.com/atomi/api-server.git')).toBe('github.com/atomi/api-server');
  });
});

describe('extractOrg', () => {
  it('extracts org from github.com/org/repo', () => {
    expect(extractOrg('github.com/atomi/api-server')).toBe('atomi');
  });

  it('returns full string if no slash', () => {
    expect(extractOrg('github.com')).toBe('github.com');
  });
});
