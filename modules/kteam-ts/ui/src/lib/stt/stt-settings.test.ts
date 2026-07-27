import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STT_SETTINGS,
  MAX_DICTIONARY_LINES,
  MAX_DICTIONARY_LINE_LENGTH,
  MAX_USER_CONTEXT_CHARS,
  STT_SETTINGS_KEY,
  STT_SETTINGS_VERSION,
  loadSttSettings,
  normaliseSttSettings,
  parseSttSettings,
  saveSttSettings,
  sttDictionary,
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

describe('defaults', () => {
  test('are browser-local, enhancement on, empty dictionary and context', () => {
    expect(DEFAULT_STT_SETTINGS).toEqual({
      v: STT_SETTINGS_VERSION,
      enhancement: true,
      dictionary: [],
      userContext: '',
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
    ['an unknown old version', '{"v":0,"mode":"local"}'],
  ];

  for (const [label, raw] of rubbish) {
    test(`degrades ${label} to the defaults`, () => {
      expect(parseSttSettings(raw)).toEqual({ ...DEFAULT_STT_SETTINGS });
    });
  }

  test('reads a well-formed payload', () => {
    const raw = JSON.stringify({
      v: STT_SETTINGS_VERSION,
      mode: 'local',
      language: 'de',
      enhancement: false,
      dictionary: ['tmux'],
    });
    expect(parseSttSettings(raw)).toEqual({
      v: STT_SETTINGS_VERSION,
      enhancement: false,
      dictionary: ['tmux'],
      userContext: '',
    });
  });

  test('migrates a v1 DAEMON preference without losing dictionary or context', () => {
    const raw = JSON.stringify({
      v: 1,
      mode: 'daemon',
      language: 'en',
      enhancement: false,
      dictionary: ['kteam'],
      userContext: 'nitroso and diene',
    });
    expect(parseSttSettings(raw)).toEqual({
      v: STT_SETTINGS_VERSION,
      enhancement: false,
      dictionary: ['kteam'],
      userContext: 'nitroso and diene',
    });
  });

  test('migrates a pre-userContext v1 LOCAL payload without discarding its dictionary', () => {
    const raw = JSON.stringify({ v: 1, mode: 'local', language: 'en', enhancement: true, dictionary: ['kteam'] });
    const parsed = parseSttSettings(raw);
    expect(parsed.v).toBe(STT_SETTINGS_VERSION);
    expect(parsed.dictionary).toEqual(['kteam']);
    expect(parsed.userContext).toBe('');
  });

  test('ignores obsolete mode/language fields even when injected into v2', () => {
    const parsed = parseSttSettings(
      JSON.stringify({ ...DEFAULT_STT_SETTINGS, mode: 'daemon', language: 'ja', dictionary: ['tmux'] }),
    );
    expect(parsed).toEqual({ ...DEFAULT_STT_SETTINGS, dictionary: ['tmux'] });
    expect(parsed).not.toHaveProperty('mode');
    expect(parsed).not.toHaveProperty('language');
  });

  test('reads and caps the userContext field', () => {
    const raw = JSON.stringify({ ...DEFAULT_STT_SETTINGS, userContext: 'x'.repeat(MAX_USER_CONTEXT_CHARS + 100) });
    expect(parseSttSettings(raw).userContext).toHaveLength(MAX_USER_CONTEXT_CHARS);
    const hostile = JSON.stringify({ ...DEFAULT_STT_SETTINGS, userContext: ['not', 'a', 'string'] });
    expect(parseSttSettings(hostile).userContext).toBe('');
  });

  test('falls back per FIELD, not per document, when one field is hostile', () => {
    const raw = JSON.stringify({
      v: STT_SETTINGS_VERSION,
      mode: 'telepathy',
      language: 'klingon',
      enhancement: 'yes',
      dictionary: 'nope',
    });
    expect(parseSttSettings(raw)).toEqual({ ...DEFAULT_STT_SETTINGS });
  });

  test('caps the dictionary length and each line', () => {
    const raw = JSON.stringify({
      v: STT_SETTINGS_VERSION,
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
      v: STT_SETTINGS_VERSION,
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
    const hostile = {
      v: STT_SETTINGS_VERSION,
      mode: 'nope',
      language: 'nope',
      enhancement: 1,
      dictionary: [1],
    } as unknown as SttSettings;
    expect(normaliseSttSettings(hostile)).toEqual({ ...DEFAULT_STT_SETTINGS });
  });
});

describe('storage', () => {
  test('round-trips through a working storage', () => {
    const storage = memoryStorage();
    const next: SttSettings = {
      v: STT_SETTINGS_VERSION,
      enhancement: false,
      dictionary: ['tmux'],
      userContext: 'nitroso and diene',
    };
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
