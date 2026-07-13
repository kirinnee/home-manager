#!/usr/bin/env bun

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { startApiServer } from './api-server';
import { ensureDaemonToken, loadDaemonConfig } from './daemon-config';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';

const paths = createPaths();
await mkdir(paths.daemon, { recursive: true, mode: 0o700 });

if (existsSync(paths.pid)) {
  const previous = Number((await readFile(paths.pid, 'utf8').catch(() => '')).trim());
  if (Number.isFinite(previous) && previous > 1) {
    try {
      process.kill(previous, 0);
      console.error(`kteamd is already running (pid ${previous})`);
      process.exit(1);
    } catch {}
  }
}

await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
const config = await loadDaemonConfig(paths);
const token = await ensureDaemonToken(paths);
const manager = await SessionManager.create(paths, {
  healthIntervalSeconds: config.healthIntervalSeconds,
  quotaUrl: config.quotaUrl,
  transcriptReconcileSeconds: config.transcriptReconcileSeconds,
  publicUrl: config.publicUrl,
});
const server = startApiServer({ host: config.host, port: config.port, token, service: manager });
console.log(`kteamd listening on http://${config.host}:${server.port} (pid ${process.pid})`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await manager.close();
  await rm(paths.pid, { force: true });
  process.exit(0);
};
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
