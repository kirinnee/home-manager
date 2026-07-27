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

  test('an unreachable daemon and a missing model are named distinctly', () => {
    expect(dictationFailureCopy('network').title).toBe('Daemon unreachable');
    expect(dictationFailureCopy('unavailable').title).toBe('Speech model not ready');
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
    mode: 'daemon',
    elapsedMs: 3200,
    inputMonitor: null,
    text: '',
    onTextChange: () => {},
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
    expect(html).toContain('Stop &amp; transcribe');
    expect(html).toContain('Cancel');
    expect(html).toContain('Hide dictation panel; recording continues');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('data-bottom-sheet');
    expect(html).not.toContain('bg-scrim');
  });

  test('review shows the editable transcript, an explicit Insert, and the never-sent promise', () => {
    const html = render({ stage: 'review', text: 'hello there' });
    expect(html).toContain('hello there');
    expect(html).toContain('Insert into message');
    expect(html).toContain('Re-record');
    expect(html.toLowerCase()).toContain('nothing is sent');
  });

  test('an error stage speaks the real reason plus Try again', () => {
    const html = render({ stage: 'error', errorCode: 'network', errorMessage: 'The daemon could not be reached.' });
    expect(html).toContain('The daemon could not be reached.');
    expect(html).toContain('Try again');
  });

  test('NO stage ever renders partial-text or live/streaming language', () => {
    for (const stage of ['starting', 'recording', 'transcribing', 'review', 'empty', 'error'] as const) {
      const html = render({ stage, text: 'sample', errorCode: 'network', errorMessage: 'x' }).toLowerCase();
      expect(html).not.toContain('streaming');
      expect(html).not.toContain('real-time');
      expect(html).not.toContain('live transcription');
    }
  });
});
