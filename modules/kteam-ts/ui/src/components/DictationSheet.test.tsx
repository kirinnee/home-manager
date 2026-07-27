import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DictationSheet,
  dictationStage,
  formatElapsed,
  dictationFailureCopy,
  type DictationSheetProps,
} from './DictationSheet';

describe('dictationStage — what the reader sees, derived from the phase', () => {
  const base = { phase: 'idle' as const, hasTranscript: false, hasError: false, wasCapturing: false };

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

  test('a landed transcript is review, even once the phase has gone back to idle', () => {
    expect(dictationStage({ ...base, phase: 'idle', hasTranscript: true, wasCapturing: true })).toBe('review');
  });

  test('idle with nothing AFTER capturing is a too-short dead end, shown honestly', () => {
    expect(dictationStage({ ...base, phase: 'idle', wasCapturing: true })).toBe('empty');
  });

  test('an error wins over every other signal', () => {
    expect(dictationStage({ ...base, hasError: true })).toBe('error');
    expect(dictationStage({ ...base, phase: 'error' })).toBe('error');
    expect(dictationStage({ phase: 'recording', hasTranscript: true, hasError: true, wasCapturing: true })).toBe(
      'error',
    );
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
    committedText: '',
    provisionalText: '',
    pendingSegments: 0,
    onCommittedTextChange: () => {},
    onProvisionalTextChange: () => {},
    onDismiss: () => {},
    onStop: () => {},
    onCancel: () => {},
    onRetry: () => {},
    onInsert: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<DictationSheet {...props} />);
}

describe('DictationSheet rendering', () => {
  test('the panel source contains no focus trap or mount-time focus call', async () => {
    const source = await Bun.file(new URL('./DictationSheet.tsx', import.meta.url).pathname).text();
    expect(source).not.toContain('<BottomSheet');
    expect(source).not.toContain('useDialogFocus');
    expect(source).not.toContain('.focus(');
    expect(source).not.toContain('autoFocus');
  });

  test('a closed panel paints nothing', () => {
    const html = render({ open: false });
    expect(html).toBe('');
  });

  test('recording uses a non-modal mini panel with a waveform, clock, and Stop target', () => {
    const html = render({ stage: 'recording', elapsedMs: 5000 });
    expect(html).toContain('0:05');
    expect(html).toContain('data-dictation-panel="non-modal"');
    expect(html).toContain('role="region"');
    expect(html).toContain('<canvas');
    expect(html).toContain('Stop &amp; finish');
    expect(html).toContain('Audio stays on this device');
    expect(html).toContain('Cancel');
    expect(html).toContain('Hide dictation panel; recording continues');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('data-bottom-sheet');
    expect(html).not.toContain('bg-scrim');
  });

  test('recording distinguishes editable committed text from editable provisional text', () => {
    const html = render({
      stage: 'recording',
      committedText: 'reader corrected this',
      provisionalText: 'latest phrase',
      pendingSegments: 1,
    });
    expect(html).toContain('Committed · yours to edit');
    expect(html).toContain('Provisional · still settling');
    expect(html).toContain('aria-label="Committed dictated text"');
    expect(html).toContain('aria-label="Provisional dictated text"');
    expect(html).toContain('reader corrected this');
    expect(html).toContain('latest phrase');
    expect(html).toContain('Recognising one local phrase');
  });

  test('finishing keeps both transcript editors available and says it is local', () => {
    const html = render({ stage: 'transcribing', committedText: 'kept', provisionalText: 'settling' });
    expect(html).toContain('Finishing the last phrase on this device');
    expect(html).toContain('Committed · yours to edit');
    expect(html).toContain('Provisional · still settling');
  });

  test('review shows the editable transcript, an explicit Insert, and the never-sent promise', () => {
    const html = render({ stage: 'review', committedText: 'hello there' });
    expect(html).toContain('hello there');
    expect(html).toContain('Insert into message');
    expect(html).toContain('Re-record');
    expect(html.toLowerCase()).toContain('nothing is sent');
  });

  test('an error stage speaks the real local-model reason plus Try again', () => {
    const html = render({
      stage: 'error',
      errorCode: 'not-prepared',
      errorMessage: 'The local speech model has not been prepared.',
    });
    expect(html).toContain('The local speech model has not been prepared.');
    expect(html).toContain('Try again');
  });

  test('a local queue error keeps captured text editable and insertable', () => {
    const html = render({
      stage: 'error',
      errorCode: 'backlog',
      errorMessage: 'This device is falling behind.',
      committedText: 'safe earlier phrase',
      provisionalText: 'safe latest phrase',
    });
    expect(html).toContain('safe earlier phrase');
    expect(html).toContain('safe latest phrase');
    expect(html).toContain('Insert captured text');
  });

  test('NO stage implies that microphone audio goes to a daemon or cloud service', () => {
    for (const stage of ['starting', 'recording', 'transcribing', 'review', 'empty', 'error'] as const) {
      const html = render({
        stage,
        committedText: 'sample',
        errorCode: 'unknown',
        errorMessage: 'x',
      }).toLowerCase();
      expect(html).not.toContain('sent to the daemon');
      expect(html).not.toContain('sent to google');
      expect(html).not.toContain('sent to apple');
    }
  });
});
