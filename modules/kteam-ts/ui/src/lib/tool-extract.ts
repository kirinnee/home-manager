// Pure tool-call parsing — shared by the transcript's ToolGroup. Extracted
// from the old ToolCard so the presentation can change without touching the
// (well-tested-by-eye) heuristics for Claude object inputs and Codex string
// inputs (exec / apply_patch).

export type ToolUseData = {
  toolUseId?: string;
  name?: string;
  input?: unknown;
  id?: string;
};

export type ToolResultData = {
  toolUseId?: string;
  content?: unknown;
  text?: string;
  isError?: boolean;
  [k: string]: unknown;
};

export type ToolKind = 'bash' | 'read' | 'write' | 'edit' | 'patch' | 'search' | 'plan' | 'wait' | 'generic';

export interface ExtractedTool {
  /** short verb shown as the group chip, e.g. "Bash", "Edit", "Read". */
  verb: string;
  /** the informative headline (command / file path). */
  headline: string;
  /** muted suffix (description / patch summary). */
  detail?: string;
  /** expanded body (the full input). */
  bodyLines: string[];
  kind: ToolKind;
  isExec: boolean;
}

function extractExecCommand(input: unknown): { cmd: string } | null {
  if (typeof input !== 'string') return null;
  const m = input.match(/cmd\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (m && m[1]) return { cmd: decodeEscapes(m[1]) };
  const m2 = input.match(/cmd\s*:\s*`([^`]+)`/);
  if (m2 && m2[1]) return { cmd: m2[1] };
  return null;
}

function decodeEscapes(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\$/g, '$');
}

function isApplyPatch(input: unknown, name?: string): boolean {
  return name === 'apply_patch' || (typeof input === 'string' && /Begin Patch/.test(input));
}

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

export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return (i === -1 ? s : s.slice(0, i)).trim();
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
export function parseExecOutput(text: string): { wallTime?: string; cleanText: string } {
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

function baseName(p: string): string {
  const clean = p.split(/[?#]/)[0]!.replace(/\/+$/, '');
  const seg = clean.split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1]! : p;
}

export function extractToolSummary(name: string | undefined, input: unknown): ExtractedTool {
  const n = (name ?? '').toLowerCase();

  if (name === 'exec' && typeof input === 'string') {
    const parsed = extractExecCommand(input);
    if (parsed)
      return {
        verb: 'Bash',
        headline: firstLine(parsed.cmd),
        bodyLines: parsed.cmd.split('\n'),
        kind: 'bash',
        isExec: true,
      };
  }

  if (isApplyPatch(input, name)) {
    const patch = typeof input === 'string' ? input : '';
    return {
      verb: 'Patch',
      headline: pickPatchSummary(patch) ?? 'apply_patch',
      detail: undefined,
      bodyLines: patch.split('\n'),
      kind: 'patch',
      isExec: false,
    };
  }

  if (n === 'bash') {
    const obj = inputAsObject(input);
    if (obj) {
      const command = firstString(obj, ['command']);
      const description = firstString(obj, ['description']);
      return {
        verb: 'Bash',
        headline: command ? firstLine(command) : 'Bash',
        detail: description,
        bodyLines: command ? command.split('\n') : [],
        kind: 'bash',
        isExec: true,
      };
    }
  }

  if (n === 'read') {
    const obj = inputAsObject(input);
    const file = obj ? firstString(obj, ['file_path', 'filePath', 'path']) : undefined;
    return {
      verb: 'Read',
      headline: file ? baseName(file) : 'Read',
      detail: file,
      bodyLines: file ? [file] : [],
      kind: 'read',
      isExec: false,
    };
  }
  if (n === 'write') {
    const obj = inputAsObject(input);
    const file = obj ? firstString(obj, ['file_path', 'filePath', 'path']) : undefined;
    const content = obj?.['content'];
    return {
      verb: 'Write',
      headline: file ? baseName(file) : 'Write',
      detail: file,
      bodyLines: file ? [file, '', ...stringifySafe(content).split('\n')] : [],
      kind: 'write',
      isExec: false,
    };
  }
  if (n === 'edit' || n === 'multi_edit' || n === 'multiedit' || n === 'edit_file') {
    const obj = inputAsObject(input);
    const file = obj ? firstString(obj, ['file_path', 'filePath', 'path']) : undefined;
    const oldStr = obj ? firstString(obj, ['old_string', 'oldString', 'old']) : undefined;
    const newStr = obj ? firstString(obj, ['new_string', 'newString', 'new', 'replace']) : undefined;
    const lines: string[] = [];
    if (oldStr) {
      lines.push('- old', ...oldStr.split('\n'));
    }
    if (newStr) {
      lines.push('+ new', ...newStr.split('\n'));
    }
    return {
      verb: 'Edit',
      headline: file ? baseName(file) : 'Edit',
      detail: file,
      bodyLines: lines,
      kind: 'edit',
      isExec: false,
    };
  }
  if (n === 'apply_patch' || n === 'patch' || n === 'notebookedit') {
    const obj = inputAsObject(input);
    const patch = (obj ? firstString(obj, ['patch', 'input']) : undefined) ?? (typeof input === 'string' ? input : '');
    return {
      verb: 'Patch',
      headline: pickPatchSummary(patch) ?? 'apply_patch',
      bodyLines: patch.split('\n'),
      kind: 'patch',
      isExec: false,
    };
  }

  if (name === 'wait') {
    const obj = inputAsObject(input);
    const cell = obj ? (firstString(obj, ['cell_id']) ?? String(obj['cell_id'] ?? '')) : '';
    return {
      verb: 'Wait',
      headline: cell ? `cell ${cell}` : 'wait',
      bodyLines: obj ? [JSON.stringify(obj, null, 2)] : [],
      kind: 'wait',
      isExec: false,
    };
  }

  if (name === 'update_plan' || (typeof input === 'string' && /update_plan/.test(input))) {
    return {
      verb: 'Plan',
      headline: 'update_plan',
      bodyLines: typeof input === 'string' ? [firstLine(input)] : ['plan update'],
      kind: 'plan',
      isExec: false,
    };
  }

  if (n === 'grep' || n === 'glob' || n === 'search' || n === 'websearch' || n === 'webfetch') {
    const obj = inputAsObject(input);
    const q = obj ? firstString(obj, ['pattern', 'query', 'url', 'prompt']) : undefined;
    return {
      verb: cap(name ?? 'search'),
      headline: q ?? name ?? 'search',
      bodyLines: obj ? [JSON.stringify(obj, null, 2)] : [],
      kind: 'search',
      isExec: false,
    };
  }

  const obj = inputAsObject(input);
  if (obj) {
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
    return {
      verb: cap(name ?? 'tool'),
      headline: value ? firstLine(value) : (name ?? 'tool'),
      bodyLines: [JSON.stringify(obj, null, 2)],
      kind: 'generic',
      isExec: false,
    };
  }
  if (typeof input === 'string') {
    return {
      verb: cap(name ?? 'tool'),
      headline: firstLine(input),
      bodyLines: input.split('\n').slice(0, 40),
      kind: 'generic',
      isExec: false,
    };
  }
  return { verb: cap(name ?? 'tool'), headline: name ?? 'tool', bodyLines: [], kind: 'generic', isExec: false };
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// Best-effort readable text of a tool result.
export function resultText(result: ToolResultData): string | null {
  if (typeof result.text === 'string') return result.text;
  if (Array.isArray(result.content)) {
    const parts = (result.content as Array<{ text?: string; type?: string }>).map(p =>
      typeof p?.text === 'string' ? p.text : `[${p?.type ?? 'unknown'}]`,
    );
    const joined = parts.join('\n');
    return joined.length ? joined : null;
  }
  if (result.content != null) return stringifySafe(result.content);
  return null;
}
