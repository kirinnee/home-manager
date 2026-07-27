import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DictationControl, dictationStatusCopy } from './DictationControl';

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

function render(props: Partial<Parameters<typeof DictationControl>[0]> = {}): string {
  return renderToStaticMarkup(<DictationControl draft="" onDraftChange={() => {}} {...props} />);
}

function theButton(html: string): string {
  const match = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/u);
  if (!match) throw new Error(`no button in\n${html}`);
  return match[0];
}

describe('dictationStatusCopy — never claims live text', () => {
  test('says Recording while capturing and Transcribing after stop', () => {
    expect(dictationStatusCopy('recording', 'daemon')).toBe('Recording…');
    expect(dictationStatusCopy('transcribing', 'daemon')).toBe('Transcribing…');
  });

  test('names the device when the work is happening on it', () => {
    expect(dictationStatusCopy('transcribing', 'local')).toBe('Transcribing on this device…');
  });

  test('idle says nothing at all', () => {
    expect(dictationStatusCopy('idle', 'daemon')).toBe('');
  });

  test('the permission wait is its own state, not "Recording"', () => {
    expect(dictationStatusCopy('requesting', 'daemon')).toBe('Waiting for microphone permission…');
  });

  test('an error shows the failure, with a fallback when there is no message', () => {
    expect(dictationStatusCopy('error', 'daemon', 'Microphone access was blocked.')).toBe(
      'Microphone access was blocked.',
    );
    expect(dictationStatusCopy('error', 'daemon')).toBe('Dictation failed.');
  });

  test('NO phase, in either mode, promises live or streaming text', () => {
    const phases = ['idle', 'requesting', 'recording', 'transcribing', 'error'] as const;
    for (const mode of ['daemon', 'local'] as const) {
      for (const phase of phases) {
        const copy = dictationStatusCopy(phase, mode).toLowerCase();
        expect(copy).not.toContain('live');
        expect(copy).not.toContain('streaming');
        expect(copy).not.toContain('real-time');
      }
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

    test('renders a 44px, labelled dialog-trigger that is collapsed at rest', () => {
      withNavigator(NAV);
      const button = theButton(render());
      expect(button).toContain('min-h-[44px]');
      expect(button).toContain('min-w-[44px]');
      expect(button).toContain('aria-label="Dictate a message"');
      // It OPENS a modal — announced as a dialog trigger, closed until tapped.
      expect(button).toContain('aria-haspopup="dialog"');
      expect(button).toContain('aria-expanded="false"');
      expect(button).toContain('type="button"');
    });

    test('the closed sheet renders no dialog markup at rest', () => {
      withNavigator(NAV);
      const html = render();
      // BottomSheet is inert until opened, so nothing but the trigger paints.
      expect(html).not.toContain('role="dialog"');
      expect(html).not.toContain('aria-modal');
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

    test('says out loud that dictation never sends', () => {
      withNavigator(NAV);
      expect(theButton(render()).toLowerCase()).toContain('nothing is ever sent for you');
    });
  });
});
