import { spawn } from 'bun';
import type { CheckStatus, PollThread } from './types';

// ============================================================================
// Bot signature
// ============================================================================

const BOT_SIGNATURE = '\n\nBy Claude Code Kautopilot';

export function withBotSignature(body: string): string {
  return body + BOT_SIGNATURE;
}

// ============================================================================
// Generic gh CLI wrapper
// ============================================================================

interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function gh(args: string[], cwd?: string): Promise<GhResult> {
  const proc = spawn({
    cmd: ['gh', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

  return {
    exitCode: await proc.exited,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`gh ${label}: invalid JSON output: ${stdout.slice(0, 200)}`);
  }
}

// ============================================================================
// PR checks
// ============================================================================

interface GhCheck {
  name: string;
  state: string;
}

export async function ghPrChecks(prNumber: number, cwd?: string): Promise<CheckStatus[]> {
  const result = await gh(['pr', 'checks', String(prNumber), '--json', 'name,state'], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`gh pr checks failed: ${result.stderr}`);
  }

  const checks = parseJson<GhCheck[]>(result.stdout, 'pr-checks');
  return checks.map(c => {
    const s = c.state.toLowerCase();
    return {
      name: c.name,
      status:
        s === 'pass' || s === 'success'
          ? ('passing' as const)
          : s === 'fail' || s === 'failure'
            ? ('failing' as const)
            : ('pending' as const),
    };
  });
}

// ============================================================================
// PR view (merge status)
// ============================================================================

interface GhPrView {
  mergeable: boolean;
  mergeStateStatus: string;
  headRefName: string;
  state: string;
  url: string;
  reviews: { author: { login: string }; state: string }[];
  createdAt: string;
}

export async function ghPrView(prNumber: number, cwd?: string): Promise<GhPrView> {
  const result = await gh(
    ['pr', 'view', String(prNumber), '--json', 'mergeable,mergeStateStatus,headRefName,state,url,reviews,createdAt'],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${result.stderr}`);
  }

  return parseJson<GhPrView>(result.stdout, 'pr-view');
}

// ============================================================================
// Review threads (GraphQL)
// ============================================================================

interface GhReviewThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: {
            id: string;
            isOutdated: boolean;
            isResolved: boolean;
            comments: {
              nodes: {
                id: string;
                author: { login: string | null };
                body: string;
                createdAt: string;
              }[];
            };
          }[];
        };
      };
    };
  };
}

export async function ghReviewThreads(prNumber: number, cwd?: string): Promise<PollThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isOutdated
              isResolved
              comments(first: 100) {
                nodes {
                  id
                  author { login }
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const repoInfo = await ghRepoInfo(cwd);
  const result = await gh(
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${repoInfo.owner}`,
      '-f',
      `repo=${repoInfo.repo}`,
      '-F',
      `pr=${prNumber}`,
    ],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh review threads failed: ${result.stderr}`);
  }

  const data = parseJson<GhReviewThreadsResponse>(result.stdout, 'review-threads');
  const threads = data.data.repository.pullRequest.reviewThreads.nodes;

  return threads
    .filter(t => !t.isResolved)
    .map(t => ({
      id: t.id,
      isOutdated: t.isOutdated,
      author: t.comments.nodes[0]?.author?.login || 'unknown',
      body: t.comments.nodes[0]?.body || '',
      firstCommentId: t.comments.nodes[0]?.id || '',
      replies: t.comments.nodes.slice(1).map(c => ({
        id: c.id,
        author: c.author?.login || 'unknown',
        body: c.body,
        isBot: c.author?.login?.includes('[bot]') ?? false,
      })),
    }));
}

// ============================================================================
// Reviews
// ============================================================================

interface GhReview {
  id: string;
  author: { login: string };
  state: string;
  body: string;
}

export async function ghReviews(prNumber: number, cwd?: string): Promise<GhReview[]> {
  const repoInfo = await ghRepoInfo(cwd);
  const result = await gh(['api', `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}/reviews`], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`gh reviews failed: ${result.stderr}`);
  }

  return parseJson<GhReview[]>(result.stdout, 'reviews');
}

// ============================================================================
// PR comments
// ============================================================================

interface GhComment {
  id: number;
  author: { login: string };
  body: string;
  created_at: string;
}

export async function ghPrComments(prNumber: number, since?: string, cwd?: string): Promise<GhComment[]> {
  const repoInfo = await ghRepoInfo(cwd);
  let url = `repos/${repoInfo.owner}/${repoInfo.repo}/issues/${prNumber}/comments`;
  if (since) {
    url += `?since=${encodeURIComponent(since)}`;
  }

  const result = await gh(['api', url], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`gh pr comments failed: ${result.stderr}`);
  }

  return parseJson<GhComment[]>(result.stdout, 'pr-comments');
}

// ============================================================================
// Post PR comment
// ============================================================================

export async function ghPrComment(prNumber: number, body: string, cwd?: string): Promise<void> {
  const result = await gh(['pr', 'comment', String(prNumber), '--body', body], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr comment failed: ${result.stderr}`);
  }
}

// ============================================================================
// Reply to review thread
// ============================================================================

export async function ghReplyToThread(prNumber: number, commentId: string, body: string, cwd?: string): Promise<void> {
  const repoInfo = await ghRepoInfo(cwd);
  const result = await gh(
    [
      'api',
      `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      '-f',
      `body=${body}`,
      '--method',
      'POST',
    ],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh reply to thread failed: ${result.stderr}`);
  }
}

// ============================================================================
// Reply to issue comment (PR-level comment)
// ============================================================================

export async function ghReplyToIssueComment(
  prNumber: number,
  body: string,
  inReplyTo?: number,
  cwd?: string,
): Promise<void> {
  const repoInfo = await ghRepoInfo(cwd);
  const args = ['api', `repos/${repoInfo.owner}/${repoInfo.repo}/issues/${prNumber}/comments`, '-f', `body=${body}`];

  if (inReplyTo) {
    args.push('-f', `in_reply_to=${inReplyTo}`);
  }

  const result = await gh([...args, '--method', 'POST'], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`gh reply to issue comment failed: ${result.stderr}`);
  }
}

// ============================================================================
// Resolve thread (GraphQL mutation)
// ============================================================================

export async function ghResolveThread(threadId: string, cwd?: string): Promise<void> {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id }
      }
    }
  `;

  const result = await gh(['api', 'graphql', '-f', `query=${mutation}`, '-f', `threadId=${threadId}`], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`gh resolve thread failed: ${result.stderr}`);
  }
}

// ============================================================================
// Add reaction
// ============================================================================

export async function ghReact(commentId: number, reaction: string = '+1', cwd?: string): Promise<void> {
  const repoInfo = await ghRepoInfo(cwd);
  const result = await gh(
    [
      'api',
      `repos/${repoInfo.owner}/${repoInfo.repo}/issues/comments/${commentId}/reactions`,
      '-f',
      `content=${reaction}`,
      '--method',
      'POST',
    ],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh react failed: ${result.stderr}`);
  }
}

// ============================================================================
// Close PR
// ============================================================================

export async function ghClosePr(prNumber: number, cwd?: string): Promise<void> {
  const result = await gh(
    ['pr', 'close', String(prNumber), '--comment', 'Closed for rollover — creating fresh PR'],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh pr close failed: ${result.stderr}`);
  }
}

// ============================================================================
// List PRs for branch
// ============================================================================

export async function ghListPrsForBranch(branch: string, cwd?: string): Promise<Array<{ number: number }>> {
  const result = await gh(['pr', 'list', '--head', branch, '--json', 'number'], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`gh pr list failed: ${result.stderr}`);
  }

  return parseJson<Array<{ number: number }>>(result.stdout, 'pr-list');
}

// ============================================================================
// Merge policy (GraphQL)
// ============================================================================

interface GhMergePolicyResponse {
  data: {
    repository: {
      branchProtectionRules: {
        nodes: Array<{
          requiresApprovingReviews: boolean;
          requiredApprovingReviewCount: number;
          requiresStatusChecks: boolean;
          requiredStatusCheckContexts: string[];
          requiresStrictStatusChecks: boolean;
          requiresCodeOwnerReviews: boolean;
        }>;
      };
      defaultBranchRef: {
        name: string;
        target: {
          oid: string;
        };
      };
    };
  };
}

export interface MergePolicyInfo {
  requiresApprovingReviews: boolean;
  requiredApprovingReviewCount: number;
  requiresStatusChecks: boolean;
  requiredStatusCheckContexts: string[];
  requiresCodeOwnerReviews: boolean;
}

export async function ghFetchMergePolicy(owner: string, repo: string, cwd?: string): Promise<MergePolicyInfo> {
  const query = `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        branchProtectionRules(first: 10) {
          nodes {
            requiresApprovingReviews
            requiredApprovingReviewCount
            requiresStatusChecks
            requiredStatusCheckContexts
            requiresStrictStatusChecks
            requiresCodeOwnerReviews
          }
        }
        defaultBranchRef {
          name
          target { oid }
        }
      }
    }
  `;

  const result = await gh(
    ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh merge policy failed: ${result.stderr}`);
  }

  const data = parseJson<GhMergePolicyResponse>(result.stdout, 'merge-policy');
  const rules = data.data.repository.branchProtectionRules.nodes;

  return {
    requiresApprovingReviews: rules.some(r => r.requiresApprovingReviews),
    requiredApprovingReviewCount: Math.max(...rules.map(r => r.requiredApprovingReviewCount), 0),
    requiresStatusChecks: rules.some(r => r.requiresStatusChecks),
    requiredStatusCheckContexts: rules.flatMap(r => r.requiredStatusCheckContexts),
    requiresCodeOwnerReviews: rules.some(r => r.requiresCodeOwnerReviews),
  };
}

// ============================================================================
// Failed CI run logs
// ============================================================================

export async function ghRunLogsFailed(runId: string, cwd?: string): Promise<string> {
  const result = await gh(['run', 'view', runId, '--log-failed'], cwd);

  return result.exitCode !== 0 ? `Failed to fetch logs: ${result.stderr}` : result.stdout;
}

// ============================================================================
// Get repo info from current directory
// ============================================================================

interface RepoInfo {
  owner: string;
  repo: string;
}

export async function ghRepoInfo(cwd?: string): Promise<RepoInfo> {
  const result = await gh(['repo', 'view', '--json', 'nameWithOwner'], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`gh repo view failed: ${result.stderr}`);
  }
  const data = parseJson<{ nameWithOwner: string }>(result.stdout, 'repo-view');
  const [owner, repo] = data.nameWithOwner.split('/');
  return { owner, repo };
}

// ============================================================================
// PR CI run IDs (for fetching failed logs)
// ============================================================================

interface GhRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  workflowId: number;
  headBranch: string;
}

export async function ghPrRuns(branch: string, cwd?: string): Promise<GhRun[]> {
  const result = await gh(
    ['run', 'list', '--branch', branch, '--json', 'databaseId,name,status,conclusion,headBranch', '--limit', '10'],
    cwd,
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh run list failed: ${result.stderr}`);
  }

  return parseJson<GhRun[]>(result.stdout, 'run-list');
}
