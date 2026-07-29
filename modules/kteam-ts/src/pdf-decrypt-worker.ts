/**
 * One-shot qpdf-WASM decryption worker.
 *
 * Everything here is deliberately isolated in a Worker rather than run inline:
 *
 * - qpdf's emscripten build binds its `print`/`printErr` to `console.log` /
 *   `console.error` BEFORE it applies the caller's module options, so the
 *   documented `print`/`printErr` options are ignored. The parser's diagnostics
 *   ("invalid password", structural complaints about hostile files) would go
 *   straight to daemon stderr. This worker overrides both console methods before
 *   the dynamic import, which is the only interception point that works.
 * - The same build's `quit_` is `(status, error) => { process.exitCode = status;
 *   throw error }`. A wrong password therefore sets `process.exitCode = 2`. In a
 *   Bun Worker `process.exitCode` is thread-local, so the poisoned code dies with
 *   the worker instead of making the daemon exit non-zero later.
 * - Input bytes, the password, the WASM MEMFS and the decrypted output all live
 *   in this worker's heap. Terminating it after one attempt is the cheapest
 *   guarantee that none of it outlives the request.
 */
import { fileURLToPath } from 'node:url';

interface QpdfRuntime {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

/** The published types describe only `locateFile`; `noInitialRun` is read by the
 * generated module (verified against dist/qpdf.js) and is what keeps `callMain`
 * under our control. */
type QpdfFactory = (options: { locateFile(): string; noInitialRun: boolean }) => Promise<QpdfRuntime>;

export interface PdfDecryptWorkerRequest {
  input: ArrayBuffer;
  password: string;
  maxOutputBytes: number;
}

export type PdfDecryptWorkerFailureCode = 'wrong_password' | 'unreadable_document' | 'decrypted_document_too_large';

export type PdfDecryptWorkerResponse =
  | { ok: true; output: ArrayBuffer }
  | { ok: false; code: PdfDecryptWorkerFailureCode };

const MAX_DIAGNOSTIC_CHARACTERS = 4_000;
const MAX_DIAGNOSTIC_LINE = 1_000;

const diagnostics: string[] = [];
let diagnosticCharacters = 0;

/** Diagnostics are classified, never forwarded: a hostile PDF must not be able
 * to write attacker-chosen text into the daemon's log stream. */
function collectDiagnostic(...parts: unknown[]): void {
  if (diagnosticCharacters >= MAX_DIAGNOSTIC_CHARACTERS) return;
  const line = parts
    .map(part => String(part))
    .join(' ')
    .slice(0, MAX_DIAGNOSTIC_LINE);
  diagnostics.push(line);
  diagnosticCharacters += line.length;
}

console.log = collectDiagnostic;
console.error = collectDiagnostic;
console.warn = collectDiagnostic;
console.info = collectDiagnostic;

const QPDF_WASM_PATH = fileURLToPath(new URL('./qpdf.wasm', import.meta.resolve('@neslinesli93/qpdf-wasm')));

const INPUT_PATH = '/input.pdf';
const OUTPUT_PATH = '/output.pdf';
const PASSWORD_PATH = '/password';

/** qpdf exits 0 on success and 3 when it succeeded with warnings; a warning on a
 * file we are only unwrapping is not a reason to refuse the result. */
const QPDF_SUCCESS_STATUS = new Set([0, 3]);

const WRONG_PASSWORD = /invalid password|incorrect password|password.{0,20}is incorrect|password is not correct/i;

/**
 * `postMessage` inside a Bun/DOM worker is `(message: T, transfer?: Transferable[])`,
 * but the ambient worker `self` is typed with the window overload in this project's
 * lib set, which is what made the previous attempt fail to typecheck. Narrow it once,
 * here, instead of casting at every call site.
 */
const post = (message: PdfDecryptWorkerResponse, transfer: Transferable[] = []): void => {
  (postMessage as (message: unknown, transfer?: Transferable[]) => void)(message, transfer);
};

declare const self: { onmessage: ((event: MessageEvent<PdfDecryptWorkerRequest>) => void) | null };

self.onmessage = async (event: MessageEvent<PdfDecryptWorkerRequest>): Promise<void> => {
  const request = event.data;
  if (
    !(request?.input instanceof ArrayBuffer) ||
    typeof request.password !== 'string' ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0
  ) {
    post({ ok: false, code: 'unreadable_document' });
    return;
  }

  let passwordBytes: Uint8Array | undefined;
  let qpdf: QpdfRuntime | undefined;
  try {
    const { default: createQpdf } = await import('@neslinesli93/qpdf-wasm');
    qpdf = await (createQpdf as unknown as QpdfFactory)({
      locateFile: () => QPDF_WASM_PATH,
      noInitialRun: true,
    });

    qpdf.FS.writeFile(INPUT_PATH, new Uint8Array(request.input));
    // The password reaches qpdf through a MEMFS file rather than argv so it
    // never appears in a command line, a process listing, or a diagnostic echo.
    passwordBytes = new TextEncoder().encode(request.password);
    qpdf.FS.writeFile(PASSWORD_PATH, passwordBytes);

    const status = qpdf.callMain([`--password-file=${PASSWORD_PATH}`, '--decrypt', INPUT_PATH, OUTPUT_PATH]);
    if (!QPDF_SUCCESS_STATUS.has(status)) {
      const detail = diagnostics.join('\n');
      post({ ok: false, code: WRONG_PASSWORD.test(detail) ? 'wrong_password' : 'unreadable_document' });
      return;
    }

    const output = qpdf.FS.readFile(OUTPUT_PATH);
    if (output.byteLength === 0) {
      post({ ok: false, code: 'unreadable_document' });
      return;
    }
    if (output.byteLength > request.maxOutputBytes) {
      post({ ok: false, code: 'decrypted_document_too_large' });
      return;
    }
    // `slice()` copies out of the WASM heap into a transferable buffer; the heap
    // copy dies with the worker moments later.
    const copy = output.slice();
    post({ ok: true, output: copy.buffer as ArrayBuffer }, [copy.buffer as ArrayBuffer]);
  } catch {
    post({ ok: false, code: 'unreadable_document' });
  } finally {
    passwordBytes?.fill(0);
    // Best effort: the worker is terminated by the host immediately after this
    // message, but do not leave plaintext sitting in MEMFS if that ever slips.
    try {
      qpdf?.FS.unlink(PASSWORD_PATH);
    } catch {
      /* the password file may never have been written */
    }
    try {
      qpdf?.FS.unlink(OUTPUT_PATH);
    } catch {
      /* qpdf may have failed before producing output */
    }
  }
};
