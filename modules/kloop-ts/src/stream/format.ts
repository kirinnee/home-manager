import pc from 'picocolors';
import type { StreamEvent, ContentBlock } from './parse';
import { extractText, extractToolUses } from './parse';

export function formatEvent(event: StreamEvent): string | null {
  switch (event.type) {
    case 'system':
      if (event.message) {
        return pc.dim(`[system] ${event.message}`);
      }
      if (event.subtype === 'init' && event.session_id) {
        return pc.dim(`[system:init session_id=${event.session_id}]`);
      }
      return pc.dim(`[system]`);

    case 'user':
      return formatUserMessage(event.message.content);

    case 'assistant':
      return formatAssistantMessage(event.message.content);

    case 'result':
      return formatResult(event.result);

    case 'error':
      return pc.red(`[error] ${event.error.message}`);

    case 'unknown':
      return null; // Skip unknown events
  }
}

function formatUserMessage(content: string | Array<ContentBlock>): string {
  if (typeof content === 'string') {
    const truncated = content.length > 200 ? content.slice(0, 200) + '...' : content;
    return pc.cyan(`▶ ${truncated.replace(/\n/g, ' ')}`);
  }

  const text = extractText(content);
  if (text) {
    const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
    return pc.cyan(`▶ ${truncated.replace(/\n/g, ' ')}`);
  }

  // tool_use_result / tool_result blocks — show truncated summary
  const toolResults = content.filter(
    (
      c,
    ): c is {
      type: 'tool_use_result' | 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string }>;
    } => c.type === 'tool_use_result' || c.type === 'tool_result',
  );
  if (toolResults.length > 0) {
    return pc.dim(`  ↳ ${toolResults.length} tool result(s)`);
  }

  return '';
}

function formatAssistantMessage(content: Array<ContentBlock>): string {
  const parts: string[] = [];

  // Text content
  const text = extractText(content);
  if (text) {
    parts.push(text);
  }

  // Tool uses
  const tools = extractToolUses(content);
  for (const tool of tools) {
    parts.push(pc.yellow(`[${tool.name}]`) + formatToolInput(tool.input));
  }

  return parts.join('\n');
}

function formatToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const o = input as Record<string, unknown>;

  // Common tool patterns
  if ('command' in o && typeof o.command === 'string') {
    return pc.dim(` $ ${o.command.slice(0, 80)}`);
  }
  if ('file_path' in o && typeof o.file_path === 'string') {
    return pc.dim(` ${o.file_path}`);
  }
  if ('pattern' in o && typeof o.pattern === 'string') {
    return pc.dim(` ${o.pattern}`);
  }

  return '';
}

function formatResult(result: { cost_usd?: number; duration_ms?: number; session_id?: string }): string {
  const parts: string[] = [];

  if (result.duration_ms) {
    const secs = (result.duration_ms / 1000).toFixed(1);
    parts.push(`${secs}s`);
  }

  if (result.cost_usd) {
    parts.push(`$${result.cost_usd.toFixed(4)}`);
  }

  return pc.dim(`[done] ${parts.join(' | ')}`);
}
