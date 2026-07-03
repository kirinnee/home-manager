#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { logError } from "./util/format";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
	readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

import { createCompleteCommand } from "./cli/complete";
import { createConfigCommand } from "./cli/config";
import { createDashCommand } from "./cli/dash";
import { createDeleteCommand } from "./cli/delete";
import { createDiffCommand } from "./cli/diff";
import { createLogEventCommand } from "./cli/log-event";
import { createLogsCommand } from "./cli/logs";
import { createNextCommand } from "./cli/next";
import { createOrgCommand } from "./cli/org";
import { createPsCommand } from "./cli/ps";
import { createRecordCommand } from "./cli/record";
import { createResetCommand } from "./cli/reset";
import { createReviseCommand } from "./cli/revise";
import { createScheduleCommand } from "./cli/schedule";
import { createServeCommand } from "./cli/serve";
import { createServiceCommand } from "./cli/service";
import { createStartCommand } from "./cli/start";
import { createStatusCommand } from "./cli/status";
import { createStopCommand } from "./cli/stop";

const program = new Command();

program
	.name("kautopilot")
	.description("End-to-end task completion from ticket to merge-ready PR")
	.version(pkg.version);

program
	.addCommand(createStartCommand())
	.addCommand(createNextCommand())
	.addCommand(createCompleteCommand())
	.addCommand(createReviseCommand())
	.addCommand(createScheduleCommand())
	.addCommand(createRecordCommand())
	.addCommand(createDiffCommand())
	.addCommand(createStatusCommand())
	.addCommand(createDeleteCommand())
	.addCommand(createStopCommand())
	.addCommand(createLogsCommand())
	.addCommand(createPsCommand())
	.addCommand(createOrgCommand())
	.addCommand(createLogEventCommand())
	.addCommand(createConfigCommand())
	.addCommand(createResetCommand())
	.addCommand(createServeCommand())
	.addCommand(createServiceCommand())
	.addCommand(createDashCommand());

program
	.parseAsync(process.argv)
	.then(() => process.exit(0))
	.catch((err: unknown) => {
		logError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
