// Render-agnostic code-reference grammar and remark transform.
//
// The authored text is deliberately preserved. A compiler-style
// `src/app.ts:42`, a hosted `src/app.ts#L42-L48`, and an explicit
// `@src/app.ts:42` all render exactly as written; only their mdast node changes
// from text to a reserved in-app link.
//
// RESOLUTION IS REQUIRED. Lexical path-shape checks prevent obvious mistakes
// such as treating `1:30` as a file, but only the session filesystem knows
// whether a candidate exists. The remark plugin therefore receives a synchronous
// resolver over paths its owner has already verified. A missing/failed resolver
// leaves the candidate as ordinary text rather than painting a broken live link.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  data?: {
    hProperties?: Record<string, string>;
  };
  children?: MdNode[];
}

export interface CodeReference {
  /** Session-root-relative path after resolution. */
  path: string;
  /** 1-based source line. Absent means "open this file". */
  line?: number;
  /** Inclusive 1-based range end. */
  endLine?: number;
  /** 1-based column from compiler/IDE output. The Files surface still marks the line. */
  column?: number;
}

export interface CodeReferenceMatch {
  reference: CodeReference;
  /** The exact authored bytes, including a leading `@` when present. */
  raw: string;
  start: number;
  end: number;
  mentioned: boolean;
}

/** Payload the SidePane host threads into FilesTab. Sequence makes clicking the
 * same reference twice observable without coupling this module to React. */
export interface CodeReferenceOpenRequest {
  reference: CodeReference;
  sequence: number;
}

export type CodeReferencePathResolver = (candidatePath: string) => string | null | undefined;

export interface RemarkCodeReferencesOptions {
  resolvePath?: CodeReferencePathResolver;
}

/** Fragment hrefs survive react-markdown's safe URL transform while remaining
 * reserved to this app. They never navigate when the consumer handles them. */
export const CODE_REFERENCE_HREF_PREFIX = '#kteam-code-reference?';

const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);
const INTEGER = /^[1-9][0-9]*$/u;
const HOSTED_LOCATION = /^(.*)#L([1-9][0-9]*)(?:-L?([1-9][0-9]*))?$/iu;
const COLON_LOCATION = /^(.*?):([1-9][0-9]*)(?:(?::([1-9][0-9]*))|(?:-([1-9][0-9]*)))?$/u;

// A deliberately narrow token alphabet. Paths containing spaces or shell
// punctuation should be mentioned explicitly through the picker, not guessed
// out of prose. The left boundary includes ':' so `see:src/a.ts:4` works, while
// the whole-token parser rejects URL schemes and clock times.
const REFERENCE_CANDIDATE = /(^|[\s([{"'`<:])(@?[/.\p{L}\p{N}_+@:#-]+)(?=$|[\s)\]}"'`,;!?>.])/gu;

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !INTEGER.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function validPath(path: string): boolean {
  if (!path || /[\\\u0000-\u001f\u007f]/u.test(path) || path.endsWith('/')) return false;
  const withoutRoot = path.startsWith('/') ? path.slice(1) : path;
  const segments = withoutRoot.split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '..')) return false;
  // A single leading `./` is conventional. A dot segment anywhere else is an
  // ambiguous normalization request and is left as text.
  if (segments.some((segment, index) => segment === '.' && index !== 0)) return false;
  return true;
}

function pathShaped(path: string, mentioned: boolean): boolean {
  if (!validPath(path)) return false;
  if (mentioned || path.includes('/')) return true;
  const name = path.startsWith('./') ? path.slice(2) : path;
  // Require a real suffix, not merely a leading dot (`.env`) or a trailing dot.
  return /[^.]\.[\p{L}\p{N}_+-]+$/u.test(name);
}

function validReference(reference: CodeReference): boolean {
  if (!validPath(reference.path)) return false;
  if (reference.line === undefined) return reference.endLine === undefined && reference.column === undefined;
  if (!Number.isSafeInteger(reference.line) || reference.line < 1) return false;
  if (reference.endLine !== undefined) {
    if (!Number.isSafeInteger(reference.endLine) || reference.endLine < reference.line) return false;
    if (reference.column !== undefined) return false;
  }
  return reference.column === undefined || (Number.isSafeInteger(reference.column) && reference.column >= 1);
}

/** Parse one complete token. Recognised input:
 *
 * - `path`, but only when path-shaped (or explicitly `@`-mentioned)
 * - `path:LINE` / `path:LINE:COL`
 * - canonical range `path:START-END`
 * - GitHub `path#LLINE` / `path#LSTART-LEND`
 * - GitLab `path#LLINE` / `path#LSTART-END`
 */
export function parseCodeReference(raw: string): CodeReference | null {
  const mentioned = raw.startsWith('@');
  const token = mentioned ? raw.slice(1) : raw;
  if (!token) return null;

  let path = token;
  let line: number | undefined;
  let endLine: number | undefined;
  let column: number | undefined;
  const hosted = HOSTED_LOCATION.exec(token);
  const colon = hosted ? null : COLON_LOCATION.exec(token);
  if (hosted) {
    path = hosted[1] ?? '';
    line = positiveInteger(hosted[2]);
    endLine = positiveInteger(hosted[3]);
  } else if (colon) {
    path = colon[1] ?? '';
    line = positiveInteger(colon[2]);
    column = positiveInteger(colon[3]);
    endLine = positiveInteger(colon[4]);
  } else if (token.includes(':') || token.includes('#')) {
    return null;
  }

  const reference: CodeReference = {
    path,
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(column === undefined ? {} : { column }),
  };
  return pathShaped(path, mentioned) && validReference(reference) ? reference : null;
}

/** Find lexical candidates without claiming they exist. Consumers use this to
 * pre-resolve paths; the remark transform below performs the final live-link
 * gate through `resolvePath`. */
export function findCodeReferences(text: string): CodeReferenceMatch[] {
  const matches: CodeReferenceMatch[] = [];
  for (const match of text.matchAll(REFERENCE_CANDIDATE)) {
    const prefix = match[1] ?? '';
    let raw = match[2] ?? '';
    // Sentence punctuation is not part of a source location. The regex is
    // greedy so it can include a final period; peel only that unambiguous case.
    raw = raw.replace(/\.+$/u, '');
    if (!raw) continue;
    const reference = parseCodeReference(raw);
    if (!reference || match.index === undefined) continue;
    const start = match.index + prefix.length;
    matches.push({ reference, raw, start, end: start + raw.length, mentioned: raw.startsWith('@') });
  }
  return matches;
}

/** Canonical compiler/IDE form. The composer uses `mention=true`; rendered
 * compiler output normally omits it. */
export function formatCodeReference(reference: CodeReference, mention = false): string {
  if (!validReference(reference)) throw new TypeError('invalid code reference');
  let location = '';
  if (reference.line !== undefined) {
    location = `:${reference.line}`;
    if (reference.endLine !== undefined) location += `-${reference.endLine}`;
    else if (reference.column !== undefined) location += `:${reference.column}`;
  }
  return `${mention ? '@' : ''}${reference.path}${location}`;
}

export function codeReferenceHref(reference: CodeReference): string {
  if (!validReference(reference)) throw new TypeError('invalid code reference');
  const query = new URLSearchParams({ path: reference.path });
  if (reference.line !== undefined) query.set('line', String(reference.line));
  if (reference.endLine !== undefined) query.set('end', String(reference.endLine));
  if (reference.column !== undefined) query.set('column', String(reference.column));
  return `${CODE_REFERENCE_HREF_PREFIX}${query}`;
}

function one(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

export function parseCodeReferenceHref(href: string | undefined): CodeReference | null {
  if (!href?.startsWith(CODE_REFERENCE_HREF_PREFIX)) return null;
  const query = new URLSearchParams(href.slice(CODE_REFERENCE_HREF_PREFIX.length));
  if ([...query.keys()].some(key => !['path', 'line', 'end', 'column'].includes(key))) return null;
  const path = one(query, 'path');
  if (!path) return null;
  const rawLine = one(query, 'line');
  const rawEnd = one(query, 'end');
  const rawColumn = one(query, 'column');
  if ((query.has('line') && rawLine === undefined) || (query.has('end') && rawEnd === undefined)) return null;
  if (query.has('column') && rawColumn === undefined) return null;
  const line = rawLine === undefined ? undefined : positiveInteger(rawLine);
  const endLine = rawEnd === undefined ? undefined : positiveInteger(rawEnd);
  const column = rawColumn === undefined ? undefined : positiveInteger(rawColumn);
  if ((rawLine !== undefined && line === undefined) || (rawEnd !== undefined && endLine === undefined)) return null;
  if (rawColumn !== undefined && column === undefined) return null;
  const reference: CodeReference = {
    path,
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(column === undefined ? {} : { column }),
  };
  return validReference(reference) ? reference : null;
}

function referenceTitle(reference: CodeReference): string {
  if (reference.line === undefined) return `Open ${reference.path}`;
  if (reference.endLine !== undefined) return `Open ${reference.path} at lines ${reference.line}–${reference.endLine}`;
  return `Open ${reference.path} at line ${reference.line}`;
}

function linkifyText(value: string, resolvePath: CodeReferencePathResolver): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const match of findCodeReferences(value)) {
    let resolved: string | null | undefined;
    try {
      resolved = resolvePath(match.reference.path);
    } catch {
      resolved = null;
    }
    if (!resolved) continue;
    const reference = { ...match.reference, path: resolved };
    if (!validReference(reference)) continue;
    if (match.start > cursor) output.push({ type: 'text', value: value.slice(cursor, match.start) });
    output.push({
      type: 'link',
      url: codeReferenceHref(reference),
      title: referenceTitle(reference),
      // The renderer uses this unforgeable-through-Markdown origin marker in
      // addition to the reserved href. An authored link can copy the fragment,
      // but cannot acquire mdast hProperties without a transform creating it.
      data: { hProperties: { 'data-code-reference': reference.path } },
      children: [{ type: 'text', value: match.raw }],
    });
    cursor = match.end;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

function transform(node: MdNode, resolvePath: CodeReferencePathResolver): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      children.push(...(linkifyText(child.value, resolvePath) ?? [child]));
      continue;
    }
    transform(child, resolvePath);
    children.push(child);
  }
  node.children = children;
}

export function remarkCodeReferences(options: RemarkCodeReferencesOptions = {}) {
  return (tree: MdNode): void => {
    // Secure default: without an authoritative existence answer there are no
    // live links. Consumers can still call `findCodeReferences` to warm one.
    if (!options.resolvePath) return;
    transform(tree, options.resolvePath);
  };
}
