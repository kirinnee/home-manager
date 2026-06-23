import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PORT } from './serve';

// ============================================================================
// `kloop dash <up|down|restart|logs>` — a dockerized, always-on web dashboard
// for ~/.kloop. Stock `oven/bun:1` container that bind-mounts the module root
// and the host's ~/.kloop (read-only) and runs `kloop serve` inside. Live reload
// works over the bind mount (mtime-polled SSE). For a foreground server without
// Docker, use `kloop serve`.
// ============================================================================

const PROJECT = 'kloop';
const CONTAINER_NAME = 'kloop-viewer';

// Resolves to the kloop-ts module root (has src/ + package.json) in both dev and
// the installed layout.
const moduleRoot = path.resolve(import.meta.dir, '../..');

function serveDir(): string {
  return path.join(homedir(), '.kloop', '.serve');
}

function composePath(): string {
  return path.join(serveDir(), 'docker-compose.yml');
}

function dockerAvailable(): boolean {
  const proc = Bun.spawnSync({
    cmd: ['docker', '--version'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return proc.success;
}

function writeComposeFile(port: number, host?: string): string {
  const home = homedir();
  mkdirSync(serveDir(), { recursive: true });
  // G5: bind the published port to localhost unless an explicit --host is given.
  const portMapping = host ? `${host}:${port}:${port}` : `127.0.0.1:${port}:${port}`;
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
      - "${home}/.kloop:/data/.kloop:ro"
    command: ["bun","run","/app/src/index.ts","serve","--host","0.0.0.0","--port","${port}"]
    restart: unless-stopped
    stop_grace_period: 1s
`;
  const file = composePath();
  writeFileSync(file, yaml);
  return file;
}

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
    console.error(pc.red('docker not found — run `kloop serve` to serve directly without Docker.'));
    process.exit(1);
  }
  const file = writeComposeFile(port, opts.host);
  const code = await dockerCompose(['-p', PROJECT, '-f', file, 'up', '-d', '--remove-orphans']);
  if (code !== 0) {
    console.error(pc.red('docker compose up failed'));
    process.exit(code);
  }
  console.log(pc.green(`kloop dashboard on http://localhost:${port}`));
  console.log(pc.dim(`container: ${CONTAINER_NAME}`));
  console.log(pc.dim('kloop dash logs      follow logs'));
  console.log(pc.dim('kloop dash restart   restart server (pick up edited src/)'));
  console.log(pc.dim('kloop dash down      stop and remove'));
}

export function createDashCommand(): Command {
  const dash = new Command('dash').description('Dockerized always-on web dashboard for ~/.kloop (read-only)');

  dash
    .command('up')
    .description('Start the dashboard container')
    .option('--port <n>', 'Port to listen on', v => Number.parseInt(v, 10))
    .option('--host <h>', 'Host to bind the published port')
    .action(async (opts: { port?: number; host?: string }) => {
      try {
        await dashUp(opts);
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  dash
    .command('down')
    .description('Stop and remove the dashboard container')
    .action(async () => {
      try {
        // `-t 1`: stateless read-only server, don't wait the 10s SIGTERM grace.
        await dockerCompose(['-p', PROJECT, '-f', composePath(), 'down', '-t', '1']);
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  dash
    .command('restart')
    .description('Restart the dashboard server (picks up edited src/ — fast)')
    .action(async () => {
      try {
        if (!existsSync(composePath())) {
          console.error(pc.red('no dashboard running — start it with `kloop dash up`.'));
          process.exit(1);
        }
        const code = await dockerCompose(['-p', PROJECT, '-f', composePath(), 'restart', '-t', '1']);
        if (code !== 0) {
          console.error(pc.red('docker compose restart failed'));
          process.exit(code);
        }
        console.log(pc.green('dashboard restarted'));
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
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
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  dash.action(() => {
    dash.help();
  });

  return dash;
}
