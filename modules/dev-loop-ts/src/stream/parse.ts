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
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

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
