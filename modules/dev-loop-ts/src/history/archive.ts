// Archive logic is now in StateService.archiveRun()
// This file kept for potential future pure helper functions

import type { Run, Session, HistoryEntry } from '../types';

export function buildIterationSummary(sessions: Session[], learnings: string[]): HistoryEntry['summary'] {
  const byIteration = new Map<number, Session[]>();

  for (const s of sessions) {
    const list = byIteration.get(s.iteration) || [];
    list.push(s);
    byIteration.set(s.iteration, list);
  }

  return Array.from(byIteration.entries()).map(([iteration, iterSessions]) => {
    const impl = iterSessions.find(s => s.role === 'implementer');
    const reviewers = iterSessions.filter(s => s.role === 'reviewer');

    return {
      iteration,
      implementerDuration:
        impl?.completedAt && impl?.startedAt
          ? new Date(impl.completedAt).getTime() - new Date(impl.startedAt).getTime()
          : 0,
      reviewerVerdicts: reviewers.map(r => ({
        index: r.reviewerIndex ?? 0,
        verdict: r.verdict ?? 'rejected',
      })),
      learnings: learnings.slice(0, iteration),
      sessions: iterSessions.map(s => ({
        role: s.role,
        reviewerIndex: s.reviewerIndex,
        claudeSessionPath: s.claudeSessionPath ?? '',
      })),
    };
  });
}
