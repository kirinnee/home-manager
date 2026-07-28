import { describe, expect, test } from 'bun:test';
import type { KTeamEvent, SendRecord } from '../types';
import {
  foldSendRecords,
  isSendLedgerEvent,
  parseSendRecord,
  parseSendsResponse,
  reconcileLocalSends,
  selectLedgerChips,
  sendBadge,
  visibleUserRows,
  type LocalSend,
} from './sends';

const ACCEPTED_AT = '2026-07-27T02:00:32.112Z';
const AT = Date.parse(ACCEPTED_AT);
const ATT_A = `att_${'a'.repeat(64)}`;
const ATT_B = `att_${'b'.repeat(64)}`;

function row(over: Partial<SendRecord> = {}): SendRecord {
  return {
    sendId: 'send-1',
    acceptedAt: ACCEPTED_AT,
    message: 'mission control -- rework it please!',
    attachmentIds: [],
    fate: 'accepted',
    ...over,
  };
}

function local(over: Partial<LocalSend> = {}): LocalSend {
  return {
    key: 'k1',
    requestId: 'req-1',
    text: 'mission control -- rework it please!',
    attachmentIds: [],
    at: AT,
    ...over,
  };
}

describe('parsing is defensive about daemon skew', () => {
  test('a row with no usable identity is dropped, not half-kept', () => {
    expect(parseSendRecord({ acceptedAt: ACCEPTED_AT, fate: 'accepted' })).toBeNull();
    expect(parseSendRecord({ sendId: 'x', fate: 'accepted' })).toBeNull();
    expect(parseSendRecord(null)).toBeNull();
    expect(parseSendRecord([])).toBeNull();
  });

  test('AN UNKNOWN FATE READS AS ACCEPTED, NEVER AS DELIVERED', () => {
    // The load-bearing invariant. A daemon newer than this bundle may report a
    // state this build has never heard of; reading it as delivered would assert
    // that an unverified message reached the agent.
    expect(parseSendRecord({ sendId: 's', acceptedAt: ACCEPTED_AT, fate: 'teleported' })?.fate).toBe('accepted');
    expect(parseSendRecord({ sendId: 's', acceptedAt: ACCEPTED_AT })?.fate).toBe('accepted');
    expect(parseSendRecord({ sendId: 's', acceptedAt: ACCEPTED_AT, fate: 42 })?.fate).toBe('accepted');
  });

  test('unknown enums are omitted rather than trusted or fatal', () => {
    const parsed = parseSendRecord({
      sendId: 's',
      acceptedAt: ACCEPTED_AT,
      fate: 'delivered',
      path: 'carrier-pigeon',
      unaccountedReason: 'vibes',
      evidence: { key: 'uuid-1', tier: 'psychic', kind: 'chat.user', harness: 'claude' },
    });
    expect(parsed?.path).toBeUndefined();
    expect(parsed?.unaccountedReason).toBeUndefined();
    // The citation survives with its usable parts; one unknown enum must not
    // discard the whole record.
    expect(parsed?.evidence?.key).toBe('uuid-1');
    expect(parsed?.evidence?.tier).toBeUndefined();
    expect(parsed?.evidence?.kind).toBe('chat.user');
    expect(parsed?.evidence?.harness).toBe('claude');
  });

  test('evidence with no key is dropped (an uncitable citation cannot be deduped)', () => {
    const parsed = parseSendRecord({
      sendId: 's',
      acceptedAt: ACCEPTED_AT,
      fate: 'delivered',
      evidence: { tier: 'exact-text' },
    });
    expect(parsed?.evidence).toBeUndefined();
    expect(parsed?.fate).toBe('delivered');
  });

  test('attachment ids are validated, so a malformed id cannot poison the join', () => {
    expect(
      parseSendRecord({ sendId: 's', acceptedAt: ACCEPTED_AT, fate: 'accepted', attachmentIds: [ATT_A, 'nope', 7] })
        ?.attachmentIds,
    ).toEqual([ATT_A]);
  });

  test('one bad row does not blank the ledger, and a bare array is tolerated', () => {
    expect(parseSendsResponse({ sends: [row(), null, { junk: true }, row({ sendId: 'send-2' })] })).toHaveLength(2);
    expect(parseSendsResponse([row()])).toHaveLength(1);
    expect(parseSendsResponse({})).toEqual([]);
    expect(parseSendsResponse(undefined)).toEqual([]);
  });
});

describe('fold: last snapshot per sendId wins', () => {
  test('a later snapshot supersedes the earlier one, which is how promotion works', () => {
    const folded = foldSendRecords(
      [row({ fate: 'unaccounted', unaccountedReason: 'timeout' })],
      [row({ fate: 'delivered' })],
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]?.fate).toBe('delivered');
  });

  test('a withdrawn tombstone removes the row entirely', () => {
    // The caller was told synchronously and still holds the message, so the
    // durable row must retract and leave the local retry affordance in charge.
    expect(foldSendRecords([row()], [row({ withdrawn: true })])).toEqual([]);
  });

  test('newest-first ordering', () => {
    const folded = foldSendRecords([
      row({ sendId: 'old', acceptedAt: '2026-07-27T01:00:00.000Z' }),
      row({ sendId: 'new', acceptedAt: '2026-07-27T03:00:00.000Z' }),
    ]);
    expect(folded.map(r => r.sendId)).toEqual(['new', 'old']);
  });
});

describe('live ledger events trigger a refresh', () => {
  const ev = (type: string): KTeamEvent =>
    ({ sequence: 1, time: ACCEPTED_AT, sessionId: 's', type, source: 'daemon', data: {} }) as KTeamEvent;

  test('the four ledger transitions are recognised', () => {
    for (const type of [
      'control.send_accepted',
      'control.send_delivered',
      'control.send_unaccounted',
      'control.send_withdrawn',
    ])
      expect(isSendLedgerEvent(ev(type))).toBe(true);
  });

  test('the legacy compat emissions are NOT ledger signals', () => {
    // They still feed the transcript replacement index. Treating them as ledger
    // signals would create a second, disagreeing source of fate.
    for (const type of ['control.send', 'control.send_queued', 'control.send_consumed', 'chat.user'])
      expect(isSendLedgerEvent(ev(type))).toBe(false);
  });
});

describe('local ↔ durable join, one-to-one', () => {
  test('an exact request-id match wins outright', () => {
    const result = reconcileLocalSends([local()], [row({ sendId: 'req-1', message: 'totally different text' })]);
    expect(result.claimed.get('k1')?.sendId).toBe('req-1');
    expect(result.unclaimedLocal).toEqual([]);
    expect(result.durable).toEqual([]);
  });

  test('content + attachments + forward window is the fallback', () => {
    const result = reconcileLocalSends([local({ attachmentIds: [ATT_A] })], [row({ attachmentIds: [ATT_A] })]);
    expect(result.claimed.size).toBe(1);
  });

  test('a mismatched attachment set never joins', () => {
    const result = reconcileLocalSends([local({ attachmentIds: [ATT_A] })], [row({ attachmentIds: [ATT_B] })]);
    expect(result.claimed.size).toBe(0);
    expect(result.unclaimedLocal).toHaveLength(1);
    expect(result.durable).toHaveLength(1);
  });

  test('AN OLDER DURABLE ROW CANNOT CLAIM A NEWER SEND', () => {
    // Re-sending "continue" for the fifth time must join to the fifth durable
    // row, not to the first. The forward-only window is what enforces that.
    const older = row({ sendId: 'old', acceptedAt: new Date(AT - 60_000).toISOString() });
    const result = reconcileLocalSends([local()], [older]);
    expect(result.claimed.size).toBe(0);
    expect(result.durable.map(r => r.sendId)).toEqual(['old']);
  });

  test('clock slack absorbs a daemon clock slightly behind the browser', () => {
    const slightlyBehind = row({ acceptedAt: new Date(AT - 3_000).toISOString() });
    expect(reconcileLocalSends([local()], [slightlyBehind]).claimed.size).toBe(1);
    const tooFarBehind = row({ acceptedAt: new Date(AT - 30_000).toISOString() });
    expect(reconcileLocalSends([local()], [tooFarBehind]).claimed.size).toBe(0);
  });

  test('identical texts pair off one-to-one, never all onto one row', () => {
    const locals = [
      local({ key: 'k1', requestId: 'r1', at: AT }),
      local({ key: 'k2', requestId: 'r2', at: AT + 1_000 }),
    ];
    const durable = [
      row({ sendId: 'd1', acceptedAt: new Date(AT + 100).toISOString() }),
      row({ sendId: 'd2', acceptedAt: new Date(AT + 1_100).toISOString() }),
    ];
    const result = reconcileLocalSends(locals, durable);
    expect(result.claimed.get('k1')?.sendId).toBe('d1');
    expect(result.claimed.get('k2')?.sendId).toBe('d2');
    expect(result.durable).toEqual([]);
  });

  test('two identical locals and ONE durable row leaves one local unclaimed', () => {
    const locals = [local({ key: 'k1', requestId: 'r1' }), local({ key: 'k2', requestId: 'r2' })];
    const result = reconcileLocalSends(locals, [row()]);
    expect(result.claimed.size).toBe(1);
    expect(result.unclaimedLocal).toHaveLength(1);
  });

  test('EQUALITY, NOT PREFIX — the false-DELIVERED regression', () => {
    // The corpus bug: an 80-char whitespace-stripped `includes()` let a longer
    // message that merely CONTAINED a pending send stand in as its proof. Two
    // drafts where one is a prefix of the other are different messages.
    const short = local({ text: 'ship the change' });
    const longer = row({ message: 'ship the change and then also refactor the adapter boundary' });
    expect(reconcileLocalSends([short], [longer]).claimed.size).toBe(0);

    // And the quoting case, which is what actually fired in production.
    const quoted = row({ message: `carol asked about ('mission control -- rework it please!') earlier` });
    expect(reconcileLocalSends([local()], [quoted]).claimed.size).toBe(0);
  });

  test('soft-wrap whitespace differences still join; case differences do not', () => {
    expect(reconcileLocalSends([local({ text: 'a  b\n c' })], [row({ message: 'a b c' })]).claimed.size).toBe(1);
    expect(reconcileLocalSends([local({ text: 'OK' })], [row({ message: 'ok' })]).claimed.size).toBe(0);
  });

  test('THE HANDOVER IS NON-DESTRUCTIVE: a retracted durable row un-claims its local row', () => {
    // This is why the page must not DELETE pending rows. The generic content-based
    // reaper did, and `unclaimedLocal` can only re-render a row that still exists — so
    // a wrongly reaped send was gone for good, retry affordance included.
    //
    // Sequence: send accepted durably ⇒ the local row is claimed and hidden. Injection
    // then fails synchronously, the daemon tombstones it, the fold drops the durable
    // row — and because the local row was only HIDDEN, it comes back on its own with
    // its "failed to send" chip intact.
    const localRow = local({ key: 'k1', requestId: 'req-1' });
    const accepted = foldSendRecords([row({ sendId: 'req-1', fate: 'accepted' })]);
    const whileAccepted = reconcileLocalSends([localRow], accepted);
    expect(whileAccepted.claimed.get('k1')?.sendId).toBe('req-1');
    expect(whileAccepted.unclaimedLocal).toEqual([]);

    const afterTombstone = foldSendRecords(accepted, [row({ sendId: 'req-1', withdrawn: true })]);
    expect(afterTombstone).toEqual([]);
    const whileWithdrawn = reconcileLocalSends([localRow], afterTombstone);
    expect(whileWithdrawn.claimed.size).toBe(0);
    expect(whileWithdrawn.unclaimedLocal.map(r => r.key)).toEqual(['k1']);
  });

  test('a QUOTING or repeated durable row cannot claim a local row it is not', () => {
    // The local join is allowed to use content, but only as a fallback BEHIND exact
    // requestId identity, and never loosely: a durable row whose message merely
    // contains the local text is not that send.
    const quoting = row({ sendId: 'other', message: `re: ("mission control -- rework it please!") noted` });
    expect(reconcileLocalSends([local()], [quoting]).claimed.size).toBe(0);
    expect(reconcileLocalSends([local()], [quoting]).unclaimedLocal).toHaveLength(1);
  });

  test('durable rows with no local twin are returned to be rendered', () => {
    // This is what survives a refresh: another client sent it, or this browser
    // reloaded and lost its optimistic state entirely.
    const result = reconcileLocalSends([], [row({ sendId: 'from-elsewhere' })]);
    expect(result.durable.map(r => r.sendId)).toEqual(['from-elsewhere']);
  });
});

describe('which durable rows get a chip — RETIREMENT REQUIRES EXACT PROOF IDENTITY', () => {
  // Larita's blocker: retirement used to be decided by normalized text +
  // attachments + peer + time. That is resemblance, not identity — two sends of the
  // same text are indistinguishable by text, and so is a later message that quotes
  // an earlier one. Under pagination that loses messages: the real proof row can sit
  // outside the loaded 200-record page while a LATER identical row is on screen, so
  // the chip was retired against the wrong row and the delivered send showed neither
  // its own row nor a badge.
  //
  // A row now retires a delivered chip ONLY when `row.proofKeys` contains
  // `record.evidence.key`. Claude writes `record.uuid` there verbatim and bare;
  // Codex writes `payload.id` verbatim (surfaced as `itemId`). Text/attachments/
  // peer/time survive as consistency checks that can only VETO a retirement.
  const PROOF = 'e0801fc1-034a-45c4-aa7d-eb5b2694c0f0';

  function delivered(over: Partial<SendRecord> = {}, key = PROOF): SendRecord {
    return row({ fate: 'delivered', evidence: { key }, ...over });
  }

  test('accepted and unaccounted always do', () => {
    const chips = selectLedgerChips(
      [row({ sendId: 'a', fate: 'accepted' }), row({ sendId: 'u', fate: 'unaccounted' })],
      [],
    );
    expect(chips.map(r => r.sendId).sort()).toEqual(['a', 'u']);
  });

  test('THE NORMAL PATH: the exact cited row retires the chip', () => {
    const chips = selectLedgerChips(
      [delivered()],
      visibleUserRows([
        {
          kind: 'user',
          text: 'mission control -- rework it please!',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: [PROOF],
        },
      ]),
    );
    expect(chips).toEqual([]);
  });

  test('THE BLOCKER: proof row outside the page + a LATER IDENTICAL visible row keeps the chip', () => {
    // The exact case Larita found. The cited row (uuid PROOF) is not loaded; what IS
    // loaded is a different record with identical text, sent later. Content matching
    // retired the chip here and the message vanished. Identity does not.
    const laterIdentical = visibleUserRows([
      {
        kind: 'user',
        text: 'mission control -- rework it please!',
        ts: new Date(AT + 600_000).toISOString(),
        proofKeys: ['a-completely-different-record-uuid'],
      },
    ]);
    const chips = selectLedgerChips([delivered()], laterIdentical);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.fate).toBe('delivered');
  });

  test('A DELIVERED ROW WHOSE PROOF SCROLLED OUT OF THE LOADED PAGE KEEPS ITS CHIP', () => {
    expect(selectLedgerChips([delivered()], [])).toHaveLength(1);
    expect(
      selectLedgerChips([delivered()], visibleUserRows([{ kind: 'user', text: 'something else', ts: ACCEPTED_AT }])),
    ).toHaveLength(1);
  });

  test('TWO IDENTICAL SENDS, ONE PROOF IDENTITY: only the cited one is retired', () => {
    // Both rows have the same text and both are delivered; only one names the loaded
    // row. The other must keep its chip rather than ride along on its twin's proof.
    const chips = selectLedgerChips(
      [
        delivered({ sendId: 'cited' }, PROOF),
        delivered({ sendId: 'uncited', acceptedAt: new Date(AT + 1_000).toISOString() }, 'other-uuid'),
      ],
      visibleUserRows([
        {
          kind: 'user',
          text: 'mission control -- rework it please!',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: [PROOF],
        },
      ]),
    );
    expect(chips.map(r => r.sendId)).toEqual(['uncited']);
  });

  test('ONE visible row cannot retire TWO delivered sends even if both cite it', () => {
    // Assignment stays one-to-one: a single visible message is proof of one delivery.
    const chips = selectLedgerChips(
      [delivered({ sendId: 'd1' }), delivered({ sendId: 'd2', acceptedAt: new Date(AT + 1_000).toISOString() })],
      visibleUserRows([
        {
          kind: 'user',
          text: 'mission control -- rework it please!',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: [PROOF],
        },
      ]),
    );
    expect(chips).toHaveLength(1);
  });

  test('a row with NO proofKeys can never retire anything (live Codex / cursor fallback)', () => {
    // Codex cursor-fallback keys are `file#start#end`, whose components the browser
    // never receives; the live broadcast path also forwards no itemId. Both surface
    // here as a row without proofKeys, and both must keep the chip rather than fall
    // back to content.
    const noIdentity = visibleUserRows([
      { kind: 'user', text: 'mission control -- rework it please!', ts: new Date(AT + 4_000).toISOString() },
    ]);
    expect(selectLedgerChips([delivered()], noIdentity)).toHaveLength(1);
    expect(selectLedgerChips([delivered({}, 'rollout.jsonl#1024#2048')], noIdentity)).toHaveLength(1);
  });

  test('a Codex row retires on itemId once history supplies it', () => {
    // `payload.id` verbatim, surfaced as top-level itemId on the historical chat row.
    // When it is present the identity is exact, so retiring is correct; when it is
    // absent (live path) the test above keeps the chip. No content matching either way.
    const chips = selectLedgerChips(
      [delivered({}, 'item_abc123')],
      visibleUserRows([
        {
          kind: 'user',
          text: 'mission control -- rework it please!',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: ['item_abc123'],
        },
      ]),
    );
    expect(chips).toEqual([]);
  });

  test('a delivered row with NO evidence keeps its chip', () => {
    // Production always writes evidence, but it stays optional in the compat type and
    // old/hand-edited rows may lack it. No citation ⇒ nothing to match ⇒ keep.
    expect(selectLedgerChips([row({ fate: 'delivered' })], [])).toHaveLength(1);
    expect(
      selectLedgerChips(
        [row({ fate: 'delivered' })],
        visibleUserRows([
          {
            kind: 'user',
            text: 'mission control -- rework it please!',
            ts: new Date(AT + 4_000).toISOString(),
            proofKeys: [PROOF],
          },
        ]),
      ),
    ).toHaveLength(1);
  });

  describe('consistency checks can only VETO a retirement, never authorise one', () => {
    function citedRow(
      over: { text?: string; attachments?: { attachmentId: string }[]; peer?: string; ts?: string } = {},
    ) {
      return visibleUserRows([
        {
          kind: 'user',
          text: over.text ?? 'mission control -- rework it please!',
          ts: over.ts ?? new Date(AT + 4_000).toISOString(),
          proofKeys: [PROOF],
          ...(over.attachments ? { attachments: over.attachments } : {}),
          ...(over.peer ? { from: { name: over.peer } } : {}),
        },
      ]);
    }

    test('identity hit but text disagrees ⇒ keep the chip', () => {
      // The daemon named this row, yet its content contradicts the record. Something
      // is wrong upstream; showing both is safer than trusting either.
      expect(selectLedgerChips([delivered()], citedRow({ text: 'not the same message' }))).toHaveLength(1);
    });

    test('identity hit but attachment sets disagree ⇒ keep the chip', () => {
      expect(
        selectLedgerChips(
          [delivered({ attachmentIds: [ATT_A] })],
          citedRow({ attachments: [{ attachmentId: ATT_B }] }),
        ),
      ).toHaveLength(1);
    });

    test('identity hit but the row predates acceptance ⇒ keep the chip', () => {
      expect(selectLedgerChips([delivered()], citedRow({ ts: new Date(AT - 600_000).toISOString() }))).toHaveLength(1);
    });
  });

  describe('peer attribution still has to agree', () => {
    const banner = `[peer message from teammate jessica (session mspeer-12345678) — not from the human lead]\nNo reply is required; jessica has carried on.\n\npeer body here`;

    function peerRow(name: string | undefined, key = PROOF) {
      return visibleUserRows([
        {
          kind: 'user',
          text: 'peer body here',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: [key],
          ...(name === undefined ? {} : { from: { name } }),
        },
      ]);
    }

    test('a delivered PEER send is retired by its own cited peer row (no double render)', () => {
      // The ledger stores the message WITH the daemon's banner; the rendered row has
      // it lifted into a sender chip, so bodies are compared.
      const record = delivered({ message: banner, from: 'mspeer-12345678', fromName: 'jessica' });
      expect(selectLedgerChips([record], peerRow('jessica'))).toEqual([]);
    });

    test('a DIFFERENT teammate’s row does not retire jessica’s send, even when cited', () => {
      const record = delivered({ message: banner, from: 'mspeer-12345678', fromName: 'jessica' });
      expect(selectLedgerChips([record], peerRow('dale'))).toHaveLength(1);
    });

    test('PEER-IDENTICAL ROWS: same body, same text, different senders — no cross-claim', () => {
      // Two teammates say the same thing. Each send may only be retired by its own
      // sender's row, so a shared body cannot let one retire the other.
      const jessica = delivered(
        { sendId: 'from-jessica', message: banner, from: 'mspeer-1', fromName: 'jessica' },
        'uuid-j',
      );
      const daleBanner = banner.replace(/jessica/g, 'dale');
      const dale = delivered(
        {
          sendId: 'from-dale',
          message: daleBanner,
          from: 'mspeer-2',
          fromName: 'dale',
          acceptedAt: new Date(AT + 1_000).toISOString(),
        },
        'uuid-d',
      );
      const rows = visibleUserRows([
        {
          kind: 'user',
          text: 'peer body here',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: ['uuid-j'],
          from: { name: 'jessica' },
        },
        {
          kind: 'user',
          text: 'peer body here',
          ts: new Date(AT + 5_000).toISOString(),
          proofKeys: ['uuid-d'],
          from: { name: 'dale' },
        },
      ]);
      expect(selectLedgerChips([jessica, dale], rows)).toEqual([]);

      // Swap the citations: each row now names the OTHER teammate's send, so the peer
      // check vetoes both and neither is retired.
      const crossed = visibleUserRows([
        {
          kind: 'user',
          text: 'peer body here',
          ts: new Date(AT + 4_000).toISOString(),
          proofKeys: ['uuid-d'],
          from: { name: 'jessica' },
        },
        {
          kind: 'user',
          text: 'peer body here',
          ts: new Date(AT + 5_000).toISOString(),
          proofKeys: ['uuid-j'],
          from: { name: 'dale' },
        },
      ]);
      expect(selectLedgerChips([jessica, dale], crossed)).toHaveLength(2);
    });

    test('a self row never retires a peer send, nor a peer row a self send', () => {
      const peerRecord = delivered({ message: banner, from: 'mspeer-12345678', fromName: 'jessica' });
      expect(selectLedgerChips([peerRecord], peerRow(undefined))).toHaveLength(1);
      const selfRecord = delivered({ message: 'peer body here' });
      expect(selectLedgerChips([selfRecord], peerRow('jessica'))).toHaveLength(1);
    });

    test('a peer row matches on the session id when the callsign was not stored', () => {
      const bare = `[peer message from teammate mspeer-12345678 (session mspeer-12345678) — not from the human lead]\nNo reply is required.\n\npeer body here`;
      const record = delivered({ message: bare, from: 'mspeer-12345678' });
      expect(selectLedgerChips([record], peerRow('mspeer-12345678'))).toEqual([]);
    });
  });

  test('withdrawn rows never produce a chip', () => {
    expect(selectLedgerChips([row({ withdrawn: true, fate: 'accepted' })], [])).toEqual([]);
  });

  test('visibleUserRows ignores system, assistant and tool rows and carries proofKeys', () => {
    const rows = visibleUserRows([
      { kind: 'system', text: 'turn prompt', proofKeys: ['sys'] },
      { kind: 'assistant', text: 'hi' },
      { kind: 'tools' },
      { kind: 'user', text: 'real', ts: ACCEPTED_AT, proofKeys: [PROOF] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('real');
    expect(rows[0]?.proofKeys).toEqual([PROOF]);
  });
});

describe('copy and tone: unconfirmed is not an error', () => {
  test('UNACCOUNTED NEVER USES ERROR RED OR THE WORD FAILED', () => {
    // Measured dwell between acceptance and transcript proof has a p99 of 4.3
    // minutes and a max of 19.2; the timeout sits generously above that, so a
    // timed-out send has very often still landed. Red invites a resend, which on
    // a message that did arrive means the agent is told twice.
    for (const reason of ['timeout', 'session_ended', 'composer_discarded'] as const) {
      const badge = sendBadge(row({ fate: 'unaccounted', unaccountedReason: reason }));
      expect(badge.label).toBe('unconfirmed');
      expect(badge.tone).not.toContain('err');
      expect(`${badge.label} ${badge.detail}`.toLowerCase()).not.toContain('fail');
      expect(`${badge.label} ${badge.detail}`.toLowerCase()).not.toContain('error');
      expect(`${badge.label} ${badge.detail}`.toLowerCase()).not.toContain('lost');
    }
  });

  test('each reason gets its own sentence, and an unknown reason still reads honestly', () => {
    expect(sendBadge(row({ fate: 'unaccounted', unaccountedReason: 'timeout' })).detail).toContain(
      'may still have landed',
    );
    expect(sendBadge(row({ fate: 'unaccounted', unaccountedReason: 'session_ended' })).detail).toContain(
      'the session ended',
    );
    expect(sendBadge(row({ fate: 'unaccounted', unaccountedReason: 'composer_discarded' })).detail).toContain(
      'interrupted',
    );
    // No reason at all (a daemon that omits it) must not produce "undefined".
    const bare = sendBadge(row({ fate: 'unaccounted' }));
    expect(bare.detail).toContain('may still have landed');
    expect(bare.detail).not.toContain('undefined');
  });

  test('"queued for next turn" is claimed ONLY on the native queue paths', () => {
    // It is a statement about the harness's own input queue. A direct/turn-file/
    // revive send was never in that queue, so the copy must not describe a
    // mechanism that did not happen.
    for (const path of ['native-inline', 'native-file'] as const)
      expect(sendBadge(row({ fate: 'accepted', path })).label).toBe('queued for next turn');
    for (const path of ['direct', 'turn-file', 'revive'] as const)
      expect(sendBadge(row({ fate: 'accepted', path })).label).toBe('accepted — awaiting confirmation');
    // Unknown/absent path (an older or newer daemon) takes the neutral wording.
    expect(sendBadge(row({ fate: 'accepted' })).label).toBe('accepted — awaiting confirmation');
  });

  test('accepted ages truthfully once a consumption opportunity has passed', () => {
    // The next turn came and went, so even "queued for next turn" is now stale.
    expect(sendBadge(row({ fate: 'accepted', path: 'native-inline', opportunityAt: ACCEPTED_AT })).label).toBe(
      'accepted — awaiting confirmation',
    );
  });

  test('ACCEPTED NEVER CLAIMS THE KEYSTROKES LANDED', () => {
    // The durable record is appended BEFORE anything reaches the pane, so wording
    // like "sent" or "delivered to the pane" overclaims in exactly the window where
    // the uncertainty lives — the same mistake as a green "delivered" on an HTTP 200.
    for (const path of ['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue'] as const) {
      for (const opportunityAt of [undefined, ACCEPTED_AT]) {
        const badge = sendBadge(row({ fate: 'accepted', path, ...(opportunityAt ? { opportunityAt } : {}) }));
        const text = `${badge.label} ${badge.detail}`.toLowerCase();
        expect(text).not.toContain('delivered to the pane');
        expect(text).not.toMatch(/\bsent\b/);
        expect(badge.tone).not.toContain('ok-');
      }
    }
    expect(sendBadge(row({ fate: 'accepted', opportunityAt: ACCEPTED_AT })).detail).toBe(
      'stored durably; kteam is waiting for harness transcript proof',
    );
  });

  test('a held revive-queue row says it is waiting on a human, not on the harness', () => {
    const badge = sendBadge(row({ fate: 'accepted', held: true, path: 'revive-queue' }));
    expect(badge.label).toBe('held for revive');
    expect(badge.detail).toContain('revived');
  });

  test('every badge carries a non-empty explanatory sentence, so tone is never colour-only', () => {
    for (const fate of ['accepted', 'delivered', 'unaccounted'] as const) {
      expect(sendBadge(row({ fate })).detail.length).toBeGreaterThan(20);
    }
  });
});

describe('late promotion (UNACCOUNTED → DELIVERED)', () => {
  test('a promoted row stops asking for a chip once its proof row is visible', () => {
    const before = foldSendRecords([row({ fate: 'unaccounted', unaccountedReason: 'timeout' })]);
    expect(selectLedgerChips(before, [])).toHaveLength(1);
    expect(sendBadge(before[0]!).label).toBe('unconfirmed');

    // The daemon re-reads the transcript, matches, and emits send_delivered — the
    // promoted snapshot carries the citation, which is what lets the chip retire.
    const proof = 'e0801fc1-034a-45c4-aa7d-eb5b2694c0f0';
    const after = foldSendRecords(before, [
      row({ fate: 'delivered', fateAt: '2026-07-27T02:30:00.000Z', evidence: { key: proof } }),
    ]);
    expect(after[0]?.fate).toBe('delivered');
    // Still keeps the chip while the cited row is not loaded…
    expect(selectLedgerChips(after, [])).toHaveLength(1);
    // …and retires only once that exact row is on screen.
    const rows = visibleUserRows([
      {
        kind: 'user',
        text: 'mission control -- rework it please!',
        ts: new Date(AT + 4_000).toISOString(),
        proofKeys: [proof],
      },
    ]);
    expect(selectLedgerChips(after, rows)).toEqual([]);
  });

  test('DELIVERED NEVER DEGRADES, IN EITHER FOLD ORDER', () => {
    // The page folds the initial fetch together with live-event refreshes, and
    // those are separate HTTP responses that can land out of order. Plain
    // last-wins would let a snapshot taken BEFORE the promotion overwrite the
    // promoted row and flip a confirmed message back to "unconfirmed", so the
    // fold pins `delivered` and is order-independent.
    expect(foldSendRecords([row({ fate: 'unaccounted' })], [row({ fate: 'delivered' })])[0]?.fate).toBe('delivered');
    expect(foldSendRecords([row({ fate: 'delivered' })], [row({ fate: 'unaccounted' })])[0]?.fate).toBe('delivered');
    expect(foldSendRecords([row({ fate: 'delivered' })], [row({ fate: 'accepted' })])[0]?.fate).toBe('delivered');
  });

  test('UNACCOUNTED IS PINNED AGAINST A STALE ACCEPTED TOO', () => {
    // accepted → unaccounted is monotonic for one attempt, so an out-of-order
    // older fetch must not restore "queued for next turn" over an honest
    // "unconfirmed" — that would make the badge oscillate as responses race.
    expect(foldSendRecords([row({ fate: 'accepted' })], [row({ fate: 'unaccounted' })])[0]?.fate).toBe('unaccounted');
    expect(foldSendRecords([row({ fate: 'unaccounted' })], [row({ fate: 'accepted' })])[0]?.fate).toBe('unaccounted');
  });

  test('a RETRY (newer acceptedAt, same sendId) legitimately supersedes any fate', () => {
    // Retrying reuses the original request id — that is the point of the
    // idempotency key — so the retried send arrives under the SAME sendId with a
    // newer acceptedAt. That clock is what separates a real new attempt from a
    // stale response trying to un-say what we already know.
    const later = new Date(AT + 60_000).toISOString();
    const afterTombstone = foldSendRecords([row({ withdrawn: true })], [row({ acceptedAt: later, fate: 'accepted' })]);
    expect(afterTombstone).toHaveLength(1);
    expect(afterTombstone[0]?.fate).toBe('accepted');

    const afterUnaccounted = foldSendRecords(
      [row({ fate: 'unaccounted' })],
      [row({ acceptedAt: later, fate: 'accepted' })],
    );
    expect(afterUnaccounted[0]?.fate).toBe('accepted');
    expect(afterUnaccounted[0]?.acceptedAt).toBe(later);
  });

  test('a tombstone is sticky WITHIN one attempt, in either order', () => {
    expect(foldSendRecords([row({ withdrawn: true })], [row({ fate: 'accepted' })])).toEqual([]);
    expect(foldSendRecords([row({ fate: 'accepted' })], [row({ withdrawn: true })])).toEqual([]);
  });

  test('THE RETRACTION PATH: a default-view tombstone removes an already-fetched ACCEPTED row', () => {
    // The endpoint's DEFAULT projection includes a bounded set of withdrawn rows
    // precisely so this works. Sequence: the initial fetch shows an accepted send;
    // injection then fails synchronously, the daemon appends a tombstone and emits
    // `control.send_withdrawn`; the refresh re-reads the endpoint and the tombstone
    // arrives in the DEFAULT response. Folding it over the earlier row is the ONLY
    // thing that retracts the chip — nothing else ever contradicts it.
    const initialFetch = parseSendsResponse({ sends: [row({ fate: 'accepted' })] });
    expect(foldSendRecords(initialFetch)).toHaveLength(1);
    expect(selectLedgerChips(foldSendRecords(initialFetch), [])).toHaveLength(1);

    const afterWithdrawn = parseSendsResponse({ sends: [row({ fate: 'accepted', withdrawn: true })] });
    const folded = foldSendRecords(initialFetch, afterWithdrawn);
    expect(folded).toEqual([]);
    expect(selectLedgerChips(folded, [])).toEqual([]);
  });

  test('parseSendsResponse must NOT drop tombstones — the fold needs to see them', () => {
    // Guard against a future "cleanup" that filters withdrawn rows at parse time.
    // That would break the retraction path above: the tombstone would never reach
    // the fold, so a withdrawn send would keep its "accepted" chip forever.
    const parsed = parseSendsResponse({ sends: [row({ fate: 'accepted', withdrawn: true })] });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.withdrawn).toBe(true);
  });

  test('an equal-rank snapshot still replaces, so updated bookkeeping lands', () => {
    const folded = foldSendRecords(
      [row({ fate: 'accepted' })],
      [row({ fate: 'accepted', opportunityAt: ACCEPTED_AT })],
    );
    expect(folded[0]?.opportunityAt).toBe(ACCEPTED_AT);
  });

  test('an OLDER attempt snapshot never displaces a newer one', () => {
    const later = new Date(AT + 60_000).toISOString();
    const folded = foldSendRecords([row({ acceptedAt: later, fate: 'accepted' })], [row({ fate: 'delivered' })]);
    expect(folded[0]?.acceptedAt).toBe(later);
    expect(folded[0]?.fate).toBe('accepted');
  });
});
