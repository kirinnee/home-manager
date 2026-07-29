import { describe, expect, test } from 'bun:test';
import { createPinReferenceResolver, resolvedPinReference } from './pin-reference-context';
import type { PinStore } from './pins';

describe('pin reference proof', () => {
  test('indexes only server-stamped pins and keeps identity session-scoped', () => {
    const store: PinStore = {
      v: 1,
      sessions: {
        'ms-one': {
          at: 1,
          pins: [
            { id: 'pin-1', kind: 'note', text: 'Ship after QA', at: 1, by: 'human' },
            { id: 'echo', kind: 'note', text: 'optimistic', at: 2 },
          ],
        },
      },
    };
    const resolve = createPinReferenceResolver(store);
    expect(resolve({ sessionId: 'ms-one', pinId: 'pin-1' })).toEqual({
      sessionId: 'ms-one',
      pinId: 'pin-1',
      label: 'Ship after QA',
    });
    expect(resolve({ sessionId: 'ms-two', pinId: 'pin-1' })).toBeNull();
    expect(resolve({ sessionId: 'ms-one', pinId: 'echo' })).toBeNull();
  });

  test('normalises and bounds live labels without depending on one pin kind', () => {
    expect(
      resolvedPinReference('ms-one', {
        id: 'diagram-1',
        kind: 'diagram',
        title: `  Release   map ${'x'.repeat(90)}  `,
        by: 'agent',
      }),
    ).toEqual({
      sessionId: 'ms-one',
      pinId: 'diagram-1',
      label: `Release map ${'x'.repeat(59)}…`,
    });
  });
});
