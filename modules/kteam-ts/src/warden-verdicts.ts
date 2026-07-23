// Parse fleet-warden reports (~/.kteam/daemon/warden/reports/*.md) into a
// compact, UI-friendly verdict list: which session the warden acted on, the
// verdict (killed / revived / nudged / cleared / needs_human), and why.
//
// Reports are LLM-authored markdown. Two shapes both land in the reports dir:
//   - fleet-triage:  `<ts>.md`            — may cover several anomalies
//   - assigned:      `<ts>-<sessionId>.md`
// Both carry `## Anomaly: \`<id>\` — <teammate> / <label>` sections. The
// assigned-warden prompt now also emits a machine line `Verdict: <LEAVE|NUDGE|
// RESUME|KILL>`; we prefer that, then fall back to phrase heuristics (with
// "needs a human / no safe action" winning over the rejected-option words the
// prose often mentions).
//
// Pure: takes file {path, content, mtimeMs} and returns entries. I/O lives in
// the service.

export type WardenVerdictKind = 'killed' | 'revived' | 'nudged' | 'cleared' | 'needs_human' | 'unknown';

export interface WardenVerdict {
  /** sweep time (ISO) — from the report title, else the file mtime. */
  at: string;
  targetSession?: string;
  teammate?: string;
  label?: string;
  verdict: WardenVerdictKind;
  reason?: string;
  reportPath: string;
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
};

/** Classify a report's verdict. Structured `Verdict: TOKEN` marker wins; else
 *  phrase heuristics with needs-human priority. */
export function classifyVerdict(content: string): WardenVerdictKind {
  const marker = content.match(/^\s*(?:[-*]\s*)?(?:\*\*)?verdict:?\s*(?:\*\*)?\s*(LEAVE|NUDGE|RESUME|KILL)\b/im);
  if (marker) return MARKER_MAP[marker[1]!.toUpperCase()] ?? 'unknown';

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
    const head = section.match(/^##\s+Anomaly:\s*`([^`]+)`\s*(?:—|-)\s*(.+)/);
    if (!head) continue;
    const session = head[1]!.trim();
    const rest = (head[2] ?? '').trim();
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
  const m = content.match(/\*\*(?:Warden )?verdict:?\*\*\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : undefined;
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
    const verdict = classifyVerdict(file.content);
    const summary = verdictSummary(file.content);
    const blocks = anomalyBlocks(file.content);
    if (blocks.length) {
      for (const b of blocks) {
        entries.push({
          at,
          targetSession: b.session,
          teammate: b.teammate,
          label: b.label,
          verdict,
          reason: reportedReason(b.block) ?? summary,
          reportPath: file.path,
        });
      }
    } else {
      entries.push({
        at,
        targetSession: filenameSession(file.path),
        verdict,
        reason: summary,
        reportPath: file.path,
      });
    }
    if (entries.length >= limit) break;
  }
  return entries.slice(0, limit);
}
