import { customAlphabet } from 'nanoid';

const shortId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

export function generateSessionId(): string {
  return shortId();
}
