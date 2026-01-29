import { tryParseJson } from '../stream/parse';
import { formatEvent } from '../stream/format';

export async function handler(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    for (const line of lines) {
      processLine(line);
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    processLine(buffer);
  }
}

function processLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  const event = tryParseJson(trimmed);

  if (event) {
    const formatted = formatEvent(event);
    if (formatted) {
      console.log(formatted);
    }
  } else {
    // Not JSON - print as literal
    console.log(line);
  }
}
