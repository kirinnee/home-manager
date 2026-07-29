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
  test('bare text is the exact self-session agent request path (open question by default)', () => {
    expect(parseAttentionCli(['Need', 'the', 'release', 'window'])).toEqual({
      command: 'add',
      subject: 'Need the release window',
      why: 'Need the release window',
      howToResolve: 'Answer this item on the attention board (it records who answered).',
      ask: { kind: 'open-question' },
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
      ask: { kind: 'open-question' },
      session: SID,
    });
  });

  test('the four kinds parse: permission, choice with options, review, open', () => {
    expect(parseAttentionCli(['Deploy to prod?', '--kind', 'permission'])).toMatchObject({
      ask: { kind: 'permission' },
    });
    expect(parseAttentionCli(['Which region?', '--kind', 'choice', '--option', 'eu', '--option', 'us'])).toMatchObject({
      ask: { kind: 'multiple-choice', options: [{ label: 'eu' }, { label: 'us' }] },
    });
    // --option alone implies a choice ask.
    expect(parseAttentionCli(['Which region?', '--option', 'eu', '--option', 'us'])).toMatchObject({
      ask: { kind: 'multiple-choice', options: [{ label: 'eu' }, { label: 'us' }] },
    });
    expect(parseAttentionCli(['Review my rollout answer', '--kind', 'review'])).toMatchObject({
      ask: { kind: 'answer-review' },
    });
    expect(parseAttentionCli(['Describe the constraint', '--kind', 'open'])).toMatchObject({
      ask: { kind: 'open-question' },
    });
    expect(() => parseAttentionCli(['Which?', '--kind', 'choice', '--option', 'only-one'])).toThrow(/2\+ distinct/);
    expect(() => parseAttentionCli(['Deploy?', '--kind', 'permission', '--option', 'eu'])).toThrow(/--option/);
    expect(() => parseAttentionCli(['Deploy?', '--kind', 'nonsense'])).toThrow(/unknown --kind/);
  });

  test('done carries a structured answer for each kind', () => {
    expect(parseAttentionCli(['done', '?A3', '--approve'])).toMatchObject({
      command: 'done',
      id: 'A3',
      response: { kind: 'permission', decision: 'approve' },
    });
    // Flag-first order still finds the id.
    expect(parseAttentionCli(['done', '--reject', '?A3'])).toMatchObject({
      id: 'A3',
      response: { kind: 'permission', decision: 'reject' },
    });
    expect(parseAttentionCli(['done', '?A3', '--choice', 'eu'])).toMatchObject({
      response: { kind: 'multiple-choice', choice: 'eu' },
    });
    expect(parseAttentionCli(['done', '?A3', '--good'])).toMatchObject({
      response: { kind: 'answer-review', verdict: 'good' },
    });
    expect(parseAttentionCli(['done', '?A3', '--clarify', 'which env?'])).toMatchObject({
      response: { kind: 'answer-review', verdict: 'clarify', clarification: 'which env?' },
    });
    expect(parseAttentionCli(['done', '?A3', '--answer', 'ship it tonight'])).toMatchObject({
      response: { kind: 'open-question', answer: 'ship it tonight' },
    });
    expect(() => parseAttentionCli(['done', '?A3', '--approve', '--good'])).toThrow(/exactly one answer/);
  });

  test('dismiss and notify parse', () => {
    expect(parseAttentionCli(['dismiss', '?A3', '--note', 'stale'])).toEqual({
      command: 'dismiss',
      id: 'A3',
      note: 'stale',
    });
    expect(() => parseAttentionCli(['dismiss'])).toThrow(/attention reference/);
    expect(parseAttentionCli(['notify', 'Build finished green', '--title', 'CI', '--kind', 'completed'])).toEqual({
      command: 'notify',
      body: 'Build finished green',
      title: 'CI',
      kind: 'completed',
    });
    expect(() => parseAttentionCli(['notify'])).toThrow(/notification text/);
    expect(() => parseAttentionCli(['notify', 'x', '--kind', 'question'])).toThrow(/completed or failed/);
  });

  test('usage teaches the stranger-reader contract', () => {
    expect(() => parseAttentionCli([])).toThrow(/NOT been following/);
    expect(() => parseAttentionCli([])).toThrow(/EXPAND every codename/);
  });

  test('ls, history and done parse', () => {
    expect(parseAttentionCli(['ls'])).toEqual({ command: 'ls' });
    expect(parseAttentionCli(['history'])).toEqual({ command: 'history' });
    expect(parseAttentionCli(['done', '!A3', '--note', 'answered'])).toEqual({
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

  test('answers, dismissals and notifications build their requests', () => {
    expect(
      attentionCliRequest({ command: 'done', id: 'A1', response: { kind: 'permission', decision: 'approve' } }, SID)
        .body,
    ).toMatchObject({ action: 'resolve', id: 'A1', response: { kind: 'permission', decision: 'approve' } });
    expect(attentionCliRequest({ command: 'dismiss', id: 'A2', note: 'stale' }, SID)).toEqual({
      method: 'POST',
      path: `/v1/sessions/${SID}/attention`,
      body: { action: 'dismiss', id: 'A2', note: 'stale' },
    });
    expect(attentionCliRequest({ command: 'notify', body: 'done', title: 'CI', kind: 'failed' }, SID)).toEqual({
      method: 'POST',
      path: `/v1/sessions/${SID}/notify`,
      body: { body: 'done', title: 'CI', kind: 'failed' },
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
    expect(output).toContain('!A3');
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
    expect(recorded).toContain('!A3');
    expect(recorded).toContain('1 unresolved');
    expect(renderAttentionCli({ command: 'done', id: 'A1' }, { ...snapshot(), items: [], count: 0 })).toContain(
      '0 unresolved',
    );
  });

  test('list names each kind by what the human does', () => {
    const base = snapshot();
    base.items[0] = { ...base.items[0]!, ask: { kind: 'permission' } };
    expect(renderAttentionList(base)).toContain('approve or reject');
    base.items[0] = {
      ...base.items[0]!,
      ask: { kind: 'multiple-choice', options: [{ label: 'eu' }, { label: 'us' }] },
    };
    expect(renderAttentionList(base)).toContain('pick one of "eu" | "us"');
    base.items[0] = { ...base.items[0]!, ask: { kind: 'answer-review' } };
    expect(renderAttentionList(base)).toContain('good, or ask to clarify');
    base.items[0] = { ...base.items[0]!, ask: { kind: 'open-question' } };
    expect(renderAttentionList(base)).toContain('write a full answer');
  });

  test('history shows structured answers and dismissals distinctly', () => {
    const base = snapshot().items[0]!;
    const answered: ResolvedAttentionItem = {
      ...base,
      ask: { kind: 'permission' },
      response: { kind: 'permission', decision: 'approve' },
      disposition: 'done',
      resolvedAt: '2026-07-28T01:00:00.000Z',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: null,
    };
    const dismissed: ResolvedAttentionItem = {
      ...base,
      id: 'A4',
      disposition: 'dismissed',
      resolvedAt: '2026-07-28T02:00:00.000Z',
      resolvedBy: 'agent',
      resolvedBySession: SID,
      resolvedByName: 'zoe',
      resolutionNote: 'stale',
    };
    const output = renderAttentionHistory({ ...snapshot(), items: [], resolved: [answered, dismissed], count: 0 });
    expect(output).toContain('approved');
    expect(output).toContain('dismissed by agent zoe');
  });

  test('notify rendering surfaces zero delivered devices honestly', () => {
    expect(renderAttentionCli({ command: 'notify', body: 'x' }, { sessionId: SID, delivered: 0 })).toContain(
      'no registered device',
    );
    expect(renderAttentionCli({ command: 'notify', body: 'x' }, { sessionId: SID, delivered: 2 })).toContain(
      '2 device(s)',
    );
  });
});
