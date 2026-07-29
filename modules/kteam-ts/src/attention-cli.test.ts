import { describe, expect, test } from 'bun:test';
import {
  attentionCliRequest,
  parseAttentionCli,
  renderAttentionCli,
  renderAttentionHistory,
  renderAttentionList,
} from './attention-cli';
import { AttentionError, type AttentionSnapshot, type ResolvedAttentionItem } from './attention-types';

const SID = 'ms3g6a8p-71542ce1';

describe('parseAttentionCli', () => {
  test('bare text is the exact self-session agent request path', () => {
    expect(parseAttentionCli(['Need', 'the', 'release', 'window'])).toEqual({
      command: 'add',
      subject: 'Need the release window',
      why: 'Need the release window',
      howToResolve: 'Respond in this session, then mark this attention item done.',
    });
  });

  test('explicit add accepts context/why/how and session flags', () => {
    expect(
      parseAttentionCli([
        'add',
        'Pick region',
        '--context',
        'This deploy is the nitroso release; region was never decided.',
        '--why',
        'deploy blocked',
        '--resolve',
        'say eu or us',
        '--session',
        SID,
      ]),
    ).toEqual({
      command: 'add',
      subject: 'Pick region',
      why: 'deploy blocked',
      context: 'This deploy is the nitroso release; region was never decided.',
      howToResolve: 'say eu or us',
      session: SID,
    });
  });

  test('usage teaches the stranger-reader contract', () => {
    expect(() => parseAttentionCli([])).toThrow(/NOT been following/);
    expect(() => parseAttentionCli([])).toThrow(/EXPAND every codename/);
  });

  test('ls, history and done parse', () => {
    expect(parseAttentionCli(['ls'])).toEqual({ command: 'ls' });
    expect(parseAttentionCli(['history'])).toEqual({ command: 'history' });
    expect(parseAttentionCli(['done', '?A3', '--note', 'answered'])).toEqual({
      command: 'done',
      id: 'A3',
      note: 'answered',
    });
  });

  test('empty and incomplete done are refused', () => {
    expect(() => parseAttentionCli([])).toThrow(AttentionError);
    expect(() => parseAttentionCli(['done'])).toThrow(/attention reference/);
    expect(() => parseAttentionCli(['done', 'A01'])).toThrow(/attention reference/);
    expect(() => parseAttentionCli(['ls', '--session'])).toThrow(/session id/);
  });
});

describe('attentionCliRequest', () => {
  test('defaults to KTEAM_SESSION_ID and builds add/resolve requests', () => {
    const add = parseAttentionCli(['Need approval']);
    expect(attentionCliRequest(add, SID)).toMatchObject({
      method: 'POST',
      path: `/v1/sessions/${SID}/attention`,
      body: { action: 'add', source: 'agent-raised', subject: 'Need approval' },
    });
    const withContext = parseAttentionCli(['Need approval', '--context', 'Background for the reader.']);
    expect(attentionCliRequest(withContext, SID).body).toMatchObject({ context: 'Background for the reader.' });
    expect(attentionCliRequest({ command: 'done', id: 'A1', note: 'done' }, SID)).toEqual({
      method: 'POST',
      path: `/v1/sessions/${SID}/attention`,
      body: { action: 'resolve', id: 'A1', note: 'done' },
    });
  });

  test('explicit session overrides self and no target throws', () => {
    expect(attentionCliRequest({ command: 'ls', session: 'other' }, SID).path).toBe('/v1/sessions/other/attention');
    expect(() => attentionCliRequest({ command: 'ls' }, undefined)).toThrow(/no session id/);
  });
});

const snapshot = (): AttentionSnapshot => ({
  v: 1,
  sessionId: SID,
  items: [
    {
      id: 'A3',
      source: 'question',
      sourceRef: 'q1',
      subject: 'Choose release?',
      why: 'The session is waiting.',
      waitingSince: '2026-07-28T00:00:00.000Z',
      howToResolve: 'Answer it.',
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
    },
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-07-28T00:00:00.000Z',
});

describe('rendering', () => {
  test('list says oldest first and includes source/provenance', () => {
    const output = renderAttentionList(snapshot());
    expect(output).toContain('oldest first');
    expect(output).toContain('[question]');
    expect(output).toContain('raised by daemon');
    expect(output).toContain('?A3');
  });

  test('list shows context when an item carries it', () => {
    const base = snapshot();
    base.items[0] = { ...base.items[0]!, context: 'Background for the stranger-reader.' };
    expect(renderAttentionList(base)).toContain('context: Background for the stranger-reader.');
    expect(renderAttentionList(snapshot())).not.toContain('context:');
  });

  test('history exposes the resolver, including an agent', () => {
    const base = snapshot().items[0]!;
    const resolved: ResolvedAttentionItem = {
      ...base,
      resolvedAt: '2026-07-28T01:00:00.000Z',
      resolvedBy: 'agent',
      resolvedBySession: SID,
      resolvedByName: 'zoe',
      resolutionNote: 'answered',
    };
    expect(renderAttentionHistory({ ...snapshot(), items: [], resolved: [resolved], count: 0 })).toContain('agent zoe');
  });

  test('parse errors are explicit and mutation confirmations keep count', () => {
    expect(renderAttentionList({ ...snapshot(), parseErrors: 1 })).toContain('before trusting');
    const addResponse = snapshot();
    addResponse.items[0] = { ...addResponse.items[0]!, source: 'agent-raised' };
    const recorded = renderAttentionCli(parseAttentionCli(['Choose release?']), addResponse);
    expect(recorded).toContain('?A3');
    expect(recorded).toContain('1 unresolved');
    expect(renderAttentionCli({ command: 'done', id: 'A1' }, { ...snapshot(), items: [], count: 0 })).toContain(
      '0 unresolved',
    );
  });
});
