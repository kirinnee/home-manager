import { isCancel, select } from '@clack/prompts';
import { Command } from 'commander';
import { getGitRoot, getWorktree } from '../core/git';
import { createSession } from '../core/session-create';
import { detectOrgFromTicket, type ExecMode, isOrg, type Lpsm, ORGS, type Org } from '../core/session-meta';
import { logError, logField, logInfo } from '../util/format';

// ============================================================================
// `kautopilot start [TICKET_ID | "request"]` — thin convenience. It resolves the
// org (--org → ticket → ask), creates the host-driven session, and hands off to
// the controller (the /kautopilot skill drives `next`/`complete`). There is NO
// self-driving loop and NO `claude -p` / TTY spawn from the binary. (SPEC §13 #2)
// ============================================================================

export function createStartCommand(): Command {
  return new Command('start')
    .description('Initialize a host-driven session (ticket or free-form request)')
    .argument('[task]', 'Ticket id (e.g. PE-1234) or a free-form request in quotes')
    .option('--org <org>', 'Org: liftoff | atomicloud')
    .option('--exec <mode>', 'Execution mode: kloop | sub-agent')
    .option('--max-repos <n>', 'Max parallel repos', v => Number.parseInt(v, 10))
    .option('--landscape <l>', 'AtomiCloud LPSM landscape/environment (atomicloud-only)')
    .option('--cluster <c>', 'AtomiCloud LPSM cluster (atomicloud-only)')
    .option('--platform <p>', 'AtomiCloud LPSM platform/namespace (atomicloud-only)')
    .option('--service <s>', 'AtomiCloud LPSM service/repo (atomicloud-only)')
    .option('--module <m>', 'AtomiCloud LPSM module (atomicloud-only)')
    .option(
      '--tag <t>',
      'Free-form session tag (repeatable)',
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .action(
      async (
        task: string | undefined,
        opts: {
          org?: string;
          exec?: string;
          maxRepos?: number;
          landscape?: string;
          cluster?: string;
          platform?: string;
          service?: string;
          module?: string;
          tag?: string[];
        },
      ) => {
        try {
          await runStart(task, opts);
        } catch (err) {
          logError(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );
}

function looksLikeTicketId(task: string): boolean {
  // A short token with no spaces is treated as a ticket id; quoted prose is a request.
  return !/\s/.test(task) && task.length <= 40;
}

async function resolveOrg(ticketId: string | null, orgArg?: string): Promise<Org> {
  if (orgArg) {
    if (!isOrg(orgArg)) throw new Error(`Unknown org: ${orgArg}. Use liftoff | atomicloud.`);
    return orgArg;
  }
  if (ticketId) {
    const detected = detectOrgFromTicket(ticketId);
    if (detected) {
      logInfo(`Detected org '${detected}' from ticket ${ticketId}.`);
      return detected;
    }
  }
  if (!process.stdout.isTTY) {
    throw new Error('Org could not be resolved. Pass --org liftoff|atomicloud.');
  }
  const picked = await select({
    message: 'Which org is this task for? (Determines the ticket system and commit-spec policy.)',
    options: ORGS.map(o => ({ value: o, label: o })),
  });
  if (isCancel(picked)) throw new Error('Cancelled.');
  return picked as Org;
}

/** Build an LPSM object from whichever flags are set, or undefined if none. */
function buildLpsm(opts: {
  landscape?: string;
  cluster?: string;
  platform?: string;
  service?: string;
  module?: string;
}): Lpsm | undefined {
  const lpsm: Lpsm = {};
  if (opts.landscape) lpsm.landscape = opts.landscape;
  if (opts.cluster) lpsm.cluster = opts.cluster;
  if (opts.platform) lpsm.platform = opts.platform;
  if (opts.service) lpsm.service = opts.service;
  if (opts.module) lpsm.module = opts.module;
  return Object.keys(lpsm).length > 0 ? lpsm : undefined;
}

async function runStart(
  task: string | undefined,
  opts: {
    org?: string;
    exec?: string;
    maxRepos?: number;
    landscape?: string;
    cluster?: string;
    platform?: string;
    service?: string;
    module?: string;
    tag?: string[];
  },
): Promise<void> {
  const ticketId = task && looksLikeTicketId(task) ? task : null;
  const org = await resolveOrg(ticketId, opts.org);

  let execMode: ExecMode | undefined;
  if (opts.exec !== undefined) {
    if (opts.exec !== 'kloop' && opts.exec !== 'sub-agent') {
      throw new Error(`Unknown exec mode: ${opts.exec}. Use kloop | sub-agent.`);
    }
    execMode = opts.exec;
  }

  if (opts.maxRepos !== undefined && !Number.isInteger(opts.maxRepos)) {
    throw new Error('--max-repos must be a positive integer.');
  }
  if (opts.maxRepos !== undefined && opts.maxRepos < 1) {
    throw new Error('--max-repos must be at least 1.');
  }

  const repoPath = getGitRoot();
  const worktree = getWorktree();
  const lpsm = buildLpsm(opts);

  const meta = createSession({
    ticketId,
    // Persist the free-form one-liner when this is an ad-hoc (no-ticket) request,
    // so brainstorm/create_ticket prompts can reference it (vars.request).
    request: ticketId ? undefined : (task ?? undefined),
    org,
    repoPath,
    worktree,
    execMode,
    maxParallelRepos: opts.maxRepos,
    lpsm,
    tags: opts.tag,
  });

  logField('Session', meta.sessionId);
  logField('Org', `${meta.org} (${meta.ticketSystem}, commitSpec=${meta.commitSpec})`);
  logField('Task', ticketId ?? `(ad-hoc) ${task ?? ''}`);
  if (meta.lpsm) {
    const parts = (
      [
        ['L', meta.lpsm.landscape],
        ['C', meta.lpsm.cluster],
        ['P', meta.lpsm.platform],
        ['S', meta.lpsm.service],
        ['M', meta.lpsm.module],
      ] as const
    )
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`);
    logField('LPSM', parts.join(' '));
  }
  if (meta.tags && meta.tags.length > 0) {
    logField('Tags', meta.tags.join(' '));
  }
  logInfo(
    'Drive it with the /kautopilot skill, or manually: `kautopilot next --json` then `kautopilot complete <step>`.',
  );
}
