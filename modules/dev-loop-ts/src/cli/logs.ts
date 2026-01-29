import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { LogsService, LogFile, RunLogs } from '../logs/service';

interface LogChoice {
  value: LogFile;
  label: string;
  hint?: string;
}

function formatLogLabel(log: LogFile): string {
  if (log.role === 'impl') {
    return `Iteration ${log.iteration} - 🔨 Implementer`;
  }
  return `Iteration ${log.iteration} - 🔍 Reviewer ${log.reviewerIndex ?? 0}`;
}

function formatLogChoice(log: LogFile, showRunId: boolean = false): LogChoice {
  const label = showRunId ? `[${log.runId}] ${formatLogLabel(log)}` : formatLogLabel(log);
  return {
    value: log,
    label,
    hint: log.name,
  };
}

export async function listHandler(logs: LogsService): Promise<void> {
  try {
    const runLogs = await logs.listLogsByRun();

    if (runLogs.length === 0) {
      console.log(pc.yellow('No logs available yet.'));
      return;
    }

    const currentRunId = await logs.getCurrentRunId();

    console.log(pc.bold('Available Logs'));
    console.log('');

    for (const { runId, logs: logFiles } of runLogs) {
      const isCurrent = runId === currentRunId;
      const runLabel = isCurrent ? pc.green(`Run ${runId} (current)`) : pc.cyan(`Run ${runId}`);
      console.log(runLabel);

      for (const log of logFiles) {
        const role = log.role === 'impl' ? '🔨 impl' : `🔍 rev${log.reviewerIndex ?? ''}`;
        console.log(`  ${role} iter ${log.iteration} ${pc.dim(log.name)}`);
      }
      console.log('');
    }
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

export async function viewHandler(logName: string, logs: LogsService): Promise<void> {
  try {
    // Try to find the log - first check current run, then all runs
    const currentRunId = await logs.getCurrentRunId();
    let logFiles: LogFile[] = [];

    if (currentRunId) {
      logFiles = await logs.listLogs(currentRunId);
    }

    let log = logFiles.find(l => l.name === logName || l.name === `${logName}.log`);

    // If not found in current run, search all runs
    if (!log) {
      logFiles = await logs.listLogs();
      log = logFiles.find(l => l.name === logName || l.name === `${logName}.log`);
    }

    if (!log) {
      console.log(pc.yellow(`Log "${logName}" not found.`));
      console.log('Use "dev-loop logs list" to see available logs.');
      return;
    }

    console.log(pc.dim(`Reading: ${log.path}`));
    console.log('');

    const content = await logs.readLog(log.path);
    displayFormattedLog(content);
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

export async function interactiveHandler(logs: LogsService): Promise<void> {
  try {
    const runLogs = await logs.listLogsByRun();

    if (runLogs.length === 0) {
      console.log(pc.yellow('No logs available yet.'));
      return;
    }

    p.intro(pc.bgMagenta(pc.black(' View Logs ')));

    const currentRunId = await logs.getCurrentRunId();

    // If multiple runs, first select a run
    let selectedRunId: string;

    if (runLogs.length === 1) {
      selectedRunId = runLogs[0].runId;
    } else {
      const runChoices = runLogs.map(({ runId, logs: logFiles }) => {
        const isCurrent = runId === currentRunId;
        const label = isCurrent ? `${runId} (current)` : runId;
        return {
          value: runId,
          label,
          hint: `${logFiles.length} log(s)`,
        };
      });

      const selected = await p.select({
        message: 'Select a run:',
        options: runChoices,
      });

      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }

      selectedRunId = selected as string;
    }

    // Now select a log from that run
    const logFiles = await logs.listLogs(selectedRunId);
    const choices = logFiles.map(log => formatLogChoice(log, false));

    const selectedLog = await p.select({
      message: `Select a log from run ${selectedRunId}:`,
      options: choices,
    });

    if (p.isCancel(selectedLog)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    const log = selectedLog as LogFile;
    p.outro(`Viewing ${pc.cyan(log.name)}`);
    console.log('');

    const content = await logs.readLog(log.path);
    displayFormattedLog(content);
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ============================================================================
// Log Display - Pretty print Claude stream JSON logs
// ============================================================================

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: string;
}

interface Message {
  role?: string;
  content?: ContentBlock[];
}

interface LogEntry {
  type: string;
  subtype?: string;
  message?: Message | string;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  tool_use_result?: {
    type?: string;
    file?: { filePath?: string };
  };
  cwd?: string;
  session_id?: string;
}

function displayFormattedLog(content: string): void {
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as LogEntry;
      formatLogEntry(obj);
    } catch {
      // Not JSON, print as-is
      console.log(line);
    }
  }
}

function formatLogEntry(entry: LogEntry): void {
  switch (entry.type) {
    case 'system':
      formatSystemEntry(entry);
      break;

    case 'assistant':
      formatAssistantEntry(entry);
      break;

    case 'user':
      formatUserEntry(entry);
      break;

    case 'result':
      formatFinalResult(entry);
      break;

    default:
      console.log(pc.dim(`[${entry.type}]`));
  }
}

function formatSystemEntry(entry: LogEntry): void {
  if (entry.subtype === 'init') {
    console.log(pc.yellow('══════════════════════════════════════════════════════════════'));
    console.log(pc.yellow(`  SESSION START`));
    if (entry.cwd) console.log(pc.dim(`  cwd: ${entry.cwd}`));
    if (entry.session_id) console.log(pc.dim(`  session: ${entry.session_id}`));
    console.log(pc.yellow('══════════════════════════════════════════════════════════════'));
    console.log('');
  } else if (typeof entry.message === 'string') {
    console.log(pc.yellow(`[system] ${entry.message}`));
  }
}

function formatAssistantEntry(entry: LogEntry): void {
  const message = entry.message as Message | undefined;
  if (!message?.content) return;

  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      console.log('');
      console.log(pc.green('┌─ CLAUDE ─────────────────────────────────────────────────────'));
      for (const line of block.text.split('\n')) {
        console.log(pc.green('│ ') + line);
      }
      console.log(pc.green('└──────────────────────────────────────────────────────────────'));
    } else if (block.type === 'tool_use' && block.name) {
      console.log('');
      console.log(pc.blue(`  ⚡ ${block.name}`));
      if (block.input) {
        const formatted = formatToolInput(block.name, block.input);
        for (const line of formatted.split('\n')) {
          console.log(pc.dim(`     ${line}`));
        }
      }
    }
  }
}

function formatUserEntry(entry: LogEntry): void {
  const message = entry.message as Message | undefined;
  if (!message?.content) return;

  for (const block of message.content) {
    if (block.type === 'tool_result') {
      // Get result content - either from block.content or entry.tool_use_result
      let resultContent = block.content || '';
      let filePath: string | undefined;

      if (entry.tool_use_result?.file?.filePath) {
        filePath = entry.tool_use_result.file.filePath;
      }

      // Truncate long results
      const lines = resultContent.split('\n');
      const maxLines = 15;
      const truncated = lines.length > maxLines;
      const displayLines = truncated ? lines.slice(0, maxLines) : lines;

      if (filePath) {
        console.log(pc.dim(`     ↳ ${filePath}`));
      }

      for (const line of displayLines) {
        // Remove line number prefix if present (e.g., "    1→") and truncate long lines
        const cleanLine = line.replace(/^\s*\d+→/, '');
        const truncatedLine = cleanLine.length > 100 ? cleanLine.slice(0, 100) + '...' : cleanLine;
        console.log(pc.dim(`     │ ${truncatedLine}`));
      }

      if (truncated) {
        console.log(pc.dim(`     │ ... (${lines.length - maxLines} more lines)`));
      }
    }
  }
}

function formatFinalResult(entry: LogEntry): void {
  console.log('');
  console.log(pc.magenta('══════════════════════════════════════════════════════════════'));
  console.log(pc.magenta('  SESSION COMPLETE'));
  console.log(pc.magenta('══════════════════════════════════════════════════════════════'));

  if (entry.duration_ms) {
    const mins = Math.floor(entry.duration_ms / 60000);
    const secs = Math.floor((entry.duration_ms % 60000) / 1000);
    console.log(pc.dim(`  Duration: ${mins}m ${secs}s`));
  }
  if (entry.num_turns) {
    console.log(pc.dim(`  Turns: ${entry.num_turns}`));
  }
  if (entry.total_cost_usd) {
    console.log(pc.dim(`  Cost: $${entry.total_cost_usd.toFixed(2)}`));
  }

  if (entry.result) {
    console.log('');
    console.log(pc.white('  Result:'));
    for (const line of entry.result.split('\n')) {
      console.log(`  ${line}`);
    }
  }
  console.log('');
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `${input.file_path}`;

    case 'Write': {
      const content = input.content as string;
      const preview = content?.split('\n').slice(0, 5).join('\n') || '';
      return `${input.file_path}\n${truncateMultiline(preview, 200)}`;
    }

    case 'Edit':
      return `${input.file_path}\n- ${truncateMultiline(input.old_string as string, 100)}\n+ ${truncateMultiline(input.new_string as string, 100)}`;

    case 'Bash':
      return `$ ${input.command}`;

    case 'Glob':
      return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;

    case 'Grep':
      return `/${input.pattern}/${input.path ? ` in ${input.path}` : ''}`;

    case 'TodoWrite': {
      const todos = input.todos as Array<{ content: string; status: string }> | undefined;
      if (todos) {
        return todos
          .map(t => {
            const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
            return `${icon} ${t.content}`;
          })
          .join('\n');
      }
      return JSON.stringify(input);
    }

    case 'Task':
      return `[${input.subagent_type}] ${input.description || ''}\n${truncateMultiline(input.prompt as string, 150)}`;

    default:
      // Compact JSON for unknown tools
      const json = JSON.stringify(input);
      return json.length > 200 ? json.slice(0, 200) + '...' : json;
  }
}

function truncateMultiline(str: string | undefined, maxLen: number): string {
  if (!str) return '';
  const single = str.replace(/\n/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen) + '...';
}

export async function clearHandler(logs: LogsService, runId?: string): Promise<void> {
  try {
    const runs = await logs.listRuns();

    if (runs.length === 0) {
      console.log(pc.yellow('No logs to clear.'));
      return;
    }

    if (runId) {
      // Clear specific run
      if (!runs.includes(runId)) {
        console.log(pc.yellow(`Run "${runId}" not found.`));
        return;
      }

      await clearRunLogs(runId);
      console.log(pc.green(`Cleared logs for run ${runId}`));
    } else {
      // Interactive: select which run(s) to clear
      p.intro(pc.bgRed(pc.white(' Clear Logs ')));

      const currentRunId = await logs.getCurrentRunId();

      const choices = [
        { value: 'all', label: 'All logs', hint: `${runs.length} run(s)` },
        ...runs.map(id => ({
          value: id,
          label: id === currentRunId ? `${id} (current)` : id,
        })),
      ];

      const selected = await p.select({
        message: 'Select logs to clear:',
        options: choices,
      });

      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }

      if (selected === 'all') {
        for (const id of runs) {
          await clearRunLogs(id);
        }
        p.outro(pc.green(`Cleared all logs (${runs.length} runs)`));
      } else {
        await clearRunLogs(selected as string);
        p.outro(pc.green(`Cleared logs for run ${selected}`));
      }
    }
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

async function clearRunLogs(runId: string): Promise<void> {
  const fs = await import('fs/promises');
  const logsDir = `.claude/dev-loop/logs/${runId}`;

  try {
    await fs.rm(logsDir, { recursive: true });
  } catch {
    // Directory might not exist
  }
}
