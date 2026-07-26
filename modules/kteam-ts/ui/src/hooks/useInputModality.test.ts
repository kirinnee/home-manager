import { describe, expect, test } from 'bun:test';
import {
  createInputModalityStore,
  resolveInputModality,
  type InputModalitySignals,
  type InputModalitySource,
} from './useInputModality';

const QUERIES = {
  finePrimary: '(pointer: fine)',
  coarsePrimary: '(pointer: coarse)',
  hoverPrimary: '(hover: hover)',
  noHoverPrimary: '(hover: none)',
  anyCoarse: '(any-pointer: coarse)',
} as const;

function signals(overrides: Partial<InputModalitySignals> = {}): InputModalitySignals {
  return {
    finePrimary: true,
    coarsePrimary: false,
    hoverPrimary: true,
    noHoverPrimary: false,
    anyCoarse: false,
    lastPointerType: null,
    ...overrides,
  };
}

describe('input-modality decision table', () => {
  const cases: Array<{
    name: string;
    signals: InputModalitySignals;
    touchAffected: boolean;
    enterSends: boolean;
  }> = [
    {
      name: 'phone',
      signals: signals({
        finePrimary: false,
        coarsePrimary: true,
        hoverPrimary: false,
        noHoverPrimary: true,
        anyCoarse: true,
        lastPointerType: 'touch',
      }),
      touchAffected: true,
      enterSends: false,
    },
    {
      name: 'iPad with a hardware keyboard attached',
      signals: signals({
        finePrimary: false,
        coarsePrimary: true,
        hoverPrimary: false,
        noHoverPrimary: true,
        anyCoarse: true,
        lastPointerType: 'touch',
      }),
      touchAffected: true,
      enterSends: false,
    },
    {
      name: 'coarse-primary tablet with a mouse',
      signals: signals({
        finePrimary: false,
        coarsePrimary: true,
        anyCoarse: true,
        lastPointerType: 'mouse',
      }),
      touchAffected: true,
      enterSends: false,
    },
    {
      name: 'touch laptop after touch',
      signals: signals({ anyCoarse: true, lastPointerType: 'touch' }),
      touchAffected: true,
      enterSends: false,
    },
    {
      name: 'touch laptop after a genuine mouse pointerdown',
      signals: signals({ anyCoarse: true, lastPointerType: 'mouse' }),
      touchAffected: true,
      enterSends: true,
    },
    {
      name: 'narrow fine-pointer desktop at boot',
      signals: signals(),
      touchAffected: false,
      enterSends: true,
    },
    {
      name: 'narrow fine-pointer desktop after mouse input',
      signals: signals({ lastPointerType: 'mouse' }),
      touchAffected: false,
      enterSends: true,
    },
    {
      name: 'matchMedia absent or every probe failed',
      signals: signals({
        finePrimary: null,
        coarsePrimary: null,
        hoverPrimary: null,
        noHoverPrimary: null,
        anyCoarse: null,
        lastPointerType: 'mouse',
      }),
      touchAffected: true,
      enterSends: false,
    },
    {
      name: 'contradictory fine and coarse primary signals',
      signals: signals({ coarsePrimary: true, anyCoarse: true, lastPointerType: 'mouse' }),
      touchAffected: true,
      enterSends: false,
    },
    {
      name: 'pen or synthetic pointer ambiguity',
      signals: signals({ lastPointerType: 'pen' }),
      touchAffected: true,
      enterSends: false,
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      expect(resolveInputModality(row.signals)).toEqual({
        touchAffected: row.touchAffected,
        enterSends: row.enterSends,
      });
    });
  }

  test('viewport width cannot change the result because it is not a policy input', () => {
    const desktop = signals({ lastPointerType: 'mouse' });
    expect(resolveInputModality(desktop)).toEqual(resolveInputModality({ ...desktop }));
    expect(Object.keys(desktop)).not.toContain('width');
  });
});

class FakeMediaQuery {
  addCount = 0;
  removeCount = 0;
  private readonly listeners = new Set<() => void>();

  constructor(public matches: boolean) {}

  addEventListener(type: 'change', listener: () => void) {
    expect(type).toBe('change');
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(type: 'change', listener: () => void) {
    expect(type).toBe('change');
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  set(matches: boolean) {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

class FakeSource implements InputModalitySource {
  readonly media = new Map<string, FakeMediaQuery>([
    [QUERIES.finePrimary, new FakeMediaQuery(true)],
    [QUERIES.coarsePrimary, new FakeMediaQuery(false)],
    [QUERIES.hoverPrimary, new FakeMediaQuery(true)],
    [QUERIES.noHoverPrimary, new FakeMediaQuery(false)],
    [QUERIES.anyCoarse, new FakeMediaQuery(false)],
  ]);
  matchCalls: string[] = [];
  pointerAdds = 0;
  pointerRemoves = 0;
  private readonly pointerListeners = new Set<(event: { pointerType?: string }) => void>();

  matchMedia(query: string) {
    this.matchCalls.push(query);
    const media = this.media.get(query);
    if (!media) throw new Error(`unexpected query: ${query}`);
    return media;
  }

  addPointerListener(listener: (event: { pointerType?: string }) => void) {
    this.pointerAdds += 1;
    this.pointerListeners.add(listener);
  }

  removePointerListener(listener: (event: { pointerType?: string }) => void) {
    this.pointerRemoves += 1;
    this.pointerListeners.delete(listener);
  }

  pointer(pointerType: string) {
    for (const listener of this.pointerListeners) listener({ pointerType });
  }
}

describe('the shared live store', () => {
  test('is conservative in SSR and missing-test-window environments', () => {
    const store = createInputModalityStore(() => null);
    expect(store.getSnapshot()).toEqual({ touchAffected: true, enterSends: false });
    expect(store.read()).toEqual({ touchAffected: true, enterSends: false });
    store.dispose();
  });

  test('installs one global listener set across subscribers and StrictMode cycles', () => {
    const source = new FakeSource();
    const store = createInputModalityStore(() => source);

    const firstCleanup = store.subscribe(() => {});
    firstCleanup(); // StrictMode's setup -> cleanup
    const remountCleanup = store.subscribe(() => {}); // -> setup again
    const secondConsumerCleanup = store.subscribe(() => {});

    expect(source.pointerAdds).toBe(1);
    expect(source.matchCalls).toEqual(Object.values(QUERIES));
    for (const query of source.media.values()) expect(query.addCount).toBe(1);

    remountCleanup();
    secondConsumerCleanup();
    expect(source.pointerRemoves).toBe(0); // page-lifetime singleton, not leaked copies

    store.dispose();
    expect(source.pointerRemoves).toBe(1);
    for (const query of source.media.values()) expect(query.removeCount).toBe(1);
  });

  test('a touch pointerdown flips the synchronous next read and mouse restores it', () => {
    const source = new FakeSource();
    const store = createInputModalityStore(() => source);
    let notifications = 0;
    store.subscribe(() => notifications++);

    expect(store.read()).toEqual({ touchAffected: false, enterSends: true });
    source.pointer('touch');
    expect(store.read()).toEqual({ touchAffected: true, enterSends: false });
    source.pointer('mouse');
    expect(store.read()).toEqual({ touchAffected: false, enterSends: true });
    expect(notifications).toBe(3); // initial desktop probe, touch, then mouse
    store.dispose();
  });

  test('media changes update every subscriber live', () => {
    const source = new FakeSource();
    const store = createInputModalityStore(() => source);
    let first = 0;
    let second = 0;
    store.subscribe(() => first++);
    store.subscribe(() => second++);

    source.media.get(QUERIES.coarsePrimary)!.set(true);
    expect(store.getSnapshot()).toEqual({ touchAffected: true, enterSends: false });
    expect(first).toBe(2); // initial desktop probe + the changed media result
    expect(second).toBe(1); // subscribed after the initial probe
    store.dispose();
  });

  test('probe failures stay conservative even after a mouse pointerdown', () => {
    const source = new FakeSource();
    source.matchMedia = () => {
      throw new Error('matchMedia probe failed');
    };
    const store = createInputModalityStore(() => source);
    store.subscribe(() => {});
    source.pointer('mouse');
    expect(store.read()).toEqual({ touchAffected: true, enterSends: false });
    store.dispose();
  });
});
