// Token scrubbing. Nothing that reaches a log line, an error message or an HTTP
// error body may carry a Slack token — not even a prefix.

// Slack tokens: xoxp-…, xoxe-…, xoxe.xoxp-…, xoxb-… and friends.
const SLACK_TOKEN_RE = /xox[a-zA-Z]*[.-][A-Za-z0-9._~+/=-]+/g;
// Generic `Bearer <anything>` and token-ish form/JSON fields.
const BEARER_RE = /(Bearer\s+)[^\s"',]+/gi;
const FIELD_RE = /((?:access_token|refresh_token|code|code_verifier)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi;

const secrets = new Set<string>();

/** Remember a live secret so it is scrubbed even if it does not look like a Slack token. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.replace(SLACK_TOKEN_RE, '[redacted]').replace(BEARER_RE, '$1[redacted]').replace(FIELD_RE, '$1[redacted]');
}

export function errorMessage(e: unknown): string {
  return scrub(e instanceof Error ? e.message : String(e));
}

export type Logger = (msg: string) => void;

/** stderr logger (launchd/systemd capture it); every line is scrubbed. */
export const stderrLogger: Logger = msg => {
  process.stderr.write(`${new Date().toISOString()} ${scrub(msg)}\n`);
};
