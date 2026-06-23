import pc from 'picocolors';
import { createFetch } from '../server/routes';
import type { CliDeps } from './index';

// `kloop serve` — a foreground Bun web viewer for ~/.kloop. Same mechanics as
// the kautopilot dashboard (SSE live-reload + log tailing). For an always-on
// dockerized version, use `kloop dash`.

export const DEFAULT_PORT = 47316;

export async function handler(opts: { port?: string; host?: string }, deps: CliDeps): Promise<void> {
  const port = opts.port ? Number.parseInt(opts.port, 10) : DEFAULT_PORT;
  // G5: bind localhost unless an explicit --host is given (dash passes 0.0.0.0).
  const host = opts.host ?? '127.0.0.1';
  const fetch = createFetch(deps);
  // idleTimeout must exceed the SSE heartbeat (15s) — Bun's default 10s otherwise
  // kills the live-reload stream and any slow request over a large ~/.kloop. Max is 255s.
  Bun.serve({ port, hostname: host, fetch, idleTimeout: 240 });
  console.log(pc.green(`kloop web UI on http://${host}:${port}`));
  console.log(pc.dim('Reading ~/.kloop live. Ctrl-C to stop.'));
  await new Promise(() => {
    /* run until killed */
  });
}
