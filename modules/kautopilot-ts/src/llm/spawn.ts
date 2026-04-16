import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spinner } from '@clack/prompts';
import { spawn } from 'bun';
import { stringify as stringifyYaml } from 'yaml';
import { nextRunNumber, type RunScope, runDir, runFilePath } from '../core/artifacts';

/** Whether debug logging is enabled (KAUTOPILOT_DEBUG=1). */
const DEBUG = !!process.env.KAUTOPILOT_DEBUG;

/** Debug log — only prints when KAUTOPILOT_DEBUG is set. */
export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.error('[debug]', ...args);
}

export interface SpawnPrintOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** If set, show a clack spinner with this message while the LLM runs. */
  spinnerMsg?: string;
  /** Legacy session ID shorthand for runtime session-scoped runs. */
  sessionId?: string;
  /** Explicit run scope for session or init execution roots. */
  runScope?: RunScope;
  /** Label for the log file (e.g. "gather-codebase", "review-completeness"). */
  label?: string;
  /** Human-readable context about why this run is happening. */
  context?: string;
}

interface RunArtifactInfo {
  scope: RunScope;
  runNumber: number;
  runPath: string;
  contextPath: string;
  logsPath: string;
  commandPath: string;
  promptPath: string;
  startedAt: string;
}

function resolveRunScope(options?: SpawnPrintOptions | SpawnTTYOptions): RunScope | null {
  if (options?.runScope) return options.runScope;
  const sessionId = 'sessionId' in (options ?? {}) ? (options as SpawnPrintOptions).sessionId : undefined;
  if (sessionId) {
    return { kind: 'session', id: sessionId };
  }
  return null;
}

function buildCommandString(args: string[]): string {
  return args.map(arg => (/^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
}

function createRunArtifacts(
  scope: RunScope,
  executionType: 'llm_print' | 'tty_handoff',
  binary: string,
  args: string[],
  prompt: string,
  options?: SpawnPrintOptions | SpawnTTYOptions,
): RunArtifactInfo {
  const runNumber = nextRunNumber(scope);
  const runPath = runDir(scope, runNumber);
  mkdirSync(runPath, { recursive: true });

  const contextPath = runFilePath(scope, runNumber, 'context');
  const logsPath = runFilePath(scope, runNumber, 'logs');
  const commandPath = runFilePath(scope, runNumber, 'command');
  const promptPath = runFilePath(scope, runNumber, 'prompt.md');

  writeFileSync(promptPath, prompt);
  writeFileSync(commandPath, `${buildCommandString(args)}\n`);
  writeFileSync(logsPath, '');
  const startedAt = new Date().toISOString();
  writeFileSync(
    contextPath,
    stringifyYaml({
      run: runNumber,
      scopeKind: scope.kind,
      scopeId: scope.id,
      executionType,
      label: options?.label,
      binary,
      cwd: options?.cwd,
      timeoutSeconds: 'timeout' in (options ?? {}) ? (options as SpawnPrintOptions).timeout : undefined,
      startedAt,
      status: 'running',
      why: options?.context,
    }),
  );

  return {
    scope,
    runNumber,
    runPath,
    contextPath,
    logsPath,
    commandPath,
    promptPath,
    startedAt,
  };
}

function updateRunContext(info: RunArtifactInfo, data: Record<string, unknown>): void {
  writeFileSync(info.contextPath, stringifyYaml(data));
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
): Promise<{
  stdout: string;
  stderr: string;
  runInfo: RunArtifactInfo | null;
}> {
  const runScope = resolveRunScope(options);
  const logging = !!runScope;
  const args = [binary, '--print', '--dangerously-skip-permissions'];
  if (logging) args.push('--output-format', 'stream-json', '--verbose');
  args.push(prompt);

  debugLog(`$ ${args.join(' ').slice(0, 200)}...`, options?.cwd ? `cwd=${options.cwd}` : '');

  const runInfo = runScope ? createRunArtifacts(runScope, 'llm_print', binary, args, prompt, options) : null;

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
      const text = new TextDecoder().decode(chunk);
      stdoutChunks.push(text);
      if (runInfo) appendFileSync(runInfo.logsPath, text);
    }
  })();
  const stderrDone = (async () => {
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      stderrChunks.push(text);
      if (runInfo) appendFileSync(runInfo.logsPath, text);
    }
  })();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      // Log partial output on timeout for debugging
      if (runInfo) {
        appendFileSync(runInfo.logsPath, '\n--- TIMED OUT ---\n');
        updateRunContext(runInfo, {
          run: runInfo.runNumber,
          scopeKind: runInfo.scope.kind,
          scopeId: runInfo.scope.id,
          executionType: 'llm_print',
          label: options?.label,
          binary,
          cwd: options?.cwd,
          timeoutSeconds: options?.timeout,
          startedAt: runInfo.startedAt,
          completedAt: new Date().toISOString(),
          status: 'timed_out',
          why: options?.context,
        });
        debugLog(`[llm-run] ${runInfo.logsPath} (partial, timed out)`);
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

  if (runInfo) {
    updateRunContext(runInfo, {
      run: runInfo.runNumber,
      scopeKind: runInfo.scope.kind,
      scopeId: runInfo.scope.id,
      executionType: 'llm_print',
      label: options?.label,
      binary,
      cwd: options?.cwd,
      timeoutSeconds: options?.timeout,
      startedAt: runInfo.startedAt,
      completedAt: new Date().toISOString(),
      status: 'completed',
      why: options?.context,
    });
    debugLog(`[llm-run] ${runInfo.logsPath}`);
  }

  // Tee JSONL to log file and extract result text
  if (logging) {
    const resultText = extractResultText(rawStdout);
    return { stdout: resultText, stderr, runInfo };
  }

  return { stdout: rawStdout.trim(), stderr, runInfo };
}

export interface SpawnTTYOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Pre-generated UUID for claude --session-id (enables JSONL tracking). */
  claudeSessionId?: string;
  /** Explicit run scope for session or init execution roots. */
  runScope?: RunScope;
  /** Human-readable context about why this run is happening. */
  context?: string;
  /** Optional label for the run directory metadata. */
  label?: string;
}

export async function spawnTTY(binary: string, prompt: string, options?: SpawnTTYOptions): Promise<number> {
  const args = [binary, '--dangerously-skip-permissions'];
  if (options?.claudeSessionId) {
    args.push('--session-id', options.claudeSessionId);
  }
  args.push(prompt);
  debugLog(`$ ${args.join(' ').slice(0, 200)}...`, options?.cwd ? `cwd=${options.cwd}` : '');

  const runScope = resolveRunScope(options);
  const runInfo = runScope ? createRunArtifacts(runScope, 'tty_handoff', binary, args, prompt, options) : null;

  const proc = spawn({
    cmd: args,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });

  const exitCode = await proc.exited;
  if (runInfo) {
    updateRunContext(runInfo, {
      run: runInfo.runNumber,
      scopeKind: runInfo.scope.kind,
      scopeId: runInfo.scope.id,
      executionType: 'tty_handoff',
      label: options?.label,
      binary,
      cwd: options?.cwd,
      startedAt: runInfo.startedAt,
      completedAt: new Date().toISOString(),
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      why: options?.context,
      claudeSessionId: options?.claudeSessionId,
    });
  }
  debugLog(`$ ${binary} exited with code ${exitCode}`);
  return exitCode;
}

/**
 * Strip markdown code fences that LLMs commonly wrap around responses.
 * Handles ``` and ```lang at start/end, including when the fence is the
 * entire content (e.g. LLM returns just "```").
 */
export function stripCodeFences(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
}

/** Convenience: spawnPrint that returns raw string (no JSON parsing). */
export async function spawnPrintRaw(binary: string, prompt: string, options?: SpawnPrintOptions): Promise<string> {
  const spinMsg = options?.spinnerMsg;
  const s = spinMsg && process.stdout.isTTY ? spinner() : null;
  s?.start(spinMsg as string);

  const { stdout } = await spawnCore(binary, prompt, options);

  s?.stop(spinMsg ?? '');

  return stripCodeFences(stdout);
}

/**
 * Spawn an LLM in --print mode, instructing it to write JSON to a file.
 * The model can reason freely in stdout; the file is the canonical result.
 * Requires sessionId or runScope so the output file lives in the run directory.
 *
 * The output path is injected into the prompt BEFORE spawnCore creates run
 * artifacts, so both share the same run directory. We peek at the next run
 * number (without creating the directory), then spawnCore's createRunArtifacts
 * calls nextRunNumber again and gets the same value since no directory was
 * created between the two calls. This is safe under Promise.all concurrency
 * because the peek → createRunArtifacts path is fully synchronous (no awaits).
 */
export async function spawnPrintToFile<T = unknown>(
  binary: string,
  prompt: string,
  options: (SpawnPrintOptions & { sessionId: string }) | (SpawnPrintOptions & { runScope: RunScope }),
): Promise<T> {
  // Peek at the run number spawnCore will use (it calls nextRunNumber internally)
  const scope = resolveRunScope(options)!;
  const nextRun = nextRunNumber(scope);
  const outputPath = runFilePath(scope, nextRun, 'output.json');

  const augmentedPrompt = `${prompt}

## Output File — CRITICAL
Write your JSON response to: ${outputPath}
Use the Write tool or Bash tool to write the file. Do NOT print the JSON to stdout — write it to the file above.
You may reason and analyze freely in your response, but the JSON MUST be written to the file.`;

  const spinMsg = options?.spinnerMsg;
  const s = spinMsg && process.stdout.isTTY ? spinner() : null;
  s?.start(spinMsg as string);

  await spawnCore(binary, augmentedPrompt, options);

  s?.stop(spinMsg ?? '');

  if (!existsSync(outputPath)) {
    throw new Error(`LLM did not write output file: ${outputPath}`);
  }

  const raw = readFileSync(outputPath, 'utf-8');
  try {
    const cleaned = stripCodeFences(raw);
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`LLM wrote invalid JSON to ${outputPath}: ${raw.slice(0, 200)}`);
  }
}
