import { describe, expect, test } from 'bun:test';
import {
  activeBlessing,
  blessingTtlMs,
  isAnomalyBlessed,
  reconcileBlessings,
  recordBlessing,
  type BlessingStore,
} from './warden-bless';
import type { WardenAnomalyKind } from './warden-detect';
import type { SessionStatus } from './types';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const TTL = blessingTtlMs(15); // 15 minutes, the default

function bless(
  store: BlessingStore,
  sessionId: string,
  kinds: WardenAnomalyKind[],
  status: SessionStatus,
  atMs = NOW,
  ttlMs = TTL,
): BlessingStore {
  return recordBlessing(store, { sessionId, kinds, status, wardenId: `w-${sessionId}` }, atMs, ttlMs);
}

describe('blessingTtlMs', () => {
  test('15 minutes → 900_000 ms', () => {
    expect(blessingTtlMs(15)).toBe(15 * 60_000);
  });

  test('floors zero/negative/NaN at 60s so the feature never self-disables', () => {
    expect(blessingTtlMs(0)).toBe(60_000);
    expect(blessingTtlMs(-5)).toBe(60_000);
    expect(blessingTtlMs(Number.NaN)).toBe(60_000);
  });
});

describe('recordBlessing', () => {
  test('records a blessing with the right expiry and kinds, immutably', () => {
    const store = bless({}, 'lenny', ['sus_subprocess'], 'tool_running');
    expect(store.lenny?.expiresAt).toBe(new Date(NOW + TTL).toISOString());
    expect(store.lenny?.kinds).toEqual(['sus_subprocess']);
    expect(store.lenny?.status).toBe('tool_running');
    expect(store.lenny?.wardenId).toBe('w-lenny');
  });

  test('de-duplicates kinds', () => {
    const store = bless({}, 'a', ['sus_subprocess', 'sus_subprocess', 'sus_thinking'], 'running');
    expect(store.a?.kinds).toEqual(['sus_subprocess', 'sus_thinking']);
  });

  test('empty kinds is a no-op (an empty blessing could never suppress anything)', () => {
    const store: BlessingStore = {};
    expect(recordBlessing(store, { sessionId: 'a', kinds: [], status: 'running' }, NOW, TTL)).toBe(store);
  });

  test('a later LEAVE replaces the earlier blessing for the same session', () => {
    let store = bless({}, 'a', ['sus_subprocess'], 'running', NOW);
    store = bless(store, 'a', ['sus_thinking'], 'thinking', NOW + 60_000);
    expect(store.a?.kinds).toEqual(['sus_thinking']);
    expect(store.a?.status).toBe('thinking');
  });
});

describe('isAnomalyBlessed — blessed session skipped until expiry', () => {
  const store = bless({}, 'lenny', ['sus_subprocess'], 'tool_running');

  test('the cleared flag is blessed while unexpired and status unchanged', () => {
    expect(
      isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'sus_subprocess' }, 'tool_running', NOW + 5 * 60_000),
    ).toBe(true);
  });

  test('blessing lapses at expiry — the flag triggers again', () => {
    // exactly at expiry and beyond: no longer blessed
    expect(isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'sus_subprocess' }, 'tool_running', NOW + TTL)).toBe(
      false,
    );
    expect(isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'sus_subprocess' }, 'tool_running', NOW + TTL + 1)).toBe(
      false,
    );
  });

  test('no blessing → not blessed', () => {
    expect(isAnomalyBlessed({}, { sessionId: 'ghost', kind: 'sus_subprocess' }, 'running', NOW)).toBe(false);
  });
});

describe('isAnomalyBlessed — narrow: a NEW flag class still triggers', () => {
  const store = bless({}, 'lenny', ['sus_subprocess'], 'tool_running');

  test('a different anomaly kind on the same session is NOT blessed', () => {
    expect(isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'sus_thinking' }, 'tool_running', NOW + 60_000)).toBe(
      false,
    );
    expect(isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'dead_monitor' }, 'tool_running', NOW + 60_000)).toBe(
      false,
    );
  });

  test('a blessing covering multiple kinds blesses each of them', () => {
    const multi = bless({}, 'a', ['sus_subprocess', 'sus_thinking'], 'running');
    expect(isAnomalyBlessed(multi, { sessionId: 'a', kind: 'sus_subprocess' }, 'running', NOW + 60_000)).toBe(true);
    expect(isAnomalyBlessed(multi, { sessionId: 'a', kind: 'sus_thinking' }, 'running', NOW + 60_000)).toBe(true);
    expect(isAnomalyBlessed(multi, { sessionId: 'a', kind: 'unattended_question' }, 'running', NOW + 60_000)).toBe(
      false,
    );
  });
});

describe('isAnomalyBlessed — invalidate on status change', () => {
  const store = bless({}, 'lenny', ['sus_subprocess'], 'tool_running');

  test('same flag but the session changed status → not blessed', () => {
    expect(isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'sus_subprocess' }, 'running', NOW + 60_000)).toBe(
      false,
    );
    expect(isAnomalyBlessed(store, { sessionId: 'lenny', kind: 'sus_subprocess' }, 'failed', NOW + 60_000)).toBe(false);
  });
});

describe('activeBlessing', () => {
  test('returns the blessing while unexpired, undefined after', () => {
    const store = bless({}, 'a', ['sus_subprocess'], 'running');
    expect(activeBlessing(store, 'a', NOW + 60_000)?.sessionId).toBe('a');
    expect(activeBlessing(store, 'a', NOW + TTL)).toBeUndefined();
    expect(activeBlessing(store, 'missing', NOW)).toBeUndefined();
  });
});

describe('reconcileBlessings — prune expired / status-changed / vanished', () => {
  test('keeps a still-valid blessing whose status is unchanged', () => {
    const store = bless({}, 'a', ['sus_subprocess'], 'tool_running');
    const out = reconcileBlessings(store, new Map([['a', 'tool_running']]), NOW + 60_000);
    expect(out.store.a).toBeDefined();
    expect(out.revoked).toEqual([]);
    expect(out.expired).toEqual([]);
  });

  test('drops an expired blessing (reported as expired, not revoked)', () => {
    const store = bless({}, 'a', ['sus_subprocess'], 'tool_running');
    const out = reconcileBlessings(store, new Map([['a', 'tool_running']]), NOW + TTL + 1);
    expect(out.store.a).toBeUndefined();
    expect(out.expired).toEqual(['a']);
    expect(out.revoked).toEqual([]);
  });

  test('revokes a blessing whose session changed status', () => {
    const store = bless({}, 'a', ['sus_subprocess'], 'tool_running');
    const out = reconcileBlessings(store, new Map([['a', 'failed']]), NOW + 60_000);
    expect(out.store.a).toBeUndefined();
    expect(out.revoked).toEqual(['a']);
    expect(out.expired).toEqual([]);
  });

  test('revokes a blessing whose session vanished from the fleet', () => {
    const store = bless({}, 'a', ['sus_subprocess'], 'tool_running');
    const out = reconcileBlessings(store, new Map(), NOW + 60_000);
    expect(out.store.a).toBeUndefined();
    expect(out.revoked).toEqual(['a']);
  });

  test('mixed store: keep one, expire one, revoke one', () => {
    let store = bless({}, 'keep', ['sus_subprocess'], 'tool_running', NOW);
    store = bless(store, 'expire', ['sus_thinking'], 'thinking', NOW - TTL); // already expired
    store = bless(store, 'revoke', ['sus_subprocess'], 'running', NOW);
    const out = reconcileBlessings(
      store,
      new Map<string, SessionStatus>([
        ['keep', 'tool_running'],
        ['expire', 'thinking'],
        ['revoke', 'awaiting_question'], // status changed
      ]),
      NOW + 60_000,
    );
    expect(Object.keys(out.store)).toEqual(['keep']);
    expect(out.expired).toEqual(['expire']);
    expect(out.revoked).toEqual(['revoke']);
  });
});
