import { describe, expect, test } from 'bun:test';
import { attemptPortraitLock, isPhoneLandscape, syncPortraitGate } from './orientation-lock';

const phone = (width: number, height: number, coarse = true): Window =>
  ({
    innerWidth: width,
    innerHeight: height,
    matchMedia: (query: string) => ({ matches: coarse && query.includes('coarse') }),
  }) as unknown as Window;

describe('attemptPortraitLock', () => {
  test('locks portrait when the platform accepts', async () => {
    const calls: string[] = [];
    const orientation = {
      lock: async (value: string) => {
        calls.push(value);
      },
    } as unknown as ScreenOrientation;
    expect(await attemptPortraitLock({ orientation })).toBe(true);
    expect(calls).toEqual(['portrait']);
  });

  test('reports false when the platform refuses', async () => {
    const orientation = {
      lock: async () => {
        throw new DOMException('fullscreen required', 'SecurityError');
      },
    } as unknown as ScreenOrientation;
    expect(await attemptPortraitLock({ orientation })).toBe(false);
  });

  test('reports false when the API is absent (iOS Safari)', async () => {
    expect(await attemptPortraitLock({})).toBe(false);
    expect(await attemptPortraitLock({ orientation: {} as ScreenOrientation })).toBe(false);
  });
});

describe('isPhoneLandscape', () => {
  test('a phone held sideways qualifies', () => {
    expect(isPhoneLandscape(phone(844, 390))).toBe(true);
  });

  test('a phone held upright does not', () => {
    expect(isPhoneLandscape(phone(390, 844))).toBe(false);
  });

  test('a laptop or tablet in landscape is left alone', () => {
    expect(isPhoneLandscape(phone(1440, 900))).toBe(false);
    expect(isPhoneLandscape(phone(1180, 820))).toBe(false);
  });

  test('a mouse-driven short window is not a phone', () => {
    expect(isPhoneLandscape(phone(844, 390, false))).toBe(false);
  });
});

describe('syncPortraitGate', () => {
  const makeDoc = () => {
    const nodes = new Map<string, { id: string; remove: () => void }>();
    const body = {
      appendChild: (node: { id: string; remove: () => void }) => {
        nodes.set(node.id, node);
      },
    };
    return {
      body,
      nodes,
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => {
        const node = {
          id: '',
          innerHTML: '',
          setAttribute: () => undefined,
          remove: () => nodes.delete(node.id),
        };
        return node;
      },
    } as unknown as Document & { nodes: Map<string, unknown> };
  };

  test('mounts the gate for a sideways phone and removes it on rotation back', () => {
    const doc = makeDoc();
    syncPortraitGate(doc, phone(844, 390));
    expect(doc.nodes.size).toBe(1);
    syncPortraitGate(doc, phone(390, 844));
    expect(doc.nodes.size).toBe(0);
  });

  test('mounts at most one gate', () => {
    const doc = makeDoc();
    syncPortraitGate(doc, phone(844, 390));
    syncPortraitGate(doc, phone(844, 390));
    expect(doc.nodes.size).toBe(1);
  });

  test('never gates a desktop', () => {
    const doc = makeDoc();
    syncPortraitGate(doc, phone(1440, 900));
    expect(doc.nodes.size).toBe(0);
  });
});
