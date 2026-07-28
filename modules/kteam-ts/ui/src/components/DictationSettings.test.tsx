import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DICTATION_SAFETY_NOTE,
  DICTATION_DISABLED_EXPLANATION,
  DictationSettings,
  ENHANCEMENT_EXPLANATION,
  ENHANCEMENT_SOURCES_EXPLANATION,
  ENHANCEMENT_TOGGLE_EXPLANATION,
  GROQ_ENHANCEMENT_EXPLANATION,
  USER_CONTEXT_EXPLANATION,
  LOCAL_MODE_SUMMARY,
  LOCAL_MODE_TRADEOFFS,
  formatBytes,
  needsBoxBrowserModel,
} from './DictationSettings';

/** Server rendering gives the local-only defaults (enhancement on) and no
 * effects, which is exactly the first paint a reader sees. */
const html = renderToStaticMarkup(<DictationSettings />);

/** Entity-decoded, so assertions can be written in the copy's own characters. */
const text = html
  .replace(/&#x27;/gu, "'")
  .replace(/&quot;/gu, '"')
  .replace(/&amp;/gu, '&')
  .replace(/&lt;/gu, '<')
  .replace(/&gt;/gu, '>')
  .replace(/&#x2F;/gu, '/');

function interactiveElements(source: string): string[] {
  return source.match(/<(button|input|select|textarea)\b[^>]*>/gu) ?? [];
}

describe('formatBytes', () => {
  test('reads in MB up to a gigabyte and GB above it', () => {
    expect(formatBytes(670_488_135)).toBe('670 MB');
    expect(formatBytes(482_468_385)).toBe('482 MB');
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
  });

  test('nonsense reads as 0 MB rather than showing NaN to the reader', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(-5)).toBe('0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 MB');
  });
});

describe('needsBoxBrowserModel — the two-stage install', () => {
  test('a box without the browser weights blocks the per-device copy', () => {
    expect(needsBoxBrowserModel({ state: 'not-installed' })).toBe(true);
    expect(needsBoxBrowserModel({ state: 'installing' })).toBe(true);
    expect(needsBoxBrowserModel({ state: 'error' })).toBe(true);
  });

  test('a ready box does not', () => {
    expect(needsBoxBrowserModel({ state: 'ready' })).toBe(false);
  });

  test('an UNKNOWN status is not treated as a refusal', () => {
    // An older daemon tells us nothing. Refusing on ignorance would break a
    // working setup to guard against a broken one.
    expect(needsBoxBrowserModel(undefined)).toBe(false);
  });
});

describe('the mandatory local-mode disclosures', () => {
  test('every cost is rendered — there is no "show more"', () => {
    for (const tradeoff of LOCAL_MODE_TRADEOFFS) expect(text).toContain(tradeoff);
  });

  test('the four costs the brief requires are each stated', () => {
    const joined = LOCAL_MODE_TRADEOFFS.join(' ');
    expect(joined).toContain('700 MB per device');
    expect(joined.toLowerCase()).toContain('slower on a phone');
    expect(joined).toContain('Safari clears unused site storage');
    expect(joined.toLowerCase()).toContain('battery');
  });

  test('and it names the box as the only source of the weights', () => {
    expect(LOCAL_MODE_TRADEOFFS.join(' ')).toContain('never a third-party CDN');
  });
});

describe('one local engine', () => {
  test('shows one truthful local path and no selectable/dead daemon path', () => {
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('role="radio"');
    expect(text).toContain('Transcribed on this device');
    expect(text).not.toContain('On my box (recommended)');
    expect(text).not.toContain('Box transcription');
  });

  test('states that microphone audio never goes to the box or a third party', () => {
    expect(text).toContain(LOCAL_MODE_SUMMARY);
    expect(LOCAL_MODE_SUMMARY).toContain('never sent to your box or a third party');
    expect(LOCAL_MODE_SUMMARY).toContain('without waiting for a pause');
  });

  test('states why WebGPU is not used, rather than leaving it unexplained', () => {
    expect(text).toContain('runs on the CPU');
  });
});

describe('the dictation master switch', () => {
  test('is on by default and says exactly which work stops when disabled', () => {
    expect(html).toMatch(/aria-label="Dictation availability"[\s\S]*role="switch"[\s\S]*aria-checked="true"/u);
    expect(text).toContain(DICTATION_DISABLED_EXPLANATION);
    expect(DICTATION_DISABLED_EXPLANATION).toContain('microphone cannot start');
    expect(DICTATION_DISABLED_EXPLANATION).toContain('model files are not fetched');
    expect(DICTATION_DISABLED_EXPLANATION).toContain('no decode runs');
    expect(DICTATION_DISABLED_EXPLANATION).toContain('about 1 GB of memory');
    expect(DICTATION_DISABLED_EXPLANATION).toContain('without a reload');
  });

  test('the control calls the real ONNX unload path, not only a UI hide', async () => {
    const source = await Bun.file(new URL('./DictationSettings.tsx', import.meta.url).pathname).text();
    expect(source).toContain('void unloadLocalEngine()');
    expect(source).toContain('preparing.current?.abort()');
    expect(source).toContain('update({ enabled })');
  });
});

describe('push to talk', () => {
  test('shows the customizable default and the hold/tap interaction', () => {
    expect(text).toContain('Push to talk');
    expect(text).toContain('Alt (either side)');
    expect(text).toContain('Hold to record and release to finish');
    expect(text).toContain('tap once to latch');
    expect(text).toContain('Change shortcut');
  });

  test('warns up front that a desktop may intercept bare Alt', () => {
    expect(text).toContain('Bare Alt can be intercepted');
    expect(text).toContain('window manager');
  });
});

describe('enhancement', () => {
  test('is on by default and is a switch, not a checkbox nobody can find', () => {
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(text).toContain(ENHANCEMENT_TOGGLE_EXPLANATION);
    expect(ENHANCEMENT_TOGGLE_EXPLANATION).toContain('after local transcription');
    expect(ENHANCEMENT_TOGGLE_EXPLANATION).toContain('cannot send a message');
  });

  test('explains WORDS ONLY verbatim', () => {
    expect(text).toContain(ENHANCEMENT_EXPLANATION);
    expect(ENHANCEMENT_EXPLANATION.startsWith('WORDS ONLY.')).toBe(true);
    expect(ENHANCEMENT_EXPLANATION).toContain('cannot add, remove or reorder words');
    expect(ENHANCEMENT_EXPLANATION).toContain('discards the whole thing');
  });

  test('names its vocabulary sources and their order, and says there is no AI model', () => {
    expect(text).toContain(ENHANCEMENT_SOURCES_EXPLANATION);
    expect(ENHANCEMENT_SOURCES_EXPLANATION).toContain('always win');
    expect(ENHANCEMENT_SOURCES_EXPLANATION).toContain('no AI model, nothing sent anywhere');
    expect(ENHANCEMENT_SOURCES_EXPLANATION).toContain('changes nothing');
  });

  test('offers a table-driven provider choice while keeping credentials out of browser storage', async () => {
    expect(html).toContain('id="stt-enhancement-provider"');
    expect(text).toContain('On-device word correction');
    expect(text).toContain('Groq correction');
    expect(GROQ_ENHANCEMENT_EXPLANATION).toContain('GROQ_API_KEY');
    expect(GROQ_ENHANCEMENT_EXPLANATION).toContain('~/.secrets');
    expect(GROQ_ENHANCEMENT_EXPLANATION).toContain('never stored in this browser');
    expect(GROQ_ENHANCEMENT_EXPLANATION).toContain('never in the live-text path');
    expect(GROQ_ENHANCEMENT_EXPLANATION).toContain('sends Groq the raw transcript');
    expect(GROQ_ENHANCEMENT_EXPLANATION).toContain('capitalization and punctuation');
    const settingsSource = await Bun.file(new URL('../lib/stt/stt-settings.ts', import.meta.url).pathname).text();
    expect(settingsSource).not.toMatch(/apiKey|api_key/u);
  });
});

describe('the dictionary', () => {
  test('is a labelled textarea with the single-word rule stated', () => {
    expect(html).toContain('id="stt-dictionary"');
    expect(html).toContain('for="stt-dictionary"');
    expect(text).toContain('Single words only');
  });

  test('reports the term count', () => {
    expect(text).toContain('0 terms');
  });
});

describe('the free-text context', () => {
  test('is a labelled textarea that invites a paste', () => {
    expect(html).toContain('id="stt-user-context"');
    expect(html).toContain('for="stt-user-context"');
    expect(text).toContain(USER_CONTEXT_EXPLANATION);
    expect(USER_CONTEXT_EXPLANATION).toContain('Paste anything');
  });

  test('states the precedence: the dictionary entry wins', () => {
    expect(USER_CONTEXT_EXPLANATION).toContain('that entry wins');
  });

  test('echoes how many words were picked out, so the reader can see it take', () => {
    // Default settings: empty context, zero words.
    expect(text).toContain('0 words picked out');
  });
});

describe('readiness', () => {
  test('shows the per-device cost next to the prepare action', () => {
    expect(text).toContain('Prepare this device');
    expect(text).toContain('/stt-models/parakeet-browser-v3');
  });

  test('describes the box as a model-file source, not a transcription engine', () => {
    expect(text).toContain('Your box hosts the pinned files');
    expect(text).not.toContain('Your box does the transcribing');
  });
});

describe('the touch and focus rules', () => {
  test('EVERY interactive target is at least 44 px', () => {
    const elements = interactiveElements(html);
    expect(elements.length).toBeGreaterThan(3);
    for (const element of elements) {
      expect(element).toContain('min-h-[44px]');
    }
  });

  test('nothing autofocuses — opening settings must not raise a phone keyboard', () => {
    expect(html.toLowerCase()).not.toContain('autofocus');
  });

  test('does not render a language selector the local engine cannot honour', () => {
    expect(html).not.toContain('id="stt-language"');
  });
});

describe('the safety note', () => {
  test('leads with the promise that nothing is ever sent', () => {
    expect(text).toContain(DICTATION_SAFETY_NOTE);
    expect(DICTATION_SAFETY_NOTE).toContain('newest bounded local window');
    expect(DICTATION_SAFETY_NOTE).toContain('current caret');
    expect(DICTATION_SAFETY_NOTE).toContain('Nothing is ever sent for you.');
  });
});
