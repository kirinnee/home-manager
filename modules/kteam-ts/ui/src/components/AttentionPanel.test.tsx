import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ATTENTION_COLLAPSE_CHARS,
  AttentionTrigger,
  actorLabel,
  attentionCollapsesByDefault,
  attentionKindMeta,
  attentionReferenceDomId,
  attentionRequestOutcome,
  attentionSectionKey,
  attentionSectionOpen,
  attentionSourceMeta,
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

  test('a human clear and an agent self-retraction are visibly different badges', () => {
    const human = resolutionBadge('human', null);
    const agent = resolutionBadge('agent', 'zoe');
    const daemon = resolutionBadge('daemon', null);
    expect(human.label).toBe('done by you');
    expect(agent.label).toBe('retracted by agent zoe');
    expect(resolutionBadge('agent', null).label).toBe('retracted by agent (unnamed)');
    expect(daemon.label).toBe('cleared by the daemon');
    // The classes must differ so the audit can be scanned for clears that
    // happened WITHOUT the human — never the same chrome for all three.
    expect(new Set([human.cls, agent.cls, daemon.cls]).size).toBe(3);
    expect(agent.cls).toContain('warn');
  });

  test('a dismissal is badged as a dismissal, never as an answer (&F139)', () => {
    expect(resolutionBadge('human', null, 'dismissed').label).toBe('dismissed by you');
    expect(resolutionBadge('agent', 'zoe', 'dismissed').label).toBe('dismissed by agent zoe');
    expect(resolutionBadge('agent', 'zoe', 'dismissed').cls).toContain('warn');
    expect(resolutionBadge('human', null, 'done').label).toBe('done by you');
    // A dismissed clear must not wear the ok chrome of an answered one.
    expect(resolutionBadge('human', null, 'dismissed').cls).not.toContain('ok');
  });

  test('the context block renders when an item carries context, inside a disclosure', async () => {
    const source = await Bun.file(new URL('./AttentionPanel.tsx', import.meta.url)).text();
    expect(source).toContain('{item.context && (');
    expect(source).toContain('text={item.context}');
    // Background is the collapsible part (&F157); the ask and the action are not.
    expect(source).toContain('<AttentionDisclosure');
    expect(source.indexOf('<AttentionDisclosure')).toBeLessThan(source.indexOf('text={item.context}'));
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

describe('four attention kinds render their own answer control (&F138)', () => {
  test('the panel wires one control per kind plus dismiss, and answers go through respond', async () => {
    const source = await Bun.file(new URL('./AttentionPanel.tsx', import.meta.url)).text();
    // Permission: approve or reject.
    expect(source).toContain("onRespond({ kind: 'permission', decision: 'approve' })");
    expect(source).toContain("onRespond({ kind: 'permission', decision: 'reject' })");
    // Multiple choice: one button per listed option.
    expect(source).toContain("onRespond({ kind: 'multiple-choice', choice: option.label })");
    // Answer review: good, or clarify with text.
    expect(source).toContain("onRespond({ kind: 'answer-review', verdict: 'good' })");
    expect(source).toContain("onRespond({ kind: 'answer-review', verdict: 'clarify', clarification: text })");
    // Open question: free text.
    expect(source).toContain("onRespond({ kind: 'open-question', answer: text })");
    // Items without an ask keep the legacy mark-done control; everything can be dismissed.
    expect(source).toContain('Mark done');
    expect(source).toContain('Dismiss without answering');
    expect(source).toContain('attentionStore.respond(sessionId, item.id, response)');
    expect(source).toContain('attentionStore.dismiss(sessionId, item.id)');
    // The audit shows the structured answer.
    expect(source).toContain('describeAttentionResponse(item.response)');
  });
});

describe('kind is carried by colour and icon, and absence stays unknown (&F157)', () => {
  test('each of the four kinds gets its own tone, label and icon', () => {
    const kinds = ['permission', 'multiple-choice', 'answer-review', 'open-question'] as const;
    const metas = kinds.map(kind =>
      attentionKindMeta({
        source: 'agent-raised',
        ask: kind === 'multiple-choice' ? { kind, options: [{ label: 'a' }, { label: 'b' }] } : { kind },
      }),
    );
    // The tone is the `data-kind` value attention-views.css resolves.
    expect(metas.map(meta => meta.tone)).toEqual([...kinds]);
    // No two kinds may look alike — colour AND icon AND label all differ.
    expect(new Set(metas.map(meta => meta.label)).size).toBe(4);
    expect(new Set(metas.map(meta => meta.icon)).size).toBe(4);
    expect(metas.every(meta => meta.action.length > 0)).toBe(true);
  });

  test('an item with no ask is never painted as a kind', () => {
    const meta = attentionKindMeta({ source: 'task' });
    expect(meta.tone).toBe('none');
    // It falls back to the SOURCE, and says the answer shape is unknown.
    expect(meta.label).toBe('Blocked task');
    expect(meta.action).toMatch(/no answer shape recorded/i);
  });

  test('an unrecognised source is named unknown rather than mislabelled', () => {
    expect(attentionSourceMeta('task').label).toBe('Blocked task');
    expect(attentionSourceMeta('permission').label).toBe('Permission');
    // A source written by a newer daemon than this build knows about.
    expect(attentionSourceMeta('teleport' as never).label).toBe('Unknown source');
  });

  test('the tone plumbing exists in CSS for every kind plus the neutral default', async () => {
    const css = await Bun.file(new URL('./attention-views.css', import.meta.url)).text();
    for (const kind of ['permission', 'multiple-choice', 'answer-review', 'open-question']) {
      expect(css).toContain(`.kt-attn[data-kind='${kind}']`);
    }
    for (const part of ['why', 'context', 'action']) {
      expect(css).toContain(`.kt-attn-part[data-part='${part}']`);
    }
    // Tokens only — a hardcoded colour here would break High Contrast and Neo.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|hsl)a?\(/);
    // The rail replaces the card border, so row geometry never shifts.
    expect(css).toContain('box-shadow: inset');
    // Every toggle is a phone-sized target.
    expect(css).toContain('min-height: 44px');
  });

  test('the row is a rail-and-divider list, not a stack of cards', async () => {
    const source = await Bun.file(new URL('./AttentionPanel.tsx', import.meta.url)).text();
    expect(source).toContain("import './attention-views.css'");
    expect(source).toContain('kt-attn kt-attn-rail');
    expect(source).toContain('divide-y divide-border-soft');
    // No per-item card: the row must not draw its own box or wash.
    expect(source).not.toContain('rounded-control border bg-surface px-cell-x py-row-y');
    // The inner "Context" / "How to resolve" boxes are gone.
    expect(source).not.toContain('rounded-control border border-border-soft bg-surface-2');
  });
});

describe('collapsible sections remember their state per item (&F157)', () => {
  test('long background collapses on arrival, short background does not', () => {
    expect(attentionCollapsesByDefault('short note')).toBe(false);
    expect(attentionCollapsesByDefault('x'.repeat(ATTENTION_COLLAPSE_CHARS + 1))).toBe(true);
    // Many short lines are just as tall as one long paragraph.
    expect(attentionCollapsesByDefault('a\nb\nc\nd\ne')).toBe(true);
    expect(attentionCollapsesByDefault('a\nb')).toBe(false);
  });

  test('expansion is keyed per item AND per part, so two items never share it', () => {
    expect(attentionSectionKey('A3', 'context')).toBe('A3:context');
    expect(attentionSectionKey('A3', 'context')).not.toBe(attentionSectionKey('A4', 'context'));
  });

  test('a remembered choice wins over the default in both directions', () => {
    const key = attentionSectionKey('A3', 'context');
    // Untouched: the default decides.
    expect(attentionSectionOpen({}, key, true)).toBe(true);
    expect(attentionSectionOpen({}, key, false)).toBe(false);
    // Touched: the reader decides, even against the default.
    expect(attentionSectionOpen({ [key]: false }, key, true)).toBe(false);
    expect(attentionSectionOpen({ [key]: true }, key, false)).toBe(true);
  });

  test('landing on a referenced item opens its background instead of hiding it', async () => {
    const source = await Bun.file(new URL('./AttentionPanel.tsx', import.meta.url)).text();
    expect(source).toContain("[attentionSectionKey(requestedAttention.id, 'context')]: true");
  });
});
