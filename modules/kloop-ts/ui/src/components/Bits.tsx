import { Badge } from './Primitives';
import { agentTone, runTone, verdictTone } from '../lib/format';
import type { AgentStatus, RunStatus } from '../types';

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={runTone(status)}>{status}</Badge>;
}

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return <Badge tone={agentTone(status)}>{status}</Badge>;
}

export function VerdictBadge({ verdict }: { verdict?: string }) {
  if (!verdict) return null;
  return <Badge tone={verdictTone(verdict)}>{verdict}</Badge>;
}

/** Quiet harness chip (claude / codex / gemini) — small, not a loud pill. */
export function HarnessChip({ harness }: { harness?: string }) {
  if (!harness) return null;
  return (
    <span className="rounded-sm border border-border-soft bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
      {harness}
    </span>
  );
}

/** A slim label + value stat, transcript-quiet. */
export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm text-fg">{value}</span>
    </div>
  );
}
