import pc from 'picocolors';
import type { IndexDb } from '../index-db';
import type { CliDeps } from './index';
import { paths } from '../deps';

// ============================================================================
// Types
// ============================================================================

const CLAUDE_AUTO_PREFIX = 'claude-auto-';

function shortBinary(binary: string): string {
  return binary.startsWith(CLAUDE_AUTO_PREFIX) ? binary.slice(CLAUDE_AUTO_PREFIX.length) : binary;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

/** Derive phase label from agent name */
function derivePhase(agent: string): string {
  if (agent === 'implementer') return 'impl';
  if (agent === 'reviewer') return 'review';
  if (agent === 'checkpointer') return 'checkpoint';
  return agent;
}

function formatNum(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  return `${(n / 1000).toFixed(1)}k`;
}

interface Sample {
  loop: number;
  agent: string;
  binary: string;
  phaseIdx?: number;
  verdict?: string;
  completionEstimate?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
  propagated?: boolean;
}

interface Matcher {
  label: string;
  op: '=' | '=~';
  value: string;
  regex?: RegExp;
}

interface ParsedQuery {
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
  groupBy: string[];
  matchers: Matcher[];
}

interface AggResult {
  labels: Record<string, string>;
  count: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

// ============================================================================
// Query parser
// ============================================================================

const AGG_OPS = ['sum', 'avg', 'min', 'max', 'count'] as const;

function parseQuery(query: string): ParsedQuery {
  let s = query.trim();

  // Try to parse aggregation at the start
  let aggregation: ParsedQuery['aggregation'] = undefined;
  let groupBy: string[] = [];

  for (const op of AGG_OPS) {
    if (s.startsWith(op)) {
      aggregation = op;
      s = s.slice(op.length).trim();
      break;
    }
  }

  if (aggregation) {
    // Check for "by (label1, label2)"
    const byMatch = s.match(/^by\s*\(\s*([^)]+)\s*\)\s*(.*)/);
    if (byMatch) {
      groupBy = byMatch[1]
        .split(',')
        .map(l => l.trim())
        .filter(Boolean);
      s = byMatch[2].trim();
    }
  }

  // Parse filter {matchers}
  const matchers: Matcher[] = [];
  const filterMatch = s.match(/^\{(.*)\}\s*$/);
  if (filterMatch) {
    const inner = filterMatch[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Match "label op value" — value can be quoted
      const m = trimmed.match(/^(\w+)\s*(=~|=)\s*(.+)$/);
      if (m) {
        let value = m[3].trim();
        // Strip quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // If value contains glob wildcards, always use regex matching
        const hasGlob = value.includes('*') || value.includes('?');
        const matcher: Matcher = { label: m[1], op: m[2] as '=' | '=~', value };

        if (m[2] === '=~' || hasGlob) {
          // Convert glob-style wildcards to regex
          const regexStr = value
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars
            .replace(/\*/g, '.*') // glob * → .*
            .replace(/\?/g, '.'); // glob ? → .
          try {
            matcher.regex = new RegExp(`^${regexStr}$`, 'i');
          } catch {
            /* skip */
          }
        }
        matchers.push(matcher);
      }
    }
  }

  return { aggregation, groupBy, matchers };
}

// ============================================================================
// Filter
// ============================================================================

function getLabel(sample: Sample, label: string): string {
  switch (label) {
    case 'agent':
      return sample.agent;
    case 'binary':
      return sample.binary;
    case 'phase':
      return derivePhase(sample.agent);
    case 'pidx':
      return sample.phaseIdx !== undefined ? String(sample.phaseIdx) : '';
    case 'verdict':
      return sample.verdict ?? '';
    case 'loop':
      return String(sample.loop);
    case 'propagated':
      return sample.propagated ? 'true' : 'false';
    default:
      return '';
  }
}

function matchSample(sample: Sample, matchers: Matcher[]): boolean {
  for (const m of matchers) {
    const val = getLabel(sample, m.label);
    if (m.regex) {
      if (!m.regex.test(val)) return false;
    } else if (val !== m.value) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Aggregation
// ============================================================================

function aggregate(samples: Sample[], aggregation: ParsedQuery['aggregation'], groupBy: string[]): AggResult[] {
  const groups = new Map<string, { samples: Sample[]; labels: Record<string, string> }>();

  for (const s of samples) {
    const key = groupBy.map(l => `${l}=${getLabel(s, l)}`).join('\x00');
    const labels: Record<string, string> = {};
    for (const l of groupBy) labels[l] = getLabel(s, l);

    let group = groups.get(key);
    if (!group) {
      group = { samples: [], labels };
      groups.set(key, group);
    }
    group.samples.push(s);
  }

  const results: AggResult[] = [];

  for (const [, group] of groups) {
    const n = group.samples.length;

    if (aggregation === 'count') {
      results.push({ labels: group.labels, count: n, durationMs: 0, inputTokens: 0, outputTokens: 0 });
      continue;
    }

    const dur = compute(
      n,
      group.samples.map(s => s.durationMs),
      aggregation,
    );
    const inTok = compute(
      n,
      group.samples.map(s => s.inputTokens),
      aggregation,
    );
    const outTok = compute(
      n,
      group.samples.map(s => s.outputTokens),
      aggregation,
    );

    results.push({ labels: group.labels, count: n, durationMs: dur, inputTokens: inTok, outputTokens: outTok });
  }

  // Sort by group labels for stable output
  results.sort((a, b) => {
    for (const l of groupBy) {
      const cmp = (a.labels[l] ?? '').localeCompare(b.labels[l] ?? '');
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  return results;
}

function compute(n: number, values: number[], op: NonNullable<ParsedQuery['aggregation']>): number {
  if (n === 0) return 0;
  switch (op) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / n;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return 0;
  }
}

// ============================================================================
// Display helpers
// ============================================================================

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// ============================================================================
// Handler
// ============================================================================

export async function handler(
  query: string | undefined,
  opts: { json?: boolean; run?: string },
  deps: CliDeps,
): Promise<void> {
  try {
    const { indexDb, state } = deps;

    // Resolve run ID
    let runId = opts.run;
    if (!runId && !query) {
      // No query and no --run — try workspace lookup (backward compat)
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No active run for this workspace.'));
        console.log(pc.dim('Usage: kloop metrics [query] [--run <id>]'));
        console.log(pc.dim('  kloop metrics                 # raw table'));
        console.log(pc.dim('  kloop metrics "sum by (binary)"'));
        console.log(pc.dim('  kloop metrics "avg by (phase) {agent=implementer}"'));
        return;
      }
      runId = row.id;
    } else if (!runId) {
      // Query provided, default to workspace run
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (row) runId = row.id;
    }

    if (!runId) {
      console.log(pc.yellow('No run found. Use --run <id> or run from a workspace with an active run.'));
      return;
    }

    // Load samples
    const samples = await loadSamples(runId, state);
    if (samples.length === 0) {
      console.log(pc.yellow('No metrics found for this run.'));
      return;
    }

    // No query — show raw table
    if (!query) {
      return showRawTable(runId, samples, opts);
    }

    // Parse and execute query
    const parsed = parseQuery(query);

    // Filter
    const filtered = parsed.matchers.length > 0 ? samples.filter(s => matchSample(s, parsed.matchers)) : samples;

    if (filtered.length === 0) {
      console.log(pc.yellow('No samples match query.'));
      return;
    }

    // If no aggregation, show filtered raw table
    if (!parsed.aggregation) {
      return showRawTable(runId, filtered, opts);
    }

    // Aggregate
    const results = aggregate(filtered, parsed.aggregation, parsed.groupBy);

    // JSON output
    if (opts.json) {
      console.log(
        JSON.stringify({ runId, query, aggregation: parsed.aggregation, groupBy: parsed.groupBy, results }, null, 2),
      );
      return;
    }

    // Human output
    console.log(pc.bold(`Run: ${runId}  ${pc.dim(`${filtered.length} samples`)}`));
    if (parsed.matchers.length > 0) {
      const matcherStrs = parsed.matchers.map(m => `${m.label}${m.op}${m.value}`).join(', ');
      console.log(pc.dim(`Filter: {${matcherStrs}}`));
    }
    console.log(
      pc.dim(
        `Aggregation: ${parsed.aggregation}${parsed.groupBy.length > 0 ? ` by (${parsed.groupBy.join(', ')})` : ''}`,
      ),
    );
    console.log('');

    if (parsed.aggregation === 'count') {
      const labelW =
        parsed.groupBy.length > 0
          ? Math.max(
              8,
              ...parsed.groupBy.map(l => l.length),
              ...results.map(r => parsed.groupBy.map(l => r.labels[l] ?? '').join(', ').length),
            )
          : 12;
      const w = { label: labelW + 2, count: 8 };
      console.log(`${padRight('GROUP', w.label)}  ${padLeft('COUNT', w.count)}`);
      console.log(pc.dim(`${'─'.repeat(w.label)}  ${'─'.repeat(w.count)}`));
      for (const r of results) {
        const labelStr = parsed.groupBy.map(l => r.labels[l] ?? '-').join(', ');
        console.log(`${padRight(labelStr, w.label)}  ${padLeft(String(r.count), w.count)}`);
      }
    } else {
      const labelW =
        parsed.groupBy.length > 0
          ? Math.max(
              8,
              ...parsed.groupBy.map(l => l.length),
              ...results.map(r => parsed.groupBy.map(l => r.labels[l] ?? '').join(', ').length),
            )
          : 12;
      const w = { label: labelW + 2, count: 6, dur: 10, inTok: 10, outTok: 10, total: 10 };
      console.log(
        `${padRight('GROUP', w.label)}  ${padLeft('N', w.count)}  ${padLeft('DURATION', w.dur)}  ${padLeft('IN', w.inTok)}  ${padLeft('OUT', w.outTok)}  ${padLeft('TOTAL', w.total)}`,
      );
      console.log(
        pc.dim(
          `${'─'.repeat(w.label)}  ${'─'.repeat(w.count)}  ${'─'.repeat(w.dur)}  ${'─'.repeat(w.inTok)}  ${'─'.repeat(w.outTok)}  ${'─'.repeat(w.total)}`,
        ),
      );

      for (const r of results) {
        const labelStr = parsed.groupBy.map(l => r.labels[l] ?? '-').join(', ');
        console.log(
          `${padRight(labelStr, w.label)}  ${padLeft(String(r.count), w.count)}  ${padLeft(formatDuration(r.durationMs), w.dur)}  ${padLeft(formatNum(r.inputTokens), w.inTok)}  ${padLeft(formatNum(r.outputTokens), w.outTok)}  ${padLeft(formatNum(r.inputTokens + r.outputTokens), w.total)}`,
        );
      }
    }

    console.log('');

    // Totals row
    if (parsed.aggregation !== 'count') {
      const totalDur = results.reduce((s, r) => s + r.durationMs, 0);
      const totalIn = results.reduce((s, r) => s + r.inputTokens, 0);
      const totalOut = results.reduce((s, r) => s + r.outputTokens, 0);
      console.log(
        pc.dim(
          `Total: ${formatDuration(totalDur)}  ${formatNum(totalIn)} in  ${formatNum(totalOut)} out  ${formatNum(totalIn + totalOut)} total`,
        ),
      );
    }
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ============================================================================
// Raw table (original behavior)
// ============================================================================

function showRawTable(runId: string, samples: Sample[], opts: { json?: boolean }): void {
  const totalDurationMs = samples.reduce((sum, s) => sum + s.durationMs, 0);
  const totalInputTokens = samples.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutputTokens = samples.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;

  if (opts.json) {
    console.log(
      JSON.stringify({ runId, totalDurationMs, totalInputTokens, totalOutputTokens, totalTokens, samples }, null, 2),
    );
    return;
  }

  console.log(pc.bold(`Run: ${runId}`));
  console.log(
    `Total: ${formatDuration(totalDurationMs)} | ${formatNum(totalTokens)} tokens (${formatNum(totalInputTokens)} in / ${formatNum(totalOutputTokens)} out)`,
  );
  console.log('');

  const w = {
    loop: 5,
    agent: 14,
    binary: 22,
    phase: 11,
    verdict: 10,
    comp: 6,
    duration: 10,
    input: 13,
    output: 13,
    total: 13,
    error: 12,
  };
  const header =
    padLeft('loop', w.loop) +
    padRight('agent', w.agent) +
    padRight('binary', w.binary) +
    padLeft('phase', w.phase) +
    padLeft('verdict', w.verdict) +
    padLeft('comp', w.comp) +
    padLeft('dur_s', w.duration) +
    padLeft('in_tok', w.input) +
    padLeft('out_tok', w.output) +
    padLeft('total', w.total) +
    padLeft('error', w.error);

  const sep = '─'.repeat(Object.values(w).reduce((a, b) => a + b, 0));

  console.log(header);
  console.log(pc.dim(sep));

  for (const s of samples) {
    const total = s.inputTokens + s.outputTokens;
    const isImpl = s.agent === 'implementer';
    const agentStr = isImpl ? pc.cyan(padRight(s.agent, w.agent)) : pc.green(padRight(s.agent, w.agent));
    const binaryStr = padRight(shortBinary(s.binary), w.binary);

    const verdictStr = s.verdict
      ? s.verdict === 'approved'
        ? pc.green(padLeft(s.verdict, w.verdict))
        : pc.red(padLeft(s.verdict, w.verdict))
      : padLeft('-', w.verdict);
    const compStr =
      s.completionEstimate !== undefined ? padLeft(`${s.completionEstimate}%`, w.comp) : padLeft('-', w.comp);
    const errorStr = s.error ? pc.yellow(padLeft(s.error, w.error)) : padLeft('-', w.error);

    const phaseStr = padLeft(derivePhase(s.agent), w.phase);

    console.log(
      padLeft(String(s.loop), w.loop) +
        agentStr +
        binaryStr +
        phaseStr +
        verdictStr +
        compStr +
        padLeft((s.durationMs / 1000).toFixed(1), w.duration) +
        padLeft(formatNum(s.inputTokens), w.input) +
        padLeft(formatNum(s.outputTokens), w.output) +
        padLeft(formatNum(total), w.total) +
        errorStr,
    );
  }

  console.log(pc.dim(sep));
}

// ============================================================================
// Sample loader
// ============================================================================

async function loadSamples(
  runId: string,
  state: {
    fs: {
      exists(p: string): Promise<boolean>;
      readdir(p: string): Promise<string[]>;
      readFile(p: string): Promise<string>;
    };
  },
): Promise<Sample[]> {
  const runDir = paths.runPath(runId);
  const loopDirs: number[] = [];
  try {
    const entries = await state.fs.readdir(runDir);
    for (const entry of entries) {
      const match = entry.match(/^loop-(\d+)$/);
      if (match) loopDirs.push(parseInt(match[1], 10));
    }
  } catch {
    return [];
  }

  const allSamples: Sample[] = [];

  for (const loopNum of loopDirs.sort((a, b) => a - b)) {
    const metricsPath = paths.loopMetrics(runId, loopNum);
    if (await state.fs.exists(metricsPath)) {
      const content = await state.fs.readFile(metricsPath);
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          allSamples.push({
            loop: loopNum,
            agent: parsed.agent ?? '?',
            binary: parsed.binary ?? '',
            phaseIdx: parsed.phaseIdx,
            verdict: parsed.verdict,
            completionEstimate: parsed.completionEstimate,
            inputTokens: parsed.inputTokens ?? 0,
            outputTokens: parsed.outputTokens ?? 0,
            durationMs: parsed.durationMs ?? 0,
            error: parsed.error,
            propagated: parsed.propagated ?? false,
          });
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  return allSamples;
}
