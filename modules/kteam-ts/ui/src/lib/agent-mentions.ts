// Agent mention grammar, stable references, and the remark transform that
// turns proven callsigns into session links.
//
// A callsign is presentation; a session id is identity. Autocomplete therefore
// inserts ordinary Markdown in the form
//
//   [@ottis](/session/ms4v5fu2-f2a89500#kteam-agent-mention)
//
// The transcript renders only `@ottis`, but the destination survives a rename
// because it is keyed by the immutable session id. Bare `@ottis` prose is also
// recognised, but ONLY when the supplied fleet resolver proves that callsign
// currently resolves. Unknown names, email addresses, paths, existing links,
// code, and raw HTML stay ordinary text.

import type { SessionView } from '../types';

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

export interface AgentMentionLookup {
  /** Stable identity. When present, it always wins over the name hint. */
  sessionId?: string;
  /** Raw lowercase teammate callsign. */
  name?: string;
}

export interface ResolvedAgentMention {
  sessionId: string;
  /** Current callsign from the fleet, so a renamed session renders honestly. */
  name: string;
}

export type AgentMentionResolver = (lookup: AgentMentionLookup) => ResolvedAgentMention | null | undefined;

export interface RemarkAgentMentionsOptions {
  resolveMention?: AgentMentionResolver;
}

export const AGENT_MENTION_FRAGMENT = '#kteam-agent-mention';
const NAME_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const TEAMMATE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);
const AGENT_REFERENCE = /@([a-z][a-z0-9-]{0,31})/giu;

// The same token-boundary idea as composer-autocomplete-engine.ts. A mention
// cannot start inside an email/word/path, and a path-shaped suffix keeps the
// token available to code-references.ts instead of stealing its prefix.
const WORD_OR_PATH_BEFORE = /[\p{L}\p{N}_\-.\\/@]/u;
const WORD_OR_PATH_AFTER = /[\p{L}\p{N}_\-\\/@]/u;
const FILE_SUFFIX_AFTER_DOT = /[\p{L}\p{N}_+-]/u;

/** Whether the bytes after a callsign prove that the candidate is merely the
 * prefix of a larger word or file reference. Sentence punctuation must remain a
 * boundary (`@ottis.` and `@ottis: ready`), while real path/location shapes such
 * as `@ottis.ts`, `@ottis:12`, and `@ottis#L12` stay available to the code
 * reference plugin that runs next. */
function continuesAsWordOrPath(value: string, after: number): boolean {
  const next = value[after] ?? '';
  if (WORD_OR_PATH_AFTER.test(next)) return true;
  if (next === '.') return FILE_SUFFIX_AFTER_DOT.test(value[after + 1] ?? '');
  if (next === ':') return /[0-9]/u.test(value[after + 1] ?? '');
  if (next === '#') return /^L[0-9]/iu.test(value.slice(after + 1));
  return false;
}

function normalizedName(raw: string | undefined): string | null {
  const name = raw?.trim().toLowerCase() ?? '';
  return TEAMMATE_NAME.test(name) ? name : null;
}

function safeSessionId(raw: string): boolean {
  return SESSION_ID.test(raw) && raw !== '.' && raw !== '..';
}

export function agentSessionHref(sessionId: string): string {
  if (!safeSessionId(sessionId)) throw new TypeError('invalid agent mention session id');
  return `/session/${encodeURIComponent(sessionId)}`;
}

export function agentMentionHref(sessionId: string): string {
  return `${agentSessionHref(sessionId)}${AGENT_MENTION_FRAGMENT}`;
}

/** Canonical composer insertion: readable callsign, immutable id destination. */
export function agentMentionReference(name: string, sessionId: string): string {
  const callsign = normalizedName(name);
  if (!callsign) throw new TypeError('invalid agent mention callsign');
  return `[@${callsign}](${agentMentionHref(sessionId)})`;
}

export function parseAgentMentionHref(href: string | undefined): string | null {
  if (!href?.startsWith('/session/') || !href.endsWith(AGENT_MENTION_FRAGMENT)) return null;
  const encoded = href.slice('/session/'.length, -AGENT_MENTION_FRAGMENT.length);
  if (!encoded) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return safeSessionId(sessionId) ? sessionId : null;
}

function createdAt(view: SessionView): number {
  const value = Date.parse(view.config.createdAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Build one immutable resolver from the already-live fleet snapshot.
 *
 * Exact ids resolve for the whole retained fleet, which is why an old finished
 * transcript remains mentionable. Bare names mirror the daemon's callsign
 * semantics: case-insensitive, sessions created in the five-day name window,
 * newest holder wins.
 */
export function createAgentMentionResolver(sessions: readonly SessionView[], now = Date.now()): AgentMentionResolver {
  const byId = new Map<string, ResolvedAgentMention>();
  const byName = new Map<string, { target: ResolvedAgentMention; createdAt: number }>();
  const cutoff = now - NAME_WINDOW_MS;

  for (const view of sessions) {
    const name = normalizedName(view.config.teammate);
    if (!name || !safeSessionId(view.config.id)) continue;
    const target = { sessionId: view.config.id, name };
    byId.set(view.config.id, target);

    const created = createdAt(view);
    if (created < cutoff) continue;
    const current = byName.get(name);
    if (!current || created > current.createdAt) byName.set(name, { target, createdAt: created });
  }

  return lookup => {
    if (lookup.sessionId) return byId.get(lookup.sessionId) ?? null;
    const name = normalizedName(lookup.name);
    return name ? (byName.get(name)?.target ?? null) : null;
  };
}

/** Only identity fields participate, so status/activity churn does not make
 * every already-rendered Markdown block parse again. */
export function agentMentionIdentityKey(sessions: readonly SessionView[]): string {
  return sessions
    .flatMap(view =>
      normalizedName(view.config.teammate)
        ? [`${view.config.id}\u0000${view.config.teammate}\u0000${view.config.createdAt}`]
        : [],
    )
    .join('\u0001');
}

function mentionTitle(target: ResolvedAgentMention): string {
  return `Open @${target.name}'s session`;
}

function linkifyText(value: string, resolveMention: AgentMentionResolver): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;

  for (const match of value.matchAll(AGENT_REFERENCE)) {
    const index = match.index;
    const raw = match[0];
    const name = match[1];
    if (index === undefined || !name) continue;
    if (index > 0 && WORD_OR_PATH_BEFORE.test(value[index - 1]!)) continue;
    if (continuesAsWordOrPath(value, index + raw.length)) continue;

    let target: ResolvedAgentMention | null | undefined;
    try {
      target = resolveMention({ name });
    } catch {
      target = null;
    }
    if (!target) continue;

    if (index > cursor) output.push({ type: 'text', value: value.slice(cursor, index) });
    output.push({
      type: 'link',
      url: agentMentionHref(target.sessionId),
      title: mentionTitle(target),
      data: { hProperties: { 'data-agent-mention': target.sessionId } },
      children: [{ type: 'text', value: `@${target.name}` }],
    });
    cursor = index + raw.length;
    changed = true;
  }

  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

function transform(node: MdNode, resolveMention: AgentMentionResolver): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      children.push(...(linkifyText(child.value, resolveMention) ?? [child]));
      continue;
    }
    transform(child, resolveMention);
    children.push(child);
  }
  node.children = children;
}

export function remarkAgentMentions(options: RemarkAgentMentionsOptions = {}) {
  return (tree: MdNode): void => {
    // Secure default: syntax is not proof. Without a fleet resolver, no link.
    if (!options.resolveMention) return;
    transform(tree, options.resolveMention);
  };
}
