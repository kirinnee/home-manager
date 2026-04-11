#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

import { createDeleteCommand } from './cli/delete';
import { createDescribeCommand } from './cli/describe';
import { createInitCommand } from './cli/init';
import { createLogEventCommand } from './cli/log-event';
import { createLogsCommand } from './cli/logs';
import { createOrgCommand } from './cli/org';
import { createPlanReviewCommand } from './cli/plan-review';
import { createPsCommand } from './cli/ps';
import { createResetCommand } from './cli/reset';
import { createSnapshotCommand } from './cli/snapshot';
import { createSpecReviewCommand } from './cli/spec-review';
import { createInternalStartCommand, createStartCommand } from './cli/start';
import { createStatusCommand } from './cli/status';
import { createStopCommand } from './cli/stop';

const program = new Command();

program.name('kautopilot').description('End-to-end task completion from ticket to merge-ready PR').version(pkg.version);

program
  .addCommand(createInitCommand())
  .addCommand(createStartCommand())
  .addCommand(createInternalStartCommand(), { hidden: true })
  .addCommand(createStatusCommand())
  .addCommand(createDescribeCommand())
  .addCommand(createDeleteCommand())
  .addCommand(createStopCommand())
  .addCommand(createLogsCommand())
  .addCommand(createPsCommand())
  .addCommand(createOrgCommand())
  .addCommand(createSpecReviewCommand())
  .addCommand(createPlanReviewCommand())
  .addCommand(createSnapshotCommand())
  .addCommand(createLogEventCommand())
  .addCommand(createResetCommand());

program.parseAsync(process.argv).then(() => process.exit(0));
