import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { logError, logInfo, logOk } from '../util/format';

// ============================================================================
// `kautopilot dash <up|down|logs>` — a dockerized, always-on dashboard for
// ~/.kautopilot. It runs a stock `oven/bun:1` container (visible in
// `docker ps`) that bind-mounts the module root and the host's ~/.kautopilot
// (read-only) and runs `kautopilot serve` inside. Live reload works over the
// bind mount: the SSE /api/events endpoint polls the store fingerprint by
// mtime, so host edits propagate into the read-only-mounted container.
//
// For a quick foreground server without Docker, use `kautopilot serve`.
// ============================================================================

const DEFAULT_PORT = 47317;
const PROJECT = 'kautopilot';
const CONTAINER_NAME = 'kautopilot-viewer';

// Resolves to a dir that has `src/` + `node_modules/` + `package.json` in BOTH
// dev (modules/kautopilot-ts/) and the installed layout ($out/lib/kautopilot/).
const moduleRoot = path.resolve(import.meta.dir, '../..');

function serveDir(): string {
  return path.join(homedir(), '.kautopilot', '.serve');
}

function composePath(): string {
  return path.join(serveDir(), 'docker-compose.yml');
}

/** True when a `docker` binary is on PATH. */
function dockerAvailable(): boolean {
  const proc = Bun.spawnSync({
    cmd: ['docker', '--version'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return proc.success;
}

/**
 * Write the generated compose file (no image build — stock oven/bun:1 with the
 * module root bind-mounted) and return its path.
 */
function writeComposeFile(port: number, host?: string): string {
  const home = homedir();
  mkdirSync(serveDir(), { recursive: true });
  const portMapping = host ? `${host}:${port}:${port}` : `${port}:${port}`;
  const yaml = `services:
  viewer:
    image: oven/bun:1
    container_name: ${CONTAINER_NAME}
    working_dir: /app
    ports: ["${portMapping}"]
    environment:
      HOME: /data
    volumes:
      - "${moduleRoot}:/app:ro"
      - "${home}/.kautopilot:/data/.kautopilot:ro"
    command: ["bun","run","/app/src/index.ts","serve","--host","0.0.0.0","--port","${port}"]
    restart: unless-stopped
`;
  const file = composePath();
  writeFileSync(file, yaml);
  return file;
}

/** Run `docker compose ...` inheriting stdio; returns the exit code. */
async function dockerCompose(args: string[]): Promise<number> {
  const proc = Bun.spawn({
    cmd: ['docker', 'compose', ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

async function dashUp(opts: { port?: number; host?: string }): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  if (!dockerAvailable()) {
    logError('docker not found — run `kautopilot serve` to serve directly without Docker.');
    process.exit(1);
  }

  const file = writeComposeFile(port, opts.host);
  const code = await dockerCompose(['-p', PROJECT, '-f', file, 'up', '-d', '--remove-orphans']);
  if (code !== 0) {
    logError('docker compose up failed');
    process.exit(code);
  }

  logOk(`kautopilot dashboard on http://localhost:${port}`);
  logInfo(`container: ${CONTAINER_NAME}`);
  logInfo('kautopilot dash logs   follow logs');
  logInfo('kautopilot dash down   stop and remove');
}

export function createDashCommand(): Command {
  const dash = new Command('dash').description('Dockerized always-on web dashboard for ~/.kautopilot (read-only)');

  dash
    .command('up')
    .description('Start the dashboard container')
    .option('--port <n>', 'Port to listen on', v => Number.parseInt(v, 10))
    .option('--host <h>', 'Host to bind the published port')
    .action(async (opts: { port?: number; host?: string }) => {
      try {
        await dashUp(opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  dash
    .command('down')
    .description('Stop and remove the dashboard container')
    .action(async () => {
      try {
        await dockerCompose(['-p', PROJECT, '-f', composePath(), 'down']);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  dash
    .command('logs')
    .description('Follow the dashboard container logs')
    .action(async () => {
      try {
        await dockerCompose(['-p', PROJECT, '-f', composePath(), 'logs', '-f']);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Bare `kautopilot dash` → show subcommand help.
  dash.action(() => {
    dash.help();
  });

  return dash;
}
