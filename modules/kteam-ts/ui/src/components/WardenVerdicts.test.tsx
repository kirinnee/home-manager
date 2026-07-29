import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  VerdictRows,
  WardenVerdicts,
  failoverReasonCopy,
  switchedAccountCopy,
  verdictProvenanceLine,
} from './WardenVerdicts';
import type { WardenVerdict } from '../types';

const verdict = (over: Partial<WardenVerdict> = {}): WardenVerdict => ({
  at: '2026-07-28T10:30:00Z',
  targetSession: 'ms4z-abc',
  teammate: 'auto-loge',
  verdict: 'needs_human',
  reason: 'blocked on a product call',
  reportPath: '/home/k/.kteam/daemon/warden/reports/2026-07-28.md',
  ...over,
});

describe('verdictProvenanceLine', () => {
  test('names the account, the model and the harness', () => {
    expect(verdictProvenanceLine({ wrapper: 'claude-auto-glm52a', model: 'glm-5.2', harness: 'claude' })).toBe(
      'claude-auto-glm52a · glm-5.2 · claude',
    );
  });

  test('says a wrapper default ran when no explicit model was passed', () => {
    expect(verdictProvenanceLine({ wrapper: 'codex-auto-loge', modelHint: 'gpt-5.6', harness: 'codex' })).toBe(
      'codex-auto-loge · gpt-5.6 (wrapper default) · codex',
    );
    expect(
      verdictProvenanceLine({
        wrapper: 'claude-auto-glm52a',
        model: 'glm-5.2',
        modelSource: 'wrapper',
        harness: 'claude',
      }),
    ).toBe('claude-auto-glm52a · glm-5.2 (wrapper default) · claude');
  });

  test('never dresses an unresolved model up as a real one', () => {
    // The daemon's placeholder for "resolved nothing" is the string `default`.
    expect(
      verdictProvenanceLine({
        wrapper: 'codex-auto-loge',
        model: 'default',
        modelSource: 'unknown',
        harness: 'codex',
      }),
    ).toBe('codex-auto-loge · model unknown · codex');
  });

  test('degrades to explicit unknowns rather than an empty line', () => {
    expect(verdictProvenanceLine(undefined)).toBe('Ran by: unknown (older report)');
    expect(verdictProvenanceLine({})).toBe('Ran by: unknown (older report)');
    expect(verdictProvenanceLine({ wrapper: 'claude-auto-b' })).toBe('claude-auto-b · model unknown · harness unknown');
  });
});

describe('switchedAccountCopy', () => {
  test('flags only a real failover', () => {
    expect(switchedAccountCopy({ wrapper: 'claude-auto-b', failedOver: true })).toBe('switched account');
    expect(switchedAccountCopy({ wrapper: 'claude-auto-a', failedOver: false })).toBeNull();
    expect(switchedAccountCopy(undefined)).toBeNull();
  });
});

describe('failoverReasonCopy', () => {
  test('quotes the selector reason for the account that was configured first', () => {
    expect(
      failoverReasonCopy({
        wrapper: 'claude-auto-b',
        failedOver: true,
        configuredFirst: 'claude-auto-a',
        skipped: { 'claude-auto-a': 'at its usage limit' },
      }),
    ).toBe('moved off claude-auto-a: at its usage limit');
  });

  test('falls back to any recorded reason, then to a plain statement', () => {
    expect(failoverReasonCopy({ configuredFirst: 'claude-auto-a', skipped: { 'claude-auto-c': 'demoted' } })).toBe(
      'moved off claude-auto-a: demoted',
    );
    expect(failoverReasonCopy({ configuredFirst: 'claude-auto-a' })).toBe('moved off claude-auto-a');
    expect(failoverReasonCopy(undefined)).toContain('configured first choice');
  });
});

describe('VerdictRows', () => {
  test('shows the provenance line beside the verdict', () => {
    const html = renderToStaticMarkup(
      <VerdictRows
        verdicts={[verdict({ spawn: { wrapper: 'claude-auto-b', model: 'opus-4.8', harness: 'claude' } })]}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('needs human');
    expect(html).toContain('claude-auto-b · opus-4.8 · claude');
  });

  test('badges a verdict whose warden failed over, with the reason as its title', () => {
    const html = renderToStaticMarkup(
      <VerdictRows
        verdicts={[
          verdict({
            // The daemon's real sidecar shape: no `failoverReason` field, the
            // exact per-wrapper reasons the selector produced.
            spawn: {
              wrapper: 'claude-auto-b',
              model: 'opus-4.8',
              harness: 'claude',
              failedOver: true,
              policy: 'fallback',
              selection: 'failover',
              configuredFirst: 'claude-auto-a',
              skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
            },
          }),
        ]}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('switched account');
    expect(html).toContain('moved off claude-auto-a: at its usage limit (kfleet feed)');
  });

  test('a report from an older daemon still renders, with unknown provenance', () => {
    const html = renderToStaticMarkup(<VerdictRows verdicts={[verdict()]} onOpen={() => {}} />);
    expect(html).toContain('Auto-Loge');
    expect(html).toContain('Ran by: unknown (older report)');
  });
});

describe('WardenVerdicts', () => {
  test('the legacy dashboard mount stays inert', () => {
    expect(renderToStaticMarkup(<WardenVerdicts />)).toBe('');
  });

  test('the report renderer preserves target-session provenance and optional openers', async () => {
    const source = await Bun.file(new URL('./WardenVerdicts.tsx', import.meta.url)).text();
    expect(source).toContain('sessionId: v.targetSession');
    expect(source).toContain('sessionId={sessionId}');
    expect(source).toContain('onTaskOpen={onTaskOpen}');
    expect(source).toContain('onCodeReferenceOpen={onCodeReferenceOpen}');
    expect(source).toContain('onAttentionOpen={onAttentionOpen}');
    expect(source).not.toContain('onPinOpen={onPinOpen}');
    expect(source).toContain('{...sessionReferenceHost(report?.sessionId)}');
  });
});
