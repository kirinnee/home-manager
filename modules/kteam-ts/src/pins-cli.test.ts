import { describe, expect, test } from 'bun:test';
import { parsePinCli, pinCliRequest, renderPinCli, renderPinList } from './pins-cli';
import { PinError, type PinSnapshot, type Pin } from './pins-types';

const SID = 'ms3g6a8p-71542ce1';

describe('parsePinCli', () => {
  test('bare text is an add', () => {
    expect(parsePinCli(['PR is https://x/pull/1'])).toEqual({ command: 'add', text: 'PR is https://x/pull/1' });
  });
  test('explicit add joins the rest', () => {
    expect(parsePinCli(['add', 'hello', 'world'])).toEqual({ command: 'add', text: 'hello world' });
  });
  test('ls and rm', () => {
    expect(parsePinCli(['ls'])).toEqual({ command: 'ls' });
    expect(parsePinCli(['rm', 'p1'])).toEqual({ command: 'rm', id: 'p1' });
  });
  test('--session targets another session', () => {
    expect(parsePinCli(['ls', '--session', SID])).toEqual({ command: 'ls', session: SID });
    expect(parsePinCli(['--session', SID, 'a note'])).toEqual({ command: 'add', text: 'a note', session: SID });
  });
  test('errors', () => {
    expect(() => parsePinCli([])).toThrow(PinError);
    expect(() => parsePinCli(['rm'])).toThrow(/pin id/);
    expect(() => parsePinCli(['add', '   '])).toThrow(PinError);
  });
});

describe('pinCliRequest', () => {
  test('defaults to self session (KTEAM_SESSION_ID)', () => {
    expect(pinCliRequest({ command: 'ls' }, SID)).toEqual({ method: 'GET', path: `/v1/sessions/${SID}/pins` });
  });
  test('add builds a note action body', () => {
    expect(pinCliRequest({ command: 'add', text: 'hi' }, SID)).toEqual({
      method: 'POST',
      path: `/v1/sessions/${SID}/pins`,
      body: { action: 'add', kind: 'note', text: 'hi' },
    });
  });
  test('rm builds a remove action body', () => {
    expect(pinCliRequest({ command: 'rm', id: 'p1' }, SID)).toEqual({
      method: 'POST',
      path: `/v1/sessions/${SID}/pins`,
      body: { action: 'remove', id: 'p1' },
    });
  });
  test('explicit --session overrides self', () => {
    expect(pinCliRequest({ command: 'ls', session: 'other' }, SID).path).toBe('/v1/sessions/other/pins');
  });
  test('no self and no --session throws', () => {
    expect(() => pinCliRequest({ command: 'ls' }, undefined)).toThrow(/no session id/);
  });
});

describe('rendering', () => {
  const pin = (over: Partial<Pin> = {}): Pin =>
    ({
      id: 'abcd1234ef',
      kind: 'note',
      text: 'a note',
      at: 1,
      by: 'human',
      createdBy: null,
      createdByName: null,
      ...over,
    }) as Pin;
  const snap = (pins: Pin[]): PinSnapshot => ({ v: 1, sessionId: SID, pins, updatedAt: 'now' });

  test('ls shows an agent tag but not a human one', () => {
    const out = renderPinList(
      snap([pin({ by: 'agent', createdBy: 's', createdByName: 'zoe' }), pin({ id: 'human0000' })]),
    );
    expect(out).toContain('[agent zoe]');
    expect(out).toContain('abcd1234'); // id prefix
  });
  test('empty list', () => {
    expect(renderPinList(snap([]))).toBe('No pins.\n');
  });
  test('add / rm confirmations', () => {
    expect(renderPinCli({ command: 'add', text: 'hi' }, snap([pin()]))).toContain('pinned');
    expect(renderPinCli({ command: 'rm', id: 'p1' }, snap([]))).toContain('removed p1');
  });
});
