#!/usr/bin/env bun

import { Command, Option } from 'commander';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { ApiClient } from './api-client';
import { discoverAutoAgents, recommendAgents, usableAgent, type AgentUsage } from './core';
import { DaemonService } from './daemon-service';
import { resolveBinary } from './harness';
import { createPaths } from './paths';
import type { KTeamEvent, SessionStatus } from './types';

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
    `${view.config.teammate ?? '-'} (${view.config.id})  ${view.state.status}  ${view.config.binary}  model=${view.config.model ?? 'default'}  ${view.config.mode}  turn ${view.state.turn}`,
  );
  console.log(`  ${view.config.cwd}`);
  const vitals = [
    view.state.contextPercent !== undefined ? `context ${view.state.contextPercent}% used` : '',
    view.state.lastToolStartedAt ? `last tool started ${view.state.lastToolStartedAt}` : '',
  ].filter(Boolean);
  if (vitals.length) console.log(`  ${vitals.join('  ')}`);
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
  const status = await daemon.status();
  if (!status.running) {
    console.log('kteamd is stopped');
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(await (await client()).health(), null, 2));
  } catch {
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

/** Account usage from kfleet: the serve endpoint when it's up (fast, cached),
 *  else one `kfleet usage --json` probe. Empty on total failure — recommend
 *  still works, just without usage-based exclusion/balancing. */
async function fetchAgentUsage(): Promise<AgentUsage[]> {
  try {
    const response = await fetch(process.env.KTEAM_QUOTA_URL ?? 'http://127.0.0.1:47318/usage', {
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as { accounts?: AgentUsage[] };
      if (payload.accounts?.length) return payload.accounts;
    }
  } catch {}
  try {
    const probe = Bun.spawnSync(['kfleet', 'usage', '--json', '--no-relogin'], { timeout: 60_000 });
    if (probe.exitCode === 0) return JSON.parse(probe.stdout.toString()) as AgentUsage[];
  } catch {}
  return [];
}

program
  .command('recommend')
  .argument('[task...]')
  .option('--json')
  .option('--no-usage', 'skip the kfleet usage probe (no exclusion or load balancing)')
  .action(async (parts: string[], options: { json?: boolean; usage?: boolean }) => {
    const task = parts.join(' ').trim();
    const available = discoverAutoAgents(paths.kfleetBin);
    const usage = options.usage === false ? [] : await fetchAgentUsage();
    const recommendations = recommendAgents(task, available, usage);
    const excluded = usage
      .filter(item => available.includes(item.binary) && !usableAgent(item))
      .map(item => `${item.binary} (${item.atLimit ? 'at usage limit' : 'not logged in'})`);
    if (options.json) return console.log(JSON.stringify({ task, available, excluded, recommendations }, null, 2));
    console.log('Suggested team (review with the user before launching):');
    for (const item of recommendations) console.log(`  ${item.binary} — ${item.role}: ${item.reason}`);
    if (excluded.length) console.log(`Excluded: ${excluded.join(', ')}`);
  });

program
  .command('start')
  .argument('<prompt...>')
  .requiredOption('-a, --agent <binary>')
  .addOption(new Option('--mode <mode>').choices(['auto', 'interactive']).default('auto'))
  .option('--name <name>')
  .option('--model <model>', 'override the model (alias or full id); defaults to the wrapper KTEAM_MODEL')
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
  .option('--max-snapshots <count>', '', Number)
  .option('--json')
  .action(async (parts: string[], options: Record<string, string | number | boolean | undefined>) => {
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
    const view = await (
      await client()
    ).start({
      prompt: parts.join(' '),
      agent: String(options.agent),
      name: options.name as string | undefined,
      model: options.model as string | undefined,
      cwd: String(options.cwd),
      mode: options.mode as 'auto' | 'interactive',
      intervalSeconds: options.interval as number | undefined,
      stallSeconds: options.stall as number | undefined,
      timeoutSeconds: options.timeout as number | undefined,
      maxSnapshots: options.maxSnapshots as number | undefined,
      initialAttachments,
    });
    if (options.json) console.log(JSON.stringify(view, null, 2));
    else printView(view);
  });

program
  .command('ps')
  .option('--json')
  .option('-a, --all', 'include terminal sessions (completed/failed/stalled/stopped); default shows only running')
  .action(async (options: { json?: boolean; all?: boolean }) => {
    const all = await (await client()).list();
    // Default to running only — same "running" semantic as the status counts:
    // any session not in a terminal state. `-a` shows everything.
    const sessions = options.all ? all : all.filter(view => !terminal.includes(view.state.status));
    if (options.json) return console.log(JSON.stringify(sessions, null, 2));
    if (!sessions.length)
      return console.log(all.length ? 'no running kteam sessions (use -a to show all)' : 'no kteam sessions');
    for (const view of sessions)
      console.log(
        `${(view.config.teammate ?? '-').padEnd(12)} ${view.config.id.padEnd(24)} ${view.state.status.padEnd(18)} ${(view.config.model ?? 'default').padEnd(20)} ${view.config.binary.padEnd(28)} ${view.config.mode.padEnd(11)} ${view.config.name}`,
      );
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
  .action(async (id: string, parts: string[], options: { image: string[] }) => {
    const api = await client();
    const attachments = await Promise.all(options.image.map(file => api.upload(id, file)));
    const view = await api.send(id, { message: parts.join(' '), attachmentIds: attachments.map(item => item.id) });
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
  .argument('<kind>')
  .argument('[message...]')
  .option('--session <id>')
  .action(async (kind: string, parts: string[], options: { session?: string }) => {
    const id = options.session ?? process.env.KTEAM_SESSION_ID;
    if (!id) throw new Error('no session id; pass --session or run inside kteam');
    if (kind !== 'done' && kind !== 'help') throw new Error('kind must be done or help');
    await (await client()).signal(id, kind, parts.join(' ') || undefined);
    console.log(`${kind} signal recorded`);
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
    while (true) {
      const view = await api.get(id);
      const print = () => {
        if (options.json) console.log(JSON.stringify(view.state, null, 2));
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
        // own — hand control back so the question/help gets answered.
        if (['waiting', 'awaiting_user', 'awaiting_question'].includes(view.state.status)) {
          print();
          console.error('kteam wait: session needs attention before the marker can appear');
          return;
        }
      } else if (
        terminal.includes(view.state.status) ||
        view.state.status === 'kill_failed' ||
        view.state.status === 'waiting' ||
        view.state.status === 'awaiting_user' ||
        view.state.status === 'awaiting_question'
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
  .argument('<id>')
  .action(async id => {
    const view = await (await client()).get(id);
    const proc = Bun.spawn(['tmux', 'attach-session', '-t', view.config.tmuxSession], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    process.exitCode = await proc.exited;
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
