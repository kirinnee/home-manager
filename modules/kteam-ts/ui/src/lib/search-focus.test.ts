import { describe, expect, test } from 'bun:test';
import { requestSearchFocus, subscribeSearchFocus } from './search-focus';

describe('search-focus signal', () => {
  test('notifies every subscriber on request', () => {
    let a = 0;
    let b = 0;
    const offA = subscribeSearchFocus(() => (a += 1));
    const offB = subscribeSearchFocus(() => (b += 1));
    requestSearchFocus();
    expect([a, b]).toEqual([1, 1]);
    offA();
    offB();
  });

  test('an unsubscribed listener stops being called', () => {
    let n = 0;
    const off = subscribeSearchFocus(() => (n += 1));
    requestSearchFocus();
    off();
    requestSearchFocus();
    expect(n).toBe(1);
  });

  test('a request with no subscribers is a harmless no-op', () => {
    expect(() => requestSearchFocus()).not.toThrow();
  });
});
