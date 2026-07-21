#!/usr/bin/env bun
// Entry point - create dependencies and run the CLI

import os from 'os';
import path from 'path';
import { createCli } from './cli';
import { paths, defaultFsService } from './deps';

// Find kfleet-generated agent wrappers (claude-<name>, codex-<name>, …) by
// default: prepend ~/.kfleet/bin to PATH so every spawned agent resolves even if
// the ambient shell PATH doesn't include it.
const kfleetBin = path.join(os.homedir(), '.kfleet', 'bin');
const pathParts = (process.env.PATH ?? '').split(path.delimiter);
if (!pathParts.includes(kfleetBin)) {
  process.env.PATH = [kfleetBin, ...pathParts].join(path.delimiter);
}
import { StateService } from './state/service';
import { createLogsService } from './logs/service';
import { IndexDb, EventLog, PidLock } from './index-db';

const state = new StateService(defaultFsService, paths);
const logs = createLogsService(defaultFsService, paths);
const indexDb = new IndexDb(defaultFsService, paths);
const eventLog = new EventLog(defaultFsService, paths);
const pidLock = new PidLock(defaultFsService, paths);

const program = createCli({ state, logs, indexDb, eventLog, pidLock });
program.parse(process.argv);
