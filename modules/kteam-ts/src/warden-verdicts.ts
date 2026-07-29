// Parse fleet-warden reports (~/.kteam/daemon/warden/reports/*.md) into a
// compact, UI-friendly verdict list: which session the warden acted on, the
// verdict (killed / revived / nudged / cleared / needs_human), and why.
//
// Reports are LLM-authored markdown. Two shapes both land in the reports dir:
//   - fleet-triage:  `<ts>.md`            — may cover several anomalies
//   - assigned:      `<ts>-<sessionId>.md`
// Both carry `## Anomaly: <id> — <teammate> / <label>` sections. Older
// reports often wrapped the id in backticks, so the parser accepts both. The
// assigned-warden prompt now also emits a machine line `Verdict: <LEAVE|NUDGE|
// RESUME|KILL>`; we prefer that, then fall back to phrase heuristics (with
// "needs a human / no safe action" winning over the rejected-option words the
// prose often mentions).
//
// Pure: takes file {path, content, mtimeMs} and returns entries. I/O lives in
// the service.

import type { WardenSpawnProvenance } from './warden-provenance';
import type { WardenAnomalyKind } from './warden-detect';

export type WardenVerdictKind = 'killed' | 'revived' | 'nudged' | 'cleared' | 'needs_human' | 'unknown';

/** API projection is additive and tolerant of older/partial producers. New
 *  daemon sidecars attach the complete WardenSpawnProvenance shape, including
 *  resolved model + modelSource; modelHint remains accepted for old clients. */
export type WardenVerdictSpawn = Pick<WardenSpawnProvenance, 'wrapper'> &
  Partial<Omit<WardenSpawnProvenance, 'wrapper'>> & { modelHint?: string; failoverReason?: string };

export interface WardenVerdict {
  /** sweep time (ISO) — from the report title, else the file mtime. */
  at: string;
  targetSession?: string;
  teammate?: string;
  label?: string;
  /** Exact anomaly class judged by this report block. */
  anomalyKind?: WardenAnomalyKind;
  verdict: WardenVerdictKind;
  /** True only when this exact report block carries `Verdict: NEEDS_HUMAN`.
   *  Attention requests require this explicit marker; heuristic legacy prose
   *  remains report history and never interrupts a human by itself. */
  explicitNeedsHuman?: boolean;
  reason?: string;
  reportPath: string;
  /** Daemon-owned spawn facts from the report's optional JSON sidecar. */
  spawn?: WardenVerdictSpawn;
}

export interface WardenReportFile {
  path: string;
  content: string;
  mtimeMs: number;
}

const MARKER_MAP: Record<string, WardenVerdictKind> = {
  KILL: 'killed',
  RESUME: 'revived',
  NUDGE: 'nudged',
  LEAVE: 'cleared',
  NEEDS_HUMAN: 'needs_human',
};

const WARDEN_ANOMALY_KINDS = new Set<WardenAnomalyKind>([
  'dead_monitor',
  'unattended_question',
  'abandoned_wreckage',
  'quota_reset_passed',
  'declared_wait_overdue',
  'peer_wait_unanswerable',
  'sus_thinking',
  'sus_subprocess',
  'bootstrap_degraded',
  'provider_unavailable',
]);

export function parseWardenAnomalyKind(value: string | null | undefined): WardenAnomalyKind | undefined {
  const normalized = value?.trim();
  return normalized && WARDEN_ANOMALY_KINDS.has(normalized as WardenAnomalyKind)
    ? (normalized as WardenAnomalyKind)
    : undefined;
}

export interface WardenVerdictSourceIdentity {
  reportPath?: string;
  anomalyKind?: WardenAnomalyKind;
}

/** Stable Attention source identity for one exact report block. Legacy rows
 *  used only a kind or report path; both remain parseable. Generated report
 *  paths never contain `#`, so the suffix is an unambiguous block selector. */
export function wardenVerdictSourceRef(
  reportPath: string | null | undefined,
  anomalyKind: WardenAnomalyKind | null | undefined,
): string | null {
  if (reportPath && anomalyKind) return `warden:${reportPath}#${anomalyKind}`;
  if (reportPath) return `warden:${reportPath}`;
  if (anomalyKind) return `warden:${anomalyKind}`;
  return null;
}

export function parseWardenVerdictSourceRef(
  sourceRef: string | null | undefined,
): WardenVerdictSourceIdentity | undefined {
  if (!sourceRef?.startsWith('warden:')) return undefined;
  const exact = sourceRef.slice('warden:'.length);
  if (!exact) return undefined;
  const separator = exact.lastIndexOf('#');
  if (separator > 0) {
    const anomalyKind = parseWardenAnomalyKind(exact.slice(separator + 1));
    const reportPath = exact.slice(0, separator);
    if (anomalyKind && reportPath) return { reportPath, anomalyKind };
  }
  const anomalyKind = parseWardenAnomalyKind(exact);
  return anomalyKind ? { anomalyKind } : { reportPath: exact };
}

function reportedAnomalyKind(content: string): WardenAnomalyKind | undefined {
  const marker = content.match(/^\s*[-*]\s+\*\*Anomaly kind:\*\*\s*`?([a-z_]+)\b/im);
  return parseWardenAnomalyKind(marker?.[1]);
}

function structuredVerdict(content: string): WardenVerdictKind | undefined {
  const marker = content.match(
    /^\s*(?:[-*]\s*)?(?:\*\*)?verdict:?\s*(?:\*\*)?\s*(LEAVE|NUDGE|RESUME|KILL|NEEDS[_ -]+HUMAN)\b/im,
  );
  return marker ? MARKER_MAP[marker[1]!.toUpperCase().replaceAll(/[- ]+/g, '_')] : undefined;
}

/** Classify a report's verdict. Structured `Verdict: TOKEN` marker wins; else
 *  phrase heuristics with needs-human priority. */
export function classifyVerdict(content: string): WardenVerdictKind {
  const marker = structuredVerdict(content);
  if (marker) return marker;

  const s = content.toLowerCase();
  if (
    /no safe.{0,20}action|needs?\s+a\s+human|no action (was )?taken|still needs a human|human (intervention|decision|is needed)/.test(
      s,
    )
  )
    return 'needs_human';
  if (/\bkill(ed|ing)?\b|kteam stop|stopped the session|\bstopped\b/.test(s)) return 'killed';
  if (/\bresum(e|ed|ing)\b|revived/.test(s)) return 'revived';
  if (/\bnudg(e|ed|ing)\b/.test(s)) return 'nudged';
  if (/\bleave\b|left (it )?alone|left as-is|no action needed|no action required/.test(s)) return 'cleared';
  return 'unknown';
}

function titleTime(content: string): string | undefined {
  const m = content.match(/sweep\s+\(?([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/);
  return m?.[1];
}

// Split into (anomaly session id, "teammate / label", block text) tuples.
function anomalyBlocks(content: string): { session: string; teammate?: string; label?: string; block: string }[] {
  const out: { session: string; teammate?: string; label?: string; block: string }[] = [];
  // Split on markdown H2 headers, keep the header with its block.
  const sections = content.split(/\n(?=##\s)/);
  for (const section of sections) {
    const head = section.match(/^##\s+Anomaly:\s*(?:`([^`\n]+)`|([A-Za-z0-9._-]+))\s*(?:(?:—|–|-)\s*(.*?))?\s*$/m);
    if (!head) continue;
    const session = (head[1] ?? head[2])!.trim();
    const rest = (head[3] ?? '').trim();
    let teammate: string | undefined;
    let label: string | undefined;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      teammate = rest.slice(0, slash).trim() || undefined;
      label = rest.slice(slash + 1).trim() || undefined;
    } else {
      teammate = rest || undefined;
    }
    out.push({ session, teammate, label, block: section });
  }
  return out;
}

function reportedReason(block: string): string | undefined {
  const m = block.match(/\*\*Reported reason:\*\*\s*`?([^\n]+?)`?\s*(?:\n|$)/);
  if (m) return m[1]!.trim();
  return undefined;
}

function verdictSummary(content: string): string | undefined {
  // Bolded verdict line (both formats), else the assigned format's
  // `## Summary` section first sentence(s).
  const bold = content.match(/\*\*(?:Warden )?verdict:?\*\*\s*(?:\w+\s*[—–-]\s*)?([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (bold) return bold[1]!.replace(/\s+/g, ' ').trim();
  // Verdict word INSIDE the bold — "**Verdict: LEAVE.** The subprocess is …" —
  // the reason is the prose that follows the closing asterisks.
  const boldInside = content.match(/\*\*(?:Warden )?verdict:?\s+[a-z_ -]+[.!]?\*\*\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (boldInside && boldInside[1]!.trim()) return boldInside[1]!.replace(/\s+/g, ' ').trim();
  const outcome = content.match(/^\s*[-*]\s+\*\*Outcome:\*\*\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/im);
  if (outcome && outcome[1]!.trim()) return outcome[1]!.replace(/\s+/g, ' ').trim();
  const summary = content.match(/^##\s+Summary\s*\n+([\s\S]*?)(?:\n\n|\n##|\n?$)/m);
  if (summary && summary[1]!.trim()) return summary[1]!.replace(/\s+/g, ' ').trim();
  return undefined;
}

/** Assigned-report header: `# Warden report — <sessionId> (teammate <name>,
 *  <label>)` — the machine-stable template the assigned prompt mandates. */
function assignedHeader(content: string): { session: string; teammate?: string; label?: string } | undefined {
  const m = content.match(
    /^#\s+Warden report\s*(?:—|-)\s*([A-Za-z0-9._-]+)\s*(?:\(\s*teammate\s+([^,)]+?)\s*(?:,\s*([^)]+?)\s*)?\))?/m,
  );
  if (!m) return undefined;
  return { session: m[1]!.trim(), teammate: m[2]?.trim() || undefined, label: m[3]?.trim() || undefined };
}

/** Session id embedded in an assigned report filename `<ts>-<sessionId>.md`.
 *  The id looks like `mr…-<hex8>`; the ts is `YYYY-MM-DDThh-mm-ss-mmmZ`. */
function filenameSession(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  const m = base.match(/Z-([a-z0-9]+-[0-9a-f]{6,})\.md$/i);
  return m?.[1];
}

/** Parse a batch of report files into verdict entries, newest-first, capped. */
export function parseWardenReports(files: WardenReportFile[], limit = 20): WardenVerdict[] {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const entries: WardenVerdict[] = [];
  for (const file of sorted) {
    const at = titleTime(file.content) ?? new Date(file.mtimeMs).toISOString();
    const reportVerdict = classifyVerdict(file.content);
    const reportSummary = verdictSummary(file.content);
    const blocks = anomalyBlocks(file.content);
    if (blocks.length) {
      for (const b of blocks) {
        const blockVerdict = structuredVerdict(b.block);
        const anomalyKind = reportedAnomalyKind(b.block);
        // A single-anomaly legacy report may keep its verdict above the block.
        // For a multi-session report, never copy one global action onto every
        // target OR infer from incidental action words: an unmarked block
        // remains explicitly unknown.
        const verdict = blockVerdict ?? (blocks.length === 1 ? reportVerdict : 'unknown');
        entries.push({
          at,
          targetSession: b.session,
          teammate: b.teammate,
          label: b.label,
          ...(anomalyKind ? { anomalyKind } : {}),
          verdict,
          ...(blockVerdict === 'needs_human' ? { explicitNeedsHuman: true } : {}),
          reason:
            verdictSummary(b.block) ?? reportedReason(b.block) ?? (blocks.length === 1 ? reportSummary : undefined),
          reportPath: file.path,
        });
      }
    } else {
      // Assigned-warden format: no `## Anomaly:` sections — identity lives in
      // the `# Warden report — <id> (teammate <name>, <label>)` header, with
      // the filename session id as backstop.
      const header = assignedHeader(file.content);
      const anomalyKind = reportedAnomalyKind(file.content);
      entries.push({
        at,
        targetSession: header?.session ?? filenameSession(file.path),
        teammate: header?.teammate,
        label: header?.label,
        ...(anomalyKind ? { anomalyKind } : {}),
        verdict: reportVerdict,
        ...(structuredVerdict(file.content) === 'needs_human' ? { explicitNeedsHuman: true } : {}),
        reason: reportSummary,
        reportPath: file.path,
      });
    }
    if (entries.length >= limit) break;
  }
  return entries.slice(0, limit);
}
