import * as fs from 'fs/promises';
import * as path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import Table from 'cli-table3';
import type { CliDeps } from './index';
import { paths } from '../deps';
import { formatDurationHuman } from '../loop/format';
import { shortBinary, loadLoopSummaries, verdictMark } from './shared';

// ============================================================================
// Run ID resolution (shared across all subcommands)
// ============================================================================

async function resolveRunId(id: string | undefined, deps: CliDeps): Promise<string | null> {
  if (id) {
    const row = await deps.indexDb.getRun(id);
    if (!row) {
      console.log(pc.red(`Run not found: ${id}`));
      return null;
    }
    return id;
  }
  const workspace = process.cwd();
  const row = await deps.indexDb.getRunByWorkspace(workspace);
  if (!row) {
    console.log(pc.yellow('No run found for this workspace.'));
    return null;
  }
  return row.id;
}

async function resolveLoop(
  runId: string,
  loopArg: string | undefined,
  opts: { run?: string },
  deps: CliDeps,
): Promise<number | null> {
  if (loopArg) return parseInt(loopArg, 10);

  const summaries = await loadLoopSummaries(runId, deps.state.fs);
  if (summaries.length === 0) {
    console.log(pc.yellow('No loop data found.'));
    return null;
  }
  return summaries[summaries.length - 1].loop;
}

async function latestLoopNum(runId: string, deps: CliDeps): Promise<number | null> {
  const summaries = await loadLoopSummaries(runId, deps.state.fs);
  if (summaries.length === 0) return null;
  return summaries[summaries.length - 1].loop;
}

// ============================================================================
// Markdown → terminal renderer
// ============================================================================

function renderMarkdown(content: string, indent: string = ''): void {
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (const rawLine of lines) {
    // Toggle code block
    if (rawLine.trim().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        console.log(`${indent}${pc.dim('└──')}`);
      } else {
        inCodeBlock = true;
        const lang = rawLine.trim().slice(3);
        console.log(`${indent}${pc.dim('┌──')}${lang ? pc.dim(` ${lang}`) : ''}`);
      }
      continue;
    }

    if (inCodeBlock) {
      console.log(`${indent}${pc.dim('│')} ${pc.dim(rawLine)}`);
      continue;
    }

    const line = rawLine;

    // Headings
    if (line.startsWith('### ')) {
      console.log(`${indent}${pc.cyan(pc.bold(line.slice(4)))}`);
    } else if (line.startsWith('## ')) {
      console.log('');
      console.log(`${indent}${pc.bold(line.slice(3))}`);
    } else if (line.startsWith('# ')) {
      console.log('');
      console.log(indent + pc.bgCyan(pc.black(pc.bold(' ' + line.slice(2) + ' '))));
      console.log('');
    } else if (line.startsWith('---')) {
      console.log(`${indent}${pc.dim('─'.repeat(40))}`);
    } else if (line.startsWith('> ')) {
      // Blockquote
      console.log(`${indent}${pc.dim('│')} ${pc.italic(line.slice(2))}`);
    } else if (/^[-*] \[[ x]\]/.test(line)) {
      // Checkbox list
      const checked = line[3] === 'x';
      const text = line.slice(5).replace(/\*\*/g, '');
      const mark = checked ? pc.green('■') : pc.red('□');
      console.log(`${indent}  ${mark} ${text}`);
    } else if (/^[-*] /.test(line)) {
      // Bullet list
      const text = inlineFormat(line.slice(2));
      console.log(`${indent}  ${pc.cyan('•')} ${text}`);
    } else if (/^\d+\. /.test(line)) {
      // Numbered list
      const text = inlineFormat(line.replace(/^\d+\. /, ''));
      const num = line.match(/^(\d+)\./)![1];
      console.log(`${indent}  ${pc.dim(num + '.')} ${text}`);
    } else if (line.trim() === '') {
      console.log('');
    } else {
      console.log(`${indent}${inlineFormat(line)}`);
    }
  }
}

function inlineFormat(text: string): string {
  // Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => pc.bold(t));
  text = text.replace(/__(.+?)__/g, (_, t) => pc.bold(t));
  // Italic *text* or _text_ (but not inside bold)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => pc.italic(t));
  // Inline code `code`
  text = text.replace(/`([^`]+)`/g, (_, t) => pc.dim(pc.white(t)));
  // ✅ / ❌ / ⚠️
  text = text.replace(/✅/g, pc.green('✓'));
  text = text.replace(/❌/g, pc.red('✗'));
  text = text.replace(/⚠️?/g, pc.yellow('!'));
  return text;
}

// ============================================================================
// File helpers
// ============================================================================

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function readJsonSafe<T>(p: string): Promise<T | null> {
  try {
    const content = await fs.readFile(p, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Subcommand handlers
// ============================================================================

// ---- reviews ----

export async function showReviews(
  id: string | undefined,
  loopArg: string | undefined,
  opts: { run?: string },
  deps: CliDeps,
): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;
  const loopNum = await resolveLoop(runId, loopArg, opts, deps);
  if (!loopNum) return;

  const reviewsDir = paths.loopReviewsPath(runId, loopNum);
  const verdictsDir = paths.loopVerdictsPath(runId, loopNum);
  const summaries = await loadLoopSummaries(runId, deps.state.fs);
  const loopSummary = summaries.find(s => s.loop === loopNum);

  // Discover reviewer markdown files
  let reviewFiles: string[] = [];
  try {
    const entries = await fs.readdir(reviewsDir);
    reviewFiles = entries
      .filter(e => e.endsWith('.md'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('reviewer-', '').replace('.md', ''), 10);
        const numB = parseInt(b.replace('reviewer-', '').replace('.md', ''), 10);
        return numA - numB;
      });
  } catch {}

  if (reviewFiles.length === 0) {
    console.log(pc.yellow(`No reviews found for loop ${loopNum}.`));
    return;
  }

  console.log(pc.bold(`Run ${runId} — Loop ${loopNum} Reviews\n`));

  for (const file of reviewFiles) {
    const match = file.match(/^reviewer-(\d+)\.md$/);
    if (!match) continue;
    const revIdx = parseInt(match[1], 10);

    // Load verdict for badge
    const verdict = await readJsonSafe<{ approved: boolean; reasoning: string; completionEstimate?: number }>(
      path.join(verdictsDir, `reviewer-${revIdx}.json`),
    );
    // Load summary for binary name / timing
    const reviewerSummary = loopSummary?.reviewPhases.flatMap(p => p.reviewers).find(r => r.reviewerIndex === revIdx);

    // Header
    const mark = verdict ? verdictMark(verdict.approved ? 'approved' : 'rejected') : pc.dim('·');
    const binary = reviewerSummary
      ? shortBinary(reviewerSummary.binary, reviewerSummary.harness)
      : `reviewer-${revIdx}`;
    const duration = reviewerSummary ? formatDurationHuman(reviewerSummary.durationMs) : '';
    const comp = verdict?.completionEstimate !== undefined ? ` ${verdict.completionEstimate}%` : '';
    const errNote = reviewerSummary?.timedOut
      ? pc.yellow(' (timed out)')
      : reviewerSummary?.error
        ? pc.red(` (${reviewerSummary.error})`)
        : '';

    console.log(pc.bold(`${mark} ${pc.cyan(binary)}${comp}${errNote}  ${pc.dim(duration)}`));
    console.log(pc.dim('─'.repeat(60)));

    // Render review markdown
    const content = await readFileSafe(path.join(reviewsDir, file));
    if (content) {
      renderMarkdown(content, '  ');
    }

    // Show verdict reasoning if separate from review
    if (verdict?.reasoning && !content) {
      console.log(`  ${pc.dim(verdict.reasoning.slice(0, 200))}`);
    }

    console.log('');
  }
}

// ---- prompts ----

export async function showPrompts(
  id: string | undefined,
  loopArg: string | undefined,
  opts: { run?: string },
  deps: CliDeps,
): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;
  const loopNum = await resolveLoop(runId, loopArg, opts, deps);
  if (!loopNum) return;

  const loopDir = paths.loopPath(runId, loopNum);

  console.log(pc.bold(`Run ${runId} — Loop ${loopNum} Prompts\n`));

  // Implementer prompt
  const implPrompt = await readFileSafe(path.join(loopDir, 'implementer', 'prompt.md'));
  if (implPrompt) {
    console.log(pc.bgCyan(pc.black(pc.bold(' Implementer '))));
    console.log(pc.dim('─'.repeat(60)));
    renderMarkdown(implPrompt, '');
    console.log('');
  }

  // Reviewer prompts
  let reviewerDirs: string[] = [];
  try {
    const entries = await fs.readdir(loopDir);
    reviewerDirs = entries
      .filter(e => e.startsWith('reviewer-'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('reviewer-', ''), 10);
        const numB = parseInt(b.replace('reviewer-', ''), 10);
        return numA - numB;
      });
  } catch {}

  for (const dir of reviewerDirs) {
    const revPrompt = await readFileSafe(path.join(loopDir, dir, 'prompt.md'));
    if (revPrompt) {
      console.log(pc.bgBlue(pc.black(pc.bold(` ${dir} `))));
      console.log(pc.dim('─'.repeat(60)));
      renderMarkdown(revPrompt, '');
      console.log('');
    }
  }
}

// ---- verdicts ----

interface VerdictRow {
  reviewer: string;
  phase: number;
  verdict: string;
  completion?: number;
  duration: string;
  tokens: string;
  error?: string;
}

export async function showVerdicts(
  id: string | undefined,
  loopArg: string | undefined,
  opts: { run?: string },
  deps: CliDeps,
): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;
  const loopNum = await resolveLoop(runId, loopArg, opts, deps);
  if (!loopNum) return;

  const summaries = await loadLoopSummaries(runId, deps.state.fs);
  const loopSummary = summaries.find(s => s.loop === loopNum);

  if (!loopSummary) {
    console.log(pc.yellow(`No summary found for loop ${loopNum}.`));
    return;
  }

  console.log(pc.bold(`Run ${runId} — Loop ${loopNum} Verdicts\n`));

  // Implementer row
  const impl = loopSummary.implementer;
  const implTok = (impl.inputTokens ?? 0) + (impl.outputTokens ?? 0);
  const implTokStr = implTok < 1000 ? `${implTok}` : `${(implTok / 1000).toFixed(1)}k`;
  console.log(
    `  ${pc.dim('impl'.padEnd(12))}  ${shortBinary(impl.binary, impl.harness).padEnd(22)}  ${pc.green('●').padEnd(4)}  ${formatDurationHuman(impl.durationMs).padStart(8)}  ${pc.dim(implTokStr + ' tok')}`,
  );
  console.log('');

  // Review phases
  const rows: VerdictRow[] = [];
  for (const phase of loopSummary.reviewPhases) {
    for (const r of phase.reviewers) {
      const tok = (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
      const tokStr = tok < 1000 ? `${tok}` : `${(tok / 1000).toFixed(1)}k`;
      rows.push({
        reviewer: shortBinary(r.binary, r.harness),
        phase: phase.phase,
        verdict: r.verdict ?? 'unknown',
        completion: r.completionEstimate,
        duration: formatDurationHuman(r.durationMs),
        tokens: tokStr,
        error: r.timedOut ? 'timeout' : r.error,
      });
    }
  }

  if (rows.length === 0) {
    console.log(pc.yellow('No reviewer verdicts found.'));
    return;
  }

  const table = new Table({
    head: ['#', 'Reviewer', 'Verdict', 'Done', 'Time', 'Tokens', 'Error'].map(h => pc.bold(pc.dim(h))),
    style: { head: [], border: ['grey'] },
    colWidths: [4, 22, 10, 7, 8, 10, 12],
  });

  for (const row of rows) {
    const vMark = row.verdict === 'approved' ? pc.green('✓') : pc.red('✗');
    const vText = row.verdict === 'approved' ? pc.green('approved') : pc.red('rejected');
    const comp = row.completion !== undefined ? `${row.completion}%` : '-';
    const errStr = row.error ? pc.yellow(row.error) : '';
    table.push([
      String(rows.indexOf(row)),
      row.reviewer,
      `${vMark} ${vText}`,
      comp,
      row.duration,
      pc.dim(row.tokens),
      errStr,
    ]);
  }

  console.log(table.toString());

  // Show reasoning summary
  console.log('');
  console.log(pc.bold('Reasoning:'));
  const verdictsDir = paths.loopVerdictsPath(runId, loopNum);
  for (const row of rows) {
    const revIdx = loopSummary.reviewPhases
      .flatMap(p => p.reviewers)
      .findIndex(r => shortBinary(r.binary, r.harness) === row.reviewer);
    if (revIdx === -1) continue;
    const verdict = await readJsonSafe<{ reasoning: string }>(path.join(verdictsDir, `reviewer-${revIdx}.json`));
    if (verdict?.reasoning) {
      console.log(
        `  ${pc.cyan(row.reviewer)}: ${pc.dim(verdict.reasoning.slice(0, 120))}${verdict.reasoning.length > 120 ? '...' : ''}`,
      );
    }
  }
}

// ---- evidence ----

export async function showEvidence(
  id: string | undefined,
  loopArg: string | undefined,
  opts: { run?: string },
  deps: CliDeps,
): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;
  const loopNum = await resolveLoop(runId, loopArg, opts, deps);
  if (!loopNum) return;

  const evidenceDir = paths.loopEvidencePath(runId, loopNum);

  if (!(await fileExists(evidenceDir))) {
    console.log(pc.yellow(`No evidence found for loop ${loopNum}.`));
    return;
  }

  console.log(pc.bold(`Run ${runId} — Loop ${loopNum} Evidence\n`));

  // Verification checklist
  const verification = await readFileSafe(path.join(evidenceDir, 'verification.md'));
  if (verification) {
    console.log(pc.bgCyan(pc.black(pc.bold(' Verification '))));
    console.log(pc.dim('─'.repeat(60)));
    renderMarkdown(verification, '');
    console.log('');
  }

  // Diff stats
  const diff = await readFileSafe(path.join(evidenceDir, 'diff.patch'));
  if (diff) {
    console.log(pc.bgCyan(pc.black(pc.bold(' Diff '))));
    const diffLines = diff.split('\n');
    const added = diffLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = diffLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    const files = diffLines.filter(l => l.startsWith('diff --git')).length;
    console.log(`  ${pc.green(`+${added}`)} ${pc.red(`-${removed}`)} across ${files} file(s)`);
    console.log('');
  }

  // Files list
  const filesJson = await readJsonSafe<Array<{ path: string; content: string | null }>>(
    path.join(evidenceDir, 'files.json'),
  );
  if (filesJson && filesJson.length > 0) {
    console.log(pc.bgCyan(pc.black(pc.bold(' Changed Files '))));
    console.log('');
    for (const f of filesJson) {
      const icon = f.content !== null ? pc.green('M') : pc.red('D');
      console.log(`  ${icon} ${f.path}`);
    }
    console.log(pc.dim(`  ${filesJson.length} file(s) total`));
  }
}

// ---- learnings ----

export async function showLearnings(id: string | undefined, opts: { run?: string }, deps: CliDeps): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;

  // Try run-level learnings first, then latest loop
  const runLearnings = await readFileSafe(paths.runLearnings(runId));
  if (runLearnings) {
    console.log(pc.bold(`Run ${runId} — Learnings\n`));
    renderMarkdown(runLearnings);
    return;
  }

  const loopNum = await latestLoopNum(runId, deps);
  if (loopNum) {
    const loopLearnings = await readFileSafe(paths.loopLearningMd(runId, loopNum));
    if (loopLearnings) {
      console.log(pc.bold(`Run ${runId} — Loop ${loopNum} Learnings\n`));
      renderMarkdown(loopLearnings);
      return;
    }
  }

  console.log(pc.yellow('No learnings found for this run.'));
}

// ---- spec ----

export async function showSpec(
  id: string | undefined,
  opts: { run?: string; diff?: boolean; versions?: boolean },
  deps: CliDeps,
): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;

  const runDir = paths.runPath(runId);

  // List versions
  if (opts.versions) {
    try {
      const entries = await fs.readdir(runDir);
      const specVersions = entries.filter(e => /^spec-\d+\.md$/.test(e)).sort();
      if (specVersions.length === 0) {
        console.log(pc.yellow('No spec versions found.'));
        return;
      }
      console.log(pc.bold(`Run ${runId} — Spec Versions\n`));
      for (const v of specVersions) {
        const num = v.replace('spec-', '').replace('.md', '');
        const filePath = path.join(runDir, v);
        const stat = await fs.stat(filePath).catch(() => null);
        const size = stat ? `${(stat.size / 1024).toFixed(1)}k` : '?';
        console.log(`  spec-${pc.bold(num)}.md  ${pc.dim(size)}`);
      }
      console.log('');
      console.log(`  ${pc.cyan('spec.md')}  ${pc.dim('(current)')}`);
    } catch {
      console.log(pc.yellow('No spec versions found.'));
    }
    return;
  }

  // Diff against previous version
  if (opts.diff) {
    const current = await readFileSafe(paths.runSpec(runId));
    const prevNum = await findLatestSpecVersion(runId);
    if (prevNum === null) {
      console.log(pc.yellow('No previous spec version to diff against.'));
      return;
    }
    const prev = await readFileSafe(paths.runSpecVersioned(runId, prevNum));
    if (!current || !prev) {
      console.log(pc.yellow('Could not read spec files.'));
      return;
    }

    console.log(pc.bold(`Run ${runId} — Spec Diff (current vs spec-${prevNum}.md)\n`));

    const currentLines = current.split('\n');
    const prevLines = prev.split('\n');
    const maxLen = Math.max(currentLines.length, prevLines.length);

    for (let i = 0; i < maxLen; i++) {
      const c = currentLines[i];
      const p = prevLines[i];
      if (c === p) {
        console.log(pc.dim(` ${c}`));
      } else if (p === undefined) {
        console.log(pc.green(`+${c}`));
      } else if (c === undefined) {
        console.log(pc.red(`-${p}`));
      } else {
        console.log(pc.red(`-${p}`));
        console.log(pc.green(`+${c}`));
      }
    }
    return;
  }

  // Show current spec
  const spec = await readFileSafe(paths.runSpec(runId));
  if (!spec) {
    console.log(pc.yellow('No spec found for this run.'));
    return;
  }

  console.log(pc.bold(`Run ${runId} — Spec\n`));
  renderMarkdown(spec);
}

async function findLatestSpecVersion(runId: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(paths.runPath(runId));
    const versions = entries
      .map(e => e.match(/^spec-(\d+)\.md$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => b - a);
    return versions.length > 0 ? versions[0] : null;
  } catch {
    return null;
  }
}

// ---- config ----

export async function showConfig(id: string | undefined, opts: { run?: string }, deps: CliDeps): Promise<void> {
  const runId = await resolveRunId(id, deps);
  if (!runId) return;

  const configPath = paths.runConfig(runId);
  const content = await readFileSafe(configPath);
  if (!content) {
    console.log(pc.yellow('No config found for this run.'));
    return;
  }

  // Parse and pretty-print
  let config: Record<string, unknown>;
  try {
    const YAML = await import('yaml');
    config = YAML.parse(content) as Record<string, unknown>;
  } catch {
    console.log(pc.yellow('Failed to parse config.'));
    return;
  }

  console.log(pc.bold(`Run ${runId} — Config\n`));
  renderConfigValue(config, '');
}

function renderConfigValue(value: unknown, prefix: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item)) {
        // Array of arrays (reviewPhases)
        console.log(`${prefix}${pc.cyan('[')}`);
        for (const subItem of item) {
          console.log(`${prefix}  ${pc.white(typeof subItem === 'string' ? subItem : JSON.stringify(subItem))}`);
        }
        console.log(`${prefix}${pc.cyan(']')}`);
      } else {
        console.log(`${prefix}- ${pc.white(typeof item === 'string' ? item : JSON.stringify(item))}`);
      }
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        console.log(`${prefix}${pc.cyan(key)}:`);
        renderConfigValue(val, prefix + '  ');
      } else if (Array.isArray(val)) {
        console.log(`${prefix}${pc.cyan(key)}:`);
        renderConfigValue(val, prefix + '  ');
      } else {
        const formatted = formatConfigValue(key, val);
        console.log(`${prefix}${pc.cyan(key)}: ${pc.white(formatted)}`);
      }
    }
  } else {
    console.log(`${prefix}${pc.white(String(value))}`);
  }
}

function formatConfigValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? pc.green('true') : pc.red('false');
  if (typeof value === 'number') {
    if (
      key.toLowerCase().includes('timeout') ||
      key.toLowerCase().includes('max') ||
      key.toLowerCase().includes('threshold')
    ) {
      return String(value);
    }
    return String(value);
  }
  return String(value);
}
