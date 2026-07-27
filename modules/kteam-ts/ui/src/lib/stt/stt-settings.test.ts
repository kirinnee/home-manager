import { describe, expect, test } from 'bun:test';
import {
  DAEMON_LANGUAGES,
  DEFAULT_STT_SETTINGS,
  MAX_DICTIONARY_LINES,
  MAX_DICTIONARY_LINE_LENGTH,
  STT_LANGUAGES,
  STT_SETTINGS_KEY,
  STT_SETTINGS_VERSION,
  daemonSupportsLanguage,
  isSttLanguage,
  loadSttSettings,
  normaliseSttSettings,
  parseSttSettings,
  saveSttSettings,
  sttDictionary,
  sttLanguageLabel,
  type SttSettings,
  type SttStorage,
} from './stt-settings';

function memoryStorage(initial?: string): SttStorage & { value: string | null; writes: number } {
  return {
    value: initial ?? null,
    writes: 0,
    getItem(key: string) {
      return key === STT_SETTINGS_KEY ? this.value : null;
    },
    setItem(key: string, next: string) {
      if (key !== STT_SETTINGS_KEY) return;
      this.writes += 1;
      this.value = next;
    },
  };
}

describe('the language catalogue', () => {
  test('is the thirteen v3 documents, with unique codes', () => {
    expect(STT_LANGUAGES.map(language => language.code)).toEqual([
      'en',
      'fr',
      'de',
      'es',
      'it',
      'pt',
      'nl',
      'pl',
      'ru',
      'uk',
      'ja',
      'ko',
      'zh',
    ]);
    expect(new Set(STT_LANGUAGES.map(language => language.code)).size).toBe(13);
    for (const language of STT_LANGUAGES) expect(language.label.length).toBeGreaterThan(0);
  });

  test('the daemon claims English and nothing else', () => {
    expect(DAEMON_LANGUAGES).toEqual(['en']);
    expect(daemonSupportsLanguage('en')).toBe(true);
    expect(daemonSupportsLanguage('ja')).toBe(false);
  });

  test('recognises and labels known codes only', () => {
    expect(isSttLanguage('uk')).toBe(true);
    expect(isSttLanguage('kl')).toBe(false);
    expect(isSttLanguage(7)).toBe(false);
    expect(sttLanguageLabel('ja')).toBe('Japanese');
    expect(sttLanguageLabel('zz')).toBe('zz');
  });
});

describe('defaults', () => {
  test('are daemon, English, enhancement on, empty dictionary', () => {
    expect(DEFAULT_STT_SETTINGS).toEqual({
      v: STT_SETTINGS_VERSION,
      mode: 'daemon',
      language: 'en',
      enhancement: true,
      dictionary: [],
    });
  });
});

describe('parseSttSettings — never throws, always usable', () => {
  const rubbish: Array<[string, string | null]> = [
    ['null', null],
    ['an empty string', ''],
    ['not JSON at all', '{{{'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"hello"'],
    ['a JSON number', '42'],
    ['an object with no version', '{"mode":"local"}'],
    ['a FUTURE version', `{"v":${STT_SETTINGS_VERSION + 1},"mode":"local"}`],
    ['an older version', `{"v":${STT_SETTINGS_VERSION - 1},"mode":"local"}`],
  ];

  for (const [label, raw] of rubbish) {
    test(`degrades ${label} to the defaults`, () => {
      expect(parseSttSettings(raw)).toEqual({ ...DEFAULT_STT_SETTINGS });
    });
  }

  test('reads a well-formed payload', () => {
    const raw = JSON.stringify({ v: 1, mode: 'local', language: 'de', enhancement: false, dictionary: ['tmux'] });
    expect(parseSttSettings(raw)).toEqual({
      v: 1,
      mode: 'local',
      language: 'de',
      enhancement: false,
      dictionary: ['tmux'],
    });
  });

  test('falls back per FIELD, not per document, when one field is hostile', () => {
    const raw = JSON.stringify({
      v: 1,
      mode: 'telepathy',
      language: 'klingon',
      enhancement: 'yes',
      dictionary: 'nope',
    });
    expect(parseSttSettings(raw)).toEqual({ ...DEFAULT_STT_SETTINGS });
  });

  test('caps the dictionary length and each line', () => {
    const raw = JSON.stringify({
      v: 1,
      mode: 'daemon',
      language: 'en',
      enhancement: true,
      dictionary: Array.from({ length: MAX_DICTIONARY_LINES + 50 }, () => 'x'.repeat(MAX_DICTIONARY_LINE_LENGTH + 40)),
    });
    const parsed = parseSttSettings(raw);
    expect(parsed.dictionary).toHaveLength(MAX_DICTIONARY_LINES);
    for (const line of parsed.dictionary) expect(line.length).toBe(MAX_DICTIONARY_LINE_LENGTH);
  });

  test('drops non-string dictionary entries without losing the rest', () => {
    const raw = JSON.stringify({
      v: 1,
      mode: 'daemon',
      language: 'en',
      enhancement: true,
      dictionary: ['a', 5, null, 'b'],
    });
    expect(parseSttSettings(raw).dictionary).toEqual(['a', 'b']);
  });
});

describe('normaliseSttSettings', () => {
  test('is parse applied to a caller-supplied object, so a bad value cannot be persisted', () => {
    const hostile = { v: 1, mode: 'nope', language: 'nope', enhancement: 1, dictionary: [1] } as unknown as SttSettings;
    expect(normaliseSttSettings(hostile)).toEqual({ ...DEFAULT_STT_SETTINGS });
  });
});

describe('storage', () => {
  test('round-trips through a working storage', () => {
    const storage = memoryStorage();
    const next: SttSettings = { v: 1, mode: 'local', language: 'ja', enhancement: false, dictionary: ['tmux'] };
    expect(saveSttSettings(next, storage)).toBe(true);
    expect(loadSttSettings(storage)).toEqual(next);
  });

  test('an absent storage reads defaults and reports the write as not persisted', () => {
    expect(loadSttSettings(null)).toEqual({ ...DEFAULT_STT_SETTINGS });
    expect(saveSttSettings({ ...DEFAULT_STT_SETTINGS }, null)).toBe(false);
  });

  test('a THROWING storage is a normal code path, not a crash', () => {
    const hostile: SttStorage = {
      getItem() {
        throw new Error('storage is disabled in this context');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadSttSettings(hostile)).toEqual({ ...DEFAULT_STT_SETTINGS });
    expect(saveSttSettings({ ...DEFAULT_STT_SETTINGS }, hostile)).toBe(false);
  });

  test('reads back exactly what a corrupted store would not', () => {
    const storage = memoryStorage('not json');
    expect(loadSttSettings(storage)).toEqual({ ...DEFAULT_STT_SETTINGS });
  });
});

describe('sttDictionary', () => {
  test('parses the reader lines into enhancer entries', () => {
    const settings: SttSettings = { ...DEFAULT_STT_SETTINGS, dictionary: ['kteam = kteem', 'tmux'] };
    expect(sttDictionary(settings).entries).toEqual([
      { term: 'kteam', aliases: ['kteem'] },
      { term: 'tmux', aliases: [] },
    ]);
  });
});
