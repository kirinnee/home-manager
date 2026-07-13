#!/usr/bin/env bun
// kfleet — generate & manage a fleet of claude/codex wrappers
// from a single ~/.kfleet/config.yaml. Replaces the Nix multi-* agent modules.
import { Command } from 'commander';
import { createDoctorCommand } from './cli/doctor';
import { createApplyCommand, createListCommand, createPruneCommand } from './cli/fleet';
import { createHealthCommand } from './cli/health';
import { createInitCommand } from './cli/init';
import { createLoginCommand } from './cli/login';
import { createServeCommand } from './cli/serve';
import { createServiceCommand } from './cli/service';
import { createUsageCommand } from './cli/usage';

const program = new Command();
program
  .name('kfleet')
  .description('YAML-driven fleet of claude/codex wrappers')
  .addCommand(createInitCommand())
  .addCommand(createApplyCommand())
  .addCommand(createListCommand())
  .addCommand(createPruneCommand())
  .addCommand(createLoginCommand())
  .addCommand(createDoctorCommand())
  .addCommand(createHealthCommand())
  .addCommand(createUsageCommand())
  .addCommand(createServeCommand())
  .addCommand(createServiceCommand());

program.parseAsync(process.argv);
