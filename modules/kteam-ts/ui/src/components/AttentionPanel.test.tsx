import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AttentionTrigger,
  actorLabel,
  attentionReferenceDomId,
  attentionRequestOutcome,
  attentionTriggerLabel,
  attentionUnreachableCopy,
  resolutionBadge,
  waitingAgeCopy,
} from './AttentionPanel';

describe('attention copy and age', () => {
  test('trigger always names the surface and carries a count when nonzero', () => {
    expect(attentionTriggerLabel(0)).toBe('Attention');
    expect(attentionTriggerLabel(4)).toBe('Attention (4)');
  });

  test('actor labels make agent resolution provenance explicit', () => {
    expect(actorLabel('agent', 'zoe')).toBe('agent zoe');
    expect(actorLabel('agent', null)).toBe('an agent');
    expect(actorLabel('human', null)).toBe('you');
    expect(actorLabel('daemon', null)).toBe('the daemon');
  });

  test('a human dismissal and an agent self-retraction are visibly different badges', () => {
    const human = resolutionBadge('human', null);
    const agent = resolutionBadge('agent', 'zoe');
    const daemon = resolutionBadge('daemon', null);
    expect(human.label).toBe('dismissed by you');
    expect(agent.label).toBe('retracted by agent zoe');
    expect(resolutionBadge('agent', null).label).toBe('retracted by agent (unnamed)');
    expect(daemon.label).toBe('cleared by the daemon');
    // The classes must differ so the audit can be scanned for clears that
    // happened WITHOUT the human — never the same chrome for all three.
    expect(new Set([human.cls, agent.cls, daemon.cls]).size).toBe(3);
    expect(agent.cls).toContain('warn');
  });

  test('the context block renders when an item carries context', async () => {
    const source = await Bun.file(new URL('./AttentionPanel.tsx', import.meta.url)).text();
    expect(source).toContain('{item.context && (');
    expect(source).toContain('text={item.context}');
  });

  test('age is compact and oldest-first friendly', () => {
    const at = Date.parse('2026-07-28T03:00:00.000Z');
    expect(waitingAgeCopy('2026-07-28T02:59:40.000Z', at)).toBe('waiting now');
    expect(waitingAgeCopy('2026-07-28T02:30:00.000Z', at)).toBe('waiting 30m');
    expect(waitingAgeCopy('2026-07-27T01:00:00.000Z', at)).toBe('waiting 1d');
  });

  test('unreachable state refuses to pretend the list is empty', () => {
    expect(attentionUnreachableCopy()).toMatch(/out of date/i);
  });

  test('exact-reference delivery distinguishes active, resolved, missing, and unavailable', () => {
    expect(attentionReferenceDomId('A3')).toBe('attention-reference-A3');
    expect(attentionRequestOutcome('A3', 'loading', [], [])).toBe('pending');
    expect(attentionRequestOutcome('A3', 'ready', [{ id: 'A3' }], [])).toBe('active');
    expect(attentionRequestOutcome('A3', 'ready', [], [{ id: 'A3' }])).toBe('resolved');
    expect(attentionRequestOutcome('A3', 'ready', [], [])).toBe('missing');
    expect(attentionRequestOutcome('A3', 'error', [], [])).toBe('unavailable');
  });

  test('lands only inside the attention-owned scroller and opens resolved audit before clearing', async () => {
    const source = await Bun.file(new URL('./AttentionPanel.tsx', import.meta.url)).text();
    expect(source).toContain('data-attention-scroller');
    expect(source).toContain("target.closest<HTMLElement>('[data-attention-scroller]')");
    expect(source).toContain('audit.open = true');
    expect(source).toContain('onPinOpen={onPinOpen}');
    expect(source.indexOf('scroller.scrollTo({')).toBeLessThan(
      source.indexOf(
        'onRequestedAttentionHandled?.(requestedAttention.sequence);',
        source.indexOf('requestAnimationFrame'),
      ),
    );
  });
});

test('trigger exposes a labelled 44px target and visible badge', () => {
  const html = renderToStaticMarkup(
    <AttentionTrigger id="needs" count={7} expanded={false} onClick={() => undefined} />,
  );
  expect(html).toContain('aria-label="Attention (7)"');
  expect(html).toContain('h-[44px]');
  expect(html).toContain('>7<');
});
