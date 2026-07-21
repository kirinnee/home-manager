// Unified tool-card renderer. The card leads with MEANING (the command, the
// file path, the most-informative input field) and only falls back to the
// raw input JSON inside the collapsed body. Paired result renders INSIDE
// this card as a second collapsible body — one card per call, always.
//
// Status chip on the right of the title line:
//   - while the result is pending, a subtle spinner-dot
//   - "ok" once paired with a successful result
//   - "error" or "exit N" if the result said so
//
// We also support a density "compact" mode (header-controlled) which hides
// the body entirely; only the title + chip render.

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Terminal,
  FileText,
  FilePenLine,
  FilePlus,
  Hash,
  Hourglass,
} from 'lucide-react';
import { cn } from '../lib/utils';

// ---------- input shape detection -------------------------------------------------

type ToolData = {
  toolUseId?: string;
  name?: string;
  // Codex `exec` and `apply_patch` ship a STRING input (raw JS / raw patch).
  // Claude's tools ship an OBJECT. We accept either.
  input?: unknown;
};

type ToolResultData = {
  toolUseId?: string;
  content?: unknown;
  text?: string;
  isError?: boolean;
  [k: string]: unknown;
};

type ExtractedTool = {
  // Visible headline of the card.
  headline: string;
  // Short, muted suffix (e.g. file path "in direnv", "(patch)", etc.).
  detail?: string;
  // Body shown when expanded (or always in non-compact mode).
  bodyLines: string[];
  // Optional structured info for a status chip context.
  extra?: {
    kind: 'exec-output';
    exitInfo?: string;
  };
};

// Codex `exec` input is a STRING containing JS:
//   `const r = await tools.exec_command({ cmd: "...", workdir: "...", yield_time_ms: N }); text(r.output);`
// We pull out the `cmd` value via a small string regex.
function extractExecCommand(input: unknown): { cmd: string; workdir?: string } | null {
  if (typeof input !== 'string') return null;
  // Match `cmd: "..."` first; fall back to `cmd: \`...\``.
  const m = input.match(/cmd\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (m && m[1]) return { cmd: decodeEscapes(m[1]) };
  const m2 = input.match(/cmd\s*:\s*`([^`]+)`/);
  if (m2 && m2[1]) return { cmd: m2[1] };
  return null;
}

function decodeEscapes(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\$/g, '$');
}

// Codex `apply_patch` ships a STRING containing a patch block — surface it
// verbatim and treat it as a "patch" type.
function isApplyPatch(input: unknown, name?: string): boolean {
  return name === 'apply_patch' || (typeof input === 'string' && /Begin Patch/.test(input));
}

// Claude tool inputs arrive as JSON objects with canonical fields.
function inputAsObject(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function extractToolSummary(name: string | undefined, input: unknown): ExtractedTool {
  const n = (name ?? '').toLowerCase();

  // 1) Codex `exec` tool — string input.
  if (name === 'exec' && typeof input === 'string') {
    const parsed = extractExecCommand(input);
    if (parsed) {
      const cmd = parsed.cmd;
      return {
        headline: firstLine(cmd),
        detail: parsed.workdir,
        bodyLines: cmd.split('\n'),
        extra: { kind: 'exec-output' },
      };
    }
  }

  // 2) Codex `apply_patch` — string input.
  if (isApplyPatch(input, name)) {
    const patch = typeof input === 'string' ? input : '';
    return {
      headline: 'apply_patch',
      detail: pickPatchSummary(patch),
      bodyLines: patch.split('\n'),
    };
  }

  // 3) Claude `Bash` — `{ command, description }`.
  if (n === 'bash') {
    const obj = inputAsObject(input);
    if (obj) {
      const command = firstString(obj, ['command']);
      const description = firstString(obj, ['description']);
      return {
        headline: command ? firstLine(command) : 'Bash',
        detail: description,
        bodyLines: command ? command.split('\n') : [],
        extra: { kind: 'exec-output' },
      };
    }
  }

  // 4) Claude file tools.
  if (n === 'read') {
    const obj = inputAsObject(input);
    const file = obj ? firstString(obj, ['file_path', 'filePath', 'path']) : undefined;
    return { headline: file ?? 'Read', bodyLines: file ? [file] : [] };
  }
  if (n === 'write') {
    const obj = inputAsObject(input);
    const file = obj ? firstString(obj, ['file_path', 'filePath', 'path']) : undefined;
    const content = obj?.['content'];
    return {
      headline: file ?? 'Write',
      bodyLines: file ? [file, '---', ...stringifySafe(content).split('\n')] : [],
    };
  }
  if (n === 'edit' || n === 'multi_edit' || n === 'multiedit' || n === 'edit_file') {
    const obj = inputAsObject(input);
    const file = obj ? firstString(obj, ['file_path', 'filePath', 'path']) : undefined;
    const oldStr = obj ? firstString(obj, ['old_string', 'oldString', 'old']) : undefined;
    const newStr = obj ? firstString(obj, ['new_string', 'newString', 'new', 'replace']) : undefined;
    const lines: string[] = [];
    if (file) lines.push(file);
    if (oldStr) {
      lines.push('--- old ---');
      lines.push(...oldStr.split('\n'));
    }
    if (newStr) {
      lines.push('--- new ---');
      lines.push(...newStr.split('\n'));
    }
    return { headline: file ?? 'Edit', detail: 'edit', bodyLines: lines };
  }
  if (n === 'apply_patch' || n === 'patch' || n === 'notebookedit') {
    const obj = inputAsObject(input);
    const patch = (obj ? firstString(obj, ['patch', 'input']) : undefined) ?? (typeof input === 'string' ? input : '');
    return {
      headline: 'apply_patch',
      detail: pickPatchSummary(patch),
      bodyLines: patch.split('\n'),
    };
  }

  // 5) Codex `wait` — poll a cell.
  if (name === 'wait') {
    const obj = inputAsObject(input);
    const cell = obj ? (firstString(obj, ['cell_id']) ?? String(obj['cell_id'] ?? '')) : '';
    const yieldMs = obj?.['yield_time_ms'];
    return {
      headline: cell ? `wait cell ${cell}` : 'wait',
      detail: typeof yieldMs === 'number' ? `${yieldMs}ms` : undefined,
      bodyLines: obj ? [JSON.stringify(obj, null, 2)] : [],
    };
  }

  // 6) Codex `update_plan` — pure planning.
  if (name === 'update_plan' || (typeof input === 'string' && /update_plan/.test(input))) {
    return {
      headline: 'update_plan',
      bodyLines: typeof input === 'string' ? [firstLine(input)] : ['plan update'],
    };
  }

  // 7) Generic: tool name + best informative input field.
  const obj = inputAsObject(input);
  if (obj) {
    // Try obvious fields first, in order: command/path/text/prompt/url/filePath/...
    const candidates = [
      'command',
      'file_path',
      'filePath',
      'path',
      'prompt',
      'text',
      'url',
      'query',
      'name',
      'description',
    ];
    const value = firstString(obj, candidates);
    if (value) {
      return {
        headline: name ?? 'tool',
        detail: firstLine(value),
        bodyLines: [JSON.stringify(obj, null, 2)],
      };
    }
    return {
      headline: name ?? 'tool',
      bodyLines: [JSON.stringify(obj, null, 2)],
    };
  }

  if (typeof input === 'string') {
    return { headline: name ?? 'tool', bodyLines: firstLines(input, 4) };
  }
  return { headline: name ?? 'tool', bodyLines: [] };
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function firstLines(s: string, n: number): string[] {
  const lines = s.split('\n');
  return lines.slice(0, n);
}

function stringifySafe(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Codex exec results start with a wall-time prefix we can use for status.
function parseExecOutput(text: string): { wallTime?: string; cleanText: string } {
  const m = text.match(/^Script completed\nWall time ([0-9.]+ seconds)\nOutput:\n?/);
  if (!m) return { cleanText: text };
  return {
    wallTime: m[1],
    cleanText: text.replace(/^Script completed\nWall time [0-9.]+ seconds\nOutput:\n?/, ''),
  };
}

function pickPatchSummary(patch: string): string | undefined {
  const m = patch.match(/^\*\*\* (Add|Update|Delete) File:\s*(\S+)/m);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

// ---------- component ------------------------------------------------------------

const PREVIEW_LINES = 15;

interface Props {
  use: ToolData;
  result?: ToolResultData;
  compact?: boolean;
}

export function ToolCard({ use, result, compact }: Props) {
  const summary = extractToolSummary(use?.name, use?.input);
  const [open, setOpen] = useState(false);
  const showBody = !compact;
  const hasBody = summary.bodyLines.length > 0;
  const truncated = summary.bodyLines.slice(0, PREVIEW_LINES);
  const hasMore = summary.bodyLines.length > PREVIEW_LINES;

  const Status = result ? (
    result.isError ? (
      <StatusChip tone="err" icon={<AlertTriangle size={11} />}>
        error
      </StatusChip>
    ) : (
      <StatusChip tone="ok" icon={<CheckCircle2 size={11} />}>
        {summary.extra?.kind === 'exec-output'
          ? (parseExecOutput(typeof result.text === 'string' ? result.text : '').wallTime ?? 'ok')
          : 'ok'}
      </StatusChip>
    )
  ) : (
    <StatusChip tone="pend" icon={<Loader2 size={11} className="animate-spin" />}>
      running
    </StatusChip>
  );

  const toolIcon = pickIcon(use?.name);

  return (
    <div className="my-1.5 rounded-md border border-border-soft bg-surface overflow-hidden text-[12.5px]">
      <button
        type="button"
        onClick={() => showBody && hasBody && setOpen(v => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
          showBody && hasBody ? 'hover:bg-surface-2 cursor-pointer' : 'cursor-default',
        )}
      >
        <span className="text-muted shrink-0">{toolIcon}</span>
        <span className="font-mono text-fg truncate" title={summary.headline}>
          {summary.headline}
        </span>
        {summary.detail && (
          <span className="text-muted text-[11px] truncate hidden sm:inline ml-1" title={summary.detail}>
            {summary.detail}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {Status}
          {use?.toolUseId && (
            <span
              className="mono text-[10px] text-muted opacity-0 group-hover:opacity-100 hidden md:inline"
              title={use.toolUseId}
            >
              {use.toolUseId.slice(-6)}
            </span>
          )}
        </span>
      </button>
      {showBody && open && hasBody && (
        <>
          {summary.bodyLines.length > 0 && (
            <pre className="m-0 px-2.5 pb-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-[420px] overflow-auto border-t border-border-soft">
              {truncated.join('\n')}
              {hasMore && <span className="text-muted">\n… (truncated, full body in raw JSON view below)</span>}
            </pre>
          )}
          {result && <ToolResultSection result={result} inputKind={summary.extra?.kind} />}
          {hasMore && (
            <details className="border-t border-border-soft">
              <summary className="px-2.5 py-1 text-[11px] text-muted cursor-pointer hover:bg-surface-2">
                show full input ({summary.bodyLines.length} lines)
              </summary>
              <pre className="m-0 px-2.5 pb-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-[420px] overflow-auto">
                {summary.bodyLines.join('\n')}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function ToolResultSection({ result, inputKind }: { result: ToolResultData; inputKind: 'exec-output' | undefined }) {
  const [open, setOpen] = useState(!result.isError);
  const text = (typeof result.text === 'string' ? result.text : null) ?? stringifyArrayResult(result.content);
  if (text == null) {
    return (
      <div className="border-t border-border-soft">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] text-muted hover:bg-surface"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          result (no text)
        </button>
        {open && (
          <pre className="m-0 px-2.5 pb-2 text-[12px] mono whitespace-pre-wrap break-words text-fg-soft max-h-72 overflow-auto">
            {stringifySafe(result.content ?? result)}
          </pre>
        )}
      </div>
    );
  }
  const cleaned = inputKind === 'exec-output' ? parseExecOutput(text).cleanText : text;
  const lineCount = cleaned.split('\n').length;
  const truncated = cleaned.split('\n').slice(0, PREVIEW_LINES).join('\n');
  const tooBig = lineCount > PREVIEW_LINES;
  return (
    <div className="border-t border-border-soft">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] text-muted hover:bg-surface"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        result · {lineCount} lines{result.isError ? ' · error' : ''}
      </button>
      {open && (
        <pre className="m-0 px-2.5 pb-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-[420px] overflow-auto">
          {truncated}
          {tooBig && '\n… (truncated — full body available in raw result)'}
        </pre>
      )}
    </div>
  );
}

function stringifyArrayResult(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.map((part: { text?: string; type?: string }) =>
    typeof part?.text === 'string' ? part.text : `[${part?.type ?? 'unknown'}]`,
  );
  const joined = parts.join('\n');
  return joined.length > 0 ? joined : null;
}

function StatusChip({
  tone,
  icon,
  children,
}: {
  tone: 'ok' | 'err' | 'pend';
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const map: Record<string, string> = {
    ok: 'border-ok-border bg-ok-bg text-ok',
    err: 'border-err-border bg-err-bg text-err',
    pend: 'border-pend-border bg-pend-bg text-pend',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10.5px] font-semibold uppercase tracking-wider',
        map[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function pickIcon(name?: string) {
  const n = (name ?? '').toLowerCase();
  if (n === 'bash' || n === 'exec') return <Terminal size={12} />;
  if (n === 'read') return <FileText size={12} />;
  if (n === 'write') return <FilePlus size={12} />;
  if (n === 'edit' || n === 'multi_edit' || n === 'apply_patch' || n === 'patch') return <FilePenLine size={12} />;
  if (n === 'wait') return <Hourglass size={12} />;
  if (n === 'update_plan') return <Hash size={12} />;
  return <FileText size={12} />;
}
