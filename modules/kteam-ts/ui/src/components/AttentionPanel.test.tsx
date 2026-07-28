import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AttentionTrigger,
  actorLabel,
  attentionTriggerLabel,
  attentionUnreachableCopy,
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

  test('age is compact and oldest-first friendly', () => {
    const at = Date.parse('2026-07-28T03:00:00.000Z');
    expect(waitingAgeCopy('2026-07-28T02:59:40.000Z', at)).toBe('waiting now');
    expect(waitingAgeCopy('2026-07-28T02:30:00.000Z', at)).toBe('waiting 30m');
    expect(waitingAgeCopy('2026-07-27T01:00:00.000Z', at)).toBe('waiting 1d');
  });

  test('unreachable state refuses to pretend the list is empty', () => {
    expect(attentionUnreachableCopy()).toMatch(/out of date/i);
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
