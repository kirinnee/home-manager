import pc from 'picocolors';
import type { CliDeps } from './index';

/**
 * List a run's kteam agent sessions. Agents now run as detached kteamd TUI
 * sessions (label `kloop-<runId>`), so "attaching" means picking one and running
 * `kteam attach <id>` — kloop just surfaces the sessions and the command.
 */
export async function handler(id: string | undefined, deps: CliDeps): Promise<void> {
  try {
    let runId = id;
    if (!runId) {
      const row = await deps.indexDb.getRunByWorkspace(process.cwd());
      if (!row) {
        console.error(pc.red('No run found for this workspace. Pass a run id or run `kloop init` first.'));
        process.exit(1);
      }
      runId = row.id;
    }

    const proc = Bun.spawnSync(['kteam', 'ps', '--all', '--label', `kloop-${runId}`, '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      console.error(pc.red('Could not query kteam (is the daemon running? `kteam daemon start`).'));
      console.error(pc.dim((proc.stderr.toString() || proc.stdout.toString()).trim()));
      process.exit(1);
    }

    const sessions = JSON.parse(proc.stdout.toString().trim() || '[]') as Array<{
      config?: { id?: string; name?: string; binary?: string };
      state?: { status?: string };
    }>;

    if (sessions.length === 0) {
      console.log(pc.yellow(`No kteam agent sessions for run ${runId}.`));
      return;
    }

    console.log(pc.bold(`kteam agent sessions for run ${runId}:`));
    for (const s of sessions) {
      const sid = s.config?.id ?? '-';
      console.log(
        `  ${pc.cyan(sid)}  ${(s.state?.status ?? '-').padEnd(12)} ${s.config?.binary ?? ''}  ${pc.dim(s.config?.name ?? '')}`,
      );
    }
    console.log(pc.dim('\nAttach with: kteam attach <id>'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
