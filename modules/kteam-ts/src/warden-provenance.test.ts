import { describe, expect, test } from 'bun:test';
import {
  buildWardenSpawnProvenance,
  isWardenSpawnProvenance,
  provenancePath,
  renderProvenanceMarkdown,
  type WardenSelectionProvenance,
} from './warden-provenance';

const selection = (over: Partial<WardenSelectionProvenance> = {}): WardenSelectionProvenance => ({
  policy: 'fallback',
  selection: 'preferred',
  configuredFirst: 'claude-auto-a',
  skipped: {},
  ...over,
});

const view = (
  over: {
    binary?: string;
    harness?: 'claude' | 'codex';
    model?: string;
    observedModel?: string;
  } = {},
) => ({
  config: {
    id: 'warden-session-1',
    binary: over.binary ?? 'claude-auto-a',
    harness: over.harness ?? 'claude',
    model: over.model,
    createdAt: '2026-07-28T12:34:56.789Z',
  },
  state: { observedModel: over.observedModel },
});

describe('warden spawn provenance', () => {
  test('derives the sidecar path beside the markdown report', () => {
    expect(provenancePath('/reports/check.md')).toBe('/reports/check.md.meta.json');
  });

  test('records resolved facts from the returned SessionView', () => {
    const spawn = buildWardenSpawnProvenance(
      view({
        binary: 'codex-auto-returned',
        harness: 'codex',
        model: 'configured-returned',
        observedModel: 'gpt-5.6-sol-observed',
      }),
      selection({
        selection: 'failover',
        skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
      }),
      'target-1',
    );
    expect(spawn).toEqual({
      v: 1,
      at: '2026-07-28T12:34:56.789Z',
      wardenSessionId: 'warden-session-1',
      target: 'target-1',
      wrapper: 'codex-auto-returned',
      model: 'gpt-5.6-sol-observed',
      modelSource: 'harness',
      harness: 'codex',
      policy: 'fallback',
      selection: 'failover',
      configuredFirst: 'claude-auto-a',
      skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
      failedOver: true,
    });
    expect(isWardenSpawnProvenance(spawn)).toBe(true);
  });

  test('records wrapper model resolution and its honest source', () => {
    const spawn = buildWardenSpawnProvenance(view({ binary: 'claude-auto-glm52a', model: 'opus' }), selection());
    expect(spawn.model).toBe('glm-5.2');
    expect(spawn.modelSource).toBe('wrapper');
  });
});

describe('provenance markdown', () => {
  test('is short point form with one bold value per bullet and no verdict triggers', () => {
    const block = renderProvenanceMarkdown(buildWardenSpawnProvenance(view(), selection()));
    const lines = block.split('\n');
    expect(lines[0]).toBe('## Who ran this check');
    expect(lines.slice(1).every(line => line.startsWith('- '))).toBe(true);
    for (const line of lines.slice(1)) expect(line.match(/\*\*/g)).toHaveLength(2);
    expect(block).toContain('- Failover: **No**');
    expect(block).toContain('- Model: **Unknown**');
    expect(block).not.toContain('- Model: **`default`**');
    expect(block).not.toMatch(/\b(?:kill|stop|resume|nudge|leave)\b|needs a human/i);
  });

  test('failover names the original account and exact daemon reason', () => {
    const spawn = buildWardenSpawnProvenance(
      view({ binary: 'claude-auto-b' }),
      selection({
        selection: 'failover',
        skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
      }),
    );
    const block = renderProvenanceMarkdown(spawn);
    expect(block).toContain('- Failover: **Yes**');
    expect(block).toContain('- From: **`claude-auto-a`**');
    expect(block).toContain('- Why: **at its usage limit (kfleet feed)**');
  });

  test('round-robin rotation is never labeled failover', () => {
    const spawn = buildWardenSpawnProvenance(
      view({ binary: 'claude-auto-b' }),
      selection({
        policy: 'round_robin',
        selection: 'rotation',
        skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
      }),
    );
    const block = renderProvenanceMarkdown(spawn);
    expect(spawn.failedOver).toBe(false);
    expect(block).toContain('- Failover: **No**');
    expect(block).not.toContain('- From:');
    expect(block).not.toContain('- Why:');
  });
});
