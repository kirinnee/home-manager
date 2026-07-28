#!/usr/bin/env bun

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { startApiServer } from './api-server';
import { EXIT_ALREADY_RUNNING, bindWithRetry, probeExistingDaemon } from './daemon-boot';
import { ensureDaemonToken, ensureWardenToken, loadDaemonConfig } from './daemon-config';
import { DaemonService } from './daemon-service';
import { LearningManager } from './learning';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';
import { createSttService } from './stt-service';
import { PinApi, PinService } from './pins';
import { TaskService } from './tasks';
import { AttentionApi, AttentionService, AttentionSources } from './attention';
import { TaskApi } from './tasks-api';
import { AnalyticsIndex } from './analytics-index';
import { loadDaemonSecretsEnvironment } from './daemon-secrets';
import { PushService } from './push-service';
import { TerminalApi } from './terminal-api';
import { TerminalService } from './terminal-service';

const secretsStatus = loadDaemonSecretsEnvironment();
if (secretsStatus === 'failed') {
  // Keep session control available, but never echo the shell/source error: it
  // can contain a provider credential. Warden health will surface the missing
  // authentication state without exposing values.
  console.error('kteamd: could not load ~/.secrets; provider credentials are unavailable');
}

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

/** How long a shutdown may drain before exiting anyway. The service manager's
 *  own stop timeout is the hard deadline: on 2026-07-23 a close() that awaited
 *  wedged monitor I/O ran past systemd's 90 s and was SIGKILLed, orphaning the
 *  tmux server. Both restart supervisors (systemd Restart=always, launchd
 *  KeepAlive) re-spawn a clean exit, so exiting promptly IS the restart. */
const SHUTDOWN_GRACE_MS = 15_000;

const token = await ensureDaemonToken(paths);
const wardenToken = await ensureWardenToken(paths);
/** Assigned once the server exists; the manager may ask for a restart before then. */
let requestStop: (reason: string) => void = reason => {
  console.error(`kteamd: stopping before startup completed (${reason})`);
  process.exit(0);
};
// A clean exit is only a RESTART when a service manager owns this process. An
// env marker would leak into every child (a daemon started by hand from a
// supervised pane inherits it), so ask the manager whether it owns our pid.
/** Does a service manager own THIS process? Asked when a restart is actually
 *  wanted, not latched at boot: the probe shells out to the service manager,
 *  which on a loaded box is exactly what is slow, and a boot-time false would
 *  disable the repair for the whole process lifetime. Bounded either way — it
 *  must never hold up the bind or a shutdown. */
const supervised = async () =>
  await Promise.race([
    new DaemonService(paths, process.execPath).supervises(process.pid).catch(() => false),
    Bun.sleep(3_000).then(() => false),
  ]);
const manager = await SessionManager.create(paths, {
  healthIntervalSeconds: config.healthIntervalSeconds,
  quotaUrl: config.quotaUrl,
  transcriptReconcileSeconds: config.transcriptReconcileSeconds,
  contextWindows: config.contextWindows,
  publicUrl: config.publicUrl,
  projectRoots: config.projectRoots,
  remoteControl: config.remoteControl,
  warden: config.warden,
  scratch: config.scratch,
  onSelfRestart: async () => {
    if (!(await supervised())) return false;
    requestStop('session index unhealable in place');
    return true;
  },
});
const learning = new LearningManager(paths, config.learning, manager);
// One writable service and one idempotency controller for the daemon lifetime.
// Initialization performs the in-daemon, copy-only legacy migration, so the
// first task request can never observe a half-migrated board and the daemon
// stays the sole writer.
const taskService = new TaskService(paths, manager);
await taskService.initialize();
const taskApi = new TaskApi(taskService);
// One writable pin store + idempotency controller for the daemon lifetime.
const sessionExists = {
  has: async (id: string) =>
    manager.get(id).then(
      () => true,
      () => false,
    ),
};
const pinApi = new PinApi(new PinService(paths, sessionExists));
// Independent human terminals resolve aliases through the same daemon session
// registry, then root each shell in that session's canonical cwd.
const terminalService = new TerminalService(paths, {
  resolve: async ref =>
    manager.get(ref).then(
      view => ({ id: view.config.id, cwd: view.config.cwd }),
      () => undefined,
    ),
});
const terminalApi = new TerminalApi(terminalService);
// Attention is a separate durable primitive; its source adapter listens to the
// existing task/session streams but never presents notifications itself.
const attentionSessions = {
  resolve: async (ref: string) =>
    manager.get(ref).then(
      view => ({
        id: view.config.id,
        name: view.config.teammate ?? view.config.name ?? null,
      }),
      () => null,
    ),
};
const attentionService = new AttentionService(paths, attentionSessions);
const attentionApi = new AttentionApi(attentionService, manager);
const attentionSources = new AttentionSources(attentionService, manager, taskService);
const stt = createSttService({ paths });
const pushService = await PushService.create(paths, manager);
let analytics: AnalyticsIndex | undefined;
// Keep the bind ahead of analytics cold materialization. On a missing index,
// session/event rows are folded by SQLite after the API is already reachable;
// the object is then attached to this options bag in place.
const apiOptions = {
  host: config.host,
  port: config.port,
  token,
  wardenToken,
  service: manager,
  learning,
  stt,
  tasks: taskApi,
  pins: pinApi,
  terminals: terminalApi,
  attention: attentionApi,
  push: pushService.api,
  analytics,
};
// Retry EADDRINUSE: a dying predecessor (service-manager restart) can hold the
// port for seconds while it drains; give it up to 30 s before failing.
const server = await bindWithRetry(() => startApiServer(apiOptions)).catch(async error => {
  attentionSources.close();
  await pushService.close();
  await Promise.allSettled([manager.close(), stt.close(), terminalService.close()]);
  throw error;
});
// Write the pid file only AFTER the bind succeeded — a loser of the bind race
// must never overwrite the live daemon's pid.
await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
console.log(`kteamd listening on http://${config.host}:${server.port} (pid ${process.pid})`);
try {
  analytics = new AnalyticsIndex({ databasePath: paths.database });
  apiOptions.analytics = analytics;
  analytics.start();
} catch (error) {
  // Analytics is additive: an index failure must not take down session control.
  console.error(`kteamd analytics unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

let stopping = false;
const stop = async (reason: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`kteamd stopping (${reason})`);
  server.stop(true);
  learning.stop();
  // BOUNDED drain: monitor loops await tmux and transcript I/O that can hang,
  // and a shutdown that outlives the service manager's timeout is SIGKILLed
  // mid-write. Give the drain a deadline and exit cleanly either way.
  const drained = await Promise.race([
    (async () => {
      // Stop accepting status events before the manager closes; then drain any
      // already-encrypted outbound attempts within the shared grace period.
      attentionSources.close();
      await pushService.close();
      await Promise.all([
        manager.close(),
        stt.close(),
        terminalService.close(),
        ...(analytics ? [analytics.close()] : []),
      ]);
      return true;
    })(),
    Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
  ]).catch(error => {
    console.error(`kteamd: shutdown drain failed: ${String(error)}`);
    return false;
  });
  if (!drained) console.error(`kteamd: shutdown drain exceeded ${SHUTDOWN_GRACE_MS}ms — exiting anyway`);
  await rm(paths.pid, { force: true }).catch(() => undefined);
  process.exit(0);
};
// Bound BEFORE bootstrap: the self-check timer is armed in create() and can
// ask for a restart at t=60 s, long before a cold boot finishes indexing.
requestStop = reason => void stop(reason);
process.on('SIGINT', () => {
  void stop('SIGINT');
});
process.on('SIGTERM', () => {
  void stop('SIGTERM');
});
// Index journals + recover sessions AFTER listen: the scan of ~1000 session
// directories must never block the bind (the old 80 s cold-boot window).
// bootstrap() isolates phase failures internally; this catch is the LAST
// resort — an unexpected throw must not take down a listening daemon, and
// must never be silent (2026-07-23 silent-partial-boot incident).
try {
  await manager.bootstrap();
  await attentionSources.start();
  await learning.start().catch(error => console.error(`kteamd: learning start failed: ${String(error)}`));
  const problems = manager.bootstrapErrors.length;
  console.log(
    problems === 0
      ? 'kteamd bootstrap complete (journals indexed, sessions reconciled)'
      : `kteamd bootstrap DEGRADED: ${problems} error(s) — see /v1/health bootstrapErrorMessages`,
  );
} catch (error) {
  console.error(`kteamd bootstrap crashed (daemon stays up; self-check will repair): ${String(error)}`);
}
