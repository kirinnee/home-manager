import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from './attachments';
import { MemoryBackedFileStore, resolveMemoryBackedRoot } from './memory-locator';
import { SessionManager } from './session-manager';
import type { AttachmentView } from './service';
import { encryptedPdfBytes, USER_PASSWORD_PDF_BASE64, USER_PASSWORD_PDF_PASSWORD } from './fixtures/encrypted-pdf';

// The daemon-facing half of the unlock flow: what the API actually returns for a
// locked and an unlocked attachment. The store-level behaviour (decryption,
// RAM-backed locator, durable-storage guarantees) is pinned in
// attachments-encrypted.test.ts; this pins the VIEW, which is the only thing the
// UI ever sees.

const SESSION = 'ms1docs-12345678';

const ramRoot = resolveMemoryBackedRoot();
const ramTest = ramRoot === undefined ? test.skip : test;

const homes: string[] = [];
const stores: AttachmentStore[] = [];

/** A SessionManager with only the collaborators the attachment methods touch
 * wired up — the same loose-bag idiom the chat-service tests use. */
interface Loose {
  attachments: AttachmentStore;
  resolveRef(id: string): string;
  get(id: string): Promise<unknown>;
  getAttachment(id: string, attachmentId: string): Promise<{ attachment: AttachmentView; bytes: Uint8Array }>;
  unlockAttachment(id: string, attachmentId: string, password: string): Promise<AttachmentView>;
  lockAttachment(id: string, attachmentId: string): Promise<AttachmentView>;
}

async function bareManager(): Promise<{ manager: Loose; store: AttachmentStore; rootDir: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-attachment-view-test-'));
  homes.push(rootDir);
  const store = new AttachmentStore({
    rootDir,
    unlock: { memoryStore: new MemoryBackedFileStore(ramRoot ? { root: ramRoot } : {}) },
  });
  stores.push(store);
  const manager = Object.create(SessionManager.prototype) as Loose;
  manager.attachments = store;
  manager.resolveRef = (id: string) => id;
  manager.get = async () => ({ config: { id: SESSION } });
  return { manager, store, rootDir };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe('attachment views report encryption as a resolvable state', () => {
  test('a locked PDF is reported as locked, with no terminal failure alongside it', async () => {
    const { manager, store } = await bareManager();
    const stored = await store.upload(SESSION, encryptedPdfBytes(USER_PASSWORD_PDF_BASE64), {
      filename: 'statement.pdf',
      mime: 'application/pdf',
    });

    const { attachment } = await manager.getAttachment(SESSION, stored.manifest.id);

    expect(attachment.encrypted).toEqual({ kind: 'pdf', locked: true });
    expect(attachment.textExtraction).toBeUndefined();
    expect(attachment.textExtractionFailure).toBeUndefined();
  }, 30_000);

  ramTest(
    'unlocking reports the decrypted copy without ever exposing its RAM path',
    async () => {
      const { manager, store } = await bareManager();
      const stored = await store.upload(SESSION, encryptedPdfBytes(USER_PASSWORD_PDF_BASE64), {
        filename: 'statement.pdf',
        mime: 'application/pdf',
      });

      const unlocked = await manager.unlockAttachment(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);

      expect(unlocked.encrypted?.locked).toBe(false);
      expect(unlocked.encrypted?.decryptedSize).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(unlocked.encrypted?.expiresAt ?? ''))).toBe(false);
      expect(unlocked.textExtraction?.method).toBe('pdfjs');
      // `path` is the STORED original, which is still the encrypted file. The
      // RAM-backed decrypted path is daemon-internal and must never travel out.
      expect(unlocked.path).toBe(stored.path);
      expect(JSON.stringify(unlocked)).not.toContain('/dev/shm');

      // The download endpoint keeps serving the stored bytes, not the plaintext:
      // unlocking gives the AGENT a decrypted copy, it does not open a second
      // distribution path for it.
      const served = await manager.getAttachment(SESSION, stored.manifest.id);
      expect(Buffer.from(served.bytes).equals(Buffer.from(encryptedPdfBytes(USER_PASSWORD_PDF_BASE64)))).toBe(true);
      expect(served.attachment.encrypted?.locked).toBe(false);

      const relocked = await manager.lockAttachment(SESSION, stored.manifest.id);
      expect(relocked.encrypted).toEqual({ kind: 'pdf', locked: true });
      expect(relocked.textExtraction).toBeUndefined();
    },
    60_000,
  );

  test('a pre-unlock-flow manifest is reported as locked instead of as a dead end', async () => {
    // Written by a daemon that only knew the terminal shape. Reporting both the
    // old "re-attach it decrypted" failure AND a working password box would be
    // two contradictory instructions for one file.
    const { manager, rootDir } = await bareManager();
    const bytes = encryptedPdfBytes(USER_PASSWORD_PDF_BASE64);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const hashDir = path.join(rootDir, SESSION, 'attachments', hash);
    await mkdir(hashDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(hashDir, 'legacy.pdf'), bytes, { mode: 0o600 });
    await writeFile(
      path.join(hashDir, 'manifest.json'),
      `${JSON.stringify(
        {
          version: 1,
          id: `att_${hash}`,
          filename: 'legacy.pdf',
          mime: 'application/pdf',
          size: bytes.byteLength,
          hash,
          time: '2026-07-01T00:00:00.000Z',
          textExtractionFailure: {
            code: 'password_protected_document',
            message:
              'This PDF needs a password to open; kteam could not read its text. Decrypt it locally and re-attach it if you want the agent to read it',
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const { attachment } = await manager.getAttachment(SESSION, `att_${hash}`);

    expect(attachment.encrypted).toEqual({ kind: 'pdf', locked: true });
    expect(attachment.textExtractionFailure).toBeUndefined();
  });

  test('a legacy locked DOCX keeps its terminal failure and is never offered a password', async () => {
    const { manager, rootDir } = await bareManager();
    // An OOXML encrypted package is an MS-OFFCRYPTO container; the PDF
    // decryptor cannot open it, so promising an unlock would be a lie.
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const hashDir = path.join(rootDir, SESSION, 'attachments', hash);
    await mkdir(hashDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(hashDir, 'locked.docx'), bytes, { mode: 0o600 });
    await writeFile(
      path.join(hashDir, 'manifest.json'),
      `${JSON.stringify(
        {
          version: 1,
          id: `att_${hash}`,
          filename: 'locked.docx',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: bytes.byteLength,
          hash,
          time: '2026-07-01T00:00:00.000Z',
          textExtractionFailure: {
            code: 'password_protected_document',
            message: 'This DOCX needs a password to open; kteam could not read its text',
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const { attachment } = await manager.getAttachment(SESSION, `att_${hash}`);

    expect(attachment.encrypted).toBeUndefined();
    expect(attachment.textExtractionFailure?.code).toBe('password_protected_document');
  });
});
