import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_BONUS,
  FIELD_WEIGHTS,
  MAX_SESSION_RESULTS,
  RECENT_SESSION_COUNT,
  SUBSEQUENCE_SCORE,
  SUBSTRING_SCORE,
  WORD_START_SCORE,
  fieldScore,
  rankSessions,
  recentSessions,
  scoreFields,
  sessionBonus,
  type SessionEntry,
} from './fuzzy';
import { displayCallsign } from './callsign';

/** Fixed clock: every recency assertion below is relative to this, so the
 *  ladder's boundaries are testable without a fake timer. */
const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An entry that matches nothing and carries no bonus, so each test can turn on
 *  exactly the one field or flag it is about. */
function entry(patch: Partial<SessionEntry> & { id: string }): SessionEntry {
  return {
    teammate: '',
    task: '',
    label: '',
    folder: '',
    activityAt: 0,
    active: false,
    finished: false,
    ...patch,
  };
}

function ids(entries: readonly SessionEntry[]): string[] {
  return entries.map(e => e.id);
}

describe('fieldScore — the three match kinds are strictly ordered', () => {
  test('a query that begins the value is a word start', () => {
    expect(fieldScore('meghan', 'meg')).toBe(WORD_START_SCORE);
    expect(fieldScore('meghan', 'meghan')).toBe(WORD_START_SCORE);
  });

  test('a query that begins any segment of the value is also a word start', () => {
    // The first `n` of the path is not a word start; the one in `nitroso` is.
    expect(fieldScore('/home/k/Workspace/atomi/nitroso', 'nitro')).toBe(WORD_START_SCORE);
    expect(fieldScore('fix the transcript scroller', 'scroll')).toBe(WORD_START_SCORE);
    expect(fieldScore('mary-jane', 'jane')).toBe(WORD_START_SCORE);
  });

  test('a substring that starts mid-word scores below any word start', () => {
    expect(fieldScore('amelia', 'mel')).toBe(SUBSTRING_SCORE);
    expect(fieldScore('amelia', 'mel')).toBeLessThan(fieldScore('melissa', 'mel'));
  });

  test('an in-order subsequence scores below any substring, by density', () => {
    // `ad` spans 4 characters of `abcd` → 40 × (2/4).
    expect(fieldScore('abcd', 'ad')).toBeCloseTo(SUBSEQUENCE_SCORE * 0.5, 10);
    expect(fieldScore('abcd', 'ad')).toBeLessThan(SUBSTRING_SCORE);
    // Tighter packing wins: the same needle, less padding between the letters.
    expect(fieldScore('axd', 'ad')).toBeGreaterThan(fieldScore('axxxd', 'ad'));
  });

  test('the tightest window is scored, not the first one found', () => {
    // A greedy left-to-right scan would span the whole string from the leading
    // `a`; the real abbreviation is the tight `a-b` at the end.
    const greedySpan = SUBSEQUENCE_SCORE * (2 / 'axxxxxxab'.length);
    expect(fieldScore('axxxxxxab', 'ab')).toBeGreaterThan(greedySpan);
  });

  test('out-of-order and absent characters do not match at all', () => {
    expect(fieldScore('abcd', 'da')).toBe(0);
    expect(fieldScore('abcd', 'z')).toBe(0);
    expect(fieldScore('', 'a')).toBe(0);
    expect(fieldScore('abcd', '')).toBe(0);
    expect(fieldScore('abcd', '   ')).toBe(0);
  });
});

describe('fieldScore — anchored (id) fields', () => {
  const id = 'ms10dwtu-58bc22d1';

  test('an id answers to a prefix of itself or of one of its segments', () => {
    expect(fieldScore(id, 'ms10', { anchored: true })).toBe(WORD_START_SCORE);
    expect(fieldScore(id, '58bc', { anchored: true })).toBe(WORD_START_SCORE);
    expect(fieldScore(id, id, { anchored: true })).toBe(WORD_START_SCORE);
  });

  test('an id never answers to a mid-segment substring or a subsequence', () => {
    expect(fieldScore(id, '0dwt', { anchored: true })).toBe(0);
    expect(fieldScore(id, 'm1d', { anchored: true })).toBe(0);
    // The same value UNANCHORED would have matched — the flag is what stops it.
    expect(fieldScore(id, '0dwt')).toBe(SUBSTRING_SCORE);
  });
});

describe('scoreFields — weights and multi-term queries', () => {
  test('the composite of a lone matching field is that field weight × its score', () => {
    expect(scoreFields([{ value: 'zeta', weight: FIELD_WEIGHTS.teammate }], 'zeta')).toBeCloseTo(
      FIELD_WEIGHTS.teammate * WORD_START_SCORE,
      10,
    );
  });

  test('matching in a second field adds a residual but never reorders match kinds', () => {
    const oneField = scoreFields([{ value: 'zeta', weight: FIELD_WEIGHTS.teammate }], 'zeta');
    const twoFields = scoreFields(
      [
        { value: 'zeta', weight: FIELD_WEIGHTS.teammate },
        { value: 'zeta build', weight: FIELD_WEIGHTS.task },
      ],
      'zeta',
    );
    expect(twoFields).toBeGreaterThan(oneField);
    // A full second field cannot lift a mid-word substring past a word start in
    // the SAME field — otherwise the three kinds would stop being an ordering.
    const substringEverywhere = scoreFields(
      [
        { value: 'azeta', weight: FIELD_WEIGHTS.teammate },
        { value: 'azeta', weight: FIELD_WEIGHTS.task },
        { value: 'azeta', weight: FIELD_WEIGHTS.label },
        { value: 'azeta', weight: FIELD_WEIGHTS.folder },
      ],
      'zeta',
    );
    expect(substringEverywhere).toBeLessThan(oneField);
  });

  test('whitespace is AND — every term must land somewhere', () => {
    const fields = [
      { value: 'jessica', weight: FIELD_WEIGHTS.teammate },
      { value: 'command palette', weight: FIELD_WEIGHTS.task },
    ];
    expect(scoreFields(fields, 'jessica palette')).toBeGreaterThan(0);
    expect(scoreFields(fields, 'jessica transcript')).toBe(0);
  });

  test('an empty query scores nothing (the caller shows recents instead)', () => {
    expect(scoreFields([{ value: 'jessica', weight: 3 }], '')).toBe(0);
    expect(scoreFields([{ value: 'jessica', weight: 3 }], '   ')).toBe(0);
  });
});

describe('rankSessions — field weights decide between equally good matches', () => {
  test('teammate > task > label > folder > id for the same word-start query', () => {
    const entries = [
      entry({ id: 'e-id', teammate: '', task: '', label: '', folder: '' }),
      entry({ id: 'e-folder', folder: 'zeta' }),
      entry({ id: 'e-label', label: 'zeta' }),
      entry({ id: 'e-task', task: 'zeta the build' }),
      entry({ id: 'e-teammate', teammate: 'zeta' }),
    ];
    // The id entry matches through its own id, anchored.
    entries[0]!.id = 'zeta-0000';
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual([
      'e-teammate',
      'e-task',
      'e-label',
      'e-folder',
      'zeta-0000',
    ]);
  });

  test('match kind outranks field weight order within one query', () => {
    const entries = [
      entry({ id: 'a', teammate: 'azeta' }), // substring: 3 × 70 = 210
      entry({ id: 'b', task: 'zeta build' }), // word start: 2 × 100 = 200
    ];
    // …and a word start in a heavier field beats both.
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(['a', 'b']);
    expect(ids(rankSessions([...entries, entry({ id: 'c', teammate: 'zeta' })], 'zeta', { now: NOW }))).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('non-matching sessions are dropped, not merely ranked last', () => {
    const entries = [entry({ id: 'a', teammate: 'zeta' }), entry({ id: 'b', teammate: 'quinn' })];
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(['a']);
  });

  test('visible sessions are capped at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry({ id: `s${i}`, teammate: 'zeta' }));
    expect(rankSessions(many, 'zeta', { now: NOW })).toHaveLength(MAX_SESSION_RESULTS);
    expect(rankSessions(many, 'zeta', { now: NOW, limit: 3 })).toHaveLength(3);
  });
});

describe('rankSessions — status and recency bonuses', () => {
  test('the recency ladder pays 25 / 15 / 5 and then nothing', () => {
    expect(sessionBonus(entry({ id: 'a', activityAt: NOW - MINUTE }), NOW)).toBe(25);
    expect(sessionBonus(entry({ id: 'a', activityAt: NOW - 30 * MINUTE }), NOW)).toBe(15);
    expect(sessionBonus(entry({ id: 'a', activityAt: NOW - 5 * HOUR }), NOW)).toBe(5);
    expect(sessionBonus(entry({ id: 'a', activityAt: NOW - 3 * DAY }), NOW)).toBe(0);
    // Unknown activity is not "just now".
    expect(sessionBonus(entry({ id: 'a', activityAt: 0 }), NOW)).toBe(0);
  });

  test('a live session outranks an identical idle one', () => {
    const entries = [
      entry({ id: 'idle', teammate: 'zeta', activityAt: NOW - 3 * DAY }),
      entry({ id: 'live', teammate: 'zeta', activityAt: NOW - 3 * DAY, active: true }),
    ];
    expect(sessionBonus(entries[1]!, NOW)).toBe(ACTIVE_BONUS);
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(['live', 'idle']);
  });

  test('recency breaks a tie between two equal matches in the same window', () => {
    const entries = [
      entry({ id: 'older', teammate: 'zeta', activityAt: NOW - 20 * MINUTE }),
      entry({ id: 'newer', teammate: 'zeta', activityAt: NOW - 10 * MINUTE }),
    ];
    // Same bucket ⇒ same score; the sort's second key decides.
    expect(sessionBonus(entries[0]!, NOW)).toBe(sessionBonus(entries[1]!, NOW));
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(['newer', 'older']);
  });

  test('a bonus can reorder matches but can never admit a non-match', () => {
    const entries = [
      entry({ id: 'stale', teammate: 'zeta', activityAt: NOW - 3 * DAY }),
      entry({ id: 'fresh-miss', teammate: 'quinn', activityAt: NOW - MINUTE, active: true }),
    ];
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(['stale']);
  });
});

describe('rankSessions — stable order', () => {
  test('sessions the query cannot tell apart keep their input order', () => {
    const entries = [
      entry({ id: 'first', teammate: 'zeta', activityAt: NOW - MINUTE }),
      entry({ id: 'second', teammate: 'zeta', activityAt: NOW - MINUTE }),
      entry({ id: 'third', teammate: 'zeta', activityAt: NOW - MINUTE }),
    ];
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(['first', 'second', 'third']);
    // …and re-ranking the same input is byte-identical, so a re-render cannot
    // shuffle the rows out from under an arrow key.
    expect(ids(rankSessions(entries, 'zeta', { now: NOW }))).toEqual(ids(rankSessions(entries, 'zeta', { now: NOW })));
  });
});

describe('recentSessions — the empty-query default', () => {
  test('newest life-sign first, capped at six', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ id: `s${i}`, activityAt: NOW - i * MINUTE }));
    const recent = recentSessions(entries);
    expect(recent).toHaveLength(RECENT_SESSION_COUNT);
    expect(ids(recent)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
  });

  test('live sessions come first; finished ones only top the list up', () => {
    const entries = [
      entry({ id: 'done-recent', activityAt: NOW - MINUTE, finished: true }),
      entry({ id: 'live-old', activityAt: NOW - 3 * DAY }),
    ];
    expect(ids(recentSessions(entries))).toEqual(['live-old', 'done-recent']);
  });

  test('a fleet where everything has finished still offers somewhere to go', () => {
    const entries = Array.from({ length: 3 }, (_, i) =>
      entry({ id: `s${i}`, activityAt: NOW - i * MINUTE, finished: true }),
    );
    expect(ids(recentSessions(entries))).toEqual(['s0', 's1', 's2']);
  });

  test('sessions with no known activity sort last but are not dropped', () => {
    const entries = [entry({ id: 'unknown', activityAt: 0 }), entry({ id: 'known', activityAt: NOW - DAY })];
    expect(ids(recentSessions(entries))).toEqual(['known', 'unknown']);
  });
});

describe('the casing contract — raw lowercase matching, Title Case display', () => {
  test('entries carry the RAW callsign and still answer to either casing', () => {
    const meghan = entry({ id: 'a', teammate: 'meghan' });
    const maryJane = entry({ id: 'b', teammate: 'mary-jane' });

    // What the palette RENDERS is not what it matches on.
    expect(displayCallsign(meghan.teammate)).toBe('Meghan');
    expect(displayCallsign(maryJane.teammate)).toBe('Mary-Jane');
    expect(meghan.teammate).toBe('meghan');

    for (const query of ['meg', 'Meg', 'MEGHAN', 'Meghan']) {
      expect(ids(rankSessions([meghan, maryJane], query, { now: NOW }))).toEqual(['a']);
    }
    for (const query of ['jane', 'Mary-Jane', 'MARY']) {
      expect(ids(rankSessions([meghan, maryJane], query, { now: NOW }))).toEqual(['b']);
    }
  });

  test('scoring the Title Case form would be the same score — so display casing is free', () => {
    expect(fieldScore('meghan', 'meg')).toBe(fieldScore(displayCallsign('meghan'), 'Meg'));
  });
});
