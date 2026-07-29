import { describe, expect, spyOn, test } from 'bun:test';
import { SessionManager, type TerminalAnalyticsIngestor, type TerminalAnalyticsIngestResult } from './session-manager';

interface TerminalHarness {
  setTerminalAnalyticsIngestor(ingestor: TerminalAnalyticsIngestor | undefined): void;
  scheduleTerminalSendFinalization(id: string, acceptedThrough: string): void;
  terminalSendFinalizers: Map<string, Promise<void>>;
  terminalSendFinalizerCutoffs: Map<string, string>;
  finalizeTerminalSends(id: string, acceptedThrough: string): Promise<void>;
  emit(id: string, type: string, data: Record<string, unknown>, source: string): Promise<unknown>;
}

function harness(): TerminalHarness {
  const manager = Object.create(SessionManager.prototype) as TerminalHarness;
  manager.terminalSendFinalizers = new Map();
  manager.terminalSendFinalizerCutoffs = new Map();
  return manager;
}

describe('terminal analytics ingestion', () => {
  test('runs after terminal transcript finalization and emits durable success evidence', async () => {
    const manager = harness();
    const order: string[] = [];
    const result: TerminalAnalyticsIngestResult = { sources: 1, bytes: 42, pending: 0, errors: 0 };
    manager.finalizeTerminalSends = async () => {
      order.push('transcript-finalized');
    };
    manager.emit = async (_id, type, data) => {
      order.push(type);
      expect(data).toEqual({ ...result });
    };
    manager.setTerminalAnalyticsIngestor(async id => {
      expect(id).toBe('claude-terminal');
      order.push('analytics-ingested');
      return result;
    });

    manager.scheduleTerminalSendFinalization('claude-terminal', '2026-07-29T08:00:03.000Z');
    await manager.terminalSendFinalizers.get('claude-terminal');
    expect(order).toEqual(['transcript-finalized', 'analytics-ingested', 'session.analytics_ingested']);
  });

  test('logs ingestion failures and emits a durable failure event', async () => {
    const manager = harness();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    manager.finalizeTerminalSends = async () => {};
    manager.emit = async (_id, type, data) => {
      events.push({ type, data });
    };
    manager.setTerminalAnalyticsIngestor(async () => {
      throw new Error('fixture transcript is unreadable');
    });
    const logged: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      logged.push(values.map(String).join(' '));
    });
    try {
      manager.scheduleTerminalSendFinalization('codex-terminal', '2026-07-29T08:00:03.000Z');
      await manager.terminalSendFinalizers.get('codex-terminal');
    } finally {
      error.mockRestore();
    }

    expect(logged.join('\n')).toContain(
      'terminal analytics ingestion failed for codex-terminal: fixture transcript is unreadable',
    );
    expect(events).toEqual([
      {
        type: 'session.analytics_ingestion_failed',
        data: { message: 'fixture transcript is unreadable' },
      },
    ]);
  });
});
