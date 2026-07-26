import { ShieldCheck } from 'lucide-react';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';

/** First-class, full-width fleet-supervision destination. The fleet sidebar is
 * intentionally absent here; App owns that layout decision for non-session
 * destinations, while this page owns the one vertical scroller. */
export function WardenPage() {
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-4">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-3 py-2">
        <div className="min-w-0">
          <h1 className="m-0 flex items-center gap-sm font-display text-display font-bold tracking-display">
            <ShieldCheck size={20} className="text-accent" aria-hidden="true" />
            Warden
          </h1>
          <p className="mt-0.5 text-ui text-muted">Fleet sweeps, anomalies, and recent supervision verdicts.</p>
        </div>

        <WardenStrip page />
        <WardenVerdicts page />
      </div>
    </div>
  );
}
