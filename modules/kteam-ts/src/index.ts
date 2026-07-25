#!/usr/bin/env bun

import { Command, Option } from 'commander';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { ApiClient } from './api-client';
import {
  discoverAutoAgents,
  recommendTeam,
  resolveDisplayModel,
  type AgentUsage,
  type Budget,
  type TeamRole,
} from './core';
import { DaemonService } from './daemon-service';
import { resolveBinary } from './harness';
import { createPaths } from './paths';
import { SIGNAL_KINDS } from './types';
import type { KTeamEvent, SessionStatus, SignalKind } from './types';
import { compactUsageQuota, fetchKfleetUsage, UsageFeed, usageQuotaLabel } from './usage';

const VERSION = '0.2.1';
const paths = createPaths();
process.env.PATH = [paths.kfleetBin, process.env.PATH ?? ''].join(path.delimiter);
// Background/automation shells sometimes carry HTTP(S)_PROXY vars the
// interactive shell doesn't; a proxy in front of 127.0.0.1 makes the daemon
// look dead even though it never went down. Loopback must never be proxied.
for (const key of ['NO_PROXY', 'no_proxy']) {
  const entries = new Set((process.env[key] ?? '').split(',').filter(Boolean));
  entries.add('127.0.0.1').add('localhost').add('::1');
  process.env[key] = [...entries].join(',');
}

const client = async () => await ApiClient.connect(paths);
const daemonBinary = process.env.KTEAMD_BIN ?? resolveBinary('kteamd') ?? 'kteamd';
const daemon = new DaemonService(paths, daemonBinary);
const terminal: SessionStatus[] = ['completed', 'failed', 'stalled', 'stopped'];

async function waitForDaemon(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await (await client()).health();
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`kteamd did not become ready; inspect ${paths.daemonLog}`);
}

function printView(view: Awaited<ReturnType<ApiClient['get']>>): void {
  console.log(
    `${view.config.teammate ?? '-'} (${view.config.id})  ${view.state.status}  ${view.config.binary}  model=${resolveDisplayModel(view.config.binary, view.config.model, view.state.observedModel).model}${view.config.label ? `  label=${view.config.label}` : ''}${view.config.parent ? `  parent=${view.config.parent}` : ''}  ${view.config.mode}  turn ${view.state.turn}`,
  );
  console.log(`  ${view.config.cwd}`);
  const quota = usageQuotaLabel(view.state);
  const vitals = [
    view.state.contextPercent !== undefined ? `context ${view.state.contextPercent}% used` : '',
    quota ? `quota ${quota}` : '',
    view.state.lastToolStartedAt ? `last tool started ${view.state.lastToolStartedAt}` : '',
  ].filter(Boolean);
  if (vitals.length) console.log(`  ${vitals.join('  ')}`);
  // A6 liveness ledger: seconds since each life-sign. Pane change is
  // visibility only; the reflex MIN rule runs over the first three.
  const age = (value?: string) =>
    value ? `${Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000))}s` : '-';
  const ledger = [
    `transcript ${age(view.state.lastTranscriptAt)}`,
    `counters ${age(view.state.lastCounterAdvanceAt)}`,
    `tokens ${age(view.state.lastTokenAdvanceAt)}`,
    `subprocess ${age(view.state.lastSubprocessAt)}`,
    `pane ${age(view.state.lastPaneAt)}`,
  ];
  console.log(`  liveness: ${ledger.join('  ')}${view.state.nudgedAt ? '  ⚠ nudged' : ''}`);
  if (view.state.waiting)
    console.log(
      `  ⏸ DECLARED WAIT: ${view.state.waiting.condition ?? 'external condition'}` +
        `${view.state.waiting.until ? ` until ${view.state.waiting.until}` : ' (open-ended)'}` +
        ' — parked on purpose; idle-kill and the turn ceiling are suspended',
    );
  if (view.state.needsHuman) console.log(`  🚨 NEEDS HUMAN: ${view.state.needsHuman}`);
  if (view.state.reason) console.log(`  ${view.state.reason}`);
  for (const question of view.state.pendingQuestion?.questions ?? []) {
    console.log(`  question: ${question.question}`);
    if (question.options?.length)
      console.log(
        `  options: ${question.options.map(option => option.label).join(', ')}${question.multiSelect ? ' (choose one or more)' : ''}`,
      );
  }
  console.log(`  ${view.directory}`);
}

function printEvent(event: KTeamEvent, json = false): void {
  if (json) return console.log(JSON.stringify(event));
  const data = event.data as Record<string, unknown> | undefined;
  const question =
    event.type === 'interaction.question' && Array.isArray(data?.questions)
      ? ` ${(data.questions as Array<{ question?: string }>)
          .map(item => item.question)
          .filter(Boolean)
          .join(' / ')}`
      : '';
  const text = typeof data?.text === 'string' ? ` ${data.text}` : question;
  console.log(`${String(event.sequence).padStart(5)} ${event.time} ${event.type}${text}`);
}

const program = new Command();
program.name('kteam').description('client for the kteamd interactive Claude/Codex teammate daemon').version(VERSION);

const daemonCommand = program.command('daemon').description('manage the kteam daemon');
daemonCommand.command('start').action(async () => {
  await daemon.start();
  const health = await waitForDaemon();
  console.log(`kteamd ready (pid ${String(health.pid)})`);
});
daemonCommand.command('stop').action(async () => {
  await daemon.stop();
  console.log('kteamd stopped');
});
daemonCommand.command('restart').action(async () => {
  await daemon.stop();
  await Bun.sleep(500);
  await daemon.start();
  const health = await waitForDaemon();
  console.log(`kteamd restarted (pid ${String(health.pid)})`);
});
daemonCommand.command('status').action(async () => {
  // The live HTTP API is the ground truth for reachability — the unit/pid
  // check alone false-negatives ("stopped") when the daemon runs outside the
  // service manager, which broke consumers probing reachability (kloop).
  try {
    console.log(JSON.stringify(await (await client()).health(), null, 2));
    return;
  } catch {}
  const status = await daemon.status();
  if (!status.running) {
    console.log('kteamd is stopped');
    process.exitCode = 1;
    return;
  }
  {
    console.log(`kteamd process exists${status.pid ? ` (pid ${status.pid})` : ''}, but API is unavailable`);
    process.exitCode = 1;
  }
});
daemonCommand.command('install').action(async () => {
  await daemon.install();
  const health = await waitForDaemon();
  console.log(`kteamd user service installed and started (pid ${String(health.pid)})`);
});
daemonCommand.command('uninstall').action(async () => {
  await daemon.uninstall();
  console.log('kteamd user service removed');
});
daemonCommand
  .command('logs')
  .option('-f, --follow')
  .action(async (options: { follow?: boolean }) => {
    if (options.follow) {
      const proc = Bun.spawn(['tail', '-f', paths.daemonLog], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      process.exitCode = await proc.exited;
    } else process.stdout.write(await readFile(paths.daemonLog, 'utf8').catch(() => ''));
  });

const agentUsageFeed = new UsageFeed(process.env.KTEAM_QUOTA_URL ?? 'http://127.0.0.1:47318/usage', {
  fallback: fetchKfleetUsage,
});

/** Account usage from the same cached feed as the daemon quota waiter. Empty
 *  on total failure — recommend still works without usage-based balancing. */
async function fetchAgentUsage(): Promise<AgentUsage[]> {
  return await agentUsageFeed.accounts();
}

program
  .command('recommend')
  .argument('[task...]')
  .option('--json')
  .option('--no-usage', 'skip the kfleet usage probe (no exclusion or load balancing)')
  .addOption(
    new Option('--budget <budget>', 'bias the picks: cost-first, default, or quality-first')
      .choices(['cheap', 'balanced', 'max'])
      .default('balanced'),
  )
  .option(
    '--roles <roles>',
    'force the team shape instead of deriving it (comma-separated: planner,implementer,researcher,reviewer,fan-out)',
  )
  .option('--label <label>', 'ownership label to put in the generated kteam start commands')
  .action(
    async (
      parts: string[],
      options: { json?: boolean; usage?: boolean; budget: Budget; roles?: string; label?: string },
    ) => {
      const task = parts.join(' ').trim();
      if (!task) {
        console.error('a task description is required: kteam recommend "<task>"');
        process.exitCode = 1;
        return;
      }
      const available = discoverAutoAgents(paths.kfleetBin);
      const usage = options.usage === false ? [] : await fetchAgentUsage();
      const roles = options.roles
        ?.split(',')
        .map(role => role.trim())
        .filter(Boolean) as TeamRole[] | undefined;
      const team = recommendTeam(task, available, {
        usage,
        budget: options.budget,
        roles,
        label: options.label,
      });
      if (options.json) return console.log(JSON.stringify({ available, ...team }, null, 2));

      console.log(`Task: ${task}`);
      console.log(`Read: ${team.reasoning}`);
      console.log(`Budget: ${team.budget}`);
      console.log('');
      for (const role of team.roles) {
        const heading = role.count ? `${role.role.toUpperCase()} ×${role.count}` : role.role.toUpperCase();
        console.log(`${heading} — ${role.why}`);
        console.log(`  ▸ PRIMARY  ${option(role.primary)}`);
        console.log(`    ${role.primary.command}`);
        for (const alternative of role.alternatives) {
          console.log(`  · alt      ${option(alternative)}`);
          console.log(`    ${alternative.command}`);
        }
        console.log('');
      }
      if (team.warnings.length) {
        console.log('Warnings:');
        for (const warning of team.warnings) console.log(`  ! ${warning}`);
        console.log('');
      }
      if (team.exclusions.length) {
        console.log('Excluded:');
        for (const item of team.exclusions) console.log(`  - ${item.binary}: ${item.reason}`);
        console.log('');
      }
      console.log('Review this with the user before launching — it spends account quota.');
    },
  );

function option(item: {
  binary: string;
  modelLabel: string;
  modelFlag?: string;
  tradeoff: string;
  caveat?: string;
}): string {
  const flag = item.modelFlag ? ` --model ${item.modelFlag}` : '';
  const caveats: Record<string, string> = {
    'below-doctrine-floor': 'below the doctrine floor for this role — deliberate override only',
    'same-model-family': 'same model family as the implementer — a weaker independent check',
    'not-for-product-facing': 'doctrine bars this model from product-facing work — support role only',
  };
  const caveat = item.caveat ? `\n             ⚠ ${caveats[item.caveat] ?? item.caveat}` : '';
  return `${item.modelLabel.padEnd(20)} ${item.binary}${flag}\n             ${item.tradeoff}${caveat}`;
}

program
  .command('start')
  .argument('[prompt...]')
  .requiredOption('-a, --agent <binary>')
  .addOption(new Option('--mode <mode>').choices(['auto', 'interactive']).default('auto'))
  .option('--name <name>', 'succinct summary of what this session is supposed to do (shown in ps)')
  .option('--label <label>', 'ownership label (lead session/repo/ticket slug); filter later with `kteam ps --label`')
  .option('--parent <id>', 'parent session (defaults to KTEAM_SESSION_ID when started from inside a teammate)')
  .option('--prompt-file <file>', 'read the task prompt from a file instead of the command line (use for long prompts)')
  .option('--model <model>', 'override the model (alias or full id); defaults to the wrapper KTEAM_MODEL')
  .option('--rc', 'launch with Remote Control so the session is visible/steerable in the RC surface (claude; default)')
  .option('--no-rc', 'launch WITHOUT Remote Control')
  .option(
    '--harness-flag <flag>',
    'extra flag passed straight to the harness binary; repeatable',
    (value, values: string[]) => [...values, value],
    [],
  )
  .option('--cwd <dir>', '', process.cwd())
  .option(
    '-i, --image <file>',
    'attach an initial image; repeatable',
    (value, values: string[]) => [...values, value],
    [],
  )
  .option('--interval <seconds>', '', Number)
  .option('--stall <seconds>', '', Number)
  .option('--timeout <seconds>', '', Number)
  .option('--nudge-after <seconds>', 'zero life-signs this long earns a continue nudge (default 180)', Number)
  .option('--kill-after <seconds>', 'zero life-signs this long is a stall kill (default 300)', Number)
  .option(
    '--direct-max <chars>',
    'short single-line payloads up to this length are typed verbatim (0 disables; default 500)',
    Number,
  )
  .option('--max-snapshots <count>', '', Number)
  .option('--detach', 'return as soon as the session is persisted; the TUI launch continues in the background')
  .option(
    '--request-id <id>',
    'idempotency key (also KTEAM_REQUEST_ID): re-running start with the same id returns the SAME session instead of a second teammate',
  )
  .option('--json')
  .action(async (parts: string[], options: Record<string, string | number | boolean | undefined>, command: Command) => {
    const initialAttachments = await Promise.all(
      ((options.image as unknown as string[]) ?? []).map(async filename => {
        const file = Bun.file(filename);
        const bytes = await file.arrayBuffer();
        return {
          filename: path.basename(filename),
          ...(file.type.startsWith('image/') ? { mime: file.type } : {}),
          base64: Buffer.from(bytes).toString('base64'),
        };
      }),
    );
    const filePrompt = options.promptFile ? (await readFile(String(options.promptFile), 'utf8')).trim() : '';
    const argPrompt = parts.join(' ').trim();
    const prompt = [argPrompt, filePrompt].filter(Boolean).join('\n\n');
    // `--mode interactive` is a terminal for a human: starting one with no task
    // is the normal case, and nothing is typed into it. Auto mode still needs a
    // task - an autonomous teammate with no assignment can only misbehave.
    if (!prompt && options.mode !== 'interactive') {
      console.error('provide a prompt (arguments and/or --prompt-file), or use --mode interactive to start bare');
      process.exit(2);
    }
    const view = await (
      await client()
    ).start(
      {
        prompt,
        agent: String(options.agent),
        name: options.name as string | undefined,
        label: options.label as string | undefined,
        // A teammate's pane carries its own session id — starting a session from
        // inside one automatically records the parent (teammate trees).
        parent: (options.parent as string | undefined) ?? process.env.KTEAM_SESSION_ID,
        model: options.model as string | undefined,
        // Only send an explicit RC decision when the user made one; otherwise the
        // daemon's fleet default (config `remoteControl`, itself on) decides.
        remoteControl: command.getOptionValueSource('rc') === 'cli' ? options.rc === true : undefined,
        harnessFlags: (options.harnessFlag as unknown as string[]) ?? [],
        cwd: String(options.cwd),
        mode: options.mode as 'auto' | 'interactive',
        intervalSeconds: options.interval as number | undefined,
        stallSeconds: options.stall as number | undefined,
        timeoutSeconds: options.timeout as number | undefined,
        nudgeAfterSeconds: options.nudgeAfter as number | undefined,
        killAfterSeconds: options.killAfter as number | undefined,
        directSendMaxChars: options.directMax as number | undefined,
        maxSnapshots: options.maxSnapshots as number | undefined,
        detach: options.detach === true,
        initialAttachments,
      },
      options.requestId as string | undefined,
    );
    if (options.json) console.log(JSON.stringify(view, null, 2));
    else printView(view);
    if (view.state.status === 'starting')
      console.error(
        `note: ${view.config.id} is still launching in the background — watch it with \`kteam ps\` / \`kteam stream ${view.config.id}\``,
      );
  });

program
  .command('ps')
  .option('--json')
  .option('-a, --all', 'include terminal sessions (completed/failed/stalled/stopped); default shows only running')
  .option('-l, --label <label>', 'only sessions started with this ownership label')
  .action(async (options: { json?: boolean; all?: boolean; label?: string }) => {
    const everything = await (await client()).list();
    // Default to running only — same "running" semantic as the status counts:
    // any session not in a terminal state. `-a` shows everything.
    const all = options.label ? everything.filter(view => view.config.label === options.label) : everything;
    const sessions = options.all ? all : all.filter(view => !terminal.includes(view.state.status));
    if (options.json) return console.log(JSON.stringify(sessions, null, 2));
    if (!sessions.length)
      return console.log(
        all.length
          ? 'no running kteam sessions (use -a to show all)'
          : options.label
            ? `no kteam sessions with label "${options.label}"`
            : 'no kteam sessions',
      );
    // Column widths are measured from the DATA (fixed widths misalign the
    // moment any value outgrows them). Variable-length columns (TASK, LABEL)
    // sit at the end; the final column is never padded.
    const header = ['TEAMMATE', 'ID', 'STATUS', 'MODEL', 'AGENT', 'MODE', 'QUOTA', 'TASK', 'LABEL'];
    const rows = sessions.map(view => [
      view.config.teammate ?? '-',
      view.config.id,
      // A declared park reports the same 'waiting' status as an unanswered
      // question; the marker is the only fleet-level way to tell them apart.
      view.state.waiting ? `${view.state.status} PARKED` : view.state.status,
      // The RESOLVED model, not the alias: `claude-auto-glm52a` defaults to the
      // alias `opus` while the pane actually runs glm-5.2. Harness-reported
      // first, then the wrapper's known mapping, then whatever was configured.
      resolveDisplayModel(view.config.binary, view.config.model, view.state.observedModel).model,
      view.config.binary,
      view.config.mode,
      compactUsageQuota(view.state),
      view.config.name,
      view.config.label ?? '-',
    ]);
    const widths = header.map((title, column) => Math.max(title.length, ...rows.map(cells => cells[column]!.length)));
    const render = (cells: string[]) =>
      cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ');
    console.log(render(header));
    for (const cells of rows) console.log(render(cells));
  });

program
  .command('status')
  .argument('<id>')
  .option('--json')
  .action(async (id, options: { json?: boolean }) => {
    const view = await (await client()).get(id);
    if (options.json) console.log(JSON.stringify(view, null, 2));
    else printView(view);
  });

program
  .command('send')
  .argument('<id>')
  .argument('[message...]')
  .option('-i, --image <file>', 'attach image; repeatable', (value, values: string[]) => [...values, value], [])
  .option('--message-file <file>', 'read the message from a file (use for long messages)')
  .option(
    '--now',
    'immediate steer: interrupt the active turn (Escape) and deliver the message right away instead of riding the native queue',
  )
  .action(async (id: string, parts: string[], options: { image: string[]; messageFile?: string; now?: boolean }) => {
    const api = await client();
    const fileMessage = options.messageFile ? (await readFile(options.messageFile, 'utf8')).trim() : '';
    const message = [parts.join(' ').trim(), fileMessage].filter(Boolean).join('\n\n');
    const attachments = await Promise.all(options.image.map(file => api.upload(id, file)));
    const view = await api.send(id, {
      message,
      attachmentIds: attachments.map(item => item.id),
      now: options.now === true,
    });
    // The daemon states what actually happened; older daemons omit the field
    // and fall back to the status-based guess.
    if (view.disposition === 'queued')
      console.log("queued in the TUI's native queue (auto-submits at the turn boundary)");
    else if (view.disposition === 'revived') console.log('revived session with message');
    else if (view.disposition === 'delivered') console.log('delivered');
    else {
      const busy = !['waiting', 'awaiting_user', 'interrupted'].includes(view.state.status) && !view.state.promptReady;
      if (!options.now && busy)
        console.error('kteam send: session is busy — message queued for the next turn boundary');
    }
    printView(view);
  });
program
  .command('reply')
  .description('compatibility alias for send')
  .argument('<id>')
  .argument('<message...>')
  .action(async (id: string, parts: string[]) => {
    printView(await (await client()).send(id, { message: parts.join(' ') }));
  });

program
  .command('answer')
  .argument('<id>')
  .argument('[labels...]')
  .option('--other <text>', 'choose the free-form Other response for one question')
  .option(
    '--response <answer>',
    'answer each question in order; repeatable',
    (value, values: string[]) => [...values, value],
    [],
  )
  .action(async (id, labels: string[], options: { other?: string; response: string[] }) => {
    if (!labels.length && !options.other && !options.response.length)
      throw new Error('provide labels, --other <text>, or one --response per question');
    printView(
      await (await client()).answer(id, labels, options.other, options.response.length ? options.response : undefined),
    );
  });
program
  .command('interrupt')
  .argument('<id>')
  .action(async id => printView(await (await client()).interrupt(id)));
program
  .command('stop')
  .argument('<id>')
  .option('--reason <reason>')
  .action(async (id, options: { reason?: string }) => printView(await (await client()).stop(id, options.reason)));
program
  .command('resume')
  .argument('<id>')
  .argument('[message...]')
  .action(async (id, parts: string[]) => printView(await (await client()).resume(id, parts.join(' ') || undefined)));
program
  .command('migrate')
  .description('continue a session on another same-kind account (new wrapper); relaunches under it')
  .argument('<id>')
  .requiredOption('-a, --agent <binary>', 'the auto-mode wrapper to move the session onto (same harness kind)')
  .option('--model <model>', 'override the model on the new account; defaults to the new wrapper KTEAM_MODEL')
  .action(async (id, options: { agent: string; model?: string }) =>
    printView(await (await client()).migrate(id, options.agent, options.model)),
  );
program
  .command('restart')
  .description('stop the session (even while "running") and resume it in a fresh TUI')
  .argument('<id>')
  .argument('[message...]')
  .action(async (id, parts: string[]) => {
    const api = await client();
    await api.stop(id, 'restarted by client');
    printView(await api.resume(id, parts.join(' ') || undefined));
  });
program
  .command('delete')
  .argument('<id>')
  .option('--purge')
  .option('--force')
  .action(async (id, options: { purge?: boolean; force?: boolean }) => {
    await (await client()).remove(id, options.purge, options.force);
    console.log(`deleted ${id}${options.purge ? ' permanently' : ' to trash'}`);
  });

program
  .command('signal')
  .description('done | help | waiting | working — the teammate lifecycle signals')
  .argument('<kind>')
  .argument('[message...]')
  .option('--session <id>')
  .option('--until <when>', 'waiting: deadline as a duration (45m, 2h) or ISO timestamp; the daemon wakes you at it')
  .option('--on <condition>', 'waiting: what is being waited for (shown in status and heartbeats)')
  .action(async (kind: string, parts: string[], options: { session?: string; until?: string; on?: string }) => {
    const id = options.session ?? process.env.KTEAM_SESSION_ID;
    if (!id) throw new Error('no session id; pass --session or run inside kteam');
    if (!SIGNAL_KINDS.includes(kind as SignalKind)) throw new Error(`kind must be one of ${SIGNAL_KINDS.join(', ')}`);
    if ((options.until || options.on) && kind !== 'waiting') throw new Error('--until/--on apply to `signal waiting`');
    const view = await (
      await client()
    ).signal(id, kind as SignalKind, parts.join(' ') || undefined, { until: options.until, condition: options.on });
    if (kind === 'waiting')
      console.log(
        `waiting recorded${view.state.waiting?.until ? ` until ${view.state.waiting.until}` : ' (open-ended)'} — ` +
          'idle-kill and the turn ceiling are suspended while it holds',
      );
    else console.log(`${kind} signal recorded`);
  });

program
  .command('snapshot')
  .argument('<id>')
  .action(async id => {
    process.stdout.write(await (await client()).snapshot(id));
  });
program
  .command('logs')
  .argument('<id>')
  .option('--turn <number>', '', Number)
  .action(async (id, options: { turn?: number }) => {
    process.stdout.write(await (await client()).logs(id, options.turn));
  });
program
  .command('events')
  .argument('<id>')
  .option('--after <sequence>', '', Number, 0)
  .option('--limit <count>', '', Number)
  .option('--json')
  .action(async (id, options: { after: number; limit?: number; json?: boolean }) => {
    for (const event of await (await client()).history(id, options.after, options.limit))
      printEvent(event, options.json);
  });
program
  .command('view')
  .description('view normalized historical chat and lifecycle events')
  .argument('<id>')
  .option('--after <sequence>', '', Number, 0)
  .option('--limit <count>', '', Number)
  .option('--json')
  .action(async (id, options: { after: number; limit?: number; json?: boolean }) => {
    for (const event of await (await client()).history(id, options.after, options.limit))
      printEvent(event, options.json);
  });
program
  .command('stream')
  .argument('[id]')
  .option('--after <sequence>', '', Number, 0)
  .option('--json')
  .action(async (id, options: { after: number; json?: boolean }) => {
    await (await client()).stream(id, options.after, event => printEvent(event, options.json));
  });
program
  .command('wait')
  .argument('<id>')
  .option('--json')
  .option('--timeout <seconds>', 'give up after this many seconds (exit code 124, prints the current state)')
  .option(
    '--until-marker <file>',
    'only return once this file exists (deliverable gate) — `completed` alone is not trusted; non-completed terminal states exit 1',
  )
  .action(async (id, options: { json?: boolean; timeout?: string; untilMarker?: string }) => {
    const api = await client();
    const timeoutSec = options.timeout === undefined ? undefined : Number(options.timeout);
    if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
      console.error(`invalid --timeout: ${options.timeout}`);
      process.exit(2);
    }
    const marker = options.untilMarker === undefined ? undefined : path.resolve(options.untilMarker);
    const deadline = timeoutSec === undefined ? undefined : Date.now() + timeoutSec * 1000;
    let notedMissingMarker = false;
    let notedDeclaredWait = false;
    while (true) {
      const view = await api.get(id);
      const print = () => {
        // Single-line by design: consumers (kloop) parse this from a pipe —
        // pretty-printed multi-line JSON broke line-oriented readers.
        if (options.json) console.log(JSON.stringify(view.state));
        else printView(view);
      };
      if (marker !== undefined) {
        if (existsSync(marker)) {
          print();
          return;
        }
        // The deliverable is the ground truth. A completed status without the
        // marker keeps waiting (bounded by --timeout); a failed/stalled/
        // stopped session will never produce it — surface that as failure.
        if (['failed', 'stalled', 'stopped', 'kill_failed'].includes(view.state.status)) {
          print();
          console.error(`kteam wait: session is ${view.state.status} and the marker never appeared: ${marker}`);
          process.exit(1);
        }
        if (view.state.status === 'completed' && !notedMissingMarker) {
          notedMissingMarker = true;
          console.error(`kteam wait: session completed but marker not present yet; still waiting for ${marker}`);
        }
        // A session waiting on the lead can never produce the marker on its
        // own — hand control back so the question/help gets answered. A
        // DECLARED wait is the opposite: the teammate is parked on an external
        // condition and the daemon will wake it, so keep waiting.
        if (view.state.waiting !== undefined) {
          if (!notedDeclaredWait) {
            notedDeclaredWait = true;
            console.error(
              `kteam wait: teammate declared a wait${view.state.waiting.condition ? ` on ${view.state.waiting.condition}` : ''}` +
                `${view.state.waiting.until ? ` until ${view.state.waiting.until}` : ' (open-ended)'}; still waiting`,
            );
          }
        } else if (['waiting', 'awaiting_user', 'awaiting_question'].includes(view.state.status)) {
          print();
          console.error('kteam wait: session needs attention before the marker can appear');
          return;
        }
      } else if (
        terminal.includes(view.state.status) ||
        view.state.status === 'kill_failed' ||
        // A DECLARED wait is not "needs attention": the daemon holds the
        // deadline and will wake the teammate, so keep waiting for it.
        (view.state.waiting === undefined &&
          (view.state.status === 'waiting' ||
            view.state.status === 'awaiting_user' ||
            view.state.status === 'awaiting_question'))
      ) {
        print();
        return;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        print();
        console.error(`kteam wait: timed out after ${timeoutSec}s (session still ${view.state.status})`);
        process.exit(124);
      }
      await Bun.sleep(1000);
    }
  });
program
  .command('attach')
  .argument('<id>', 'session id or teammate name')
  .description("attach this terminal to the session's tmux pane (Ctrl-b d detaches)")
  .option('--print', 'print the tmux command instead of running it')
  .action(async (id: string, options: { print?: boolean }) => {
    const view = await (await client()).get(id);
    const target = view.config.tmuxSession;
    // Inside an existing tmux client, `attach-session` refuses to nest; the
    // equivalent there is switching this client to the teammate's session.
    const argv = process.env.TMUX ? ['tmux', 'switch-client', '-t', target] : ['tmux', 'attach-session', '-t', target];
    if (options.print) {
      console.log(argv.join(' '));
      return;
    }
    const proc = Bun.spawn(argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exitCode = await proc.exited;
  });
const humanBytes = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${(bytes / 1e3).toFixed(0)} kB`;

program
  .command('gc')
  .description('reclaim agent scratch from sessions terminal past the TTL (kteam data is never touched)')
  .option('--dry-run', 'print what WOULD be freed and why, without deleting anything')
  .option('--limit <count>', 'sessions to consider in a dry run', Number, 20)
  .option('--force', 'run even when scratch gc is disabled in daemon config')
  .option('--json')
  .action(async (options: { dryRun?: boolean; limit: number; force?: boolean; json?: boolean }) => {
    const api = await client();
    if (options.dryRun) {
      const plan = await api.scratchPlan(options.limit);
      if (options.json) return console.log(JSON.stringify(plan, null, 2));
      const eligible = plan.filter(item => item.eligible);
      const total = eligible.reduce((sum, item) => sum + item.bytes, 0);
      for (const item of plan) {
        const mark = item.eligible ? 'FREE' : 'keep';
        console.log(
          `${mark}  ${item.sessionId}  ${humanBytes(item.bytes).padStart(8)}  ${item.teammate ?? ''}${item.eligible ? '' : `  (${item.reason})`}`,
        );
        if (item.eligible) {
          for (const entry of item.entries.slice(0, 8))
            console.log(
              `        ${humanBytes(entry.bytes).padStart(8)}  ${entry.name}${entry.kind === 'directory' ? '/' : ''}`,
            );
        }
      }
      console.log(`\nwould free ${humanBytes(total)} from ${eligible.length} session(s) — nothing was deleted`);
      return;
    }
    const result = await api.scratchSweep(options.force === true);
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    console.log(
      `reclaimed ${humanBytes(result.bytes)} from ${result.sessions} session(s)${result.failures > 0 ? `; ${result.failures} entr(ies) could not be removed (see daemon log)` : ''}`,
    );
  });

const wardenCommand = program.command('warden').description('fleet-level watchdog (layer-3 oversight)');
wardenCommand
  .command('status')
  .option('--json')
  .action(async (options: { json?: boolean }) => {
    const status = await (await client()).wardenStatus();
    if (options.json) return console.log(JSON.stringify(status, null, 2));
    const w = status.config;
    console.log(
      `warden: escalation ${w.enabled ? 'ENABLED' : 'disabled'}  wrapper=${w.wrapper}  interval=${w.intervalMinutes}m  unattended=${w.unattendedMinutes}m  gap=${w.minSpawnGapMinutes}m`,
    );
    console.log(`last sweep: ${status.lastSweepAt ?? 'never'}`);
    if (status.liveWarden) console.log(`live warden session: ${status.liveWarden}`);
    if (status.lastSpawnAt) console.log(`last escalation spawn: ${status.lastSpawnAt}`);
    if (!status.anomalies.length) console.log('anomalies: none');
    else {
      console.log(`anomalies (${status.anomalies.length}):`);
      for (const anomaly of status.anomalies)
        console.log(`  ${anomaly.kind}  ${anomaly.teammate ?? '-'} (${anomaly.sessionId})  ${anomaly.detail}`);
    }
    if (status.lastReport) {
      console.log(`last report: ${status.lastReport.path}`);
      for (const line of status.lastReport.head.split('\n')) console.log(`  | ${line}`);
    }
  });
wardenCommand
  .command('run')
  .description('force a fleet sweep now')
  .option('--spawn', 'force LLM escalation past the enabled flag, spawn gap, and unchanged-anomaly suppression')
  .option('--json')
  .action(async (options: { spawn?: boolean; json?: boolean }) => {
    const result = await (await client()).wardenRun(options.spawn === true);
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    console.log(
      `swept ${result.sweptAt}: ${result.anomalies.length} anomal${result.anomalies.length === 1 ? 'y' : 'ies'}`,
    );
    for (const anomaly of result.anomalies)
      console.log(`  ${anomaly.kind}  ${anomaly.teammate ?? '-'} (${anomaly.sessionId})  ${anomaly.detail}`);
    if (result.spawned) console.log(`escalated: spawned warden session ${result.spawned}`);
    else if (result.message) console.log(`no escalation: ${result.message}`);
  });

program.command('doctor').action(async () => {
  const tmux = Bun.spawnSync(['tmux', '-V']);
  const agents = discoverAutoAgents(paths.kfleetBin);
  console.log(
    `${tmux.exitCode === 0 ? 'ok' : 'missing'}  tmux${tmux.stdout.length ? ` (${tmux.stdout.toString().trim()})` : ''}`,
  );
  console.log(`${agents.length ? 'ok' : 'missing'}  auto wrappers (${agents.length})`);
  try {
    const health = await (await client()).health();
    console.log(`ok  kteamd (pid ${String(health.pid)})`);
  } catch (error) {
    console.log(`missing  kteamd (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
  }
});

program.parseAsync(process.argv).catch(error => {
  console.error(`kteam: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
