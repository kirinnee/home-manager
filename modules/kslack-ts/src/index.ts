#!/usr/bin/env bun
// kslack — read-only Slack CLI for the agent fleet. Reads the human's DMs,
// group DMs, channels, threads and search results with a user token from
// $SLACK_USER_TOKEN. It cannot write: the client only calls an allowlist of
// read methods (see client.ts).
import { Command } from 'commander';
import { SlackClient } from './client';
import { cmdAuth, cmdChannels, cmdDms, cmdHistory, cmdSearch, cmdThread, cmdUsers, type Ctx } from './commands';
import { parseIntOption } from './parse';
import { UserDirectory } from './users';

const client = SlackClient.fromEnv();

interface CommonOpts {
  json?: boolean;
  team?: string;
}

function ctx(o: CommonOpts): Ctx {
  return {
    client,
    users: new UserDirectory(client),
    out: line => console.log(line),
    json: !!o.json,
    team: o.team,
  };
}

function common(cmd: Command): Command {
  return cmd
    .option('--json', 'print raw Slack JSON instead of human-readable output')
    .option('--team <id>', 'Enterprise Grid workspace (team_id); defaults from auth.test');
}

const program = new Command();
program
  .name('kslack')
  .description('Read-only Slack CLI: search, channels, DMs, history, threads, users (token: $SLACK_USER_TOKEN)')
  .showHelpAfterError();

common(program.command('auth').description('who am I: user, team, enterprise_id (auth.test)')).action(
  async (o: CommonOpts) => {
    await cmdAuth(ctx(o));
  },
);

common(
  program
    .command('search <query>')
    .description('search messages (Slack search syntax: from:@x in:#y before:2026-10-01 "phrase")')
    .option('-n, --count <n>', 'max results', '20')
    .option('--sort <by>', 'timestamp | score', 'timestamp'),
).action(async (query: string, o: CommonOpts & { count?: string; sort: string }) => {
  if (o.sort !== 'timestamp' && o.sort !== 'score') throw new Error('--sort must be timestamp or score');
  await cmdSearch(ctx(o), query, { count: parseIntOption('--count', o.count, 20), sort: o.sort });
});

common(
  program
    .command('channels')
    .description('conversations you are a member of')
    .option('--type <types>', 'comma list of public,private,im,mpim', 'public,private,im,mpim')
    .option('-l, --limit <n>', 'max conversations', '1000'),
).action(async (o: CommonOpts & { type: string; limit?: string }) => {
  await cmdChannels(ctx(o), { type: o.type, limit: parseIntOption('--limit', o.limit, 1000) });
});

common(
  program
    .command('dms')
    .description('DMs and group DMs, most recently active first')
    .option('-l, --limit <n>', 'max conversations', '20'),
).action(async (o: CommonOpts & { limit?: string }) => {
  await cmdDms(ctx(o), { limit: parseIntOption('--limit', o.limit, 20) });
});

common(
  program
    .command('history <channel>')
    .description('recent messages in a conversation; <channel> = ID, #name, @user (existing DM) or permalink')
    .option('-l, --limit <n>', 'max messages', '50')
    .option('--since <when>', 'only messages after a duration ago (30m, 6h, 2d, 1w) or a date'),
).action(async (channel: string, o: CommonOpts & { limit?: string; since?: string }) => {
  await cmdHistory(ctx(o), channel, { limit: parseIntOption('--limit', o.limit, 50), since: o.since });
});

common(
  program
    .command('thread <channelOrPermalink> [ts]')
    .description('a thread: `thread <channel> <ts>` or `thread <permalink>`')
    .option('-l, --limit <n>', 'max messages', '500'),
).action(async (a: string, ts: string | undefined, o: CommonOpts & { limit?: string }) => {
  await cmdThread(ctx(o), a, ts, { limit: parseIntOption('--limit', o.limit, 500) });
});

common(
  program
    .command('users <query>')
    .description('find users by handle, display name, real name or email')
    .option('-l, --limit <n>', 'max results', '20')
    .option('--refresh', 'ignore the cached user list (refreshed daily) and re-fetch'),
).action(async (query: string, o: CommonOpts & { limit?: string; refresh?: boolean }) => {
  await cmdUsers(ctx(o), query, { limit: parseIntOption('--limit', o.limit, 20), refresh: o.refresh });
});

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const err = client.scrub(e);
  console.error(`kslack: ${err.message}`);
  process.exit(1);
}
