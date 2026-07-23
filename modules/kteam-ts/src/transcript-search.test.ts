import { expect, test } from 'bun:test';
import { searchRecords } from './transcript-search';

const recs = [
  { type: 'turn.started', turn: 1 },
  { type: 'chat.user', timestamp: 't1', data: { text: 'please fix the login bug in auth.ts' } },
  { type: 'chat.assistant.text', timestamp: 't2', data: { text: 'Looking at the AUTH module now.' } },
  { type: 'turn.started', turn: 2 },
  { type: 'chat.assistant.thinking', timestamp: 't3', data: { thinking: 'the Auth token is stale' } },
  { type: 'tool.use', timestamp: 't4', data: { name: 'Bash', input: { command: 'grep auth' } } },
];

test('case-insensitive match with snippet + turn', () => {
  const out = searchRecords(recs, 'auth');
  expect(out.length).toBe(3); // user + assistant + thinking (tool.use has no text field)
  expect(out[0]!.snippet).toContain('auth.ts');
  expect(out[0]!.turn).toBe(1);
  expect(out[2]!.turn).toBe(2); // thinking is in turn 2
  expect(out[2]!.at).toBe('t3');
});

test('empty query returns nothing', () => {
  expect(searchRecords(recs, '   ')).toEqual([]);
});

test('no match returns nothing', () => {
  expect(searchRecords(recs, 'zzzzz')).toEqual([]);
});

test('perSession cap is honoured', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    type: 'chat.assistant.text',
    timestamp: `t${i}`,
    data: { text: 'match match match' },
  }));
  expect(searchRecords(many, 'match', 3).length).toBe(3);
});

test('snippet adds ellipses when truncated', () => {
  const long = 'x'.repeat(200) + ' needle ' + 'y'.repeat(200);
  const out = searchRecords([{ type: 'chat.user', data: { text: long } }], 'needle');
  expect(out[0]!.snippet.startsWith('…')).toBe(true);
  expect(out[0]!.snippet.endsWith('…')).toBe(true);
  expect(out[0]!.snippet).toContain('needle');
});
