import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './storage';
import {
  PushError,
  parseStoredPushDevice,
  pushDeviceView,
  type PushDeviceRecord,
  type PushDeviceView,
  type RegisterPushDeviceInput,
} from './push-types';

interface SubscriptionDocument {
  version: 1;
  devices: PushDeviceRecord[];
}

export const pushSubscriptionFile = (daemonDirectory: string): string =>
  path.join(daemonDirectory, 'push-subscriptions.json');

/** Enrollment is human-scale. This also bounds fan-out, memory, and outbound
 * concurrency even if an authenticated client accidentally loops. */
export const MAX_PUSH_DEVICES = 32;

function cloneRecord(record: PushDeviceRecord): PushDeviceRecord {
  return structuredClone(record);
}

/** Atomic, daemon-only subscription storage. Endpoint/key material never leaves
 * this class except through subscriptions(), which is the sender's internal
 * port; list() returns redacted device metadata for individual revocation. */
export class PushSubscriptionStore {
  private records: PushDeviceRecord[] | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  list(): Promise<PushDeviceView[]> {
    return this.serial(async () => (await this.load()).map(pushDeviceView));
  }

  subscriptions(): Promise<PushDeviceRecord[]> {
    return this.serial(async () => (await this.load()).map(cloneRecord));
  }

  register(input: RegisterPushDeviceInput): Promise<PushDeviceView> {
    return this.serial(async () => {
      const records = await this.load();
      const at = new Date().toISOString();
      const index = records.findIndex(record => record.subscription.endpoint === input.subscription.endpoint);
      const existing = index === -1 ? undefined : records[index];
      if (!existing && records.length >= MAX_PUSH_DEVICES) {
        throw new PushError('invalid', `push device limit (${MAX_PUSH_DEVICES}) reached`);
      }
      const next: PushDeviceRecord = existing
        ? { ...existing, ...structuredClone(input), revision: existing.revision + 1, updatedAt: at }
        : {
            id: `push-${crypto.randomUUID()}`,
            revision: 1,
            createdAt: at,
            updatedAt: at,
            ...structuredClone(input),
          };
      const updated = existing
        ? records.map((record, atIndex) => (atIndex === index ? next : record))
        : [...records, next];
      await this.persist(updated);
      return pushDeviceView(next);
    });
  }

  revoke(id: string): Promise<PushDeviceView> {
    return this.serial(async () => {
      const records = await this.load();
      const index = records.findIndex(record => record.id === id);
      if (index === -1) throw new PushError('not_found', `unknown push device ${id}`);
      const removed = records[index]!;
      await this.persist(records.filter((_, atIndex) => atIndex !== index));
      return pushDeviceView(removed);
    });
  }

  /** Drop endpoints rejected as permanently gone (404/410). The revision
   * comparison protects a newly refreshed subscription from an older request
   * completing late with 410. */
  removeMany(revisions: ReadonlyMap<string, number>): Promise<number> {
    if (revisions.size === 0) return Promise.resolve(0);
    return this.serial(async () => {
      const records = await this.load();
      const kept = records.filter(record => revisions.get(record.id) !== record.revision);
      const removed = records.length - kept.length;
      if (removed > 0) await this.persist(kept);
      return removed;
    });
  }

  private async load(): Promise<PushDeviceRecord[]> {
    if (this.records) return this.records;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.file), 0o700);
    if (!existsSync(this.file)) return (this.records = []);
    await chmod(this.file, 0o600);
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(this.file);
    } catch (error) {
      throw new PushError('corrupt_store', `could not read push subscription store: ${String(error)}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PushError('corrupt_store', 'push subscription store is not an object');
    }
    const document = raw as Record<string, unknown>;
    if (document['version'] !== 1 || !Array.isArray(document['devices'])) {
      throw new PushError('corrupt_store', 'push subscription store has an unsupported shape');
    }
    try {
      this.records = document['devices'].map(parseStoredPushDevice);
    } catch (error) {
      throw new PushError('corrupt_store', `push subscription store contains an invalid device: ${String(error)}`);
    }
    return this.records;
  }

  private async persist(records: PushDeviceRecord[]): Promise<void> {
    const document: SubscriptionDocument = { version: 1, devices: records };
    // fsync-before-rename is important here: a torn subscription store would
    // otherwise make every device simultaneously unrecoverable after a crash.
    await writeJsonAtomic(this.file, document);
    await chmod(this.file, 0o600);
    this.records = records;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
