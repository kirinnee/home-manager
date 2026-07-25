import { describe, expect, test } from 'bun:test';
import { classifySystemText } from './system-blocks';

// Fixtures below are copied VERBATIM from real `~/.kteam/*/chat.jsonl` records
// (see the wrapper-mining scan in the plan) so the classifier is tested against
// the exact shapes both harnesses emit, not idealised ones.

const TASK_NOTIFICATION_STOPPED = `<task-notification>
<task-id>b1oj3g688</task-id>
<tool-use-id>toolu_01PgyNK8V9nw6B9fE15b3b7Z</tool-use-id>
<status>stopped</status>
<summary>No completion record was found for this background shell command from the previous session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited. Check the output file for partial results before assuming it completed.</summary>
</task-notification>`;

const TASK_NOTIFICATION_COMPLETED = `<task-notification>
<task-id>bywg8or5y</task-id>
<tool-use-id>toolu_01CtrjnCTNb6FwnhAJ6kCc26</tool-use-id>
<output-file>/tmp/claude-1000/-home-kirin-Workspace-atomi-diene--worktrees-exec-bun-lib-20260723T000641Z/bbdaff34-be96-4439-a258-e1646ab21f2c/tasks/bywg8or5y.output</output-file>
<status>completed</status>
<summary>Background command "Run all 15 bun-lib probes in background" completed (exit code 0)</summary>
</task-notification>`;

const TASK_NOTIFICATION_WITH_RESULT = `<task-notification>
<task-id>zzz</task-id>
<status>failed</status>
<result>Exit code 2
some more result detail on a second line</result>
</task-notification>`;

const TASK_NOTIFICATION_SUMMARY_AND_RESULT = `<task-notification>
<task-id>qqq</task-id>
<status>completed</status>
<result>3 passed, 0 failed
(trailing detail)</result>
<summary>Background command "run the suite" completed (exit code 0)</summary>
</task-notification>`;

const ENVIRONMENT_CONTEXT = `<environment_context>
  <cwd>/home/kirin/Workspace/atomi/diene/step5-work/spikes/logto-renewal</cwd>
  <shell>zsh</shell>
  <current_date>2026-07-22</current_date>
  <timezone>Etc/UTC</timezone>
  <filesystem><workspace_roots><root>/home/kirin/Workspace/atomi/diene/step5-work/spikes/logto-renewal</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

const TURN_PROMPT = `Read the file /home/kirin/.kteam/ms0v8vgc-d445a669/turns/turn-001.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`;

const SYSTEM_REMINDER = `<system-reminder>
The user has changed their mind about the approach. Prefer the smaller diff.
</system-reminder>`;

const COMPACTION = `This session is being continued from a previous conversation that ran out of context. Below is a summary of the conversation so far.

Summary:
1. Primary Request and Intent: the user asked to refactor the transcript renderer and we split it into blocks.

More detail follows across many lines...`;

const CODEX_PROTOCOL = `# AGENTS.md instructions

<INSTRUCTIONS>
- Run your own shell/tool-call commands through direnv exec.
- Never use Python for ad hoc scripting.
</INSTRUCTIONS>`;

const COMMAND_INLINE = `<command-name>/compact</command-name>`;

const COMMAND_SIBLINGS = `<command-message>compacting is running…</command-message>
<command-name>/compact</command-name>
<command-args></command-args>`;

const LOCAL_COMMAND_STDOUT = `<local-command-stdout>everything is up to date</local-command-stdout>`;

describe('classifySystemText — task notification', () => {
  test('stopped → warn tone, summary from <summary>, status retained', () => {
    const info = classifySystemText(TASK_NOTIFICATION_STOPPED);
    expect(info).not.toBeNull();
    expect(info!.label).toBe('task notification');
    expect(info!.status).toBe('stopped');
    expect(info!.tone).toBe('warn');
    expect(info!.summary).toContain('No completion record was found');
    expect(info!.raw).toBe(TASK_NOTIFICATION_STOPPED); // full text retained
  });

  test('completed → ok tone', () => {
    const info = classifySystemText(TASK_NOTIFICATION_COMPLETED);
    expect(info!.status).toBe('completed');
    expect(info!.tone).toBe('ok');
    expect(info!.summary).toContain('Run all 15 bun-lib probes');
  });

  test('failed with only <result> → err tone, summary is result first line', () => {
    const info = classifySystemText(TASK_NOTIFICATION_WITH_RESULT);
    expect(info!.status).toBe('failed');
    expect(info!.tone).toBe('err');
    expect(info!.summary).toBe('Exit code 2');
  });

  test('both <summary> and <result> present → both surfaced, neither dropped', () => {
    const info = classifySystemText(TASK_NOTIFICATION_SUMMARY_AND_RESULT);
    expect(info!.summary).toContain('run the suite'); // from <summary>
    expect(info!.summary).toContain('3 passed, 0 failed'); // first <result> line
  });

  test('summary is collapsed to a single line', () => {
    const info = classifySystemText(TASK_NOTIFICATION_STOPPED);
    expect(info!.summary).not.toContain('\n');
  });
});

describe('classifySystemText — other harness wrappers', () => {
  test('system-reminder → label + first non-tag line', () => {
    const info = classifySystemText(SYSTEM_REMINDER);
    expect(info!.label).toBe('system reminder');
    expect(info!.summary).toContain('changed their mind');
    expect(info!.raw).toBe(SYSTEM_REMINDER);
  });

  test('turn prompt → label + turn-NNN.md summary', () => {
    const info = classifySystemText(TURN_PROMPT);
    expect(info!.label).toBe('turn prompt');
    expect(info!.summary).toBe('turn-001.md');
    expect(info!.raw).toBe(TURN_PROMPT);
  });

  test('interrupt notice → interrupted, warn tone', () => {
    const info = classifySystemText('[Request interrupted by user]');
    expect(info!.label).toBe('interrupted');
    expect(info!.tone).toBe('warn');
  });

  test('interrupt notice (for tool use) → interrupted', () => {
    const info = classifySystemText('[Request interrupted by user for tool use]');
    expect(info!.label).toBe('interrupted');
  });

  test('compaction opener → first useful line AFTER Summary header, not the header', () => {
    const info = classifySystemText(COMPACTION);
    expect(info!.label).toBe('context compacted');
    expect(info!.summary).toContain('refactor the transcript renderer');
    expect(info!.summary!.toLowerCase()).not.toBe('summary:'); // never the literal header
    expect(info!.summary).not.toMatch(/^1\./); // leading list marker stripped
  });

  test('compaction with no Summary header → fixed fallback text', () => {
    const info = classifySystemText('This session is being continued from a previous conversation. Nothing else.');
    expect(info!.label).toBe('context compacted');
    expect(info!.summary).toBe('earlier conversation summarised');
  });
});

describe('classifySystemText — local slash-command markers (named in ask, 0 mined)', () => {
  test('inline command-name pair → label command, summary is the slash command', () => {
    const info = classifySystemText(COMMAND_INLINE);
    expect(info!.label).toBe('command');
    expect(info!.summary).toBe('/compact');
    expect(info!.raw).toBe(COMMAND_INLINE);
  });

  test('sibling command-message/command-name bundle → command, prefers command-name', () => {
    const info = classifySystemText(COMMAND_SIBLINGS);
    expect(info!.label).toBe('command');
    expect(info!.summary).toBe('/compact');
  });

  test('bare local-command-stdout → command, summary from stdout', () => {
    const info = classifySystemText(LOCAL_COMMAND_STDOUT);
    expect(info!.label).toBe('command');
    expect(info!.summary).toBe('everything is up to date');
  });

  test('human sentence starting "<command it to stop>" → null (allow-list is exact)', () => {
    expect(classifySystemText('<command it to stop> please')).toBeNull();
  });
});

describe('classifySystemText — Codex protocol turn', () => {
  test('# AGENTS.md instructions + wrapper → agents instructions (not a user >>> row)', () => {
    const info = classifySystemText(CODEX_PROTOCOL);
    expect(info!.label).toBe('agents instructions');
    expect(info!.summary).toBe('Codex harness instructions');
    expect(info!.raw).toBe(CODEX_PROTOCOL);
  });

  test('# AGENTS.md instructions WITHOUT the wrapper → null (human heading stays a message)', () => {
    expect(classifySystemText('# AGENTS.md instructions\n\nI edited these by hand, take a look.')).toBeNull();
  });

  test('ordinary markdown heading → null', () => {
    expect(classifySystemText('# Notes\n\nhere are some thoughts on the design')).toBeNull();
  });
});

describe('classifySystemText — generic fallback', () => {
  test('environment_context (all-tag children) → label = tag name', () => {
    const info = classifySystemText(ENVIRONMENT_CONTEXT);
    expect(info!.label).toBe('environment_context');
    expect(info!.raw).toBe(ENVIRONMENT_CONTEXT);
  });

  test('unknown wrapper with matching close tag → label = tag name + summary', () => {
    const info = classifySystemText('<future_wrapper>\nsome human-useful line\n</future_wrapper>');
    expect(info!.label).toBe('future_wrapper');
    expect(info!.summary).toBe('some human-useful line');
  });

  test('tag with attributes on first line still classifies', () => {
    const info = classifySystemText('<wrapper id="x" type="note">\nbody text\n</wrapper>');
    expect(info!.label).toBe('wrapper');
  });
});

describe('classifySystemText — must return null (never demote a human message)', () => {
  test('unknown opening tag WITHOUT a close tag → null', () => {
    expect(classifySystemText('<thinking about this> what should I do here?')).toBeNull();
  });

  test('human message that merely starts with < → null', () => {
    expect(classifySystemText('<3 this is great, can you also add tests?')).toBeNull();
  });

  test('human sentence mentioning a turn .md file → null (turn prompt is anchored)', () => {
    expect(
      classifySystemText('Can you read the file /home/kirin/.kteam/foo/turns/turn-001.md for me and summarise it?'),
    ).toBeNull();
  });

  test('ordinary prose → null', () => {
    expect(classifySystemText('hey can you restart this session? it seems stuck')).toBeNull();
  });

  test('empty text → null', () => {
    expect(classifySystemText('')).toBeNull();
  });

  test('peer-banner-shaped text is not classified as system (asserted for safety)', () => {
    // Peer messages never reach the classifier (transcript.ts calls it only when
    // from == null), but assert the raw prose still returns null in isolation.
    expect(classifySystemText('thanks for the fix, merging now')).toBeNull();
  });
});
