import { navigate } from './router';
import type { AttentionId } from './attention';
import type { CodeReference } from './references';

/** Delivery callbacks for a reference-aware Markdown surface. */
export interface ReferenceOpenHost {
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
}

/**
 * Fleet surfaces do not own the session side pane. Their honest common
 * delivery target is therefore the referenced session itself; once there, the
 * richer session host can open task, file, and attention details.
 */
export function sessionReferenceHost(sessionId?: string): ReferenceOpenHost {
  if (!sessionId) return {};
  const openSession = () => navigate(`/session/${encodeURIComponent(sessionId)}`);
  return {
    onTaskOpen: openSession,
    onCodeReferenceOpen: openSession,
    onAttentionOpen: openSession,
  };
}
