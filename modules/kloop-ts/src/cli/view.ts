import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { createReadStream, existsSync, statSync } from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { paths } from '../deps';
import type { CliDeps } from './index';

/**
 * kloop view [id] [loop] [role] [ordinal] [-f] [--since <duration|iso>]
 *
 * Shows agent logs from ~/.kloop/{runId}/loop-{N}/{implementer,reviewer-{R}}/log
 */

interface AgentEntry {
  dirName: string;
  label: string;
  logPath: string;
}

interface LoopEntry {
  loopNum: number;
  agents: AgentEntry[];
}

export async function handler(
  runId: string | undefined,
  loopArg: string | undefined,
  roleArg: string | undefined,
  ordinalArg: string | undefined,
  opts: { f?: boolean; since?: string },
  deps: CliDeps,
): Promise<void> {
  try {
    const { indexDb } = deps;

    // Resolve run ID
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No run found for this workspace.'));
        return;
      }
      runId = row.id;
    }

    const runDir = paths.runPath(runId);
    if (!(await fileExists(runDir))) {
      console.log(pc.red(`Run not found: ${runId}`));
      return;
    }

    const loops = await discoverLoops(runDir);
    if (loops.length === 0) {
      console.log(pc.yellow('No agent logs found for this run.'));
      return;
    }

    // If no loop arg, prompt for loop
    if (!loopArg) {
      const selectedLoop = await promptLoop(loops);
      if (!selectedLoop) return;
      // Then prompt for agent within that loop
      const selectedAgent = await promptAgent(selectedLoop.agents);
      if (!selectedAgent) return;
      await displayLog(selectedAgent, opts);
      return;
    }

    // If loop arg provided, resolve it
    const loopNum = parseInt(loopArg, 10);
    const loop = loops.find(l => l.loopNum === loopNum);
    if (!loop) {
      console.log(pc.yellow(`Loop ${loopNum} not found. Available: ${loops.map(l => l.loopNum).join(', ')}`));
      return;
    }

    // If role arg provided, resolve agent directly
    if (roleArg) {
      const agent = resolveAgent(roleArg, ordinalArg, loop);
      if (!agent) {
        console.log(pc.yellow(`Agent not found. Available: ${loop.agents.map(a => a.label).join(', ')}`));
        return;
      }
      await displayLog(agent, opts);
      return;
    }

    // Loop specified but no role — prompt for agent
    const selectedAgent = await promptAgent(loop.agents);
    if (!selectedAgent) return;
    await displayLog(selectedAgent, opts);
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ============================================================================
// Discovery
// ============================================================================

async function discoverLoops(runDir: string): Promise<LoopEntry[]> {
  const entries = await fs.readdir(runDir);
  const loops: LoopEntry[] = [];

  for (const entry of entries) {
    const match = entry.match(/^loop-(\d+)$/);
    if (!match) continue;

    const loopNum = parseInt(match[1], 10);
    const loopDir = path.join(runDir, entry);
    const agents = await discoverAgents(loopDir, loopNum);

    if (agents.length > 0) {
      loops.push({ loopNum, agents });
    }
  }

  // Sort latest first
  return loops.sort((a, b) => b.loopNum - a.loopNum);
}

async function discoverAgents(loopDir: string, _loopNum: number): Promise<AgentEntry[]> {
  const agents: AgentEntry[] = [];

  try {
    const entries = await fs.readdir(loopDir);
    for (const entry of entries) {
      // Only show actual agent directories, not evidence/summary/metadata dirs
      if (entry === 'evidence' || entry === 'summary.json' || entry === 'summary.md' || entry === 'learning.md')
        continue;
      if (!entry.startsWith('implementer') && !entry.startsWith('reviewer-') && !entry.startsWith('checkpointer'))
        continue;

      const entryPath = path.join(loopDir, entry);
      // Skip files, only look at directories
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const logPath = path.join(entryPath, 'log');

      const label = entry === 'implementer' ? 'impl' : entry === 'checkpointer' ? 'checkpoint' : entry; // reviewer-0, reviewer-1, etc.

      agents.push({ dirName: entry, label, logPath });
    }
  } catch {
    // Not a directory
  }

  return agents;
}

// ============================================================================
// Resolution
// ============================================================================

function resolveAgent(roleArg: string, ordinalArg: string | undefined, loop: LoopEntry): AgentEntry | null {
  if (roleArg === 'impl' || roleArg === 'implementer') {
    return loop.agents.find(a => a.dirName === 'implementer') ?? null;
  }

  if (roleArg === 'rev' || roleArg === 'reviewer') {
    if (ordinalArg === undefined) {
      // Return the first reviewer
      return loop.agents.find(a => a.dirName === 'reviewer-0') ?? null;
    }
    return loop.agents.find(a => a.dirName === `reviewer-${ordinalArg}`) ?? null;
  }

  // Try exact match (e.g., "reviewer-0")
  return loop.agents.find(a => a.dirName === roleArg) ?? null;
}

// ============================================================================
// Display
// ============================================================================

async function displayLog(agent: AgentEntry, opts: { f?: boolean; since?: string }): Promise<void> {
  if (opts.f) {
    await followLog(agent, opts);
    return;
  }

  if (!(await fileExists(agent.logPath))) {
    if (opts.f) return; // tail -f handled above
    console.log(pc.yellow(`No log yet — ${agent.label} may still be starting.`));
    console.log(pc.dim(`Try: kloop view ${agent.dirName === 'implementer' ? '1 impl' : '1 ' + agent.dirName} -f`));
    return;
  }

  let content = await fs.readFile(agent.logPath, 'utf-8');

  // Filter by --since (ISO timestamp in JSON log entries)
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    if (cutoff) {
      content = filterJsonLogSince(content, cutoff);
    }
  }

  if (!content.trim()) {
    console.log(pc.yellow('No log entries.'));
    return;
  }

  console.log(pc.dim(`${agent.label} — ${agent.logPath}`));
  console.log('');
  displayFormattedLog(content);
}

// ============================================================================
// Interactive prompts
// ============================================================================

async function promptLoop(loops: LoopEntry[]): Promise<LoopEntry | null> {
  if (loops.length === 1) {
    return loops[0];
  }

  p.intro(pc.bgCyan(pc.black(' Select Loop ')));

  const choices = loops.map(l => ({
    value: l,
    label: `Loop ${l.loopNum}`,
    hint: `${l.agents.length} agent(s)`,
  }));

  const selected = await p.select({
    message: 'Select a loop:',
    options: choices,
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    return null;
  }

  p.outro(`Loop ${selected.loopNum}`);
  return selected as LoopEntry;
}

async function promptAgent(agents: AgentEntry[]): Promise<AgentEntry | null> {
  if (agents.length === 1) {
    return agents[0];
  }

  const choices = agents.map(a => ({
    value: a,
    label: a.label,
    hint: a.dirName,
  }));

  const selected = await p.select({
    message: 'Select an agent:',
    options: choices,
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    return null;
  }

  return selected as AgentEntry;
}

// ============================================================================
// Follow mode — tail + pretty-print new lines as they arrive
// ============================================================================

/**
 * Follow a log file, pretty-printing each JSON line as it appears.
 * If the file doesn't exist yet, waits for it to be created.
 */
async function followLog(agent: AgentEntry, opts: { since?: string }): Promise<void> {
  console.log(pc.dim(`Following: ${agent.label} — ${agent.logPath}`));
  console.log(pc.dim('Press Ctrl+C to stop'));
  console.log('');

  const cutoff = opts.since ? parseSince(opts.since) : null;

  // Wait for file to appear
  while (!existsSync(agent.logPath)) {
    await Bun.sleep(500);
  }

  // If --since was given, skip existing content before the cutoff
  let startOffset = 0;
  if (cutoff) {
    try {
      const content = await fs.readFile(agent.logPath, 'utf-8');
      const lines = content.split('\n');
      let byteOffset = 0;
      for (const line of lines) {
        byteOffset += Buffer.byteLength(line) + 1; // +1 for \n
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const ts = obj.timestamp ?? obj.ts;
          if (ts && new Date(ts).getTime() >= cutoff.getTime()) {
            startOffset = byteOffset;
            break;
          }
        } catch {
          // keep non-JSON lines
        }
      }
    } catch {
      // ignore
    }
  }

  // Create readline interface starting from the offset
  const stream = createReadStream(agent.logPath, {
    start: startOffset,
    encoding: 'utf-8',
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Process existing lines first
  for await (const line of rl) {
    formatLine(line);
  }

  // Now watch for new content appended to the file
  // We use a polling approach: periodically stat the file and read new bytes
  let lastSize = 0;
  try {
    lastSize = statSync(agent.logPath).size;
  } catch {}

  const pollInterval = setInterval(async () => {
    try {
      const currentSize = statSync(agent.logPath).size;
      if (currentSize <= lastSize) return;

      // Read only the new portion
      const fd = fsSync.openSync(agent.logPath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      fsSync.readSync(fd, buf, 0, buf.length, lastSize);
      fsSync.closeSync(fd);
      lastSize = currentSize;

      const newContent = buf.toString('utf-8');
      for (const line of newContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) formatLine(trimmed);
      }
    } catch {
      // File might have been rotated — re-open
      lastSize = 0;
    }
  }, 300);

  // Clean up on Ctrl+C
  const cleanup = () => {
    clearInterval(pollInterval);
    rl.close();
    stream.destroy();
    process.exit(0);
  };
  process.on('SIGINT', cleanup, { once: true });
  process.on('SIGTERM', cleanup, { once: true });
}

function formatLine(line: string): void {
  try {
    const obj = JSON.parse(line) as LogEntry;
    formatLogEntry(obj);
  } catch {
    console.log(line);
  }
}

// ============================================================================
// Log formatting (reused from old logs.ts — Claude stream JSON parser)
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
    console.log(pc.yellow('  SESSION START'));
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
    if (block.type === 'tool_result' || block.type === 'tool_use_result') {
      let resultContent = block.content || '';
      let filePath: string | undefined;

      if (entry.tool_use_result?.file?.filePath) {
        filePath = entry.tool_use_result.file.filePath;
      }

      const lines = resultContent.split('\n');
      const maxLines = 15;
      const truncated = lines.length > maxLines;
      const displayLines = truncated ? lines.slice(0, maxLines) : lines;

      if (filePath) {
        console.log(pc.dim(`     ↳ ${filePath}`));
      }

      for (const line of displayLines) {
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
    default: {
      const json = JSON.stringify(input);
      return json.length > 200 ? json.slice(0, 200) + '...' : json;
    }
  }
}

// ============================================================================
// --since filtering
// ============================================================================

function filterJsonLogSince(content: string, cutoff: Date): string {
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      const obj = JSON.parse(trimmed);
      const ts = obj.timestamp ?? obj.ts;
      if (ts) {
        return new Date(ts).getTime() >= cutoff.getTime();
      }
      return true; // Keep entries without timestamps
    } catch {
      return true; // Keep non-JSON lines
    }
  });
  return filtered.join('\n');
}

function parseSince(since: string): Date | null {
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d;

  const match = since.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    const now = Date.now();
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(now - val * (multipliers[unit] ?? 60000));
  }

  return null;
}

function truncateMultiline(str: string | undefined, maxLen: number): string {
  if (!str) return '';
  const single = str.replace(/\n/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen) + '...';
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
