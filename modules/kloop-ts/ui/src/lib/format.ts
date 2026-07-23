import type { AgentStatus, RunStatus } from '../types';

export function fmtDur(ms?: number): string {
  if (ms === undefined || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtAgo(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const d = Date.now() - then;
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export type Tone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

export function runTone(status: RunStatus): Tone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
      return 'accent';
    case 'pending':
      return 'pend';
    case 'cancelled':
      return 'warn';
    default:
      return 'err'; // error / conflict / agent_failure / crashed
  }
}

export function agentTone(status: AgentStatus): Tone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
      return 'accent';
    case 'pending':
      return 'pend';
    case 'timeout':
      return 'warn';
    default:
      return 'err';
  }
}

export function verdictTone(verdict?: string): Tone {
  if (verdict === 'approved') return 'ok';
  if (verdict === 'rejected') return 'err';
  return 'pend';
}
