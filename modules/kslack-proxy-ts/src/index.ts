#!/usr/bin/env bun
// kslack-proxy — one Slack MCP login per machine, shared by every Claude + Codex
// account. See README.md.
import { Command } from 'commander';
import { PortBusyError, login } from './login';
import { loadConfig } from './paths';
import { createProxy } from './proxy';
import { errorMessage, stderrLogger } from './redact';
import { formatStatus, status } from './status';
import { TokenStore } from './store';
import { TokenManager } from './tokens';

const program = new Command();
program
  .name('kslack-proxy')
  .description('Local Slack MCP proxy: owns ONE rotating Slack login and serves it read-only on 127.0.0.1');

const fail = (e: unknown): never => {
  console.error(`kslack-proxy: ${errorMessage(e)}`);
  process.exit(1);
};

program
  .command('login')
  .description('log in to Slack MCP in the browser (OAuth PKCE, callback on localhost:3118)')
  .option('--no-browser', 'only print the URL')
  .option('--all-scopes', 'request every scope Slack offers (default: read scopes only)')
  .action(async (opts: { browser: boolean; allScopes?: boolean }) => {
    const cfg = loadConfig();
    const store = new TokenStore(cfg.tokenPath);
    try {
      const t = await login({ store, upstream: cfg.upstream, openBrowser: opts.browser, allScopes: opts.allScopes });
      console.log(
        `\n✓ logged in${t.user_id ? ` as ${t.user_id}` : ''}${t.team_name ? ` @ ${t.team_name}` : ''}; token saved to ${store.file}`,
      );
      console.log('  the running `kslack-proxy serve` picks it up automatically — check with `kslack-proxy status`.');
      process.exit(0);
    } catch (e) {
      if (e instanceof PortBusyError) console.error(`kslack-proxy: ${e.message}`);
      else fail(e);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('serve MCP on http://127.0.0.1:<port>/mcp (KSLACK_PROXY_PORT, default 37373)')
  .option('-p, --port <port>', 'port (overrides KSLACK_PROXY_PORT)')
  .action((opts: { port?: string }) => {
    const cfg = loadConfig(opts.port ? { ...process.env, KSLACK_PROXY_PORT: opts.port } : process.env);
    const tokens = new TokenManager({ store: new TokenStore(cfg.tokenPath), log: stderrLogger });
    const handler = createProxy({ tokens, upstream: cfg.upstream, allowWrites: cfg.allowWrites, log: stderrLogger });
    try {
      // idleTimeout 0: GET /mcp is a long-lived SSE stream.
      Bun.serve({ hostname: '127.0.0.1', port: cfg.port, idleTimeout: 0, fetch: handler });
    } catch (e) {
      fail(
        new Error(
          `cannot listen on 127.0.0.1:${cfg.port}: ${errorMessage(e)} (lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN)`,
        ),
      );
    }
    let loggedIn = false;
    try {
      loggedIn = tokens.current() !== null;
    } catch (e) {
      stderrLogger(`token file unreadable: ${errorMessage(e)}`);
    }
    stderrLogger(
      `kslack-proxy listening on http://127.0.0.1:${cfg.port}/mcp → ${cfg.upstream} (${cfg.allowWrites ? 'WRITES ALLOWED' : 'read-only'}; ${loggedIn ? 'logged in' : 'NOT logged in — run `kslack-proxy login`'})`,
    );
  });

program
  .command('status')
  .description(
    'show login state, token expiry, last refresh and whether the service is listening (never prints tokens)',
  )
  .option('--json', 'machine-readable output')
  .option('--no-verify', 'skip the Slack auth.test identity check')
  .action(async (opts: { json?: boolean; verify: boolean }) => {
    const cfg = loadConfig();
    const r = await status(cfg, new TokenStore(cfg.tokenPath), { verify: opts.verify });
    console.log(opts.json ? JSON.stringify(r, null, 2) : formatStatus(r));
  });

program
  .command('logout')
  .description('delete the stored Slack tokens')
  .action(() => {
    const cfg = loadConfig();
    const removed = new TokenStore(cfg.tokenPath).delete();
    console.log(removed ? `✓ removed ${cfg.tokenPath}` : 'not logged in (no token file)');
  });

program.parseAsync(process.argv).catch(fail);
