// The ONE on-disk copy of the rotating Slack token set. Atomic writes only:
// a torn file would lose the single-use refresh token for good.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** epoch ms; absent = unknown expiry */
  expires_at?: number;
  scope?: string;
  token_type?: string;
  user_id?: string;
  team_id?: string;
  team_name?: string;
  /** OAuth context the refresh needs */
  client_id: string;
  token_endpoint: string;
  resource?: string;
  obtained_at: number;
  last_refresh_at?: number;
}

export class TokenStore {
  constructor(readonly file: string) {}

  get dir(): string {
    return path.dirname(this.file);
  }

  /** null when not logged in. Throws on a corrupt file rather than guessing. */
  read(): TokenSet | null {
    if (!existsSync(this.file)) return null;
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as TokenSet;
    if (!parsed || typeof parsed.access_token !== 'string') throw new Error(`token file is malformed: ${this.file}`);
    return parsed;
  }

  /** mtime in ms, or null when absent — lets `serve` notice a fresh `login`. */
  mtime(): number | null {
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return null;
    }
  }

  /** write temp (0600) + fsync + rename, inside a 0700 dir. */
  write(tokens: TokenSet): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = path.join(this.dir, `.token.${process.pid}.${randomUUID()}.tmp`);
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(tokens, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  delete(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file, { force: true });
    return true;
  }
}
