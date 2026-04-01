import pc from 'picocolors';

// ============================================================================
// Types
// ============================================================================

interface PollResult {
  status: string;
  exitCode: number;
  checks?: string;
  mergeState?: string;
  mergeable?: string;
  review?: string;
  unresolvedCount?: number;
  threadDetails?: UnresolvedThread[];
  reviewsJson?: string;
}

interface UnresolvedThread {
  path: string;
  line: number;
  author: string;
  body: string;
}

interface GraphQLPRData {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      path: string;
      line: number;
      comments: {
        nodes: Array<{
          author: { login: string };
          body: string;
        }>;
      };
    }>;
  };
}

// ============================================================================
// Shell helpers
// ============================================================================

async function exec(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ============================================================================
// GitHub API helpers
// ============================================================================

async function getChecks(pr: string, repoArgs: string[]): Promise<{ output: string; hasData: boolean } | null> {
  const { stdout, exitCode } = await exec(['gh', 'pr', 'checks', pr, ...repoArgs]);
  // gh pr checks exits 1 on failed checks — distinguish from real errors
  if (exitCode !== 0 && !/pass|fail|pending|running|queued/i.test(stdout)) {
    return null; // real error, retry
  }
  return { output: stdout, hasData: true };
}

const GRAPHQL_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
      mergeable
      mergeStateStatus
      reviewDecision
      reviewThreads(first: 100) {
        nodes {
          isResolved
          path
          line
          comments(first: 3) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
    }
  }
}`;

async function getPRData(owner: string, repo: string, pr: string): Promise<GraphQLPRData | null> {
  const { stdout, exitCode } = await exec([
    'gh',
    'api',
    'graphql',
    '-f',
    `query=${GRAPHQL_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `pr=${pr}`,
  ]);
  if (exitCode !== 0 || !stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.data?.repository?.pullRequest ?? null;
  } catch {
    return null;
  }
}

async function getReviewsJson(pr: string, repoArgs: string[]): Promise<string> {
  const { stdout } = await exec(['gh', 'pr', 'view', pr, ...repoArgs, '--json', 'reviews']);
  return stdout;
}

// ============================================================================
// Resolve owner/repo
// ============================================================================

async function resolveRepo(repo?: string): Promise<{ owner: string; name: string; repoArgs: string[] } | null> {
  if (repo) {
    const parts = repo.split('/');
    if (parts.length !== 2) return null;
    return { owner: parts[0], name: parts[1], repoArgs: ['--repo', repo] };
  }
  // Detect from current directory
  const ownerResult = await exec(['gh', 'repo', 'view', '--json', 'owner', '-q', '.owner.login']);
  const nameResult = await exec(['gh', 'repo', 'view', '--json', 'name', '-q', '.name']);
  if (!ownerResult.stdout || !nameResult.stdout) return null;
  return { owner: ownerResult.stdout, name: nameResult.stdout, repoArgs: [] };
}

// ============================================================================
// Core polling logic (single check)
// ============================================================================

async function checkOnce(
  pr: string,
  owner: string,
  repoName: string,
  repoArgs: string[],
): Promise<PollResult | 'retry'> {
  // 1. CI checks
  const checks = await getChecks(pr, repoArgs);
  if (!checks) return 'retry';

  // 2. PR data via GraphQL
  const prData = await getPRData(owner, repoName, pr);
  if (!prData) return 'retry';

  const { state: prState, mergeable, mergeStateStatus: mergeState, reviewDecision, reviewThreads } = prData;
  const review = reviewDecision ?? 'null';
  const unresolvedThreads = reviewThreads.nodes.filter(t => !t.isResolved);
  const unresolvedCount = unresolvedThreads.length;

  // --- PR closed or merged ---
  if (prState === 'CLOSED') {
    return { status: 'closed', exitCode: 6 };
  }
  if (prState === 'MERGED') {
    return { status: 'merged', exitCode: 6 };
  }

  // --- Still pending? ---
  if (/pending|running|queued|in_progress/i.test(checks.output)) {
    return 'retry';
  }
  if (mergeable === 'UNKNOWN') {
    return 'retry';
  }

  // --- Evaluate terminal states (priority order) ---

  // Merge conflict
  if (mergeable === 'CONFLICTING') {
    return {
      status: 'merge_conflict',
      exitCode: 4,
      mergeable: 'CONFLICTING',
      mergeState,
    };
  }

  // Branch behind
  if (mergeState === 'BEHIND') {
    return {
      status: 'behind',
      exitCode: 4,
      mergeState: 'BEHIND',
    };
  }

  // CI failed
  if (/fail/i.test(checks.output)) {
    return {
      status: 'ci_failed',
      exitCode: 1,
      checks: checks.output,
    };
  }

  // Changes requested
  if (review === 'CHANGES_REQUESTED') {
    const reviewsJson = await getReviewsJson(pr, repoArgs);
    return {
      status: 'changes_requested',
      exitCode: 2,
      reviewsJson,
    };
  }

  // Unresolved conversations blocking merge
  if (mergeState === 'BLOCKED' && unresolvedCount > 0) {
    const threadDetails: UnresolvedThread[] = unresolvedThreads.map(t => ({
      path: t.path,
      line: t.line,
      author: t.comments.nodes[0]?.author?.login ?? '?',
      body: (() => {
        const b = t.comments.nodes[0]?.body ?? '';
        return b.length > 200 ? b.slice(0, 200) + '...' : b;
      })(),
    }));
    return {
      status: 'conversations_blocking',
      exitCode: 5,
      unresolvedCount,
      threadDetails,
    };
  }

  // All clear
  if (mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS' || mergeState === 'UNSTABLE') {
    return {
      status: 'all_pass',
      exitCode: 0,
      checks: checks.output,
      mergeState,
      unresolvedCount,
    };
  }

  // Blocked for unknown reason
  if (mergeState === 'BLOCKED') {
    return {
      status: 'blocked',
      exitCode: 5,
      mergeState: 'BLOCKED',
      review,
      unresolvedCount,
      checks: checks.output,
    };
  }

  return 'retry';
}

// ============================================================================
// Output formatting
// ============================================================================

function formatResult(result: PollResult): string {
  const lines: string[] = [];
  lines.push(`STATUS:${result.status}`);

  switch (result.status) {
    case 'closed':
      lines.push('PR is closed.');
      break;
    case 'merged':
      lines.push('PR is already merged.');
      break;
    case 'merge_conflict':
      lines.push(`MERGEABLE:${result.mergeable}`);
      lines.push(`MERGE_STATE:${result.mergeState}`);
      break;
    case 'behind':
      lines.push(`MERGE_STATE:${result.mergeState}`);
      lines.push('Branch is behind the base branch and needs rebase or update.');
      break;
    case 'ci_failed':
      if (result.checks) lines.push(result.checks);
      break;
    case 'changes_requested':
      if (result.reviewsJson) lines.push(result.reviewsJson);
      break;
    case 'conversations_blocking':
      lines.push(`UNRESOLVED_THREADS:${result.unresolvedCount}`);
      if (result.threadDetails) lines.push(JSON.stringify(result.threadDetails));
      break;
    case 'all_pass':
      if (result.checks) lines.push(result.checks);
      lines.push(`MERGE_STATE:${result.mergeState}`);
      if (result.unresolvedCount && result.unresolvedCount > 0) {
        lines.push(`UNRESOLVED_THREADS:${result.unresolvedCount} (non-blocking)`);
      }
      break;
    case 'blocked':
      lines.push(`MERGE_STATE:${result.mergeState}`);
      lines.push(`REVIEW_DECISION:${result.review}`);
      lines.push(`UNRESOLVED_THREADS:${result.unresolvedCount ?? 0}`);
      if (result.checks) lines.push(result.checks);
      break;
  }

  return lines.join('\n');
}

// ============================================================================
// Handler
// ============================================================================

export async function handler(pr: string, opts: { repo?: string; interval?: string }): Promise<void> {
  const interval = parseInt(opts.interval ?? '60', 10) * 1000;

  // Verify gh is available
  const ghCheck = await exec(['gh', '--version']);
  if (ghCheck.exitCode !== 0) {
    console.error(pc.red('Error: gh CLI not found'));
    process.exit(3);
  }

  // Resolve repo
  const repoInfo = await resolveRepo(opts.repo);
  if (!repoInfo) {
    console.error(pc.red('Error: could not determine repo owner/name'));
    process.exit(3);
  }

  // Poll loop
  while (true) {
    const result = await checkOnce(pr, repoInfo.owner, repoInfo.name, repoInfo.repoArgs);

    if (result === 'retry') {
      await Bun.sleep(interval);
      continue;
    }

    console.log(formatResult(result));
    process.exit(result.exitCode);
  }
}
