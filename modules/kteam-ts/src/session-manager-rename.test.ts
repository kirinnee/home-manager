import { describe, expect, test } from 'bun:test';
import { SessionManager } from './session-manager';

// `kteam rename` changes a session's TASK TITLE and/or its teammate CALLSIGN.
// It must: accept an id OR a teammate name (resolveRef), require at least one
// field, normalise + collision-check a new callsign exactly like
// `start --teammate` (but EXCLUDING the session itself, so re-asserting its own
// name is never a self-collision), persist via updateConfig (config + index in
// one primitive), and journal a `session.renamed` event so the live UI
// refetches. These pin that behaviour without a live daemon.

type Loose = Record<string, unknown>;

interface Row {
  config: Record<string, unknown>;
  state: Record<string, unknown>;
}

interface Harness {
  manager: {
    rename(id: string, name?: string, teammate?: string): Promise<{ config: Record<string, unknown> }>;
  };
  rows: Map<string, Row>;
  emitted: Array<{ id: string; type: string; payload: unknown }>;
}

const RECENT = new Date().toISOString();

/** A bare SessionManager (prototype only) with store/emit/get faked so the real
 *  rename/resolveRef/resolveRenameTeammate/teammateNameUsage logic runs against
 *  an in-memory session table. */
function harness(rows: Row[]): Harness {
  const table = new Map<string, Row>(rows.map(row => [row.config.id as string, row]));
  const emitted: Harness['emitted'] = [];
  const manager = Object.create(SessionManager.prototype) as Loose;
  manager.store = {
    listSessions: () => [...table.values()],
    async updateConfig(id: string, transform: (current: Record<string, unknown>) => Record<string, unknown>) {
      const row = table.get(id);
      if (!row) throw new Error(`no such session ${id}`);
      row.config = transform(row.config);
      return row.config;
    },
  };
  manager.emit = async (id: string, type: string, payload: unknown) => {
    emitted.push({ id, type, payload });
    return { id, type };
  };
  manager.get = async (id: string) => ({ config: table.get(id)!.config, state: table.get(id)!.state });
  manager.closed = false;
  manager.deleting = new Set();
  return { manager: manager as Harness['manager'], rows: table, emitted };
}

function row(id: string, teammate: string, name: string, status = 'running'): Row {
  return { config: { id, teammate, name, createdAt: RECENT }, state: { status } };
}

describe('SessionManager.rename', () => {
  test('retitles by id, applying displayName and journalling session.renamed', async () => {
    const h = harness([row('s1', 'hayden', '[Hayden] Old Title')]);
    const view = await h.manager.rename('s1', '[Hayden] Fix Transcript Scrolling');
    expect(view.config.name).toBe('[Hayden] Fix Transcript Scrolling');
    expect(h.rows.get('s1')!.config.name).toBe('[Hayden] Fix Transcript Scrolling');
    // callsign untouched when only --name is given
    expect(h.rows.get('s1')!.config.teammate).toBe('hayden');
    const event = h.emitted.find(e => e.type === 'session.renamed');
    expect(event).toBeDefined();
    expect(event!.id).toBe('s1');
  });

  test('resolves a teammate NAME to its session id', async () => {
    const h = harness([row('s1', 'hayden', 'Old')]);
    const view = await h.manager.rename('hayden', 'New Title');
    expect(view.config.id).toBe('s1');
    expect(view.config.name).toBe('New Title');
  });

  test('renames the callsign to a normalised slug', async () => {
    const h = harness([row('s1', 'hayden', 'Task')]);
    await h.manager.rename('s1', undefined, 'Marlon');
    expect(h.rows.get('s1')!.config.teammate).toBe('marlon');
  });

  test('renaming a session to its OWN callsign is not a self-collision', async () => {
    const h = harness([row('s1', 'hayden', 'Task')]);
    await h.manager.rename('s1', 'New Title', 'hayden');
    expect(h.rows.get('s1')!.config.teammate).toBe('hayden');
    expect(h.rows.get('s1')!.config.name).toBe('New Title');
  });

  test('rejects a callsign already held by another LIVE session', async () => {
    const h = harness([row('s1', 'hayden', 'A'), row('s2', 'marlon', 'B', 'running')]);
    await expect(h.manager.rename('s1', undefined, 'marlon')).rejects.toThrow(/already taken by a live session/);
    // the losing session keeps its original callsign
    expect(h.rows.get('s1')!.config.teammate).toBe('hayden');
  });

  test('allows a callsign whose only holder is a TERMINAL session', async () => {
    const h = harness([row('s1', 'hayden', 'A'), row('s2', 'marlon', 'B', 'completed')]);
    await h.manager.rename('s1', undefined, 'marlon');
    expect(h.rows.get('s1')!.config.teammate).toBe('marlon');
  });

  test('rejects an invalid callsign slug', async () => {
    const h = harness([row('s1', 'hayden', 'A')]);
    await expect(h.manager.rename('s1', undefined, '99 bad name!')).rejects.toThrow(/invalid --teammate name/);
  });

  test('requires at least one of --name / --teammate', async () => {
    const h = harness([row('s1', 'hayden', 'A')]);
    await expect(h.manager.rename('s1')).rejects.toThrow(/requires --name/);
    // nothing emitted on the no-op error path
    expect(h.emitted.length).toBe(0);
  });
});
