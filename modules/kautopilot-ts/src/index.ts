#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Command } from 'commander';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
import { createInitCommand } from './cli/init';
import { createStartCommand } from './cli/start';
import { createStatusCommand } from './cli/status';
import { createDescribeCommand } from './cli/describe';
import { createStopCommand } from './cli/stop';
import { createLogsCommand } from './cli/logs';
import { createPsCommand } from './cli/ps';
import { createOrgCommand } from './cli/org';
import { createSpecReviewCommand } from './cli/spec-review';
import { createPlanReviewCommand } from './cli/plan-review';
import { createLogEventCommand } from './cli/log-event';
import { createResetCommand } from './cli/reset';

const program = new Command();

program.name('kautopilot').description('End-to-end task completion from ticket to merge-ready PR').version(pkg.version);

program
  .addCommand(createInitCommand())
  .addCommand(createStartCommand())
  .addCommand(createStatusCommand())
  .addCommand(createDescribeCommand())
  .addCommand(createStopCommand())
  .addCommand(createLogsCommand())
  .addCommand(createPsCommand())
  .addCommand(createOrgCommand())
  .addCommand(createSpecReviewCommand())
  .addCommand(createPlanReviewCommand())
  .addCommand(createLogEventCommand())
  .addCommand(createResetCommand());

program.parseAsync(process.argv).then(() => process.exit(0));
