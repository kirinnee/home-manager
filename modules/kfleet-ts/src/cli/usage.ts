// `kfleet usage` — probe every tracked subscription/usage account (Anthropic
// OAuth, Codex/ChatGPT, z.ai GLM, MiniMax coding plan) and print each one's 5-hour
// and weekly utilization plus whether it's logged in. Read-only, does NOT consume
// quota. Same prober the `kfleet serve` /metrics + /usage endpoints use; this is
// the on-demand view.
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../core/config';
import { type AccountUsage, probeUsage } from '../core/usage';
import { logDim, logOk, logWarn } from '../util/format';
import { loadOrDie } from './shared';

/** "in 3h12m" / "in 4d" from an epoch-ms reset time. */
function until(ms?: number): string {
  if (!ms) return '';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
}

const pct = (v?: number): string => (typeof v === 'number' ? `${v.toFixed(0)}%` : '—');

// Column padding operates on PLAIN text, then color is applied to the padded cell,
// so ANSI codes never throw the alignment off.
const padR = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const padL = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s);
/** Heat-color a utilization cell: ≥100% red, ≥80% yellow, else plain (dim if unknown). */
const heat = (v: number | undefined, s: string): string =>
  typeof v !== 'number' ? pc.dim(s) : v >= 100 ? pc.red(s) : v >= 80 ? pc.yellow(s) : s;

const PROV_W = 9; // widest provider label ("anthropic")
const BAR_W = 8; // mini utilization bar width
const RESET_W = 7; // reset-time column width ("29d23h")

/** Mini heat bar: filled blocks proportional to utilization, heat-colored; empty blocks dim.
 *  Unknown utilization → an all-dim track. Always BAR_W visible chars so columns line up. */
const heatBar = (v?: number): string => {
  if (typeof v !== 'number') return pc.dim('░'.repeat(BAR_W));
  const filled = Math.max(0, Math.min(BAR_W, Math.round((v / 100) * BAR_W)));
  return heat(v, '█'.repeat(filled)) + pc.dim('░'.repeat(BAR_W - filled));
};

/** One utilization cell: `{bar} {pct}` — fixed visible width (BAR_W + 1 + 4 = 13). */
const cell = (v?: number): string => `${heatBar(v)} ${heat(v, padL(pct(v), 4))}`;

export function createUsageCommand(): Command {
  return new Command('usage')
    .description('probe each subscription account (claude/codex/z.ai/minimax) for 5h + weekly usage + login status')
    .option('--json', 'machine-readable output')
    .option('--all', 'include untracked (non usage-based) accounts')
    .option('--no-relogin', 'skip the pre-probe token-free refresh of expired OAuth tokens')
    .option('--concurrency <n>', 'how many credentials to probe at once', v => Number.parseInt(v, 10))
    .option('--timeout <sec>', 'per-probe HTTP timeout in seconds', v => Number.parseInt(v, 10))
    .action(
      async (opts: { json?: boolean; all?: boolean; relogin?: boolean; concurrency?: number; timeout?: number }) => {
        const config = loadOrDie(() => loadConfig());
        const u = config.usage;
        // --no-relogin forces it off; otherwise follow config.usage.relogin.
        const relogin = opts.relogin === false ? false : u.relogin;
        if (!opts.json)
          logDim(
            `probing subscription accounts (read-only, does not use quota)${relogin ? '; refreshing expired tokens first' : ''}…`,
          );
        const rows = await probeUsage(config, {
          concurrency: opts.concurrency ?? u.concurrency,
          timeoutMs: (opts.timeout ?? u.timeout) * 1000,
          atLimitPercent: u.atLimitPercent,
          relogin,
        });

        if (opts.json) {
          console.log(JSON.stringify(opts.all ? rows : rows.filter(r => r.usageBased), null, 2));
          return;
        }

        const shown = opts.all ? rows : rows.filter(r => r.usageBased);
        if (shown.length === 0) return logWarn('no usage-based accounts in config');

        // Group by VARIANT (the wrapper-name infix: default / auto / …) so each section
        // shows one model across its variants together.
        const variantNames = Object.keys(config.variants ?? {}).filter(v => v !== 'default');
        const variantOf = (name: string): string =>
          variantNames.find(v => name === v || name.startsWith(`${v}-`)) ?? 'default';
        const groups = new Map<string, AccountUsage[]>();
        for (const r of shown) {
          const v = variantOf(r.name);
          const arr = groups.get(v);
          if (arr) arr.push(r);
          else groups.set(v, [r]);
        }
        // One binary-column width across every row so all sections line up together.
        const binW = Math.max(8, ...shown.map(r => r.binary.length));
        // 4 leading spaces = the row's "  " print-prefix + the 2-char "{mark} " column,
        // so the header labels sit exactly over their data columns.
        const header = pc.dim(
          `    ${padR('account', binW)} ${padR('provider', PROV_W)}  ${padR('5h', 13)}  ${padR('wk', 13)}  ${padL('5h↻', RESET_W)} ${padL('wk↻', RESET_W)}`,
        );
        const order = ['default', ...[...groups.keys()].filter(v => v !== 'default').sort()];
        for (const v of order) {
          const list = groups.get(v);
          if (!list?.length) continue;
          console.log(`${pc.bold(pc.cyan(`\n${v}`))}\n${header}`);
          // Within a variant: group by provider first (untracked/null last), then
          // sort alphabetically by binary name inside each provider group.
          const provKey = (r: AccountUsage): string => r.provider ?? '￿';
          for (const r of list.sort(
            (a, b) => provKey(a).localeCompare(provKey(b)) || a.binary.localeCompare(b.binary),
          )) {
            console.log(`  ${row(r, binW)}`);
          }
        }
        const exhausted = rows.filter(r => r.atLimit);
        const loggedOut = rows.filter(r => r.authOk === false);
        // "Errored" = couldn't read usage but the creds ARE fine (transient/endpoint) — distinct from logged-out.
        const errored = rows.filter(r => r.usageBased && !r.ok && r.authOk !== false);
        console.log(
          exhausted.length
            ? pc.yellow(`\n${exhausted.length} at limit: ${exhausted.map(r => r.binary).join(', ')}`)
            : pc.green('\nall tracked accounts have usage left'),
        );
        if (loggedOut.length)
          logWarn(`${loggedOut.length} NOT logged in (re-auth needed): ${loggedOut.map(r => r.binary).join(', ')}`);
        if (errored.length)
          logDim(`${errored.length} usage unavailable (creds OK): ${errored.map(r => r.binary).join(', ')}`);
        logOk('done');
      },
    );
}

/** One aligned table row: `{mark} {binary} {provider}  {5h bar+%}  {wk bar+%}  {5h↻} {wk↻}  {note}`.
 *  Utilization shows as a heat bar + percentage; the reset times get their own right-aligned
 *  columns (no more verbose repeated "resets" prose). The trailing note only appears for the
 *  actionable states (AT LIMIT / not logged in / probe failed). Plain text is padded first, then
 *  colored, so columns line up regardless of status. */
function row(r: AccountUsage, binW: number): string {
  const bin = padR(r.binary, binW);
  const prov = pc.dim(padR(r.provider ?? '', PROV_W));
  const blank = cell(undefined); // dim placeholder bar+% for rows with no reading
  const cols = (mark: string, c5: string, cwk: string, r5: string, rwk: string, note: string): string =>
    `${mark} ${bin} ${prov}  ${c5}  ${cwk}  ${pc.dim(padL(r5, RESET_W))} ${pc.dim(padL(rwk, RESET_W))}${note ? `  ${note}` : ''}`;
  if (!r.usageBased) {
    return cols(pc.dim('·'), blank, blank, '—', '—', pc.dim('not usage-based'));
  }
  // Not logged in is the actionable state — flag it distinctly from a transient miss.
  if (r.authOk === false) {
    return cols(pc.red('⚠'), blank, blank, '—', '—', `${pc.red('not logged in')} ${pc.dim(`(${r.error ?? ''})`)}`);
  }
  if (!r.ok) {
    return cols(pc.yellow('?'), blank, blank, '—', '—', pc.dim(`usage unavailable (${r.error ?? 'probe failed'})`));
  }
  const mark = r.atLimit ? pc.red('✗') : pc.green('✓');
  const r5 = until(r.fiveHourResetAt) || '—';
  const rwk = until(r.weeklyResetAt) || '—';
  const note = r.atLimit ? pc.red('AT LIMIT') : '';
  return cols(mark, cell(r.fiveHourPercent), cell(r.weeklyPercent), r5, rwk, note);
}
