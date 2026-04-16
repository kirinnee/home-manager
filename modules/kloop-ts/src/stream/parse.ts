// Stream JSON event types from claude --output-format stream-json and gemini CLI

export type StreamEvent =
  | { type: 'system'; subtype?: string; message?: string; session_id?: string; tools?: unknown[]; timestamp?: string }
  | { type: 'assistant'; message: AssistantMessage }
  | { type: 'user'; message: UserMessage }
  | { type: 'result'; result: ResultMessage }
  | { type: 'error'; error: { message: string } }
  | { type: 'unknown'; raw: unknown };

export interface AssistantMessage {
  content: Array<ContentBlock>;
}

export interface UserMessage {
  content: string | Array<ContentBlock>;
}

export interface ResultMessage {
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'tool_use_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> };

export function tryParseJson(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return normalizeEvent(parsed);
  } catch {
    return null;
  }
}

/**
 * Normalize Claude, Gemini, and Codex stream events into kloop's internal event shapes.
 *
 * Gemini event shapes (per spec):
 * - {type: "init", timestamp, session_id, model} -> system init
 * - {type: "message", timestamp, role: "user"|"model", content} -> user/assistant
 * - {type: "result", timestamp, status: "success", stats: {total_tokens, input_tokens, output_tokens, duration_ms}} -> result
 * - {type: "result", timestamp, status: "error", error: {type, message}, stats} -> error
 *
 * Codex event shapes (per spec):
 * - {type: "thread.started", thread_id} -> system init
 * - {type: "item.completed", item_type: "agent_message", content} -> assistant
 * - {type: "turn.completed", usage: {input_tokens, output_tokens}} -> result
 * - {type: "turn.failed", error: {message}} -> error
 */
function normalizeEvent(obj: unknown): StreamEvent {
  if (!obj || typeof obj !== 'object') {
    return { type: 'unknown', raw: obj };
  }

  const o = obj as Record<string, unknown>;

  // === Gemini error result (must come before success result) ===
  if (o.type === 'result' && o.status === 'error' && o.error) {
    const error = o.error as { message?: string };
    return { type: 'error', error: { message: error.message ?? 'Unknown error' } };
  }

  // === Claude system events ===
  if (o.type === 'system' && typeof o.message === 'string') {
    return { type: 'system', message: o.message, timestamp: o.timestamp as string };
  }

  // === Claude assistant events ===
  if (o.type === 'assistant' && o.message) {
    return { type: 'assistant', message: o.message as AssistantMessage };
  }

  // === Claude user events ===
  if (o.type === 'user' && o.message) {
    return { type: 'user', message: o.message as UserMessage };
  }

  // === Claude result events ===
  if (o.type === 'result' && o.result) {
    return { type: 'result', result: o.result as ResultMessage };
  }

  // === Claude error events ===
  if (o.type === 'error' && o.error) {
    return { type: 'error', error: o.error as { message: string } };
  }

  // === Gemini init event -> system init ===
  if (o.type === 'init' && typeof o.session_id === 'string') {
    return {
      type: 'system',
      subtype: 'init',
      session_id: o.session_id,
      tools: [],
    };
  }

  // === Gemini model message -> assistant message ===
  if (o.type === 'message' && (o.role === 'model' || o.role === 'assistant')) {
    const content = o.content;
    let normalizedContent: Array<ContentBlock>;

    if (typeof content === 'string') {
      normalizedContent = [{ type: 'text', text: content }];
    } else if (Array.isArray(content)) {
      normalizedContent = content as Array<ContentBlock>;
    } else {
      normalizedContent = [];
    }

    return {
      type: 'assistant',
      message: {
        content: normalizedContent,
      },
    };
  }

  // === Gemini user message -> user message ===
  if (o.type === 'message' && o.role === 'user') {
    const content = o.content;
    return {
      type: 'user',
      message: {
        content: typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<ContentBlock>) : '',
      },
    };
  }

  // === Gemini success result -> result ===
  if (o.type === 'result' && o.status === 'success' && o.stats) {
    const stats = o.stats as Record<string, unknown>;
    return {
      type: 'result',
      result: {
        duration_ms: stats.duration_ms as number | undefined,
        input_tokens: stats.input_tokens as number | undefined,
        output_tokens: stats.output_tokens as number | undefined,
      },
    };
  }

  // === Codex error: turn failed ===
  if (o.type === 'turn.failed' && o.error) {
    const error = o.error as { message?: string };
    return { type: 'error', error: { message: error.message ?? 'Unknown error' } };
  }

  // === Codex session start -> system init ===
  if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
    return {
      type: 'system',
      subtype: 'init',
      session_id: o.thread_id,
      tools: [],
    };
  }

  // === Codex assistant message (final only) -> assistant ===
  if (o.type === 'item.completed' && o.item_type === 'agent_message' && o.content) {
    return {
      type: 'assistant',
      message: {
        content:
          typeof o.content === 'string' ? [{ type: 'text', text: o.content }] : (o.content as Array<ContentBlock>),
      },
    };
  }

  // === Codex turn result -> result ===
  if (o.type === 'turn.completed' && o.usage) {
    const usage = o.usage as Record<string, unknown>;
    return {
      type: 'result',
      result: {
        duration_ms: o.duration_ms as number | undefined,
        input_tokens: usage.input_tokens as number | undefined,
        output_tokens: usage.output_tokens as number | undefined,
      },
    };
  }

  return { type: 'unknown', raw: obj };
}

export function extractText(content: Array<ContentBlock>): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('');
}

export function extractToolUses(content: Array<ContentBlock>): Array<{ name: string; input: unknown }> {
  return content
    .filter((c): c is { type: 'tool_use'; id: string; name: string; input: unknown } => c.type === 'tool_use')
    .map(c => ({ name: c.name, input: c.input }));
}

// ============================================================================
// Token extraction from log files
// ============================================================================

interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Extract the harness-native session ID from a log file.
 * For Gemini: reads the init event's session_id.
 * Returns undefined if not found.
 */
export async function extractHarnessSessionId(logFilePath: string): Promise<string | undefined> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(logFilePath, 'utf-8');
    return extractHarnessSessionIdFromContent(content);
  } catch {
    return undefined;
  }
}

/**
 * Parse log content for the harness-native session ID.
 * Gemini emits: {"type":"init","session_id":"..."}
 * Codex emits: {"type":"thread.started","thread_id":"..."}
 */
function extractHarnessSessionIdFromContent(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // Gemini init event
      if (parsed.type === 'init' && typeof parsed.session_id === 'string') {
        return parsed.session_id;
      }
      // Codex session ID: thread.started event with thread_id
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
        return parsed.thread_id;
      }
    } catch {
      // Skip malformed lines
    }
  }
  return undefined;
}

/**
 * Parse a log file for the result event and extract token counts.
 * Best-effort: returns undefined fields if not found or unparseable.
 */
export async function extractTokensFromLog(logFilePath: string): Promise<TokenCounts> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(logFilePath, 'utf-8');
    return extractTokensFromContent(content);
  } catch {
    return {};
  }
}

/**
 * Parse log content for the result event and extract token counts.
 * Supports Claude (usage.*), Gemini (stats.*), and Codex (turn.completed.usage.*) token formats.
 */
function extractTokensFromContent(content: string): TokenCounts {
  const result: TokenCounts = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'result') {
        // Claude token format: parsed.usage.input_tokens / parsed.usage.output_tokens
        const usage = parsed.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          result.inputTokens = usage.input_tokens;
        }
        if (usage && typeof usage.output_tokens === 'number') {
          result.outputTokens = usage.output_tokens;
        }

        // Gemini token format: parsed.stats.input_tokens / parsed.stats.output_tokens
        const stats = parsed.stats;
        if (stats) {
          if (typeof stats.input_tokens === 'number' && result.inputTokens === undefined) {
            result.inputTokens = stats.input_tokens;
          }
          if (typeof stats.output_tokens === 'number' && result.outputTokens === undefined) {
            result.outputTokens = stats.output_tokens;
          }
          // Also check total_tokens as fallback for input
          if (
            typeof stats.total_tokens === 'number' &&
            result.inputTokens === undefined &&
            result.outputTokens === undefined
          ) {
            // total_tokens is the sum; we can't split, so leave both undefined
            // This is better than showing misleading numbers
          }
        }

        // Found the result event, no need to continue
        break;
      }

      // Codex token format: turn.completed event with usage.input_tokens / usage.output_tokens
      if (parsed.type === 'turn.completed' && parsed.usage) {
        const usage = parsed.usage;
        if (typeof usage.input_tokens === 'number' && result.inputTokens === undefined) {
          result.inputTokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === 'number' && result.outputTokens === undefined) {
          result.outputTokens = usage.output_tokens;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return result;
}
