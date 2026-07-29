// Settings control for the composer highlight overlay. Kept standalone because
// SettingsPage.tsx is a shared/contended integration point in this batch.

import { MD_COMPOSE_DEFAULT, useMdComposePref, writeMdComposePref } from '../lib/md-compose';

export const MARKDOWN_COMPOSER_EXPLANATION =
  'Markdown markers stay visible in the native textarea. A separate bounded preview renders headings, lists, emphasis, code, links, and proven in-app references while you type.';

export function MarkdownComposerSettings() {
  const pref = useMdComposePref();
  const enabled = pref === 'on';

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-control-x py-2 text-left hover:border-accent"
        onClick={() => writeMdComposePref(enabled ? 'off' : 'on')}
      >
        <span className="min-w-0">
          <span className="block text-ui font-semibold text-fg">Highlight Markdown syntax</span>
          <span className="mt-0.5 block text-meta leading-base text-muted">Native textarea · no editor swap</span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
            enabled ? 'border-accent bg-accent' : 'border-border-strong bg-surface'
          }`}
        >
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-fg transition-transform ${
              enabled ? 'translate-x-[20px]' : 'translate-x-0.5'
            }`}
          />
        </span>
      </button>
      <p className="m-0 text-ui leading-base text-muted">{MARKDOWN_COMPOSER_EXPLANATION}</p>
      {MD_COMPOSE_DEFAULT === 'off' && (
        <p className="m-0 text-meta leading-base text-faint">
          Off by default while this experience receives a real-device mobile Safari pass. Enabling it changes
          presentation only; the original textarea still owns input, selection, dictation, autocomplete and drafts.
        </p>
      )}
    </div>
  );
}
