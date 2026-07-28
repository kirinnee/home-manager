import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as webPush from 'web-push';
import { readJsonFile, writeJsonAtomic } from './storage';
import { PushError, type VapidKeyPair } from './push-types';

export const vapidKeyFile = (daemonDirectory: string): string => path.join(daemonDirectory, 'push-vapid.json');

export type GenerateVapidKeys = () => { publicKey: string; privateKey: string };

function validateKey(value: unknown, label: string, bytes: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PushError('corrupt_store', `persisted VAPID ${label} is invalid`);
  }
  if (Buffer.from(value, 'base64url').byteLength !== bytes) {
    throw new PushError('corrupt_store', `persisted VAPID ${label} has the wrong length`);
  }
  return value;
}

function parsePersisted(value: unknown): VapidKeyPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PushError('corrupt_store', 'persisted VAPID key file is not an object');
  }
  const raw = value as Record<string, unknown>;
  const createdAt = raw['createdAt'];
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new PushError('corrupt_store', 'persisted VAPID key timestamp is invalid');
  }
  return {
    publicKey: validateKey(raw['publicKey'], 'public key', 65),
    privateKey: validateKey(raw['privateKey'], 'private key', 32),
    createdAt,
  };
}

/** Lazily creates the daemon's self-identifying P-256 keypair. There is no
 * registration or account: VAPID is generated locally on the first GET or the
 * first delivery, then kept stable so existing browser subscriptions remain
 * usable. A corrupt existing file is never silently replaced with a new key. */
export class VapidKeyStore {
  private loading: Promise<VapidKeyPair> | undefined;

  constructor(
    private readonly file: string,
    private readonly generate: GenerateVapidKeys = webPush.generateVAPIDKeys,
  ) {}

  keys(): Promise<VapidKeyPair> {
    if (!this.loading) {
      this.loading = this.loadOrCreate().catch(error => {
        this.loading = undefined;
        throw error;
      });
    }
    return this.loading;
  }

  async publicKey(): Promise<string> {
    return (await this.keys()).publicKey;
  }

  private async loadOrCreate(): Promise<VapidKeyPair> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.file), 0o700);
    if (existsSync(this.file)) {
      await chmod(this.file, 0o600);
      try {
        return parsePersisted(await readJsonFile<unknown>(this.file));
      } catch (error) {
        if (error instanceof PushError) throw error;
        throw new PushError('corrupt_store', `could not read persisted VAPID keys: ${String(error)}`);
      }
    }
    const generated = this.generate();
    const pair: VapidKeyPair = {
      publicKey: validateKey(generated.publicKey, 'public key', 65),
      privateKey: validateKey(generated.privateKey, 'private key', 32),
      createdAt: new Date().toISOString(),
    };
    // The shared storage primitive fsyncs the private temp file before its
    // same-directory rename, so a crash cannot strand a torn key document.
    await writeJsonAtomic(this.file, pair);
    await chmod(this.file, 0o600);
    return pair;
  }
}
