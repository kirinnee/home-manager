#!/usr/bin/env bun
// Entry point - create dependencies and run the CLI

import { createCli } from './cli';
import { paths, defaultFsService } from './deps';
import { StateService } from './state/service';
import { createTmuxService } from './tmux/service';
import { createLogsService } from './logs/service';
import { IndexDb, EventLog, PidLock } from './index-db';

const state = new StateService(defaultFsService, paths);
const tmux = createTmuxService();
const logs = createLogsService(defaultFsService, paths);
const indexDb = new IndexDb(defaultFsService, paths);
const eventLog = new EventLog(defaultFsService, paths);
const pidLock = new PidLock(defaultFsService, paths);

const program = createCli({ state, tmux, logs, indexDb, eventLog, pidLock });
program.parse(process.argv);
