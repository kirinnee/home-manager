// One canonical reference grammar and proof gate for every Markdown surface.
//
// References are authored as plain sigil tokens:
//   :agent  @file[:line[-end]]  &task  !attention
//
// Syntax is never existence proof. `findReferences` reports lexical candidates;
// `resolveReference` requires the appropriate live resolver; and
// `remarkReferences` creates a link only after that resolver proves the target.
// The React renderer re-proves the reserved href and transform-origin marker
// before exposing a click.

import type { AttentionId } from './attention';

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

export interface AgentReference {
  kind: 'agent';
  name: string;
}

export interface CodeReference {
  /** Session-root-relative path after resolution. */
  path: string;
  /** 1-based source line. Absent means "open this file". */
  line?: number;
  /** Inclusive 1-based range end. */
  endLine?: number;
  /** Legacy open-request compatibility. Canonical written references omit it. */
  column?: number;
}

export interface FileReference extends CodeReference {
  kind: 'file';
}

export interface TaskReference {
  kind: 'task';
  id: string;
}

export interface AttentionReference {
  kind: 'attention';
  id: AttentionId;
}

export type Reference = AgentReference | FileReference | TaskReference | AttentionReference;

export interface ResolvedAgentReference extends AgentReference {
  sessionId: string;
}

export type ResolvedReference = ResolvedAgentReference | FileReference | TaskReference | AttentionReference;

export interface ReferenceMatch {
  reference: Reference;
  raw: string;
  start: number;
  end: number;
}

export interface AgentReferenceLookup {
  /** Stable identity. Used when re-proving a transformed link. */
  sessionId?: string;
  /** Canonical lowercase callsign. Used for authored `:name` tokens. */
  name?: string;
}

export interface ResolvedAgent {
  sessionId: string;
  name: string;
}

export type AgentReferenceResolver = (lookup: AgentReferenceLookup) => ResolvedAgent | null | undefined;
export type FileReferenceResolver = (candidatePath: string) => string | null | undefined;
export type TaskReferenceResolver = (id: string) => boolean;
export type AttentionReferenceResolver = (id: AttentionId) => boolean;

export interface ReferenceResolvers {
  agent?: AgentReferenceResolver;
  file?: FileReferenceResolver;
  task?: TaskReferenceResolver;
  attention?: AttentionReferenceResolver;
}

export interface CodeReferenceOpenRequest {
  reference: CodeReference;
  sequence: number;
}

export interface RemarkReferencesOptions {
  resolvers?: ReferenceResolvers;
}

/** Fragment hrefs are inert delivery envelopes, not browser destinations. */
export const REFERENCE_HREF_PREFIX = '#kteam-reference?';

const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TASK_ID = /^[BFIC][0-9]{1,9}$/iu;
const ATTENTION_ID = /^A[1-9][0-9]*$/u;
const INTEGER = /^[1-9][0-9]*$/u;
const FILE_TOKEN = /^@(?!@)([/.\p{L}\p{N}_+@#-]*[\p{L}\p{N}_+@#-])(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?$/u;
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);

// Each alternative owns its right boundary. A colon may naturally follow
// agent/task/attention prose, but it cannot terminate a file candidate because
// it could be the start of a malformed location suffix.
const REFERENCE_CANDIDATE =
  /(^|[\s([{"'`<>=—–])(?:(:[a-z][a-z0-9-]{0,31})(?=$|[\s)\]}"'`,;!?<>:.=—–])|(&[BFIC][0-9]{1,9})(?=$|[\s)\]}"'`,;!?<>:.=—–])|(!A[1-9][0-9]*)(?=$|[\s)\]}"'`,;!?<>:.=—–])|(@(?!@)[/.\p{L}\p{N}_+@#-]*[\p{L}\p{N}_+@#-](?::[1-9][0-9]*(?:-[1-9][0-9]*)?)?)(?=$|[\s)\]}"'`,;!?<>.=—–]))/giu;

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !INTEGER.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function safeSessionId(value: string): boolean {
  return SESSION_ID.test(value) && value !== '.' && value !== '..';
}

function validPath(path: string): boolean {
  if (!path || /[\\\u0000-\u001f\u007f]/u.test(path) || path.endsWith('/') || path.endsWith('.')) return false;
  const withoutRoot = path.startsWith('/') ? path.slice(1) : path;
  const segments = withoutRoot.split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '..')) return false;
  return !segments.some((segment, index) => segment === '.' && index !== 0);
}

function validCodeReference(reference: CodeReference): boolean {
  if (!validPath(reference.path)) return false;
  if (reference.column !== undefined) return false;
  if (reference.line === undefined) return reference.endLine === undefined;
  if (!Number.isSafeInteger(reference.line) || reference.line < 1) return false;
  return (
    reference.endLine === undefined || (Number.isSafeInteger(reference.endLine) && reference.endLine >= reference.line)
  );
}

/** Parse one complete canonical token. No legacy sigils or implicit paths. */
export function parseReferenceToken(raw: string): Reference | null {
  const agent = raw.match(/^:([a-z][a-z0-9-]{0,31})$/iu);
  if (agent?.[1]) return { kind: 'agent', name: agent[1].toLowerCase() };

  const task = raw.match(/^&([BFIC][0-9]{1,9})$/iu);
  if (task?.[1]) return { kind: 'task', id: task[1].toUpperCase() };

  const attention = raw.match(/^!(A[1-9][0-9]*)$/u);
  if (attention?.[1]) return { kind: 'attention', id: attention[1] as AttentionId };

  const file = raw.match(FILE_TOKEN);
  if (!file?.[1]) return null;
  const line = positiveInteger(file[2]);
  const endLine = positiveInteger(file[3]);
  const reference: FileReference = {
    kind: 'file',
    path: file[1],
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
  };
  return validCodeReference(reference) ? reference : null;
}

/** Find lexical candidates without claiming any target exists. */
export function findReferences(value: string): ReferenceMatch[] {
  const matches: ReferenceMatch[] = [];
  for (const match of value.matchAll(REFERENCE_CANDIDATE)) {
    const prefix = match[1] ?? '';
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!raw || match.index === undefined) continue;
    const reference = parseReferenceToken(raw);
    if (!reference) continue;
    const start = match.index + prefix.length;
    matches.push({ reference, raw, start, end: start + raw.length });
  }
  return matches;
}

export function formatReference(reference: Reference | ResolvedReference): string {
  switch (reference.kind) {
    case 'agent':
      if (!AGENT_NAME.test(reference.name)) throw new TypeError('invalid agent reference');
      return `:${reference.name.toLowerCase()}`;
    case 'file': {
      if (!validCodeReference(reference)) throw new TypeError('invalid file reference');
      const location =
        reference.line === undefined
          ? ''
          : `:${reference.line}${reference.endLine === undefined ? '' : `-${reference.endLine}`}`;
      return `@${reference.path}${location}`;
    }
    case 'task': {
      const id = reference.id.toUpperCase();
      if (!TASK_ID.test(id)) throw new TypeError('invalid task reference');
      return `&${id}`;
    }
    case 'attention':
      if (!ATTENTION_ID.test(reference.id)) throw new TypeError('invalid attention reference');
      return `!${reference.id}`;
  }
}

/** Compatibility formatter for Files/SidePane contracts. Files are always
 * authored with `@`; the old optional-mention mode no longer exists. */
export function formatCodeReference(reference: CodeReference, _mention = true): string {
  return formatReference({
    kind: 'file',
    path: reference.path,
    ...(reference.line === undefined ? {} : { line: reference.line }),
    ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
  });
}

function resolvedAgent(value: ResolvedAgent | null | undefined): ResolvedAgentReference | null {
  if (!value || !safeSessionId(value.sessionId) || !AGENT_NAME.test(value.name)) return null;
  return { kind: 'agent', sessionId: value.sessionId, name: value.name.toLowerCase() };
}

/** The sole proof gate. Thrown/absent/mismatched answers always resolve null. */
export function resolveReference(reference: Reference, resolvers: ReferenceResolvers): ResolvedReference | null {
  try {
    switch (reference.kind) {
      case 'agent':
        return resolvers.agent ? resolvedAgent(resolvers.agent({ name: reference.name })) : null;
      case 'file': {
        const path = resolvers.file?.(reference.path);
        if (!path) return null;
        const resolved: FileReference = { ...reference, path };
        return validCodeReference(resolved) ? resolved : null;
      }
      case 'task':
        return resolvers.task?.(reference.id) ? reference : null;
      case 'attention':
        return resolvers.attention?.(reference.id) ? reference : null;
    }
  } catch {
    return null;
  }
}

function one(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function exactKeys(query: URLSearchParams, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return [...query.keys()].every(key => allowed.has(key)) && keys.every(key => query.getAll(key).length === 1);
}

export function referenceHref(reference: ResolvedReference): string {
  const query = new URLSearchParams({ kind: reference.kind });
  switch (reference.kind) {
    case 'agent':
      if (!safeSessionId(reference.sessionId) || !AGENT_NAME.test(reference.name))
        throw new TypeError('invalid resolved agent reference');
      query.set('id', reference.sessionId);
      query.set('name', reference.name.toLowerCase());
      break;
    case 'file':
      if (!validCodeReference(reference)) throw new TypeError('invalid resolved file reference');
      query.set('path', reference.path);
      if (reference.line !== undefined) query.set('line', String(reference.line));
      if (reference.endLine !== undefined) query.set('end', String(reference.endLine));
      break;
    case 'task':
      if (!TASK_ID.test(reference.id)) throw new TypeError('invalid resolved task reference');
      query.set('id', reference.id.toUpperCase());
      break;
    case 'attention':
      if (!ATTENTION_ID.test(reference.id)) throw new TypeError('invalid resolved attention reference');
      query.set('id', reference.id);
      break;
  }
  return `${REFERENCE_HREF_PREFIX}${query}`;
}

export function parseReferenceHref(href: string | undefined): ResolvedReference | null {
  if (!href?.startsWith(REFERENCE_HREF_PREFIX)) return null;
  const query = new URLSearchParams(href.slice(REFERENCE_HREF_PREFIX.length));
  const kind = one(query, 'kind');
  if (kind === 'agent') {
    if (!exactKeys(query, ['kind', 'id', 'name'])) return null;
    const sessionId = one(query, 'id');
    const name = one(query, 'name');
    return sessionId && name ? resolvedAgent({ sessionId, name }) : null;
  }
  if (kind === 'file') {
    const allowed = ['kind', 'path', ...(query.has('line') ? ['line'] : []), ...(query.has('end') ? ['end'] : [])];
    if (!exactKeys(query, allowed) || (query.has('end') && !query.has('line'))) return null;
    const path = one(query, 'path');
    const rawLine = one(query, 'line');
    const rawEnd = one(query, 'end');
    const line = rawLine === undefined ? undefined : positiveInteger(rawLine);
    const endLine = rawEnd === undefined ? undefined : positiveInteger(rawEnd);
    if (!path || (rawLine !== undefined && line === undefined) || (rawEnd !== undefined && endLine === undefined))
      return null;
    const reference: FileReference = {
      kind: 'file',
      path,
      ...(line === undefined ? {} : { line }),
      ...(endLine === undefined ? {} : { endLine }),
    };
    return validCodeReference(reference) ? reference : null;
  }
  if (kind === 'task') {
    if (!exactKeys(query, ['kind', 'id'])) return null;
    const id = one(query, 'id')?.toUpperCase();
    return id && TASK_ID.test(id) ? { kind: 'task', id } : null;
  }
  if (kind === 'attention') {
    if (!exactKeys(query, ['kind', 'id'])) return null;
    const id = one(query, 'id');
    return id && ATTENTION_ID.test(id) ? { kind: 'attention', id: id as AttentionId } : null;
  }
  return null;
}

export function referenceIdentity(reference: ResolvedReference): string {
  switch (reference.kind) {
    case 'agent':
      return `agent:${reference.sessionId}`;
    case 'file':
      return `file:${reference.path}:${reference.line ?? ''}:${reference.endLine ?? ''}`;
    case 'task':
      return `task:${reference.id}`;
    case 'attention':
      return `attention:${reference.id}`;
  }
}

export function revalidateReference(
  reference: ResolvedReference,
  resolvers: ReferenceResolvers,
): ResolvedReference | null {
  try {
    switch (reference.kind) {
      case 'agent': {
        const current = resolvers.agent ? resolvedAgent(resolvers.agent({ sessionId: reference.sessionId })) : null;
        return current?.sessionId === reference.sessionId ? current : null;
      }
      case 'file': {
        const path = resolvers.file?.(reference.path);
        return path === reference.path && validCodeReference(reference) ? reference : null;
      }
      case 'task':
        return resolvers.task?.(reference.id) ? reference : null;
      case 'attention':
        return resolvers.attention?.(reference.id) ? reference : null;
    }
  } catch {
    return null;
  }
}

function referenceTitle(reference: ResolvedReference): string {
  switch (reference.kind) {
    case 'agent':
      return `Open :${reference.name}'s session`;
    case 'file':
      if (reference.line === undefined) return `Open ${formatReference(reference)}`;
      if (reference.endLine !== undefined)
        return `Open @${reference.path} at lines ${reference.line}–${reference.endLine}`;
      return `Open @${reference.path} at line ${reference.line}`;
    case 'task':
      return `Open task &${reference.id}`;
    case 'attention':
      return `Open attention !${reference.id}`;
  }
}

function linkifyText(value: string, resolvers: ReferenceResolvers): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const match of findReferences(value)) {
    const resolved = resolveReference(match.reference, resolvers);
    if (!resolved) continue;
    if (match.start > cursor) output.push({ type: 'text', value: value.slice(cursor, match.start) });
    output.push({
      type: 'link',
      url: referenceHref(resolved),
      title: referenceTitle(resolved),
      data: { hProperties: { 'data-kteam-reference': referenceIdentity(resolved) } },
      children: [{ type: 'text', value: match.raw }],
    });
    cursor = match.end;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

function transform(node: MdNode, resolvers: ReferenceResolvers): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      children.push(...(linkifyText(child.value, resolvers) ?? [child]));
      continue;
    }
    transform(child, resolvers);
    children.push(child);
  }
  node.children = children;
}

export function remarkReferences(options: RemarkReferencesOptions = {}) {
  return (tree: MdNode): void => {
    if (!options.resolvers) return;
    transform(tree, options.resolvers);
  };
}
