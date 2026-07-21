// Animated thinking indicator. Shows the harness's verbatim activity line
// when one is available (parsed by the daemon from the live pane frame); falls
// back to a generic "working…" string when not.

import { useEffect, useState } from 'react';

export function ThinkingIndicator({ activity }: { activity?: string | null }) {
  const text = (activity && activity.trim()) || 'working…';
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 text-muted text-[12.5px]">
      <span className="flex gap-0.5">
        <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '120ms' }} />
        <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '240ms' }} />
      </span>
      <span className="font-mono text-[12px]">{text}</span>
    </div>
  );
}
