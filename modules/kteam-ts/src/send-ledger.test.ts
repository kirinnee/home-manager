import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  advanceSendTimeout,
  matchObservedHumanInputs,
  newAcceptedSend,
  normalizeSendText,
  SendLedger,
  shiftFrozenSendTimeout,
  type ObservedHumanInput,
  type SendRecord,
} from './send-ledger';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-ledger-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function accepted(
  sendId: string,
  message: string,
  acceptedAt = '2026-07-27T02:00:32.000Z',
  overrides: Partial<SendRecord> = {},
): SendRecord {
  return newAcceptedSend({
    sendId,
    acceptedAt,
    acceptedTurn: 7,
    path: 'native-inline',
    message,
    matchText: message,
    attachmentIds: [],
    ...overrides,
  });
}

function observed(proofKey: string, text: string, observedAt = '2026-07-27T02:00:36.000Z'): ObservedHumanInput {
  return {
    harness: 'claude',
    text,
    proof: 'native-queue-drain',
    observedAt,
    proofKey,
    shapeVersion: 1,
  };
}

describe('append-only send ledger', () => {
  test('rebuilds last snapshot per id and tolerates a corrupt tail', async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'channel', 'sends.jsonl');
    const ledger = await SendLedger.open(file);
    const first = accepted('q1', 'hello');
    await ledger.accept(first);
    const matches = matchObservedHumanInputs([first], [observed('proof-1', 'hello')]);
    expect(matches).toHaveLength(1);
    await ledger.deliver(matches[0]!, 7, '2026-07-27T02:00:37.000Z');
    await ledger.accept(accepted('q2', 'not injected'));
    await ledger.withdraw('q2', '2026-07-27T02:00:38.000Z');
    await appendFile(file, '{"partial":');

    const rebuilt = await SendLedger.open(file);
    expect(rebuilt.get('q1')).toMatchObject({ fate: 'delivered', evidence: { key: 'proof-1' } });
    expect(rebuilt.all()).toHaveLength(1);
    expect(rebuilt.all({ includeWithdrawn: true })).toHaveLength(2);
    expect(rebuilt.usedEvidenceKeys()).toEqual(new Set(['proof-1']));

    // Recovery must also make the file appendable again. Without a separator,
    // this snapshot would concatenate onto `{"partial":` and disappear on the
    // following restart.
    await rebuilt.accept(accepted('q3', 'accepted after corrupt tail'));
    const rebuiltAgain = await SendLedger.open(file);
    expect(rebuiltAgain.get('q3')).toMatchObject({ fate: 'accepted', message: 'accepted after corrupt tail' });
  });

  test('a replayed proof key is idempotent across restart', async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'sends.jsonl');
    const ledger = await SendLedger.open(file);
    const record = accepted('q1', 'same');
    await ledger.accept(record);
    const [match] = matchObservedHumanInputs([record], [observed('stable-proof', 'same')]);
    await ledger.deliver(match!, 7, '2026-07-27T02:00:37.000Z');

    const rebuilt = await SendLedger.open(file);
    const second = accepted('q2', 'same', '2026-07-27T02:00:33.000Z');
    await rebuilt.accept(second);
    expect(
      matchObservedHumanInputs(rebuilt.all(), [observed('stable-proof', 'same')], rebuilt.usedEvidenceKeys()),
    ).toEqual([]);
  });

  test('same-id retry resurrects a withdrawn tombstone but non-withdrawn acceptance is idempotent', async () => {
    const directory = await temporaryDirectory();
    const ledger = await SendLedger.open(path.join(directory, 'sends.jsonl'));
    const first = accepted('stable-request', 'first attempt');
    expect(await ledger.accept(first)).toMatchObject({ created: true });
    expect(await ledger.accept(accepted('stable-request', 'must not replace'))).toMatchObject({
      created: false,
      record: { message: 'first attempt' },
    });
    await ledger.withdraw('stable-request', '2026-07-27T02:00:40.000Z');

    const retry = accepted('stable-request', 'retry attempt', '2026-07-27T02:01:00.000Z');
    expect(await ledger.accept(retry)).toMatchObject({
      created: true,
      record: {
        fate: 'accepted',
        acceptedAt: '2026-07-27T02:01:00.000Z',
        message: 'retry attempt',
      },
    });
    expect(ledger.get('stable-request')?.withdrawn).toBeUndefined();
    expect(ledger.all({ includeWithdrawn: true })).toHaveLength(1);
  });

  test('late in-window proof promotes unaccounted to delivered', async () => {
    const directory = await temporaryDirectory();
    const ledger = await SendLedger.open(path.join(directory, 'sends.jsonl'));
    const record = accepted('q1', 'late proof');
    await ledger.accept(record);
    await ledger.unaccount('q1', 'timeout', '2026-07-27T03:00:33.000Z');
    const current = ledger.get('q1')!;
    const [match] = matchObservedHumanInputs([current], [observed('late-key', 'late proof', '2026-07-27T02:59:59Z')]);
    expect(match?.sendId).toBe('q1');
    await ledger.deliver(match!, 7, '2026-07-27T04:00:00.000Z');
    expect(ledger.get('q1')).toMatchObject({ fate: 'delivered', evidence: { observedAt: '2026-07-27T02:59:59Z' } });
  });
});

describe('strict evidence matching', () => {
  test('normalizes NFC and whitespace but remains case-sensitive and whole-string exact', () => {
    expect(normalizeSendText('  Cafe\u0301\n\trequest  ')).toBe('Café request');
    const record = accepted('q1', 'Café request');
    expect(matchObservedHumanInputs([record], [observed('p1', 'Cafe\u0301   request')])).toHaveLength(1);
    expect(matchObservedHumanInputs([record], [observed('p2', 'café request')])).toEqual([]);
    expect(matchObservedHumanInputs([record], [observed('p3', 'prefix Café request suffix')])).toEqual([]);
  });

  test('rejects the exact e0801fc1 quoted-peer false delivery', () => {
    const record = accepted('e0801fc1-034a-45c4-aa7d-eb5b2694c0f0', 'mission control -- rework it please!');
    const quote = observed(
      'quoted-peer',
      "carol found the old text ('mission control -- rework it please!') inside the matcher",
      '2026-07-28T00:13:29.185Z',
    );
    expect(matchObservedHumanInputs([record], [quote])).toEqual([]);
    // Equality alone is independently sufficient to reject it inside the window.
    expect(matchObservedHumanInputs([record], [{ ...quote, observedAt: '2026-07-27T02:00:36.000Z' }])).toEqual([]);
    // The upper time bound independently rejects an otherwise exact observation.
    expect(
      matchObservedHumanInputs(
        [record],
        [{ ...quote, text: record.matchText!, observedAt: '2026-07-27T03:00:32.001Z' }],
      ),
    ).toEqual([]);
  });

  test('does not cross-match prefix collisions and assigns identical sends FIFO one-to-one', () => {
    const shared = 'x'.repeat(200);
    const first = accepted('q1', `${shared}-first`, '2026-07-27T02:00:30.000Z');
    const second = accepted('q2', `${shared}-second`, '2026-07-27T02:00:31.000Z');
    expect(matchObservedHumanInputs([first, second], [observed('p1', second.matchText!)])).toEqual([
      expect.objectContaining({ sendId: 'q2' }),
    ]);

    const identicalFirst = accepted('q3', 'identical', '2026-07-27T02:00:30.000Z');
    const identicalSecond = accepted('q4', 'identical', '2026-07-27T02:00:31.000Z');
    expect(matchObservedHumanInputs([identicalSecond, identicalFirst], [observed('p2', 'identical')])).toEqual([
      expect.objectContaining({ sendId: 'q3' }),
    ]);
    expect(
      matchObservedHumanInputs(
        [identicalSecond, identicalFirst],
        [observed('p2', 'identical'), observed('p3', 'identical', '2026-07-27T02:00:37.000Z')],
      ).map(match => match.sendId),
    ).toEqual(['q3', 'q4']);
  });

  test('enforces the -30 second and +60 minute timestamp bounds', () => {
    const record = accepted('q1', 'window');
    expect(matchObservedHumanInputs([record], [observed('p1', 'window', '2026-07-27T02:00:02.000Z')])).toHaveLength(1);
    expect(matchObservedHumanInputs([record], [observed('p2', 'window', '2026-07-27T02:00:01.999Z')])).toEqual([]);
    expect(matchObservedHumanInputs([record], [observed('p3', 'window', '2026-07-27T03:00:32.000Z')])).toHaveLength(1);
    expect(matchObservedHumanInputs([record], [observed('p4', 'window', '2026-07-27T03:00:32.001Z')])).toEqual([]);
  });

  test('labels an exact native-file instruction with its UUID tier', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const instruction = `Read the queued message file at /tmp/channel/queued-${id}.md completely now, then follow every instruction inside it.`;
    const record = accepted(id, 'large payload', undefined, {
      path: 'native-file',
      matchText: instruction,
      payloadFile: `/tmp/channel/queued-${id}.md`,
    });
    expect(matchObservedHumanInputs([record], [observed('p1', instruction)])[0]?.tier).toBe('queue-file-id');
  });
});

describe('timeout bookkeeping', () => {
  test('uses opportunity-gated 60m timeout, 4h hard cap, and held exemption', () => {
    const record = accepted('q1', 'wait', '2026-07-27T00:00:00.000Z');
    expect(
      advanceSendTimeout(record, { now: '2026-07-27T03:00:00.000Z', opportunity: false, frozen: false }).fate,
    ).toBe('accepted');
    expect(
      advanceSendTimeout(record, { now: '2026-07-27T01:00:00.001Z', opportunity: true, frozen: false }),
    ).toMatchObject({ fate: 'unaccounted', unaccountedReason: 'timeout', opportunityAt: '2026-07-27T01:00:00.001Z' });
    expect(
      advanceSendTimeout(record, { now: '2026-07-27T04:00:00.000Z', opportunity: false, frozen: false }).fate,
    ).toBe('unaccounted');
    const held = { ...record, held: true };
    expect(advanceSendTimeout(held, { now: '2026-07-28T00:00:00.000Z', opportunity: true, frozen: false })).toBe(held);
  });

  test('freezes deadlines while the harness provably cannot consume without rewriting acceptedAt', () => {
    const record = accepted('q1', 'quota', '2026-07-27T00:00:00.000Z');
    const frozen = advanceSendTimeout(record, {
      now: '2026-07-27T00:30:00.000Z',
      opportunity: false,
      frozen: true,
    });
    const resumed = advanceSendTimeout(frozen, {
      now: '2026-07-27T02:30:00.000Z',
      opportunity: false,
      frozen: false,
    });
    expect(resumed).toMatchObject({
      acceptedAt: record.acceptedAt,
      fate: 'accepted',
      unaccountedDeadline: '2026-07-27T03:00:00.000Z',
      hardDeadline: '2026-07-27T04:00:00.000Z',
    });
    expect(resumed.timeoutFrozenAt).toBeUndefined();
    expect(
      matchObservedHumanInputs([resumed], [observed('post-freeze-proof', 'quota', '2026-07-27T02:30:01.000Z')]),
    ).toHaveLength(1);
    expect(
      advanceSendTimeout(resumed, { now: '2026-07-27T03:00:00.000Z', opportunity: true, frozen: false }).fate,
    ).toBe('unaccounted');

    const terminalWhileFrozen = {
      ...frozen,
      fate: 'unaccounted' as const,
      fateAt: '2026-07-27T00:45:00.000Z',
      unaccountedReason: 'session_ended' as const,
    };
    expect(
      advanceSendTimeout(terminalWhileFrozen, {
        now: '2026-07-27T02:30:00.000Z',
        opportunity: false,
        frozen: false,
      }),
    ).toMatchObject({
      fate: 'unaccounted',
      unaccountedDeadline: '2026-07-27T03:00:00.000Z',
      hardDeadline: '2026-07-27T04:00:00.000Z',
    });

    // A long freeze may extend the evidence window beyond the absolute fate
    // cap. Reconciliation runs first: a valid first post-resume proof still
    // wins through the shifted +60m boundary. With no proof, the first thawed
    // sweep immediately applies the fixed 4h cap. Also repair snapshots written
    // by the earlier implementation with an already-shifted hardDeadline.
    const longFrozen = { ...frozen, hardDeadline: '2026-07-27T12:00:00.000Z' };
    const thawedForProof = shiftFrozenSendTimeout(longFrozen, '2026-07-27T10:30:00.000Z');
    expect(thawedForProof).toMatchObject({
      fate: 'accepted',
      unaccountedDeadline: '2026-07-27T11:00:00.000Z',
      hardDeadline: '2026-07-27T04:00:00.000Z',
    });
    expect(
      matchObservedHumanInputs([thawedForProof], [observed('long-freeze-proof', 'quota', '2026-07-27T10:30:01.000Z')]),
    ).toHaveLength(1);
    expect(
      advanceSendTimeout(longFrozen, {
        now: '2026-07-27T10:30:00.000Z',
        opportunity: false,
        frozen: false,
      }),
    ).toMatchObject({
      fate: 'unaccounted',
      unaccountedReason: 'timeout',
      unaccountedDeadline: '2026-07-27T11:00:00.000Z',
      hardDeadline: '2026-07-27T04:00:00.000Z',
    });
  });
});
