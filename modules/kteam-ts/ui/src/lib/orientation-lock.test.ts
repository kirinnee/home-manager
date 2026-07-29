import { describe, expect, test } from 'bun:test';
import { attemptPortraitLock } from './orientation-lock';

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
