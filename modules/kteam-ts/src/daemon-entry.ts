#!/usr/bin/env bun

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { startApiServer } from './api-server';
import { EXIT_ALREADY_RUNNING, bindWithRetry, probeExistingDaemon } from './daemon-boot';
import { ensureDaemonToken, ensureWardenToken, loadDaemonConfig } from './daemon-config';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';

const paths = createPaths();
await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
const config = await loadDaemonConfig(paths);

// The PORT is the real single-instance lock (the old pid-file check was TOCTOU
// and let concurrent starters race the bind — see daemon-boot.ts). A live
// responder on the configured address means a daemon is already serving.
const probeToken = (await readFile(paths.token, 'utf8').catch(() => '')).trim() || undefined;
if (await probeExistingDaemon({ url: `http://${config.host}:${config.port}`, token: probeToken })) {
  console.error(`kteamd is already running at http://${config.host}:${config.port}`);
  // Distinct exit status: the systemd unit lists it in RestartPreventExitStatus
  // so Restart=always does not re-spawn every RestartSec against a healthy
  // standalone daemon that legitimately owns the port.
  process.exit(EXIT_ALREADY_RUNNING);
}

const token = await ensureDaemonToken(paths);
const wardenToken = await ensureWardenToken(paths);
const manager = await SessionManager.create(paths, {
  healthIntervalSeconds: config.healthIntervalSeconds,
  quotaUrl: config.quotaUrl,
  transcriptReconcileSeconds: config.transcriptReconcileSeconds,
  contextWindows: config.contextWindows,
  publicUrl: config.publicUrl,
  projectRoots: config.projectRoots,
  warden: config.warden,
});
// Retry EADDRINUSE: a dying predecessor (service-manager restart) can hold the
// port for seconds while it drains; give it up to 30 s before failing.
const server = await bindWithRetry(() =>
  startApiServer({ host: config.host, port: config.port, token, wardenToken, service: manager }),
).catch(async error => {
  await manager.close();
  throw error;
});
// Write the pid file only AFTER the bind succeeded — a loser of the bind race
// must never overwrite the live daemon's pid.
await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
console.log(`kteamd listening on http://${config.host}:${server.port} (pid ${process.pid})`);
// Index journals + recover sessions AFTER listen: the scan of ~1000 session
// directories must never block the bind (the old 80 s cold-boot window).
// bootstrap() isolates phase failures internally; this catch is the LAST
// resort — an unexpected throw must not take down a listening daemon, and
// must never be silent (2026-07-23 silent-partial-boot incident).
try {
  await manager.bootstrap();
  const problems = manager.bootstrapErrors.length;
  console.log(
    problems === 0
      ? 'kteamd bootstrap complete (journals indexed, sessions reconciled)'
      : `kteamd bootstrap DEGRADED: ${problems} error(s) — see /v1/health bootstrapErrorMessages`,
  );
} catch (error) {
  console.error(`kteamd bootstrap crashed (daemon stays up; self-check will repair): ${String(error)}`);
}

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
