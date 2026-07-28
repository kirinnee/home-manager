import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DictationControl, dictationStatusCopy, dictationTriggerStartsFresh } from './DictationControl';

/** Swap in a navigator that does — or does not — expose a microphone API.
 *  `hasMicrophoneApi` reads the global at render, which is exactly the
 *  distinction being tested. */
function withNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

const REAL_NAVIGATOR = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: REAL_NAVIGATOR, configurable: true, writable: true });
});

describe('dictation trigger — hidden flows resume instead of restarting', () => {
  const fresh = { phase: 'idle' as const, hasTranscript: false, hasError: false, wasCapturing: false };

  test('starts only from a genuinely fresh idle state', () => {
    expect(dictationTriggerStartsFresh(fresh)).toBe(true);
  });

  test('reopens every in-progress or landed state without replacing it', () => {
    expect(dictationTriggerStartsFresh({ ...fresh, phase: 'requesting' })).toBe(false);
    expect(dictationTriggerStartsFresh({ ...fresh, phase: 'recording' })).toBe(false);
    expect(dictationTriggerStartsFresh({ ...fresh, phase: 'transcribing' })).toBe(false);
    expect(dictationTriggerStartsFresh({ ...fresh, hasTranscript: true })).toBe(false);
    expect(dictationTriggerStartsFresh({ ...fresh, hasError: true })).toBe(false);
    expect(dictationTriggerStartsFresh({ ...fresh, wasCapturing: true })).toBe(false);
  });
});

function render(props: Partial<Parameters<typeof DictationControl>[0]> = {}): string {
  return renderToStaticMarkup(<DictationControl draft="" onDraftChange={() => {}} {...props} />);
}

function theButton(html: string): string {
  const match = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/u);
  if (!match) throw new Error(`no button in\n${html}`);
  return match[0];
}

describe('dictationStatusCopy — local-only state', () => {
  test('says Recording while capturing and names the device while finishing', () => {
    expect(dictationStatusCopy('recording')).toBe('Recording…');
    expect(dictationStatusCopy('transcribing')).toBe('Finishing on this device…');
  });

  test('idle says nothing at all', () => {
    expect(dictationStatusCopy('idle')).toBe('');
  });

  test('the permission wait is its own state, not "Recording"', () => {
    expect(dictationStatusCopy('requesting')).toBe('Waiting for microphone permission…');
  });

  test('an error shows the failure, with a fallback when there is no message', () => {
    expect(dictationStatusCopy('error', 'Microphone access was blocked.')).toBe('Microphone access was blocked.');
    expect(dictationStatusCopy('error')).toBe('Dictation failed.');
  });

  test('NO phase implies daemon or cloud transcription', () => {
    const phases = ['idle', 'requesting', 'recording', 'transcribing', 'error'] as const;
    for (const phase of phases) {
      const copy = dictationStatusCopy(phase).toLowerCase();
      expect(copy).not.toContain('daemon');
      expect(copy).not.toContain('cloud');
    }
  });
});

describe('rendering', () => {
  test('renders NOTHING when the browser has no microphone API', () => {
    // An insecure context leaves `navigator.mediaDevices` UNDEFINED. The
    // capability is absent, not refused, so a disabled button would be a lie.
    withNavigator({ userAgent: 'test' });
    expect(render()).toBe('');
  });

  test('renders nothing when there is no navigator at all (SSR)', () => {
    withNavigator(undefined);
    expect(render()).toBe('');
  });

  describe('with a microphone', () => {
    const NAV = { userAgent: 'test', mediaDevices: { getUserMedia: () => Promise.resolve({}) } };

    test('renders a 44px, labelled panel trigger that is collapsed at rest', () => {
      withNavigator(NAV);
      const button = theButton(render());
      expect(button).toContain('min-h-[44px]');
      expect(button).toContain('min-w-[44px]');
      expect(button).toContain('aria-label="Dictate a message"');
      // It opens a non-modal region, not a dialog/menu that claims focus.
      expect(button).not.toContain('aria-haspopup');
      expect(button).toContain('aria-expanded="false"');
      expect(button).toContain('type="button"');
    });

    test('the closed panel renders no floating markup at rest', () => {
      withNavigator(NAV);
      const html = render();
      // The non-modal recorder is absent until opened, so only the trigger paints.
      expect(html).not.toContain('role="dialog"');
      expect(html).not.toContain('aria-modal');
      expect(html).not.toContain('data-dictation-panel');
    });

    test('never autofocuses', () => {
      withNavigator(NAV);
      expect(render().toLowerCase()).not.toContain('autofocus');
    });

    test('honours `disabled`', () => {
      withNavigator(NAV);
      expect(theButton(render({ disabled: true }))).toContain('disabled');
    });

    test('the full layout adds a visible label without losing the accessible one', () => {
      withNavigator(NAV);
      const html = render({ layout: 'full' });
      expect(html).toContain('Dictate');
      expect(theButton(html)).toContain('aria-label="Dictate a message"');
    });

    test('says out loud that dictation never sends, and that words drop into the draft', () => {
      withNavigator(NAV);
      const button = theButton(render()).toLowerCase();
      expect(button).toContain('nothing is ever sent for you');
      // The promise the redesign makes: no manual insert, words land in the draft.
      expect(button).toContain('drop into your draft');
    });

    test('shows the current push-to-talk binding in the mic tooltip', () => {
      withNavigator(NAV);
      const button = theButton(render());
      expect(button).toContain('Alt (either side)');
      expect(button).toContain('aria-keyshortcuts="Alt"');
    });
  });
});

// These behaviours run inside the hook's async capture flow, which this project
// has no DOM/act harness to drive (the hook's own tests likewise only exercise
// pure exports). Following the DictationSheet source-inspection precedent, the
// integration wiring is asserted against the component source instead.
describe('useDictationBundle wiring — the integration contract', () => {
  async function source(): Promise<string> {
    return Bun.file(new URL('./DictationControl.tsx', import.meta.url).pathname).text();
  }

  test('passes the real draft and selection through to the hook', async () => {
    const src = await source();
    expect(src).toContain('draft,');
    expect(src).toContain('selectionRef,');
    // Both are forwarded to useDictation (the hook now reads them at insert time).
    expect(src).toMatch(/useDictation\(\{[\s\S]*selectionRef,[\s\S]*\}\)/u);
  });

  test('adapts the single final onDraft result to onDraftChange, then closes the flow', async () => {
    const src = await source();
    // onDraft is the ONE output: forward it, then auto-close. No review step.
    expect(src).toMatch(/onDraft:\s*result\s*=>\s*\{[\s\S]*onDraftChange\(result\)[\s\S]*closePanel\(\)[\s\S]*\}/u);
  });

  test('there is no manual transcript editing, review, or Insert logic left', async () => {
    const src = await source();
    expect(src).not.toContain('editCommittedTranscript');
    expect(src).not.toContain('editProvisionalTranscript');
    expect(src).not.toContain('insertTranscript');
    expect(src).not.toContain('onInsert');
    expect(src).not.toContain("'review'");
    // Only a read-only live snapshot is retained for the panel caption.
    expect(src).toContain('reduceLiveTranscript');
    expect(src).toContain('completeTranscriptText');
  });

  test('the returned handle wraps start() so push-to-talk opens the panel first', async () => {
    const src = await source();
    // start() is replaced with the panel-opening entry point; the rest of the
    // handle contract (phase, stop, cancel, …) is preserved by the spread.
    expect(src).toMatch(/\{\s*\.\.\.dictation,\s*start:\s*openAndRecord\s*\}/u);
    // openAndRecord makes the panel visible before delegating to capture.
    expect(src).toMatch(/openAndRecord[\s\S]*setOpen\(true\)/u);
  });
});
