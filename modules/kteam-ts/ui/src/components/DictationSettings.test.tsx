import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DAEMON_LANGUAGE_NOTE,
  DAEMON_MODE_SUMMARY,
  DICTATION_SAFETY_NOTE,
  DictationSettings,
  ENHANCEMENT_EXPLANATION,
  ENHANCEMENT_SOURCES_EXPLANATION,
  USER_CONTEXT_EXPLANATION,
  LOCAL_LANGUAGE_NOTE,
  LOCAL_MODE_SUMMARY,
  LOCAL_MODE_TRADEOFFS,
  formatBytes,
  languageNote,
  languageOptionDisabled,
  needsBoxBrowserModel,
} from './DictationSettings';
import { STT_LANGUAGES } from '../lib/stt/stt-settings';

/** Server rendering gives the DEFAULT settings (daemon, English, enhancement
 *  on) and no effects, which is exactly the first paint a reader sees. */
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
  return source.match(/<(button|select|textarea)\b[^>]*>/gu) ?? [];
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

describe('the language selector is honest about what it controls', () => {
  test('daemon mode disables every language but English', () => {
    expect(languageOptionDisabled('daemon', 'en')).toBe(false);
    for (const language of STT_LANGUAGES.filter(entry => entry.code !== 'en')) {
      expect(languageOptionDisabled('daemon', language.code)).toBe(true);
    }
  });

  test('local mode disables nothing — and the note explains why that is not the same as working', () => {
    for (const language of STT_LANGUAGES) expect(languageOptionDisabled('local', language.code)).toBe(false);
    expect(languageNote('local')).toBe(LOCAL_LANGUAGE_NOTE);
    // parakeet.js 1.4.4 accepts no language anywhere, so the honest note says
    // the choice does not apply here rather than implying it does.
    expect(LOCAL_LANGUAGE_NOTE).toContain('does not change transcription on this device');
  });

  test('daemon mode gets the English-only note', () => {
    expect(languageNote('daemon')).toBe(DAEMON_LANGUAGE_NOTE);
  });
});

describe('the mandatory local-mode disclosures', () => {
  test('every cost is rendered — there is no "show more"', () => {
    for (const tradeoff of LOCAL_MODE_TRADEOFFS) expect(text).toContain(tradeoff);
  });

  test('the four costs the brief requires are each stated', () => {
    const joined = LOCAL_MODE_TRADEOFFS.join(' ');
    expect(joined).toContain('640 MB per device');
    expect(joined.toLowerCase()).toContain('slower on a phone');
    expect(joined).toContain('Safari clears unused site storage');
    expect(joined.toLowerCase()).toContain('battery');
  });

  test('and it names the box as the only source of the weights', () => {
    expect(LOCAL_MODE_TRADEOFFS.join(' ')).toContain('never a third-party CDN');
  });
});

describe('modes', () => {
  test('offers exactly two, as a radiogroup, with daemon selected by default', () => {
    expect(html).toContain('role="radiogroup"');
    const radios = html.match(/role="radio"/gu) ?? [];
    expect(radios).toHaveLength(2);
    expect(text).toContain('On my box (recommended)');
    expect(text).toContain('On this device');
    expect(html).toMatch(/aria-checked="true"[\s\S]*?On my box \(recommended\)/u);
  });

  test('the daemon card carries the recommendation, not a footnote', () => {
    expect(text).toContain(DAEMON_MODE_SUMMARY);
    expect(DAEMON_MODE_SUMMARY.startsWith('Recommended.')).toBe(true);
  });

  test('the local card is upfront that it is desktop-first', () => {
    expect(text).toContain(LOCAL_MODE_SUMMARY);
  });

  test('states why WebGPU is not used, rather than leaving it unexplained', () => {
    expect(text).toContain('runs on the CPU');
  });
});

describe('enhancement', () => {
  test('is on by default and is a switch, not a checkbox nobody can find', () => {
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
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

  test('offers a re-check for the box', () => {
    expect(text).toContain('Re-check');
  });
});

describe('the touch and focus rules', () => {
  test('EVERY interactive target is at least 44 px', () => {
    const elements = interactiveElements(html);
    expect(elements.length).toBeGreaterThan(4);
    for (const element of elements) {
      expect(element).toContain('min-h-[44px]');
    }
  });

  test('nothing autofocuses — opening settings must not raise a phone keyboard', () => {
    expect(html.toLowerCase()).not.toContain('autofocus');
  });

  test('the language selector is a real, labelled control', () => {
    expect(html).toContain('id="stt-language"');
    expect(html).toContain('for="stt-language"');
    const options = html.match(/<option\b/gu) ?? [];
    expect(options).toHaveLength(STT_LANGUAGES.length);
  });
});

describe('the safety note', () => {
  test('leads with the promise that nothing is ever sent', () => {
    expect(text).toContain(DICTATION_SAFETY_NOTE);
    expect(DICTATION_SAFETY_NOTE).toContain('Nothing is ever sent for you.');
  });
});
