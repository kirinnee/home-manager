import type { StateService } from '../deps';
import type { MetricSample } from '../types';

// ============================================================================
// Query Language
// ============================================================================

interface ParsedQuery {
  operator: 'sum' | 'avg' | 'min' | 'max';
  groupBy: string[];
  matchers: Array<{ key: string; value: string }>;
}

function parseQuery(query: string | undefined): ParsedQuery | null {
  if (!query) return null;

  const trimmed = query.trim();

  // Step 1: Extract operator and groupBy
  const opMatch = trimmed.match(/^(\w+)\s+by\s*\(([^)]*)\)/);
  if (!opMatch) return null;

  const operator = opMatch[1] as 'sum' | 'avg' | 'min' | 'max';
  if (!['sum', 'avg', 'min', 'max'].includes(operator)) return null;

  const groupBy = opMatch[2]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // Step 2: Extract matchers from remainder
  // Formats: {k='v',...} or ({k='v',...}) or (k='v',...) or empty
  const remainder = trimmed.slice(opMatch[0].length).trim();
  let matcherStr: string | undefined;

  if (remainder.length === 0) {
    // No matchers
  } else if (remainder.startsWith('(') && remainder.endsWith(')')) {
    // Strip outer parens: ({k='v'}) → {k='v'} or (k='v') → k='v
    const inner = remainder.slice(1, -1).trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      // ({k='v'}) → strip to k='v'
      matcherStr = inner.slice(1, -1).trim();
    } else {
      // (k='v') → use as-is
      matcherStr = inner;
    }
  } else if (remainder.startsWith('{') && remainder.endsWith('}')) {
    // {k='v'} → strip to k='v'
    matcherStr = remainder.slice(1, -1).trim();
  } else {
    return null; // Unexpected trailing content
  }

  const matchers: Array<{ key: string; value: string }> = [];
  if (matcherStr) {
    const pairs = matcherStr.split(',');
    for (const pair of pairs) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        const key = pair.slice(0, eqIndex).trim();
        let value = pair.slice(eqIndex + 1).trim();
        // Remove quotes
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        if (key && value) {
          matchers.push({ key, value });
        }
      }
    }
  }

  return { operator, groupBy, matchers };
}

function matchesAll(sample: MetricSample, matchers: Array<{ key: string; value: string }>): boolean {
  // Group matchers by key — same key with multiple values means OR
  const byKey = new Map<string, Set<string>>();
  for (const { key, value } of matchers) {
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(value);
  }

  for (const [key, values] of byKey) {
    if (!values.has(sample.labels[key])) return false;
  }
  return true;
}

function aggregate(samples: MetricSample[], query: ParsedQuery): Record<string, MetricSample[]> {
  // Filter by matchers
  const filtered = samples.filter(s => matchesAll(s, query.matchers));

  // Group by keys
  const groups = new Map<string, MetricSample[]>();
  for (const s of filtered) {
    const key = query.groupBy.length === 0 ? '__all__' : query.groupBy.map(k => s.labels[k] ?? '').join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  return Object.fromEntries(groups);
}

// ============================================================================
// Table Rendering
// ============================================================================

interface TableRow {
  key: Record<string, string>;
  duration_s: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  samples: number;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function renderTable(rows: TableRow[], groupByKeys: string[]): string {
  if (rows.length === 0) {
    return 'No matching samples.';
  }

  const keyWidth =
    groupByKeys.length > 0 ? Math.max(12, ...rows.map(r => groupByKeys.map(k => r.key[k] ?? '').join('/').length)) : 0;

  const numWidth = 14;
  const sampleWidth = 8;

  const lines: string[] = [];

  // Header
  if (groupByKeys.length > 0) {
    const header = groupByKeys.join('/');
    lines.push(
      padRight(header, keyWidth) +
        padLeft('duration_s', numWidth) +
        padLeft('input_tokens', numWidth) +
        padLeft('output_tokens', numWidth) +
        padLeft('total_tokens', numWidth) +
        padLeft('samples', sampleWidth),
    );
  } else {
    lines.push(
      padLeft('duration_s', numWidth) +
        padLeft('input_tokens', numWidth) +
        padLeft('output_tokens', numWidth) +
        padLeft('total_tokens', numWidth) +
        padLeft('samples', sampleWidth),
    );
  }

  // Separator
  const totalWidth = keyWidth + numWidth * 4 + sampleWidth;
  lines.push('-'.repeat(totalWidth));

  // Rows
  const sortedRows = [...rows].sort((a, b) => {
    if (groupByKeys.length === 0) return 0;
    for (const k of groupByKeys) {
      const av = a.key[k] ?? '';
      const bv = b.key[k] ?? '';
      if (av !== bv) return av.localeCompare(bv);
    }
    return 0;
  });

  for (const row of sortedRows) {
    const keyStr = groupByKeys.length > 0 ? padRight(groupByKeys.map(k => row.key[k] ?? '').join('/'), keyWidth) : '';
    lines.push(
      keyStr +
        padLeft(row.duration_s.toFixed(1), numWidth) +
        padLeft(row.input_tokens.toLocaleString(), numWidth) +
        padLeft(row.output_tokens.toLocaleString(), numWidth) +
        padLeft(row.total_tokens.toLocaleString(), numWidth) +
        padLeft(String(row.samples), sampleWidth),
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Raw Table Rendering (default, no query)
// ============================================================================

function renderRawTable(samples: MetricSample[]): string {
  if (samples.length === 0) {
    return 'No metric samples found.';
  }

  const sorted = [...samples].sort((a, b) => {
    const loopA = parseInt(a.labels.loop ?? '0');
    const loopB = parseInt(b.labels.loop ?? '0');
    if (loopA !== loopB) return loopA - loopB;
    const phaseOrder: Record<string, number> = { implementer: 0, reviewer: 1 };
    const phaseA = phaseOrder[a.labels.phase] ?? 99;
    const phaseB = phaseOrder[b.labels.phase] ?? 99;
    if (phaseA !== phaseB) return phaseA - phaseB;
    return parseInt(a.labels.ordinal ?? '0') - parseInt(b.labels.ordinal ?? '0');
  });

  const colWidths = {
    loop: 6,
    phase: 14,
    binary: 25,
    ordinal: 8,
    phaseIdx: 6,
    nvf: 4,
    prev: 5,
    duration: 12,
    input: 14,
    output: 14,
    error: 12,
  };

  const lines: string[] = [];

  // Header
  lines.push(
    padLeft('loop', colWidths.loop) +
      padLeft('phase', colWidths.phase) +
      padRight('binary', colWidths.binary) +
      padLeft('ord', colWidths.ordinal) +
      padLeft('pidx', colWidths.phaseIdx) +
      padLeft('nvf', colWidths.nvf) +
      padLeft('prev', colWidths.prev) +
      padLeft('duration_s', colWidths.duration) +
      padLeft('input_tok', colWidths.input) +
      padLeft('output_tok', colWidths.output) +
      padLeft('error', colWidths.error),
  );

  // Separator
  const totalWidth = Object.values(colWidths).reduce((sum, w) => sum + w, 0);
  lines.push('-'.repeat(totalWidth));

  // Rows
  for (const s of sorted) {
    lines.push(
      padLeft(s.labels.loop ?? '-', colWidths.loop) +
        padLeft(s.labels.phase ?? '-', colWidths.phase) +
        padRight(s.labels.binary ?? '-', colWidths.binary) +
        padLeft(s.labels.ordinal ?? '-', colWidths.ordinal) +
        padLeft(s.labels.phaseIdx ?? '-', colWidths.phaseIdx) +
        padLeft(s.labels.noVerdictFail ?? '-', colWidths.nvf) +
        padLeft(s.labels.sawPrevReviews ?? '-', colWidths.prev) +
        padLeft((s.durationMs / 1000).toFixed(1), colWidths.duration) +
        padLeft(String(s.inputTokens ?? '-'), colWidths.input) +
        padLeft(String(s.outputTokens ?? '-'), colWidths.output) +
        padLeft(s.error ?? '-', colWidths.error),
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Handler
// ============================================================================

export async function handler(
  query: string | undefined,
  runFilter: string | undefined,
  state: StateService,
): Promise<void> {
  try {
    let samples: MetricSample[];

    if (runFilter) {
      // Load specific run
      samples = await state.loadMetricSamples(runFilter);
      if (samples.length === 0) {
        console.log(`No metrics found for run: ${runFilter}`);
        console.log(`Available runs: ${(await state.listMetricRuns()).join(', ') || 'none'}`);
        return;
      }
    } else {
      // Load most recent run
      const runs = await state.listMetricRuns();
      if (runs.length === 0) {
        console.log('No metrics found. Run dev-loop run to generate metrics.');
        return;
      }
      const latestRun = runs[runs.length - 1];
      samples = await state.loadMetricSamples(latestRun);
      if (samples.length === 0) {
        console.log(`No metric samples found for run: ${latestRun}`);
        return;
      }
      if (!runFilter) {
        console.log(`Run: ${latestRun}`);
        console.log('');
      }
    }

    const parsedQuery = parseQuery(query);

    if (!parsedQuery) {
      // Default: raw table
      console.log(renderRawTable(samples));
    } else {
      // Aggregation query
      const groups = aggregate(samples, parsedQuery);
      const rows: TableRow[] = [];

      for (const [key, groupSamples] of Object.entries(groups)) {
        const duration_s = groupSamples.reduce((sum, s) => sum + s.durationMs, 0) / 1000;
        const input_tokens = groupSamples.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
        const output_tokens = groupSamples.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);

        let aggDuration: number;
        let aggInput: number;
        let aggOutput: number;

        switch (parsedQuery.operator) {
          case 'sum':
            aggDuration = duration_s;
            aggInput = input_tokens;
            aggOutput = output_tokens;
            break;
          case 'avg':
            aggDuration = duration_s / groupSamples.length;
            aggInput = input_tokens / groupSamples.length;
            aggOutput = output_tokens / groupSamples.length;
            break;
          case 'min':
            aggDuration = Math.min(...groupSamples.map(s => s.durationMs)) / 1000;
            aggInput = Math.min(...groupSamples.map(s => s.inputTokens ?? 0));
            aggOutput = Math.min(...groupSamples.map(s => s.outputTokens ?? 0));
            break;
          case 'max':
            aggDuration = Math.max(...groupSamples.map(s => s.durationMs)) / 1000;
            aggInput = Math.max(...groupSamples.map(s => s.inputTokens ?? 0));
            aggOutput = Math.max(...groupSamples.map(s => s.outputTokens ?? 0));
            break;
        }

        const keyObj: Record<string, string> = {};
        if (key !== '__all__' && parsedQuery.groupBy.length > 0) {
          const parts = key.split('|');
          parsedQuery.groupBy.forEach((k, i) => {
            keyObj[k] = parts[i] ?? '';
          });
        }

        rows.push({
          key: keyObj,
          duration_s: aggDuration,
          input_tokens: Math.round(aggInput),
          output_tokens: Math.round(aggOutput),
          total_tokens: Math.round(aggInput) + Math.round(aggOutput),
          samples: groupSamples.length,
        });
      }

      console.log(renderTable(rows, parsedQuery.groupBy));
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
