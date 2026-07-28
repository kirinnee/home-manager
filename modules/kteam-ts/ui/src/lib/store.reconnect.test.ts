import { afterEach, describe, expect, test } from 'bun:test';
import { api } from './api';
import { FleetStore } from './store';
import type { KTeamEvent } from '../types';

// Deterministic proof for Fix 1 (dale, Rank 1): a structured question raised
// while the client was disconnected is not in the socket's 200-event global
// reconnect tail, so recovery MUST fall to a full `listSessions`. That heal was
// `document.hidden`-gated and 5s-throttled, so a reconnect landing inside the
// gap did nothing — the "question never showed" bug. The fix forces the reconcile
// on a genuine reconnect (and on the visibility→visible edge). These tests drive
// the reconnect without a real socket and count the resulting `listSessions`.
//
// A macrotask flush: `reconcile` fires `listSessions().then().catch().finally()`,
// and the `finally` is what clears `reconcileInflight` and stamps the gap. One
// setTimeout(0) drains that whole microtask chain, so the NEXT status change sees
// a settled store rather than an in-flight one it would just dedupe against.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// The private socket-status entrypoint. In the app the event stream's `onStatus`
// calls it; here we invoke it directly to model a drop→reopen with no socket.
type StatusDriver = { setStatus(status: 'connecting' | 'open' | 'closed'): void };

describe('reconnect recovery — forced reconcile (Fix 1)', () => {
  const realList = api.listSessions;
  const realUsage = api.usage;
  afterEach(() => {
    api.listSessions = realList;
    api.usage = realUsage;
  });

  function countingList(): () => number {
    let calls = 0;
    api.listSessions = () => {
      calls += 1;
      return Promise.resolve([]);
    };
    // onVisibility also refreshes quota; stub it so the test makes no real fetch.
    // The rejection is swallowed by refreshUsage's own try/catch.
    api.usage = () => Promise.reject(new Error('stubbed in test'));
    return () => calls;
  }

  test('the min-gap throttles a plain reconcile, and force bypasses it', async () => {
    const calls = countingList();
    const store = new FleetStore();

    await store.reconcile(); // first ever: fires
    await store.reconcile(); // immediate repeat: swallowed by the 5s min-gap
    expect(calls()).toBe(1);

    await store.reconcile(true); // forced: bypasses the gap the reconnect used to die in
    expect(calls()).toBe(2);
  });

  test('a later socket reopen forces a heal the min-gap would otherwise swallow', async () => {
    const calls = countingList();
    const store = new FleetStore();
    const driver = store as unknown as StatusDriver;

    driver.setStatus('open'); // initial handshake → exactly one reconcile
    await flush();
    expect(calls()).toBe(1);

    driver.setStatus('closed'); // the drop
    driver.setStatus('open'); // the reconnect, well inside the 5s min-gap
    await flush();
    // Before the fix this second open's reconcile was NON-forced, so the min-gap
    // swallowed it and the missed question never surfaced. With the fix the
    // reconnect is forced, so a fresh listSessions runs.
    expect(calls()).toBe(2);
  });

  test('the visibility→visible edge forces one heal even inside the gap', async () => {
    const calls = countingList();
    const store = new FleetStore();
    const driver = store as unknown as StatusDriver & { onVisibility: () => void };

    driver.setStatus('open'); // stamps the gap
    await flush();
    expect(calls()).toBe(1);

    driver.onVisibility(); // returning to a backgrounded tab, still inside 5s
    await flush();
    expect(calls()).toBe(2);
  });
});

describe('live fleet event subscriptions', () => {
  test('hears a task update from any session without pinning a per-session replay subscription', () => {
    const store = new FleetStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribeEvents(event => seen.push(`${event.sessionId}:${event.type}`));
    const driver = store as unknown as { handleEvent(event: KTeamEvent): void };
    const event: KTeamEvent = {
      sequence: 0,
      time: '2026-07-28T00:00:00.000Z',
      sessionId: 'ms-previously-taskless',
      turn: 0,
      type: 'tasks.updated',
      source: 'client',
      data: { tasks: [] },
    };

    driver.handleEvent(event);
    expect(seen).toEqual(['ms-previously-taskless:tasks.updated']);
    unsubscribe();
    driver.handleEvent(event);
    expect(seen).toHaveLength(1);
  });
});
