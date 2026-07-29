// Session-scoped durable references that share Markdown's one remark pipeline.
//
// Attention ids are readable (`?A3`) and therefore have prose grammar. Pins
// use canonical Markdown links instead (their daemon ids are UUIDs, not a
// humane token); pin helpers live below the attention transform so both kinds
// share one reserved-href parser module and one renderer composition.

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

export interface AttentionReferenceMatch {
  id: AttentionId;
  raw: string;
  start: number;
  end: number;
}

export type AttentionReferenceResolver = (id: AttentionId) => boolean;

export interface RemarkSessionReferencesOptions {
  resolveAttention?: AttentionReferenceResolver;
  resolvePin?: PinReferenceResolver;
}

export const ATTENTION_REFERENCE_HREF_PREFIX = '#kteam-attention-reference?';
export const PIN_REFERENCE_HREF_PREFIX = '#kteam-pin-reference?';
const ATTENTION_REFERENCE = /\?(A[1-9][0-9]*)/gu;
const ATTENTION_ID = /^A[1-9][0-9]*$/u;
const WORD = /[\p{L}\p{N}_?]/u;
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);
const SAFE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface PinReferenceLookup {
  sessionId: string;
  pinId: string;
}

export interface ResolvedPinReference extends PinReferenceLookup {
  /** Current authoritative display label; the renderer may replace stale
   * composer text after a note edit. */
  label: string;
}

export type PinReferenceResolver = (lookup: PinReferenceLookup) => ResolvedPinReference | null | undefined;

function safeReferenceId(value: string): boolean {
  return SAFE_REFERENCE_ID.test(value) && value !== '.' && value !== '..';
}

function normalizePinLabel(value: string): string {
  const label = value.replace(/\s+/gu, ' ').trim();
  return label || 'Untitled pin';
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/gu, '\\$&');
}

export function pinReferenceHref(reference: PinReferenceLookup): string {
  if (!safeReferenceId(reference.sessionId) || !safeReferenceId(reference.pinId)) {
    throw new TypeError('invalid pin reference');
  }
  return `${PIN_REFERENCE_HREF_PREFIX}${new URLSearchParams({ session: reference.sessionId, id: reference.pinId })}`;
}

export function parsePinReferenceHref(href: string | undefined): PinReferenceLookup | null {
  if (!href?.startsWith(PIN_REFERENCE_HREF_PREFIX)) return null;
  const query = new URLSearchParams(href.slice(PIN_REFERENCE_HREF_PREFIX.length));
  if ([...query.keys()].some(key => key !== 'session' && key !== 'id')) return null;
  const sessions = query.getAll('session');
  const ids = query.getAll('id');
  if (sessions.length !== 1 || ids.length !== 1 || !safeReferenceId(sessions[0]!) || !safeReferenceId(ids[0]!))
    return null;
  return { sessionId: sessions[0]!, pinId: ids[0]! };
}

/** Canonical composer insertion. Pins deliberately have no bare UUID grammar:
 * the readable label is Markdown, while identity rides in the reserved href. */
export function pinReferenceMarkdown(reference: ResolvedPinReference): string {
  const label = escapeMarkdownLabel(`pin: ${normalizePinLabel(reference.label)}`);
  return `[${label}](${pinReferenceHref(reference)})`;
}

export function attentionReferenceHref(id: AttentionId): string {
  if (!ATTENTION_ID.test(id)) throw new TypeError('invalid attention reference id');
  return `${ATTENTION_REFERENCE_HREF_PREFIX}${new URLSearchParams({ id })}`;
}

export function parseAttentionReferenceHref(href: string | undefined): AttentionId | null {
  if (!href?.startsWith(ATTENTION_REFERENCE_HREF_PREFIX)) return null;
  const query = new URLSearchParams(href.slice(ATTENTION_REFERENCE_HREF_PREFIX.length));
  if ([...query.keys()].some(key => key !== 'id')) return null;
  const ids = query.getAll('id');
  if (ids.length !== 1 || !ATTENTION_ID.test(ids[0]!)) return null;
  return ids[0] as AttentionId;
}

export function findAttentionReferences(value: string): AttentionReferenceMatch[] {
  const matches: AttentionReferenceMatch[] = [];
  for (const match of value.matchAll(ATTENTION_REFERENCE)) {
    const start = match.index;
    const raw = match[0];
    const id = match[1];
    if (start === undefined || !id || WORD.test(value[start - 1] ?? '') || WORD.test(value[start + raw.length] ?? ''))
      continue;
    matches.push({ id: id as AttentionId, raw, start, end: start + raw.length });
  }
  return matches;
}

function linkifyAttention(value: string, resolveAttention: AttentionReferenceResolver): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const match of findAttentionReferences(value)) {
    let resolved = false;
    try {
      resolved = resolveAttention(match.id);
    } catch {
      resolved = false;
    }
    if (!resolved) continue;
    if (match.start > cursor) output.push({ type: 'text', value: value.slice(cursor, match.start) });
    output.push({
      type: 'link',
      url: attentionReferenceHref(match.id),
      title: `Open attention ${match.raw}`,
      data: { hProperties: { 'data-attention-reference': match.id } },
      children: [{ type: 'text', value: match.raw }],
    });
    cursor = match.end;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

function transformAttention(node: MdNode, resolveAttention: AttentionReferenceResolver): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      children.push(...(linkifyAttention(child.value, resolveAttention) ?? [child]));
      continue;
    }
    transformAttention(child, resolveAttention);
    children.push(child);
  }
  node.children = children;
}

function resolvePinSafely(lookup: PinReferenceLookup, resolvePin: PinReferenceResolver): ResolvedPinReference | null {
  try {
    const resolved = resolvePin(lookup);
    if (
      !resolved ||
      resolved.sessionId !== lookup.sessionId ||
      resolved.pinId !== lookup.pinId ||
      !safeReferenceId(resolved.sessionId) ||
      !safeReferenceId(resolved.pinId)
    )
      return null;
    return { ...resolved, label: normalizePinLabel(resolved.label) };
  } catch {
    return null;
  }
}

function transformPinLinks(node: MdNode, resolvePin: PinReferenceResolver): void {
  if (node.type === 'link') {
    const lookup = parsePinReferenceHref(node.url);
    if (!lookup) return;
    // A reserved href alone is authored bytes, not transform origin. Require
    // the canonical `pin:` label shape emitted by autocomplete before stamping.
    const authoredLabel =
      node.children?.length === 1 && node.children[0]?.type === 'text' ? node.children[0].value?.trim() : undefined;
    if (!authoredLabel?.toLocaleLowerCase().startsWith('pin:')) return;
    const resolved = resolvePinSafely(lookup, resolvePin);
    if (!resolved) return;
    node.url = pinReferenceHref(resolved);
    node.title = `Open pin: ${resolved.label}`;
    node.data = {
      ...node.data,
      hProperties: {
        ...node.data?.hProperties,
        'data-pin-reference': resolved.pinId,
        'data-pin-session': resolved.sessionId,
      },
    };
    node.children = [{ type: 'text', value: `pin: ${resolved.label}` }];
    return;
  }
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  for (const child of node.children) transformPinLinks(child, resolvePin);
}

export function remarkSessionReferences(options: RemarkSessionReferencesOptions = {}) {
  return (tree: MdNode): void => {
    if (options.resolveAttention) transformAttention(tree, options.resolveAttention);
    if (options.resolvePin) transformPinLinks(tree, options.resolvePin);
  };
}
