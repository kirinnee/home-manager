#!/usr/bin/env bun
// Entry point - create dependencies and run the CLI

import { createCli } from './cli';
import { paths, defaultFsService } from './deps';
import { StateService } from './state/service';
import { createTmuxService } from './tmux/service';
import { createHistoryService } from './history/service';
import { createLogsService } from './logs/service';

// Create all service instances
const state = new StateService(defaultFsService, paths);
const tmux = createTmuxService();
const history = createHistoryService(defaultFsService, paths);
const logs = createLogsService(defaultFsService, paths);

// Create and run CLI
const program = createCli({ state, tmux, history, logs });
program.parse(process.argv);
