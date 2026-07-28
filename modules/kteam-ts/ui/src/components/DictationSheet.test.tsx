import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DictationSheet,
  dictationStage,
  formatElapsed,
  dictationFailureCopy,
  type DictationSheetProps,
  type DictationStage,
} from './DictationSheet';

describe('dictationStage — what the reader sees, derived from the phase', () => {
  const base = { phase: 'idle' as const, hasError: false, wasCapturing: false };

  test('a fresh open, before the mic answers, is "starting" not "empty"', () => {
    expect(dictationStage(base)).toBe('starting');
  });

  test('permission wait is starting; only an open mic is recording', () => {
    expect(dictationStage({ ...base, phase: 'requesting' })).toBe('starting');
    expect(dictationStage({ ...base, phase: 'recording' })).toBe('recording');
  });

  test('transcribing is its own stage', () => {
    expect(dictationStage({ ...base, phase: 'transcribing' })).toBe('transcribing');
  });

  test('there is NO review stage — a landed transcript inserts itself and the panel closes', () => {
    // Once a transcript lands the hook inserts it and returns to idle, and the
    // bundle closes the panel. The reader never sits on a manual review step, so
    // an idle-with-capture state is only ever the "too short" dead end.
    const stages: DictationStage[] = ['starting', 'recording', 'transcribing', 'empty', 'error'];
    expect(stages).not.toContain('review' as DictationStage);
    expect(dictationStage({ ...base, phase: 'idle', wasCapturing: true })).toBe('empty');
  });

  test('idle with nothing AFTER capturing is a too-short dead end, shown honestly', () => {
    expect(dictationStage({ ...base, phase: 'idle', wasCapturing: true })).toBe('empty');
  });

  test('an error wins over every other signal', () => {
    expect(dictationStage({ ...base, hasError: true })).toBe('error');
    expect(dictationStage({ ...base, phase: 'error' })).toBe('error');
    expect(dictationStage({ phase: 'recording', hasError: true, wasCapturing: true })).toBe('error');
  });
});

describe('formatElapsed', () => {
  test('m:ss with a zero-padded seconds field', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(3200)).toBe('0:03');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(600_000)).toBe('10:00');
  });

  test('negatives clamp to zero rather than showing a minus', () => {
    expect(formatElapsed(-500)).toBe('0:00');
  });
});

describe('dictationFailureCopy — a plain title per code', () => {
  test('a blocked mic gets an actionable hint', () => {
    const copy = dictationFailureCopy('permission-denied');
    expect(copy.title).toBe('Microphone blocked');
    expect(copy.hint?.toLowerCase()).toContain('allow');
  });

  test('local readiness and data-loss prevention failures are named distinctly', () => {
    expect(dictationFailureCopy('not-prepared').title).toBe('Prepare this device first');
    expect(dictationFailureCopy('backlog').title).toBe('This device is falling behind');
    expect(dictationFailureCopy('empty-segment').title).toBe("One phrase wasn't readable");
  });

  test('a provider failure says the raw transcript was kept, not that dictation was lost', () => {
    const copy = dictationFailureCopy('enhancement-not-configured');
    expect(copy.title).toBe('Raw dictation kept');
    expect(copy.hint).toContain('unmodified transcript was already added');
  });

  test('an unknown code still gets a title, never a blank', () => {
    expect(dictationFailureCopy(undefined).title.length).toBeGreaterThan(0);
    expect(dictationFailureCopy('something-new').title.length).toBeGreaterThan(0);
  });
});

function render(overrides: Partial<DictationSheetProps> = {}): string {
  const props: DictationSheetProps = {
    open: true,
    stage: 'recording',
    elapsedMs: 3200,
    inputMonitor: null,
    liveText: '',
    pendingSegments: 0,
    onDismiss: () => {},
    onStop: () => {},
    onCancel: () => {},
    onRetry: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<DictationSheet {...props} />);
}

describe('DictationSheet rendering', () => {
  test('the panel source is a read-only caption — no focus trap, no editor, no Insert', async () => {
    const source = await Bun.file(new URL('./DictationSheet.tsx', import.meta.url).pathname).text();
    // Non-modal invariants from the original redesign.
    expect(source).not.toContain('<BottomSheet');
    expect(source).not.toContain('useDialogFocus');
    expect(source).not.toContain('.focus(');
    expect(source).not.toContain('autoFocus');
    // The panel no longer owns or edits a transcript: no textarea/contenteditable,
    // no committed-vs-provisional editors, and no manual Insert action.
    expect(source).not.toContain('<Textarea');
    expect(source).not.toContain('contentEditable');
    expect(source).not.toContain('onInsert');
    expect(source).not.toContain('onCommittedTextChange');
    expect(source).not.toContain('onProvisionalTextChange');
  });

  test('a closed panel paints nothing', () => {
    const html = render({ open: false });
    expect(html).toBe('');
  });

  test('recording is a composer-anchored 56px strip with a clock, caption and icon actions', () => {
    const html = render({ stage: 'recording', elapsedMs: 5000 });
    expect(html).toContain('0:05');
    expect(html).toContain('data-dictation-panel="non-modal"');
    expect(html).toContain('role="region"');
    expect(html).toContain('absolute inset-x-0 bottom-[calc(100%+0.5rem)]');
    expect(html).toContain('min-h-[56px]');
    expect(html).toContain('truncate');
    expect(html).not.toContain('<canvas');
    expect(html).toContain('aria-label="Stop recording and add text to your draft"');
    expect(html).toContain('Audio stays on this device');
    expect(html).toContain('aria-label="Cancel dictation"');
    expect(html).toContain('Hide dictation panel; recording continues');
    expect(html.match(/min-h-\[44px\]/g)).toHaveLength(3);
    // Non-modal, and read-only: no dialog, no scrim, and NO editable field.
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('data-bottom-sheet');
    expect(html).not.toContain('bg-scrim');
    expect(html).not.toContain('<textarea');
  });

  test('recording copy promises words appear as you speak, without waiting for a pause', () => {
    const html = render({ stage: 'recording' }).toLowerCase();
    expect(html).toContain('words appear as you speak');
    // The whole point of the migration: no silence boundary needed.
    expect(html).toContain('never have to pause');
  });

  test('the live caption is a single read-only surface, not a committed/provisional editor', () => {
    const html = render({ stage: 'recording', liveText: 'hello there world', pendingSegments: 1 });
    // The preview text is shown, verbatim, in a read-only region.
    expect(html).toContain('hello there world');
    expect(html).toContain('data-live-transcript="preview"');
    expect(html).not.toContain('<textarea');
    // No committed-vs-provisional split labels or styling anymore.
    expect(html).not.toContain('Committed · yours to edit');
    expect(html).not.toContain('Provisional · still settling');
    expect(html).not.toContain('aria-label="Committed dictated text"');
    expect(html).not.toContain('aria-label="Provisional dictated text"');
  });

  test('finishing names the bounded local settle and keeps captured words in the one-line status', () => {
    const html = render({ stage: 'transcribing', liveText: 'nearly done' });
    expect(html.toLowerCase()).toContain('settling the newest bounded on-device window and enhancement');
    expect(html).toContain('Last heard: nearly done');
    // Still a read-only preview, still no manual Insert button.
    expect(html).toContain('nearly done');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Insert');
  });

  test('the empty dead end offers a fresh record, no review', () => {
    const html = render({ stage: 'empty' });
    expect(html).toContain('No speech was captured');
    expect(html).toContain('Record again');
    expect(html).not.toContain('Insert');
    expect(html).not.toContain('<textarea');
  });

  test('an error stage speaks the real local-model reason plus Try again', () => {
    const html = render({
      stage: 'error',
      errorCode: 'not-prepared',
      errorMessage: 'The local speech model has not been prepared.',
    });
    expect(html).toContain('The local speech model has not been prepared.');
    expect(html).toContain('Try again');
    // No recovery-by-insert path: the transcript was disposable.
    expect(html).not.toContain('Insert');
    expect(html).not.toContain('<textarea');
  });

  test('an error can still show the captured words read-only, but never lets you edit or insert them', () => {
    const html = render({
      stage: 'error',
      errorCode: 'backlog',
      errorMessage: 'This device is falling behind.',
      liveText: 'safe earlier words',
    });
    expect(html).toContain('safe earlier words');
    expect(html).toContain('data-live-transcript="preview"');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Insert');
  });

  test('NO stage implies that microphone audio goes to a daemon or cloud service', () => {
    for (const stage of ['starting', 'recording', 'transcribing', 'empty', 'error'] as const) {
      const html = render({
        stage,
        liveText: 'sample',
        errorCode: 'unknown',
        errorMessage: 'x',
      }).toLowerCase();
      expect(html).not.toContain('sent to the daemon');
      expect(html).not.toContain('sent to google');
      expect(html).not.toContain('sent to apple');
      expect(html).toContain('speech recognition stay on this device');
      expect(html).toContain('never sent automatically');
    }
  });
});
