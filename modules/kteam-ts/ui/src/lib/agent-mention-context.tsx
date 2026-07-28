import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { agentMentionIdentityKey, createAgentMentionResolver, type AgentMentionResolver } from './agent-mentions';
import { useFleet } from './store';

const unresolved: AgentMentionResolver = () => null;
const AgentMentionContext = createContext<AgentMentionResolver>(unresolved);

/**
 * One fleet subscription for every Markdown surface in the application.
 *
 * The store's session array changes for high-frequency status/activity frames,
 * while mention resolution changes only when session identity does. Keying the
 * resolver on id + callsign + creation time preserves Markdown's memo contract:
 * existing transcript blocks do not all reparse because an unrelated agent ran
 * a tool, but a newly hydrated or renamed callsign becomes linkable at once.
 */
export function AgentMentionProvider({ children }: { children: ReactNode }) {
  const { sessions } = useFleet();
  const fleet = sessions ?? [];
  const identityKey = agentMentionIdentityKey(fleet);
  // identityKey deliberately represents the only fields copied into the
  // resolver. State-only SessionView replacements reuse the previous function.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resolver = useMemo(() => createAgentMentionResolver(fleet), [identityKey]);
  return <AgentMentionContext.Provider value={resolver}>{children}</AgentMentionContext.Provider>;
}

export function useAgentMentionResolver(): AgentMentionResolver {
  return useContext(AgentMentionContext);
}
