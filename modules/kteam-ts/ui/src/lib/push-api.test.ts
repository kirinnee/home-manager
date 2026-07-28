import { describe, expect, test } from 'bun:test';
import { applicationServerKey, subscriptionJson } from './push-api';

const b64 = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString('base64url');

describe('applicationServerKey', () => {
  test('decodes the daemon public key into the 65-byte browser form', () => {
    const decoded = applicationServerKey(b64(65, 7));
    expect(decoded.byteLength).toBe(65);
    expect(decoded[0]).toBe(7);
  });

  test('rejects malformed and wrong-length keys', () => {
    expect(() => applicationServerKey('not+/base64')).toThrow(/invalid/);
    expect(() => applicationServerKey(b64(32, 1))).toThrow(/wrong length/);
  });
});

describe('subscriptionJson', () => {
  test('keeps exactly the endpoint, expiry, and browser encryption keys', () => {
    const encoded = subscriptionJson({
      toJSON: () => ({
        endpoint: 'https://push.example.test/one',
        expirationTime: null,
        keys: { p256dh: b64(65, 1), auth: b64(16, 2) },
      }),
    } as unknown as PushSubscription);
    expect(encoded).toEqual({
      endpoint: 'https://push.example.test/one',
      expirationTime: null,
      keys: { p256dh: b64(65, 1), auth: b64(16, 2) },
    });
  });

  test('fails rather than registering an incomplete browser result', () => {
    expect(() =>
      subscriptionJson({
        toJSON: () => ({ endpoint: 'https://push.example.test/one' }),
      } as unknown as PushSubscription),
    ).toThrow(/incomplete/);
  });
});
