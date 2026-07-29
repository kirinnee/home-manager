import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AttachmentError,
  AttachmentStore,
  isLockedAttachment,
  type AttachmentStoreOptions,
  type StoredAttachment,
} from './attachments';
import { DocumentExtractionError, extractPdfText } from './document-extract';
import { MemoryBackedFileStore, resolveMemoryBackedRoot } from './memory-locator';
import { PdfDecryptionError } from './pdf-decrypt';
import {
  encryptedPdfBytes,
  OWNER_PASSWORD_ONLY_PDF_BASE64,
  USER_PASSWORD_PDF_BASE64,
  USER_PASSWORD_PDF_PASSWORD,
} from './fixtures/encrypted-pdf';

const SESSION = 'session-encrypted';
const FIXTURE_TEXT = 'KTEAM PDF FIXTURE hello';

const ramRoot = resolveMemoryBackedRoot();
/** The decrypted copy has to live on a memory filesystem. Where there is none —
 * macOS has no /dev/shm — the unlock flow is unavailable by design, so these
 * assertions are skipped rather than made to pass against a disk. */
const ramTest = ramRoot === undefined ? test.skip : test;

function errorCode(error: unknown): string | undefined {
  return error instanceof AttachmentError ? error.code : undefined;
}

/** Every regular file under `directory`, recursively, as absolute paths. */
async function allFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  await walk(directory);
  return found.sort();
}

describe('encrypted attachment unlock flow', () => {
  let rootDir: string;
  let ramDir: string | undefined;
  let stores: AttachmentStore[];

  const newStore = (options: AttachmentStoreOptions = {}): AttachmentStore => {
    const store = new AttachmentStore({
      rootDir,
      ...options,
      // A private tmpfs subtree per test, so nothing here can see (or sweep) a
      // real daemon's decrypted copies and afterEach can clean up completely.
      unlock: {
        ...options.unlock,
        memoryStore: options.unlock?.memoryStore ?? new MemoryBackedFileStore(ramDir ? { root: ramDir } : {}),
      },
    });
    stores.push(store);
    return store;
  };

  const uploadLocked = async (store: AttachmentStore, filename = 'statement.pdf'): Promise<StoredAttachment> =>
    await store.upload(SESSION, encryptedPdfBytes(USER_PASSWORD_PDF_BASE64), {
      filename,
      mime: 'application/pdf',
    });

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'kteam-attachments-encrypted-'));
    ramDir = ramRoot === undefined ? undefined : await mkdtemp(path.join(ramRoot, 'kteam-unlock-test-'));
    stores = [];
  });

  afterEach(async () => {
    await Promise.all(stores.map(store => store.dispose()));
    await rm(rootDir, { recursive: true, force: true });
    if (ramDir) await rm(ramDir, { recursive: true, force: true });
  });

  test('an encrypted PDF is stored as locked, not as a terminal extraction failure', async () => {
    const store = newStore();
    const stored = await uploadLocked(store);

    expect(stored.manifest.encrypted).toEqual({ kind: 'pdf' });
    expect(stored.manifest.textExtraction).toBeUndefined();
    // A terminal failure would tell the human "re-attach it decrypted"; a locked
    // attachment is one the human can still resolve here.
    expect(stored.manifest.textExtractionFailure).toBeUndefined();
    expect(stored.locked).toBe(true);
    expect(stored.decrypted).toBeUndefined();
    expect(isLockedAttachment(stored.manifest)).toBe(true);

    // The manifest survives a re-read, which is what a restarted daemon does.
    const reread = await newStore().get(SESSION, stored.manifest.id);
    expect(reread.manifest.encrypted).toEqual({ kind: 'pdf' });
    expect(reread.locked).toBe(true);
  }, 30_000);

  test('a PDF that opens without a password is never reported as locked', async () => {
    const store = newStore();
    const stored = await store.upload(SESSION, encryptedPdfBytes(OWNER_PASSWORD_ONLY_PDF_BASE64), {
      filename: 'owner-only.pdf',
      mime: 'application/pdf',
    });

    expect(stored.manifest.encrypted).toBeUndefined();
    expect(stored.locked).toBeUndefined();
    expect(stored.manifest.textExtraction?.method).toBe('pdfjs');
  }, 30_000);

  test('a manifest recorded before the unlock flow existed is read as locked', () => {
    // No migration, no rewrite of content-addressed bytes: the old terminal
    // shape is simply understood as the state it always described.
    expect(
      isLockedAttachment({
        version: 1,
        id: `att_${'a'.repeat(64)}`,
        filename: 'old.pdf',
        mime: 'application/pdf',
        size: 10,
        hash: 'a'.repeat(64),
        time: new Date().toISOString(),
        textExtractionFailure: { code: 'password_protected_document', message: 'needs a password' },
      }),
    ).toBe(true);
    // The DOCX form stays terminal: qpdf cannot open an MS-OFFCRYPTO package.
    expect(
      isLockedAttachment({
        version: 1,
        id: `att_${'b'.repeat(64)}`,
        filename: 'old.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 10,
        hash: 'b'.repeat(64),
        time: new Date().toISOString(),
        textExtractionFailure: { code: 'password_protected_document', message: 'needs a password' },
      }),
    ).toBe(false);
  });

  test('the agent is told the file is locked and is never told its text was read', async () => {
    const store = newStore();
    const stored = await uploadLocked(store);

    const block = await store.buildAttachmentReferenceBlock(SESSION, [stored.manifest.id]);
    expect(block).toContain('still locked in kteam (encrypted_pdf_locked)');
    expect(block).toContain('cannot be opened without one');
    expect(block).not.toContain('BEGIN KTEAM EXTRACTED TEXT');
    expect(block).not.toContain('Text extracted by kteam');
  }, 30_000);

  ramTest(
    'the correct password decrypts the fixture and the existing extractor reads its text',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);

      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);

      expect(unlocked.locked).toBe(false);
      expect(unlocked.decrypted).toBeDefined();
      expect(unlocked.decrypted!.extraction?.method).toBe('pdfjs');
      expect(unlocked.decrypted!.text).toBe(FIXTURE_TEXT);
      expect(unlocked.decrypted!.extractionFailure).toBeUndefined();
      // The decrypted copy is a different document from the stored original.
      expect(unlocked.decrypted!.size).not.toBe(unlocked.manifest.size);

      // The bytes at the RAM-backed path really are the readable PDF.
      const plain = new Uint8Array(await readFile(unlocked.decrypted!.path));
      expect(new TextDecoder().decode(plain.subarray(0, 5))).toBe('%PDF-');
      expect((await extractPdfText(plain)).text).toBe(FIXTURE_TEXT);

      // …and the stored original is still the encrypted bytes, untouched.
      const original = new Uint8Array(await readFile(unlocked.path));
      expect(Buffer.from(original).equals(Buffer.from(encryptedPdfBytes(USER_PASSWORD_PDF_BASE64)))).toBe(true);
      await expect(extractPdfText(original)).rejects.toBeInstanceOf(DocumentExtractionError);
    },
    60_000,
  );

  ramTest(
    'the agent handoff hands over a path an agent process can actually open',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);
      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      const decryptedPath = unlocked.decrypted!.path;

      const block = await store.buildAttachmentReferenceBlock(SESSION, [stored.manifest.id]);
      // The path the agent is given is the decrypted one — a path it cannot open
      // would be the same as no attachment at all.
      expect(block).toContain(`- ${decryptedPath} (application/pdf`);
      expect(block).toContain('never written to disk');
      expect(block).toContain(`BEGIN KTEAM EXTRACTED TEXT ${stored.manifest.id}`);
      expect(block).toContain(FIXTURE_TEXT);
      expect(block).toContain('This extraction is held in memory only');

      // A SEPARATE PROCESS opens the path the block advertises, exactly as a
      // tmux-hosted agent's Read tool would. This is the whole reason a memfd
      // locator was rejected: `/proc/<pid>/fd/<n>` is unreadable to a non-descendant
      // process under kernel.yama.ptrace_scope=1.
      const reader = Bun.spawnSync([
        process.execPath,
        '-e',
        `const b = new Uint8Array(await Bun.file(${JSON.stringify(decryptedPath)}).arrayBuffer());
       process.stdout.write(JSON.stringify({ bytes: b.byteLength, head: new TextDecoder().decode(b.subarray(0, 5)) }));`,
      ]);
      expect(reader.exitCode).toBe(0);
      expect(JSON.parse(reader.stdout.toString())).toEqual({
        bytes: unlocked.decrypted!.size,
        head: '%PDF-',
      });

      // Owner-only, so no other user on the box can read the plaintext.
      expect((await stat(decryptedPath)).mode & 0o777).toBe(0o600);
    },
    60_000,
  );

  ramTest(
    'no decrypted bytes land in durable storage',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);
      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      const plain = Buffer.from(await readFile(unlocked.decrypted!.path));

      // The decrypted locator is not inside the kteam root at all.
      expect(unlocked.decrypted!.path.startsWith(rootDir)).toBe(false);

      // Exactly two durable files: the manifest and the original, nothing else.
      const durable = await allFiles(rootDir);
      expect(durable.map(file => path.basename(file)).sort()).toEqual(['manifest.json', 'statement.pdf']);

      // Assert on the BYTES, not on the filenames: a decrypted copy written under
      // any name, or its extracted text, would show up here.
      for (const file of durable) {
        const contents = Buffer.from(await readFile(file));
        expect(contents.equals(plain)).toBe(false);
        expect(contents.includes(plain)).toBe(false);
        expect(contents.includes(Buffer.from(FIXTURE_TEXT, 'utf8'))).toBe(false);
        expect(contents.includes(Buffer.from(USER_PASSWORD_PDF_PASSWORD, 'utf8'))).toBe(false);
      }

      // The manifest never learns the password, the plaintext, or the RAM path.
      const manifestPath = durable.find(file => file.endsWith('manifest.json'))!;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      expect(manifest['textExtraction']).toBeUndefined();
      expect(manifest['encrypted']).toEqual({ kind: 'pdf' });
      expect(JSON.stringify(manifest)).not.toContain(unlocked.decrypted!.path);
    },
    60_000,
  );

  ramTest(
    'a wrong password is a named retryable reason that leaves the attachment locked',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);
      const exitCodeBefore = process.exitCode;

      const error = await store.unlock(SESSION, stored.manifest.id, 'not-the-password').then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(errorCode(error)).toBe('wrong_password');
      // qpdf sets process.exitCode = 2 on a wrong password; the Worker keeps that
      // thread-local so the daemon's own exit status is untouched.
      expect(process.exitCode).toBe(exitCodeBefore);
      expect((error as AttachmentError).message).not.toContain('not-the-password');

      const after = await store.get(SESSION, stored.manifest.id);
      expect(after.locked).toBe(true);
      expect(after.decrypted).toBeUndefined();

      // Retryable means retryable: the right password still works afterwards.
      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      expect(unlocked.decrypted!.text).toBe(FIXTURE_TEXT);
    },
    60_000,
  );

  test('an empty password is refused before any decryption is attempted', async () => {
    let attempts = 0;
    const store = newStore({
      pdfDecryptor: async () => {
        attempts += 1;
        return new Uint8Array([0]);
      },
    });
    const stored = await uploadLocked(store);

    expect(errorCode(await store.unlock(SESSION, stored.manifest.id, '').catch(error => error))).toBe('wrong_password');
    expect(attempts).toBe(0);
  }, 30_000);

  test('unlocking an attachment that is not locked is refused', async () => {
    const store = newStore({
      pdfExtractor: async () => ({ method: 'pdfjs', text: 'plain', characters: 5, truncated: false }),
    });
    const stored = await store.upload(SESSION, new TextEncoder().encode('%PDF-1.4\nplain'), {
      filename: 'plain.pdf',
      mime: 'application/pdf',
    });

    expect(errorCode(await store.unlock(SESSION, stored.manifest.id, 'secret').catch(error => error))).toBe(
      'attachment_not_locked',
    );
  });

  test('decryption failures keep their own named reasons', async () => {
    for (const [thrown, expected] of [
      ['unreadable_document', 'decryption_failed'],
      ['decryption_timeout', 'decryption_timeout'],
      ['decrypted_document_too_large', 'attachment_too_large'],
    ] as const) {
      const store = newStore({
        pdfDecryptor: async () => {
          throw new PdfDecryptionError(thrown);
        },
      });
      const stored = await uploadLocked(store, `failure-${thrown}.pdf`);
      expect(errorCode(await store.unlock(SESSION, stored.manifest.id, 'secret').catch(error => error))).toBe(expected);
      expect((await store.get(SESSION, stored.manifest.id)).locked).toBe(true);
    }
  }, 30_000);

  ramTest(
    'a decrypted PDF with no readable text keeps a named failure, not a false success',
    async () => {
      const store = newStore({
        pdfDecryptor: async () => new TextEncoder().encode('%PDF-1.4\nscanned'),
        pdfExtractor: async bytes => {
          if (new TextDecoder().decode(bytes).includes('scanned')) {
            throw new DocumentExtractionError(
              'no_extractable_text',
              'PDF has no extractable text; it looks like a scan',
            );
          }
          throw new DocumentExtractionError('password_protected_document', 'This PDF needs a password to open');
        },
      });
      const stored = await uploadLocked(store);

      const unlocked = await store.unlock(SESSION, stored.manifest.id, 'secret');
      expect(unlocked.decrypted!.extraction).toBeUndefined();
      expect(unlocked.decrypted!.extractionFailure?.code).toBe('no_extractable_text');

      const block = await store.buildAttachmentReferenceBlock(SESSION, [stored.manifest.id]);
      expect(block).toContain('Text extraction failed in kteam (no_extractable_text)');
      expect(block).toContain('The decrypted PDF itself is readable at the path above');
      expect(block).not.toContain('BEGIN KTEAM EXTRACTED TEXT');
    },
    30_000,
  );

  ramTest(
    'locking releases the decrypted copy and the RAM-backed file disappears',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);
      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      const decryptedPath = unlocked.decrypted!.path;
      expect(await Bun.file(decryptedPath).exists()).toBe(true);

      const relocked = await store.lock(SESSION, stored.manifest.id);

      expect(relocked.locked).toBe(true);
      expect(relocked.decrypted).toBeUndefined();
      expect(await Bun.file(decryptedPath).exists()).toBe(false);
      expect(store.unlocked.heldBytes).toBe(0);

      const block = await store.buildAttachmentReferenceBlock(SESSION, [stored.manifest.id]);
      expect(block).toContain('still locked in kteam');
      expect(block).not.toContain(decryptedPath);
    },
    60_000,
  );

  ramTest(
    're-unlocking replaces the previous copy rather than orphaning it',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);
      const first = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      const second = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);

      expect(second.decrypted!.path).not.toBe(first.decrypted!.path);
      expect(await Bun.file(first.decrypted!.path).exists()).toBe(false);
      expect(await Bun.file(second.decrypted!.path).exists()).toBe(true);
      expect(store.unlocked.size).toBe(1);
      expect(store.unlocked.heldBytes).toBe(second.decrypted!.size);
    },
    60_000,
  );

  ramTest(
    'an expired unlock reports locked again and its bytes are gone',
    async () => {
      // A real 1ms TTL raced the decrypt itself — on a loaded box the unlock
      // had already expired by the time it returned. Drive the clock instead,
      // so expiry is the thing under test rather than the machine's speed.
      let clock = Date.now();
      const store = newStore({ unlock: { ttlMs: 60_000, now: () => clock } });
      const stored = await uploadLocked(store);
      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      const decryptedPath = unlocked.decrypted!.path;

      clock += 60_001;

      const expired = await store.get(SESSION, stored.manifest.id);
      expect(expired.locked).toBe(true);
      expect(expired.decrypted).toBeUndefined();
      // The eviction that the expiry triggers is asynchronous; give it a tick.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await Bun.file(decryptedPath).exists()).toBe(false);
    },
    60_000,
  );

  ramTest(
    'the entry bound evicts the oldest decrypted copy',
    async () => {
      const store = newStore({
        unlock: { maxEntries: 1 },
        pdfDecryptor: async () => new TextEncoder().encode('%PDF-1.4\ndecrypted'),
        pdfExtractor: async bytes => {
          if (new TextDecoder().decode(bytes).includes('decrypted')) {
            return { method: 'pdfjs', text: 'decrypted text', characters: 14, truncated: false };
          }
          throw new DocumentExtractionError('password_protected_document', 'This PDF needs a password to open');
        },
      });
      const first = await uploadLocked(store, 'first.pdf');
      const second = await store.upload(SESSION, encryptedPdfBytes(OWNER_PASSWORD_ONLY_PDF_BASE64), {
        filename: 'second.pdf',
        mime: 'application/pdf',
      });

      const firstUnlocked = await store.unlock(SESSION, first.manifest.id, 'secret');
      await store.unlock(SESSION, second.manifest.id, 'secret');

      expect(store.unlocked.size).toBe(1);
      expect(await Bun.file(firstUnlocked.decrypted!.path).exists()).toBe(false);
      expect((await store.get(SESSION, first.manifest.id)).locked).toBe(true);
    },
    30_000,
  );

  ramTest(
    'disposing the store removes every decrypted copy it held',
    async () => {
      const store = newStore();
      const stored = await uploadLocked(store);
      const unlocked = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      const decryptedPath = unlocked.decrypted!.path;

      await store.releaseSession(SESSION);
      expect(await Bun.file(decryptedPath).exists()).toBe(false);

      const again = await store.unlock(SESSION, stored.manifest.id, USER_PASSWORD_PDF_PASSWORD);
      await store.dispose();
      expect(await Bun.file(again.decrypted!.path).exists()).toBe(false);
    },
    60_000,
  );

  test('the unlock flow refuses to run when no memory filesystem is available', async () => {
    // Modelled by a cache whose locator could not resolve a RAM directory. The
    // point is that it names the reason instead of falling back to a disk path.
    const store = newStore({
      unlock: {
        memoryStore: { available: false, dispose: async () => undefined } as unknown as MemoryBackedFileStore,
      },
    });
    const stored = await uploadLocked(store);

    expect(errorCode(await store.unlock(SESSION, stored.manifest.id, 'secret').catch(error => error))).toBe(
      'decryption_unavailable',
    );
    expect((await store.get(SESSION, stored.manifest.id)).locked).toBe(true);
  }, 30_000);
});
