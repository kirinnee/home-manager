import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRecord, SessionView } from '../types';
import {
  MigrateSheet,
  buildInflightItems,
  classifyCommand,
  contextWindowForModel,
  joinOpenTools,
  migrationHandoff,
  oneMillionVariant,
} from './MigrateSheet';

function view(state: Partial<SessionView['state']> = {}): SessionView {
  return {
    config: {
      id: 'ms-safe-1234',
      name: 'Safe Migration Probe',
      teammate: 'probe',
      binary: 'codex-auto-loge',
      harness: 'codex',
      modelHint: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol[1m]',
      mode: 'auto',
      cwd: '/tmp/probe',
      createdAt: '2026-07-26T12:00:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
      turn: 2,
      harnessSessionId: 'harness',
      tmuxSession: 'kteam-probe',
      watcherSession: 'watcher',
      intervalSeconds: 2,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 8,
      systemPromptFile: '/tmp/system.md',
      originalPromptFile: '/tmp/prompt.md',
    },
    state: {
      id: 'ms-safe-1234',
      status: 'awaiting_user',
      turn: 2,
      promptReady: true,
      ...state,
    },
    directory: '/tmp/session',
  };
}

describe('migration in-flight classifier', () => {
  test('destructive tokens win even when buried in a pipeline', () => {
    expect(classifyCommand('rg TODO . && git push origin main')).toBe('destructive_to_interrupt');
    expect(classifyCommand('cd ui && bun install')).toBe('destructive_to_interrupt');
    expect(classifyCommand('curl --request DELETE https://example.test/item')).toBe('destructive_to_interrupt');
  });

  test('distinguishes re-runnable, safe, and unknown commands conservatively', () => {
    expect(classifyCommand('direnv exec . bun run check')).toBe('re_armable');
    expect(classifyCommand('sleep 420')).toBe('safe_to_kill');
    expect(classifyCommand('rg migration modules/kteam-ts')).toBe('safe_to_kill');
    expect(classifyCommand('rg migration . | custom-index-writer')).toBe('unknown');
    expect(classifyCommand('rg migration . > report.txt')).toBe('unknown');
    expect(classifyCommand('custom-release-controller --continue')).toBe('unknown');
    expect(classifyCommand('')).toBe('unknown');
  });

  test('joins open tool ids to command-bearing chat records and fails closed on a miss', () => {
    const records: ChatRecord[] = [
      {
        source: 'claude',
        type: 'tool.use',
        timestamp: '2026-07-26T12:00:00.000Z',
        data: { toolUseId: 'call-safe', name: 'Bash', input: { command: 'bun test' } },
      },
      {
        source: 'codex',
        type: 'tool.use',
        data: {
          toolUseId: 'call-codex',
          name: 'exec',
          input: 'const r = await tools.exec_command({"cmd":"direnv exec . bun run check","workdir":"/repo"});',
        },
      },
    ];
    const tools = joinOpenTools(['call-safe', 'call-codex', 'call-missing'], records);
    expect(tools[0]).toMatchObject({ name: 'Bash', summary: 'bun test', verdict: 're_armable' });
    expect(tools[1]).toMatchObject({ name: 'exec', summary: 'direnv exec . bun run check', verdict: 're_armable' });
    expect(tools[2]).toMatchObject({ name: 'Unknown open tool', verdict: 'unknown' });
  });

  test('ledger-only subprocess evidence and failed inventory remain unknown blockers', () => {
    const items = buildInflightItems(
      view({
        status: 'tool_running',
        promptReady: false,
        openTools: ['call-missing'],
        subprocessSince: new Date(Date.now() - 60_000).toISOString(),
      }),
      [],
      'chat history unavailable',
    );
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'turn', verdict: 're_armable' }),
        expect.objectContaining({ key: 'tool-load-error', verdict: 'unknown' }),
        expect.objectContaining({ key: 'subprocess', verdict: 'unknown' }),
      ]),
    );
  });
});

describe('migration context and handoff copy', () => {
  test('uses the daemon model suffix rule for context windows', () => {
    expect(contextWindowForModel('claude-opus-5')).toBe(200_000);
    expect(contextWindowForModel('claude-opus-5[1m]')).toBe(1_000_000);
    expect(contextWindowForModel('')).toBeUndefined();
    expect(oneMillionVariant('claude-opus-5')).toBe('claude-opus-5[1m]');
    expect(oneMillionVariant('claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
  });

  test('handoff tells the relaunched agent to inspect before re-running', () => {
    const message = migrationHandoff(
      [{ key: 'git', label: 'Bash', detail: 'git rebase main', verdict: 'destructive_to_interrupt' }],
      'codex-auto-atomi',
      'gpt-5.6-terra',
    );
    expect(message).toContain('codex-auto-atomi on gpt-5.6-terra');
    expect(message).toContain('[destructive to interrupt] Bash: git rebase main');
    expect(message).toContain('do not blindly repeat the command');
  });

  test('the sheet exposes labelled 44px controls and never summons an input keyboard', () => {
    const html = renderToStaticMarkup(<MigrateSheet view={view()} open onClose={() => undefined} />);
    expect(html).toContain('Change model or account');
    expect(html).toContain('Cross-CLI migration is not offered');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('autofocus');
  });
});
