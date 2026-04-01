import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { TmuxService } from '../deps';
import { parseSessionName } from '../tmux/commands';

interface SessionChoice {
  value: string;
  label: string;
  hint?: string;
}

function formatSessionChoice(sessionName: string): SessionChoice {
  const parsed = parseSessionName(sessionName);

  if (!parsed) {
    return { value: sessionName, label: sessionName };
  }

  const { iteration, role, reviewerIndex } = parsed;
  const roleLabel = role === 'impl' ? '🔨 Implementer' : `🔍 Reviewer ${reviewerIndex ?? 0}`;

  return {
    value: sessionName,
    label: `Iteration ${iteration} - ${roleLabel}`,
    hint: sessionName,
  };
}

export async function handler(id: string | undefined, tmux: TmuxService): Promise<void> {
  try {
    // If id provided, try to attach directly to kloop-{id} session
    if (id) {
      const sessionName = `kloop-${id}`;
      const sessions = await tmux.listSessions();
      if (sessions.includes(sessionName)) {
        const { execSync } = await import('child_process');
        execSync(`tmux attach -t "${sessionName}"`, { stdio: 'inherit' });
        return;
      }
      // If no exact match, try to find by runId
      console.log(pc.yellow(`Session "${sessionName}" not found.`));
    }

    // Otherwise show session picker
    const sessions = await tmux.listSessions();

    if (sessions.length === 0) {
      console.log(pc.yellow('No running agent sessions.'));
      return;
    }

    p.intro(pc.bgCyan(pc.black(' Attach to Session ')));

    const choices = sessions.map(formatSessionChoice);

    const selected = await p.select({
      message: 'Select a session to attach:',
      options: choices,
    });

    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    p.outro(`Attaching to ${pc.cyan(selected as string)}...`);

    // Use execSync to replace process with tmux attach
    const { execSync } = await import('child_process');
    execSync(`tmux attach -t "${selected}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
