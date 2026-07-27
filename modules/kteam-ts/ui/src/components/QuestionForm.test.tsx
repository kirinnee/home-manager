import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRecord } from '../types';
import { ApiError } from '../lib/api';
import {
  QuestionForm,
  QuestionSubmitControl,
  QuestionNav,
  type PFQuestion,
  initAnswerState,
  optionIsMultiple,
  applyOptionToggle,
  applyOtherSelect,
  setOtherText,
  isAnswered,
  allAnswered,
  firstUnansweredIndex,
  buildPayload,
  clampPage,
  shouldFocusOtherTextarea,
  resolveRequestId,
  interruptPendingQuestion,
  submitAnswers,
} from './QuestionForm';

// ---- fixtures ---------------------------------------------------------------

const SINGLE: PFQuestion[] = [
  { header: 'Path', question: 'Which path?', options: [{ label: 'Safe' }, { label: 'Bold' }] },
];
const SINGLE_MULTI: PFQuestion[] = [
  {
    header: 'Toppings',
    question: 'Pick any',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  },
];
const MULTI: PFQuestion[] = [
  { header: 'One', question: 'First question text?', options: [{ label: 'a1' }, { label: 'a2' }] },
  { header: 'Two', question: 'Second question text?', options: [{ label: 'b1' }, { label: 'b2' }] },
  { header: 'Three', question: 'Third question text?', options: [{ label: 'c1' }, { label: 'c2' }] },
];

function record(questions: PFQuestion[], toolUseId = 'tool-1'): ChatRecord {
  return { source: 'claude', type: 'interaction.question', data: { questions, toolUseId } } as ChatRecord;
}

function buttons(html: string): string[] {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
}
function buttonWithText(html: string, text: string): string | undefined {
  return buttons(html).find(b => b.includes(`>${text}</button>`) || b.includes(text));
}
function isTouchTarget(button: string): boolean {
  return button.includes('min-h-[44px]') && button.includes('min-w-[44px]');
}

// ---- 1. payload parity ------------------------------------------------------

describe('buildPayload — wire parity', () => {
  test('single question, option picked → { labels, no other }', () => {
    const s = applyOptionToggle(initAnswerState(SINGLE), 0, 'Bold', false);
    expect(buildPayload(SINGLE, s)).toEqual({ labels: ['Bold'], other: undefined });
  });

  test('single question, Other selected → { labels: [], other } and trims', () => {
    let s = applyOtherSelect(initAnswerState(SINGLE), 0);
    s = setOtherText(s, 0, '  do something else  ');
    expect(buildPayload(SINGLE, s)).toEqual({ labels: [], other: 'do something else' });
  });

  test('single question, Other selected but blank → other undefined', () => {
    let s = applyOtherSelect(initAnswerState(SINGLE), 0);
    s = setOtherText(s, 0, '   ');
    expect(buildPayload(SINGLE, s)).toEqual({ labels: [], other: undefined });
  });

  test('multi set → { responses } with other||pick precedence, trims, unselected-Other excluded', () => {
    let s = initAnswerState(MULTI);
    s = applyOptionToggle(s, 0, 'a2', false); // q0 → pick
    s = setOtherText(s, 1, '  typed  '); // q1 text present but Other NOT selected → excluded
    s = applyOtherSelect(s, 2); // q2 → Other
    s = setOtherText(s, 2, '  freeform  ');
    // q1 falls back to its (empty) pick because Other is not its selection
    expect(buildPayload(MULTI, s)).toEqual({ responses: ['a2', '', 'freeform'] });
  });
});

// ---- 2. toggle semantics ----------------------------------------------------

describe('toggle semantics', () => {
  test('single-question multiSelect accumulates', () => {
    expect(optionIsMultiple(SINGLE_MULTI[0]!, false)).toBe(true);
    let s = applyOptionToggle(initAnswerState(SINGLE_MULTI), 0, 'A', true);
    s = applyOptionToggle(s, 0, 'C', true);
    expect(s.picks[0]).toEqual(['A', 'C']);
    s = applyOptionToggle(s, 0, 'A', true); // toggle off
    expect(s.picks[0]).toEqual(['C']);
  });

  test('multi-question sets are strictly single-choice (the :99 regression)', () => {
    expect(optionIsMultiple(MULTI[0]!, true)).toBe(false);
    let s = applyOptionToggle(initAnswerState(MULTI), 0, 'a1', false);
    s = applyOptionToggle(s, 0, 'a2', false);
    expect(s.picks[0]).toEqual(['a2']); // replaced, never accumulated
  });

  test('picking an option deselects Other and vice-versa', () => {
    let s = applyOtherSelect(initAnswerState(SINGLE), 0);
    expect(s.otherSelected[0]).toBe(true);
    s = applyOptionToggle(s, 0, 'Safe', false);
    expect(s.otherSelected[0]).toBe(false);
    expect(s.picks[0]).toEqual(['Safe']);
    s = applyOtherSelect(s, 0);
    expect(s.picks[0]).toEqual([]);
    expect(s.otherSelected[0]).toBe(true);
  });
});

// ---- 3. isAnswered ----------------------------------------------------------

describe('isAnswered / allAnswered', () => {
  test('option picked ⇒ answered', () => {
    const s = applyOptionToggle(initAnswerState(SINGLE), 0, 'Safe', false);
    expect(isAnswered(s, 0)).toBe(true);
  });
  test('Other selected + blank ⇒ unanswered; + text ⇒ answered', () => {
    let s = applyOtherSelect(initAnswerState(SINGLE), 0);
    expect(isAnswered(s, 0)).toBe(false);
    s = setOtherText(s, 0, 'x');
    expect(isAnswered(s, 0)).toBe(true);
  });
  test('allAnswered / firstUnansweredIndex across a set', () => {
    let s = initAnswerState(MULTI);
    expect(allAnswered(s, MULTI)).toBe(false);
    expect(firstUnansweredIndex(s, MULTI)).toBe(0);
    s = applyOptionToggle(s, 0, 'a1', false);
    s = applyOptionToggle(s, 2, 'c1', false);
    expect(firstUnansweredIndex(s, MULTI)).toBe(1);
    s = applyOptionToggle(s, 1, 'b1', false);
    expect(allAnswered(s, MULTI)).toBe(true);
    expect(firstUnansweredIndex(s, MULTI)).toBe(-1);
  });
});

// ---- 4. page math -----------------------------------------------------------

describe('clampPage', () => {
  test('clamps to [0, count-1] and handles empty', () => {
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(0, 3)).toBe(0);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(5, 3)).toBe(2); // index survives a shrunk set
    expect(clampPage(1, 0)).toBe(0);
  });
});

// ---- 5. request id ----------------------------------------------------------

describe('resolveRequestId', () => {
  test('same set keeps the id across attempts; a new set mints a fresh one', () => {
    let n = 0;
    const mint = () => `id-${++n}`;
    const first = resolveRequestId(null, 'tool-A', mint);
    expect(first.id).toBe('id-1');
    const retry = resolveRequestId(first, 'tool-A', mint); // e.g. post-error retry
    expect(retry).toBe(first);
    expect(retry.id).toBe('id-1');
    const next = resolveRequestId(retry, 'tool-B', mint); // new question set
    expect(next.id).toBe('id-2');
  });
});

describe('interruptPendingQuestion', () => {
  test('retries abandon for one question with the same nonempty request id and the same bound tool id', async () => {
    const requestIdRef: { current: { id: string; key: string | undefined } | null } = { current: null };
    const calls: Array<{ requestId: string; toolUseId: string }> = [];
    let n = 0;
    const interrupt = async (requestId: string, toolUseId: string) => {
      calls.push({ requestId, toolUseId });
      throw new ApiError(503, 'response lost');
    };

    await expect(
      interruptPendingQuestion({ requestIdRef, toolUseId: 'tool-A', mint: () => `abandon-${++n}`, interrupt }),
    ).rejects.toThrow('response lost');
    await expect(
      interruptPendingQuestion({ requestIdRef, toolUseId: 'tool-A', mint: () => `abandon-${++n}`, interrupt }),
    ).rejects.toThrow('response lost');

    expect(calls).toEqual([
      { requestId: 'abandon-1', toolUseId: 'tool-A' },
      { requestId: 'abandon-1', toolUseId: 'tool-A' },
    ]);
    expect(calls[0]!.requestId).not.toBe('');
  });

  test('a different pending question mints a new request id and binds to its own tool id', async () => {
    const requestIdRef: { current: { id: string; key: string | undefined } | null } = { current: null };
    const calls: Array<{ requestId: string; toolUseId: string }> = [];
    let n = 0;
    const interrupt = async (requestId: string, toolUseId: string) => {
      calls.push({ requestId, toolUseId });
    };

    await interruptPendingQuestion({ requestIdRef, toolUseId: 'tool-A', mint: () => `abandon-${++n}`, interrupt });
    await interruptPendingQuestion({ requestIdRef, toolUseId: 'tool-B', mint: () => `abandon-${++n}`, interrupt });

    expect(calls).toEqual([
      { requestId: 'abandon-1', toolUseId: 'tool-A' },
      { requestId: 'abandon-2', toolUseId: 'tool-B' },
    ]);
  });
});

// ---- 6. submit-once ---------------------------------------------------------

describe('submitAnswers guard', () => {
  test('rapid double-activation runs send exactly once', async () => {
    const guard = { current: false };
    let sends = 0;
    const send = async () => {
      sends++;
      await Promise.resolve();
    };
    const opts = { guard, validate: () => null, send, setSubmitting: () => {}, setError: () => {} };
    const p1 = submitAnswers(opts);
    const p2 = submitAnswers(opts); // fires while p1 is mid-flight
    await Promise.all([p1, p2]);
    expect(sends).toBe(1);
    expect(guard.current).toBe(true); // held after success — the form is unmounting
  });

  test('a validation failure never sends and releases the guard', async () => {
    const guard = { current: false };
    let sends = 0;
    const box: { err: string | null } = { err: null };
    await submitAnswers({
      guard,
      validate: () => 'nope',
      send: async () => {
        sends++;
      },
      setSubmitting: () => {},
      setError: v => (box.err = v),
    });
    expect(sends).toBe(0);
    expect(box.err).toBe('nope');
    expect(guard.current).toBe(false);
  });

  test('a rejected send surfaces the ApiError and releases the guard for retry', async () => {
    const guard = { current: false };
    const box: { err: string | null } = { err: null };
    await submitAnswers({
      guard,
      validate: () => null,
      send: async () => {
        // The real race: the question was withdrawn between mount and submit.
        throw new ApiError(409, 'session is not waiting on a structured question');
      },
      setSubmitting: () => {},
      setError: v => (box.err = v),
    });
    expect(box.err).toBe('session is not waiting on a structured question');
    expect(guard.current).toBe(false);
  });
});

// ---- 7. focus policy --------------------------------------------------------

describe('shouldFocusOtherTextarea', () => {
  test('reveals without focus on touch, focuses on non-touch', () => {
    expect(shouldFocusOtherTextarea(true)).toBe(false);
    expect(shouldFocusOtherTextarea(false)).toBe(true);
  });
});

// ---- 8. nav-row invariant: visible, labelled, ≥44px in every state ----------

describe('QuestionNav — the answer path never vanishes', () => {
  const cases = [
    { name: 'first page, unanswered', page: 0, canAdvance: false, canSubmit: false, submitting: false },
    { name: 'first page, answered', page: 0, canAdvance: true, canSubmit: false, submitting: false },
    { name: 'middle page, unanswered', page: 1, canAdvance: false, canSubmit: false, submitting: false },
    { name: 'middle page, answered', page: 1, canAdvance: true, canSubmit: false, submitting: false },
    { name: 'last page, incomplete', page: 2, canAdvance: true, canSubmit: false, submitting: false },
    { name: 'last page, complete', page: 2, canAdvance: true, canSubmit: true, submitting: false },
    { name: 'last page, submitting', page: 2, canAdvance: true, canSubmit: true, submitting: true },
  ] as const;

  for (const c of cases) {
    test(`${c.name}: Back + primary present, 44px, labelled, described-when-disabled`, () => {
      const html = renderToStaticMarkup(
        <QuestionNav
          page={c.page}
          pageCount={3}
          canAdvance={c.canAdvance}
          canSubmit={c.canSubmit}
          submitting={c.submitting}
          onBack={() => {}}
          onNext={() => {}}
          onSubmit={() => {}}
        />,
      );
      const back = buttonWithText(html, 'Back')!;
      const isLast = c.page >= 2;
      const primary = buttonWithText(html, isLast ? 'Submit answers' : 'Next')!;

      for (const b of [back, primary]) {
        expect(b).toBeDefined();
        expect(isTouchTarget(b)).toBe(true);
        expect(b.slice(0, b.indexOf('>'))).not.toMatch(/(?:^|\s)hidden(?:=|\s|$)/);
      }

      // Disabled controls must carry a described reason.
      const backDisabled = c.page <= 0;
      expect(back.includes('aria-disabled="true"')).toBe(backDisabled);
      if (backDisabled) {
        const id = back.match(/aria-describedby="([^"]+)"/)?.[1];
        expect(id).toBeDefined();
        expect(html).toContain(`id="${id}"`);
      }

      const primaryDisabled = isLast ? c.submitting || !c.canSubmit : !c.canAdvance;
      expect(primary.includes('aria-disabled="true"')).toBe(primaryDisabled);
      if (primaryDisabled) {
        const id = primary.match(/aria-describedby="([^"]+)"/)?.[1];
        expect(id).toBeDefined();
        expect(html).toContain(`id="${id}"`);
      }
    });
  }
});

// ---- existing: the explicit submit control ----------------------------------

describe('structured-question explicit submit path', () => {
  test('renders a visible labelled 44px answer control', () => {
    const html = renderToStaticMarkup(<QuestionForm sessionId="s" question={record(SINGLE)} onSubmit={() => {}} />);
    const button = buttonWithText(html, 'Submit answer')!;
    expect(button).toBeDefined();
    expect(isTouchTarget(button)).toBe(true);
    expect(button).not.toContain('hidden');
  });

  test('keeps the answer control visible, labelled, and described while submitting', () => {
    const html = renderToStaticMarkup(<QuestionSubmitControl submitting onClick={() => {}} />);
    const button = buttons(html)[0]!;
    const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(isTouchTarget(button)).toBe(true);
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('Submit answer');
    expect(html).toContain('Submitting answer…');
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy}"`);
  });

  test('always renders an explicit, touch-sized abandon escape hatch', () => {
    const html = renderToStaticMarkup(<QuestionForm sessionId="s" question={record(SINGLE)} onSubmit={() => {}} />);
    const abandon = buttonWithText(html, 'Abandon question')!;
    expect(abandon).toBeDefined();
    expect(isTouchTarget(abandon)).toBe(true);
    expect(html).toContain('Question stuck? Retry the answer');
  });
});

// ---- 9. paged vs all-at-once render -----------------------------------------

describe('QuestionForm render modes', () => {
  test('compact multi-question set pages one question at a time', () => {
    const html = renderToStaticMarkup(
      <QuestionForm sessionId="s" question={record(MULTI)} onSubmit={() => {}} compact />,
    );
    expect(html).toContain('Structured question — 1 of 3');
    expect(html).toContain('First question text?');
    expect(html).not.toContain('Second question text?'); // only page 1 renders
    expect(html).not.toContain('Third question text?');
    const back = buttonWithText(html, 'Back')!;
    expect(back).toBeDefined();
    expect(back).toContain('aria-disabled="true"'); // page 1 → Back disabled, not hidden
    expect(buttonWithText(html, 'Next')).toBeDefined();
    expect(buttonWithText(html, 'Submit answers')).toBeUndefined(); // not the last page
  });

  test('desktop multi-question set renders all questions at once with one submit', () => {
    const html = renderToStaticMarkup(<QuestionForm sessionId="s" question={record(MULTI)} onSubmit={() => {}} />);
    expect(html).toContain('First question text?');
    expect(html).toContain('Second question text?');
    expect(html).toContain('Third question text?');
    expect(buttonWithText(html, 'Submit answer')).toBeDefined();
    expect(buttonWithText(html, 'Next')).toBeUndefined();
    expect(buttonWithText(html, 'Back')).toBeUndefined();
    expect(html).not.toContain('Structured question —');
  });

  test('compact single-question set is the plain form (no paging chrome)', () => {
    const html = renderToStaticMarkup(
      <QuestionForm sessionId="s" question={record(SINGLE)} onSubmit={() => {}} compact />,
    );
    expect(buttonWithText(html, 'Submit answer')).toBeDefined();
    expect(buttonWithText(html, 'Next')).toBeUndefined();
    expect(html).not.toContain('Structured question —');
  });
});

// ---- multi-question single-choice at the markup layer (the :99 fix) ---------

describe('option input types match the wire', () => {
  test('multi-question set renders radios, never checkboxes', () => {
    const html = renderToStaticMarkup(<QuestionForm sessionId="s" question={record(MULTI)} onSubmit={() => {}} />);
    expect(html).toContain('type="radio"');
    expect(html).not.toContain('type="checkbox"');
  });

  test('single-question multiSelect renders checkboxes', () => {
    const html = renderToStaticMarkup(
      <QuestionForm sessionId="s" question={record(SINGLE_MULTI)} onSubmit={() => {}} />,
    );
    expect(html).toContain('type="checkbox"');
  });
});
