import { dirname } from 'node:path';

function gitSync(args: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: cwd || process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

export function getGitRoot(cwd?: string): string {
  const result = gitSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (result.exitCode !== 0) throw new Error('Not a git repository.');
  return dirname(result.stdout);
}

export function getWorktree(cwd?: string): string {
  const result = gitSync(['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd);
  if (result.exitCode !== 0) throw new Error('Not a git repository.');
  return result.stdout;
}

export function hasUnmergedPaths(cwd?: string): boolean {
  const result = gitSync(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (result.exitCode !== 0) return false;
  return result.stdout.length > 0;
}

export function getRemoteUrl(cwd?: string): string {
  const result = gitSync(['remote', 'get-url', 'origin'], cwd);
  if (result.exitCode !== 0) throw new Error('No remote "origin" found.');
  return result.stdout;
}

export function normalizeGitRoot(url: string): string {
  return url
    .replace(/^git@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/^([^/]+):/, '$1/') // SSH: host:path → host/path
    .toLowerCase();
}

export function extractOrg(gitRootHost: string | undefined | null): string {
  // github.com/atomi/api-server → atomi
  if (!gitRootHost) return 'default';
  const parts = gitRootHost.split('/');
  if (parts.length >= 2) return parts[1];
  return gitRootHost;
}

export function getCurrentBranch(cwd?: string): string {
  const result = gitSync(['branch', '--show-current'], cwd);
  if (result.exitCode !== 0) throw new Error('Could not determine current branch.');
  return result.stdout;
}

export function createBranch(name: string, cwd?: string): void {
  const result = gitSync(['checkout', '-b', name], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create branch "${name}".`);
  }
}

export function isOnMain(baseBranch?: string, cwd?: string): boolean {
  const branch = getCurrentBranch(cwd);
  const mainBranch = baseBranch || 'main';
  return branch === mainBranch;
}
