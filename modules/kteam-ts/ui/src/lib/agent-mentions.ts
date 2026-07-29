// Fleet-backed agent identity proof and session navigation.
//
// The canonical `:agent` grammar and Markdown transform live in references.ts.
// This module owns only the live fleet index plus legacy href helpers required
// by older persisted Markdown.

import type { SessionView } from '../types';
import {
  formatReference,
  type AgentReferenceLookup,
  type AgentReferenceResolver,
  type ResolvedAgent,
} from './references';

export type AgentMentionLookup = AgentReferenceLookup;
export type ResolvedAgentMention = ResolvedAgent;
export type AgentMentionResolver = AgentReferenceResolver;

export const AGENT_MENTION_FRAGMENT = '#kteam-agent-mention';
const NAME_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const TEAMMATE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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

/** Compatibility entry point used by the excluded autocomplete provider.
 * Repetition chooses a picker tier; inserted text is always canonical `:name`. */
export function agentMentionReference(name: string, sessionId: string): string {
  const callsign = normalizedName(name);
  if (!callsign || !safeSessionId(sessionId)) throw new TypeError('invalid agent mention');
  return formatReference({ kind: 'agent', name: callsign });
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
