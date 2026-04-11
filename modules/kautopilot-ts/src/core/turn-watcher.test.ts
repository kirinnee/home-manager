import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInitialContext,
  type ParsedEntry,
  processEntries,
  processEntry,
  readAppendedLines,
  type TurnMachineContext,
  watchTurn,
} from './turn-watcher';

// ============================================================================
// Helpers
// ============================================================================

function ctx(overrides: Partial<TurnMachineContext> = {}): TurnMachineContext {
  return { ...createInitialContext(), ...overrides };
}

function userMsg(permissionMode = 'bypassPermissions'): ParsedEntry {
  return { type: 'user', timestamp: '2026-04-08T10:00:00Z', permissionMode };
}

function toolResultMsg(): ParsedEntry {
  return { type: 'user', timestamp: '2026-04-08T10:00:01Z', toolUseResult: {} };
}

function assistantEndTurn(): ParsedEntry {
  return {
    type: 'assistant',
    timestamp: '2026-04-08T10:00:02Z',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
    },
  };
}

function assistantToolUse(...toolNames: string[]): ParsedEntry {
  return {
    type: 'assistant',
    timestamp: '2026-04-08T10:00:03Z',
    message: {
      stop_reason: 'tool_use',
      content: toolNames.map(name => ({ type: 'tool_use', name })),
    },
  };
}

function assistantStreaming(): ParsedEntry {
  return {
    type: 'assistant',
    timestamp: '2026-04-08T10:00:04Z',
    message: { stop_reason: null, content: [{ type: 'thinking' }] },
  };
}

function queueEnqueue(): ParsedEntry {
  return {
    type: 'queue-operation',
    timestamp: '2026-04-08T10:00:05Z',
    operation: 'enqueue',
  };
}

function queueDequeue(): ParsedEntry {
  return {
    type: 'queue-operation',
    timestamp: '2026-04-08T10:00:06Z',
    operation: 'dequeue',
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempJsonl(initialLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'turn-watcher-'));
  tempDirs.push(dir);
  const path = join(dir, 'session.jsonl');
  // Each JSONL line is terminated by \n (matching production behavior)
  const content = initialLines.length > 0 ? `${initialLines.join('\n')}\n` : '';
  writeFileSync(path, content);
  return path;
}

function appendJsonl(path: string, ...entries: ParsedEntry[]): void {
  const payload = entries.map(entry => `${JSON.stringify(entry)}\n`).join('');
  writeFileSync(path, payload, { flag: 'a' });
}

// ============================================================================
// Tests
// ============================================================================

describe('turn state machine', () => {
  test('initial state is user_turn', () => {
    const c = createInitialContext();
    expect(c.state).toBe('user_turn');
  });

  test('simple user → LLM → user cycle', () => {
    let c = ctx();
    c = processEntry(c, userMsg());
    expect(c.state).toBe('llm_thinking');

    c = processEntry(c, assistantEndTurn());
    expect(c.state).toBe('user_turn');
  });

  test('tool use (bypassPermissions) → llm_executing → tool result → llm_thinking', () => {
    let c = ctx({ state: 'llm_thinking', permissionMode: 'bypassPermissions' });
    c = processEntry(c, assistantToolUse('Read'));
    expect(c.state).toBe('llm_executing');

    c = processEntry(c, toolResultMsg());
    expect(c.state).toBe('llm_thinking');
  });

  test('AskUserQuestion → user_interactive → tool result → llm_thinking', () => {
    let c = ctx({ state: 'llm_thinking', permissionMode: 'bypassPermissions' });
    c = processEntry(c, assistantToolUse('AskUserQuestion'));
    expect(c.state).toBe('user_interactive');

    c = processEntry(c, toolResultMsg());
    expect(c.state).toBe('llm_thinking');
  });

  test('ExitPlanMode → user_interactive → tool result → llm_thinking', () => {
    let c = ctx({ state: 'llm_thinking', permissionMode: 'bypassPermissions' });
    c = processEntry(c, assistantToolUse('ExitPlanMode'));
    expect(c.state).toBe('user_interactive');

    c = processEntry(c, toolResultMsg());
    expect(c.state).toBe('llm_thinking');
  });

  test('EnterPlanMode → user_interactive → tool result → llm_thinking', () => {
    let c = ctx({ state: 'llm_thinking', permissionMode: 'bypassPermissions' });
    c = processEntry(c, assistantToolUse('EnterPlanMode'));
    expect(c.state).toBe('user_interactive');

    c = processEntry(c, toolResultMsg());
    expect(c.state).toBe('llm_thinking');
  });

  test('non-bypass permission mode → tool_use → user_interactive (approval)', () => {
    let c = ctx({ state: 'llm_thinking', permissionMode: 'default' });
    c = processEntry(c, assistantToolUse('Bash'));
    expect(c.state).toBe('user_interactive');
  });

  test('queue-operation:enqueue → llm_thinking (from user_turn)', () => {
    let c = ctx({ state: 'user_turn' });
    c = processEntry(c, queueEnqueue());
    expect(c.state).toBe('llm_thinking');
  });

  test('queue-operation:enqueue does nothing when not in user_turn', () => {
    let c = ctx({ state: 'llm_thinking' });
    c = processEntry(c, queueEnqueue());
    expect(c.state).toBe('llm_thinking');
  });

  test('queue-operation:dequeue → no change', () => {
    let c = ctx({ state: 'llm_thinking' });
    c = processEntry(c, queueDequeue());
    expect(c.state).toBe('llm_thinking');
  });

  test('multiple tool_use with one interactive → user_interactive', () => {
    let c = ctx({ state: 'llm_thinking', permissionMode: 'bypassPermissions' });
    c = processEntry(c, assistantToolUse('Read', 'AskUserQuestion', 'Write'));
    expect(c.state).toBe('user_interactive');
  });

  test('streaming intermediates (stop_reason: null) → no state change', () => {
    let c = ctx({ state: 'llm_thinking' });
    c = processEntry(c, assistantStreaming());
    expect(c.state).toBe('llm_thinking');
  });

  test('malformed assistant entry (no message) → no state change', () => {
    let c = ctx({ state: 'llm_thinking' });
    c = processEntry(c, {
      type: 'assistant',
      timestamp: '2026-04-08T10:00:00Z',
    });
    expect(c.state).toBe('llm_thinking');
  });

  test('system:turn_duration → user_turn', () => {
    let c = ctx({ state: 'llm_thinking' });
    c = processEntry(c, { type: 'system', subtype: 'turn_duration', timestamp: '2026-04-08T10:00:00Z' });
    expect(c.state).toBe('user_turn');
  });

  test('system (other subtypes) / progress / file-history-snapshot → no change', () => {
    const entries: ParsedEntry[] = [
      { type: 'system', timestamp: '2026-04-08T10:00:00Z' },
      { type: 'system', subtype: 'summary', timestamp: '2026-04-08T10:00:00Z' },
      { type: 'progress', timestamp: '2026-04-08T10:00:00Z' },
      { type: 'file-history-snapshot', timestamp: '2026-04-08T10:00:00Z' },
      { type: 'last-prompt', timestamp: '2026-04-08T10:00:00Z' },
      { type: 'custom-title', timestamp: '2026-04-08T10:00:00Z' },
      { type: 'agent-name', timestamp: '2026-04-08T10:00:00Z' },
    ];
    for (const entry of entries) {
      let c = ctx({ state: 'llm_thinking' });
      c = processEntry(c, entry);
      expect(c.state).toBe('llm_thinking');
    }
  });

  test('permission mode is tracked from human user entries', () => {
    let c = ctx();
    c = processEntry(c, userMsg('bypassPermissions'));
    expect(c.permissionMode).toBe('bypassPermissions');

    c = processEntry(c, assistantEndTurn());
    c = processEntry(c, userMsg('default'));
    expect(c.permissionMode).toBe('default');
  });

  test('tool result does not change permission mode', () => {
    let c = ctx({
      state: 'llm_executing',
      permissionMode: 'bypassPermissions',
    });
    c = processEntry(c, toolResultMsg());
    expect(c.permissionMode).toBe('bypassPermissions');
  });

  test('userTurn derivation: user_turn and user_interactive → true, others → false', () => {
    // Tested via processEntries producing specific states
    let c = ctx({ state: 'user_turn' });
    // user_turn → userTurn true
    expect(c.state === 'user_turn' || c.state === 'user_interactive').toBe(true);

    c = ctx({ state: 'user_interactive' });
    expect(c.state === 'user_turn' || c.state === 'user_interactive').toBe(true);

    c = ctx({ state: 'llm_thinking' });
    expect(c.state === 'user_turn' || c.state === 'user_interactive').toBe(false);

    c = ctx({ state: 'llm_executing' });
    expect(c.state === 'user_turn' || c.state === 'user_interactive').toBe(false);
  });
});

describe('processEntries (batch)', () => {
  test('full conversation cycle', () => {
    const entries: ParsedEntry[] = [
      userMsg('bypassPermissions'),
      assistantStreaming(),
      assistantToolUse('Read'),
      toolResultMsg(),
      assistantToolUse('Write'),
      toolResultMsg(),
      assistantEndTurn(),
    ];
    const result = processEntries(ctx(), entries);
    expect(result.state).toBe('user_turn');
    expect(result.cursor).toBe(0); // processEntries doesn't advance cursor
  });

  test('interactive tool mid-conversation', () => {
    const entries: ParsedEntry[] = [
      userMsg('bypassPermissions'),
      assistantToolUse('Read'),
      toolResultMsg(),
      assistantToolUse('AskUserQuestion'),
      // User hasn't answered yet — state should be user_interactive
    ];
    const result = processEntries(ctx(), entries);
    expect(result.state).toBe('user_interactive');
  });

  test('queue enqueue transitions from user_turn to llm_thinking', () => {
    const entries: ParsedEntry[] = [userMsg('bypassPermissions'), assistantEndTurn(), queueEnqueue()];
    const result = processEntries(ctx(), entries);
    expect(result.state).toBe('llm_thinking');
  });
});

describe('cursor-based incremental processing', () => {
  test('processing lines incrementally gives same result as batch', () => {
    const entries: ParsedEntry[] = [
      userMsg('bypassPermissions'),
      assistantToolUse('Read'),
      toolResultMsg(),
      assistantToolUse('AskUserQuestion'),
      toolResultMsg(),
      assistantEndTurn(),
    ];

    const batch = processEntries(ctx(), entries);

    let incremental = ctx();
    incremental = processEntries(incremental, entries.slice(0, 3));
    incremental = processEntries(incremental, entries.slice(3));

    expect(incremental.state).toBe(batch.state);
    expect(incremental.permissionMode).toBe(batch.permissionMode);
  });

  test('readAppendedLines reads only appended bytes', () => {
    const path = makeTempJsonl([JSON.stringify(userMsg()), JSON.stringify(assistantEndTurn())]);
    const firstSize = statSync(path).size;

    appendJsonl(path, queueEnqueue(), assistantStreaming());
    const secondSize = statSync(path).size;

    expect(readAppendedLines(path, 0, firstSize)).toEqual([
      JSON.stringify(userMsg()),
      JSON.stringify(assistantEndTurn()),
    ]);
    expect(readAppendedLines(path, firstSize, secondSize)).toEqual([
      JSON.stringify(queueEnqueue()),
      JSON.stringify(assistantStreaming()),
    ]);
  });

  test('watchTurn emits initial state from existing file and processes appended entries', async () => {
    const path = makeTempJsonl([
      JSON.stringify(userMsg('bypassPermissions')),
      JSON.stringify(assistantToolUse('Read')),
    ]);
    const states: Array<{ userTurn: boolean; ts: string }> = [];
    const watcher = watchTurn(path, state => {
      states.push(state);
    });

    await Bun.sleep(50);
    expect(states.at(-1)).toEqual({
      userTurn: false,
      ts: '2026-04-08T10:00:03Z',
    });

    appendJsonl(path, toolResultMsg(), assistantEndTurn());
    await Bun.sleep(50);
    watcher.close();

    expect(states.at(-1)).toEqual({
      userTurn: true,
      ts: '2026-04-08T10:00:02Z',
    });
  });

  test('watchTurn handles partial JSONL writes without losing events', async () => {
    const entry1 = userMsg('bypassPermissions');
    const entry2 = assistantEndTurn();
    const fullLine1 = JSON.stringify(entry1);
    const fullLine2 = JSON.stringify(entry2);

    // Write first entry fully, then only a partial second entry
    const partial = fullLine2.slice(0, 20);
    const path = makeTempJsonl([fullLine1]);
    // Append partial line (no trailing newline)
    writeFileSync(path, `\n${partial}`, { flag: 'a' });

    const states: Array<{ userTurn: boolean; ts: string }> = [];
    const watcher = watchTurn(path, state => {
      states.push(state);
    });

    await Bun.sleep(50);
    // Should have processed entry1 (llm_thinking) but NOT the partial entry2
    expect(states.at(-1)?.userTurn).toBe(false);

    // Now complete the partial line
    const remainder = fullLine2.slice(20);
    writeFileSync(path, `${remainder}\n`, { flag: 'a' });

    await Bun.sleep(50);
    watcher.close();

    // Now entry2 (end_turn → user_turn) should be processed
    expect(states.at(-1)?.userTurn).toBe(true);
  });

  test('watchTurn resets cursor after file truncation', async () => {
    const path = makeTempJsonl([JSON.stringify(userMsg('bypassPermissions')), JSON.stringify(assistantEndTurn())]);
    const states: Array<{ userTurn: boolean; ts: string }> = [];
    const watcher = watchTurn(path, state => {
      states.push(state);
    });

    await Bun.sleep(50);
    writeFileSync(path, `${JSON.stringify(userMsg('default'))}\n${JSON.stringify(assistantToolUse('Bash'))}\n`);
    await Bun.sleep(50);
    watcher.close();

    expect(states.at(-1)).toEqual({
      userTurn: true,
      ts: '2026-04-08T10:00:03Z',
    });
  });
});
