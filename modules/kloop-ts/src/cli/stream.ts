import pc from 'picocolors';
import { tryParseJson } from '../stream/parse';
import { formatEvent } from '../stream/format';

const RETRY_PATTERN = /Attempt \d+ failed.*Retrying after/i;
const MAX_CONSECUTIVE_RETRIES = 5;

export async function handler(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let consecutiveRetries = 0;

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const action = processLine(line);

      if (action === 'retry') {
        consecutiveRetries++;
        if (consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) {
          console.error(pc.red(`[kloop] Detected ${MAX_CONSECUTIVE_RETRIES} consecutive retries — aborting.`));
          process.exit(1);
        }
      } else if (action === 'progress') {
        // Any JSON event means the harness is making progress — reset counter
        consecutiveRetries = 0;
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    processLine(buffer);
  }
}

function processLine(line: string): 'retry' | 'progress' | 'skip' {
  const trimmed = line.trim();
  if (!trimmed) return 'skip';

  const event = tryParseJson(trimmed);

  if (event) {
    const formatted = formatEvent(event);
    if (formatted) {
      console.log(formatted);
    }
    return 'progress';
  }

  // Not JSON — check for gemini-cli retry loops
  if (RETRY_PATTERN.test(trimmed)) {
    console.log(pc.yellow(trimmed));
    return 'retry';
  }

  // Other non-JSON noise (keytar warnings, etc.)
  return 'skip';
}
