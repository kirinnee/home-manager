import { useId } from 'react';
import type { ChatWidth } from '../lib/store';
import { cn } from '../lib/utils';

export const CHAT_WIDTH_OPTIONS: ReadonlyArray<{
  id: ChatWidth;
  label: string;
  description: string;
}> = [
  {
    id: 'full',
    label: 'Full-bleed',
    description: 'Default. Expands the conversation to the available desktop width.',
  },
  {
    id: 'readable',
    label: 'Readable column',
    description: 'Caps the conversation at 768px and centres it.',
  },
];

/**
 * Conversation-width chooser with an immediate visual preview.
 *
 * Full pane is already the persisted/default state, while both choices are
 * intentionally identical below the readable cap. Showing the preview and both
 * facts beside the radios means selecting the default on a phone no longer
 * looks like a dead control.
 */
export function ChatWidthControl({ value, onChange }: { value: ChatWidth; onChange: (value: ChatWidth) => void }) {
  const explanationId = useId();

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Conversation width"
        aria-describedby={explanationId}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {CHAT_WIDTH_OPTIONS.map(option => {
          const checked = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange(option.id)}
              className={cn(
                'flex min-h-[44px] min-w-0 flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent',
              )}
            >
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-tight text-muted">{option.description}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 rounded-control border border-border-soft bg-surface-2 p-2.5">
        <div className="flex items-center justify-between gap-2 text-meta text-muted">
          <span>Conversation preview</span>
          <span>{value === 'full' ? 'Full-bleed · default' : 'Readable · 768px max'}</span>
        </div>
        <div
          aria-hidden="true"
          className="mt-2 flex h-10 w-full items-center justify-center rounded-control bg-surface px-2"
        >
          <div
            data-chat-width-preview={value}
            className={cn(
              'flex h-6 flex-col justify-center gap-1 rounded-sm border border-accent/50 bg-accent-soft px-2 transition-[width] duration-150',
              value === 'full' ? 'w-full' : 'w-2/3 max-w-[180px]',
            )}
          >
            <span className="block h-px w-4/5 bg-accent/50" />
            <span className="block h-px w-3/5 bg-accent/30" />
          </div>
        </div>
      </div>

      <p id={explanationId} aria-live="polite" className="mt-2 text-meta leading-base text-faint">
        {value === 'full'
          ? 'Full-bleed is already active. Choosing it again will not change the conversation.'
          : 'Readable column is active. Full-bleed will use the extra width in a wider conversation.'}{' '}
        When the conversation pane is 768px wide or narrower, both choices look the same.
      </p>
    </>
  );
}
