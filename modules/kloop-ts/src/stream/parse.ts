// Stream JSON event types from claude --output-format stream-json

export type StreamEvent =
  | { type: 'system'; message: string; timestamp?: string }
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

function normalizeEvent(obj: unknown): StreamEvent {
  if (!obj || typeof obj !== 'object') {
    return { type: 'unknown', raw: obj };
  }

  const o = obj as Record<string, unknown>;

  if (o.type === 'system' && typeof o.message === 'string') {
    return { type: 'system', message: o.message, timestamp: o.timestamp as string };
  }

  if (o.type === 'assistant' && o.message) {
    return { type: 'assistant', message: o.message as AssistantMessage };
  }

  if (o.type === 'user' && o.message) {
    return { type: 'user', message: o.message as UserMessage };
  }

  if (o.type === 'result' && o.result) {
    return { type: 'result', result: o.result as ResultMessage };
  }

  if (o.type === 'error' && o.error) {
    return { type: 'error', error: o.error as { message: string } };
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

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
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
 */
export function extractTokensFromContent(content: string): TokenCounts {
  const result: TokenCounts = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'result') {
        // Tokens live under parsed.usage (not parsed.result.usage)
        const usage = parsed.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          result.inputTokens = usage.input_tokens;
        }
        if (usage && typeof usage.output_tokens === 'number') {
          result.outputTokens = usage.output_tokens;
        }
        // Found the result event, no need to continue
        break;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return result;
}
