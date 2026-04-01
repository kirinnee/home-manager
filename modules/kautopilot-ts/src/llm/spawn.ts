import { spawn } from 'bun';
import { spinner } from '@clack/prompts';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Whether debug logging is enabled (KAUTOPILOT_DEBUG=1). */
export const DEBUG = !!process.env.KAUTOPILOT_DEBUG;

/** Debug log — only prints when KAUTOPILOT_DEBUG is set. */
export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.error('[debug]', ...args);
}

/** Resolve the Claude binary: CLAUDE_BINARY env var, or 'claude' as default. */
export function claudeBinary(): string {
  return process.env.CLAUDE_BINARY ?? 'claude';
}

export interface SpawnPrintOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** If set, show a clack spinner with this message while the LLM runs. */
  spinnerMsg?: string;
  /** Session ID — when set, the JSONL stream is tee'd to the session's logs/llm/ dir. */
  sessionId?: string;
  /** Label for the log file (e.g. "gather-codebase", "review-completeness"). */
  label?: string;
}

/** Build the JSONL log file path for a session. Creates the directory. */
function llmLogPath(sessionId: string, label: string): string {
  const logsDir = join(process.env.HOME!, '.kautopilot', sessionId, 'logs', 'llm');
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(logsDir, `${ts}-${label}.jsonl`);
}

/**
 * Extract the final assistant result text from a stream-json JSONL output.
 * Looks for the last `result` message, falling back to concatenating assistant text.
 */
function extractResultText(jsonlOutput: string): string {
  const lines = jsonlOutput
    .trim()
    .split('\n')
    .filter(l => l.trim());
  let resultText = '';
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // Final result event
      if (event.type === 'result' && event.result) {
        resultText = event.result;
      }
      // Assistant text content blocks
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
      }
      // Content block delta (streaming text)
      if (event.type === 'content_block_delta' && event.delta?.text) {
        textParts.push(event.delta.text);
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return resultText || textParts.join('') || jsonlOutput.trim();
}

/**
 * Core spawn logic shared between spawnPrint and spawnPrintRaw.
 * When sessionId is set, uses --output-format stream-json and tees to JSONL log.
 */
async function spawnCore(
  binary: string,
  prompt: string,
  options?: SpawnPrintOptions,
): Promise<{ stdout: string; stderr: string }> {
  const logging = !!options?.sessionId;
  const args = [binary, '--print', '--dangerously-skip-permissions'];
  if (logging) args.push('--output-format', 'stream-json', '--verbose');
  args.push(prompt);

  debugLog(`$ ${args.join(' ').slice(0, 200)}...`, options?.cwd ? `cwd=${options.cwd}` : '');

  const logPath = logging ? llmLogPath(options.sessionId!, options.label ?? 'unnamed') : null;

  const proc = spawn({
    cmd: args,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });

  const timeoutMs = options?.timeout ? options.timeout * 1000 : 300_000;

  // Collect output chunks incrementally so we can log partial output on timeout
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutDone = (async () => {
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      stdoutChunks.push(new TextDecoder().decode(chunk));
    }
  })();
  const stderrDone = (async () => {
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      stderrChunks.push(new TextDecoder().decode(chunk));
    }
  })();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      // Log partial output on timeout for debugging
      const partial = stdoutChunks.join('');
      if (logging && logPath) {
        writeFileSync(logPath, partial + '\n--- TIMED OUT ---\n');
        debugLog(`[llm-log] ${logPath} (partial, timed out)`);
      }
      const stderrText = stderrChunks.join('').trim();
      const hint = stderrText ? `\nstderr: ${stderrText.slice(0, 500)}` : '';
      reject(new Error(`${binary} timed out after ${Math.round(timeoutMs / 1000)}s${hint}`));
    }, timeoutMs),
  );

  await Promise.race([Promise.all([stdoutDone, stderrDone]), timeoutPromise]);

  const rawStdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');

  if (stderr) {
    debugLog(`[${binary}] stderr: ${stderr.trim()}`);
  }

  // Tee JSONL to log file and extract result text
  if (logging && logPath) {
    writeFileSync(logPath, rawStdout);
    debugLog(`[llm-log] ${logPath}`);
    const resultText = extractResultText(rawStdout);
    return { stdout: resultText, stderr };
  }

  return { stdout: rawStdout.trim(), stderr };
}

export async function spawnPrint<T = unknown>(binary: string, prompt: string, options?: SpawnPrintOptions): Promise<T> {
  const spinMsg = options?.spinnerMsg;
  const s = spinMsg && process.stdout.isTTY ? spinner() : null;
  s?.start(spinMsg!);

  const { stdout } = await spawnCore(binary, prompt, options);

  s?.stop(spinMsg ?? '');

  try {
    // Strip markdown code fences if present (LLMs often wrap JSON in ```json ... ```)
    const cleaned = stdout
      .replace(/^```(?:json)?\s*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`LLM returned invalid JSON: ${stdout.slice(0, 200)}`);
  }
}

export interface SpawnTTYOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Pre-generated UUID for claude --session-id (enables JSONL tracking). */
  claudeSessionId?: string;
}

export async function spawnTTY(binary: string, prompt: string, options?: SpawnTTYOptions): Promise<number> {
  const args = [binary, '--dangerously-skip-permissions'];
  if (options?.claudeSessionId) {
    args.push('--session-id', options.claudeSessionId);
  }
  args.push(prompt);
  debugLog(`$ ${args.join(' ').slice(0, 200)}...`, options?.cwd ? `cwd=${options.cwd}` : '');

  const proc = spawn({
    cmd: args,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });

  const exitCode = await proc.exited;
  debugLog(`$ ${binary} exited with code ${exitCode}`);
  return exitCode;
}

/** Convenience: spawnPrint that returns raw string (no JSON parsing). */
export async function spawnPrintRaw(binary: string, prompt: string, options?: SpawnPrintOptions): Promise<string> {
  const spinMsg = options?.spinnerMsg;
  const s = spinMsg && process.stdout.isTTY ? spinner() : null;
  s?.start(spinMsg!);

  const { stdout } = await spawnCore(binary, prompt, options);

  s?.stop(spinMsg ?? '');

  return stdout;
}
