// Density + legibility contract for the pre-send attachment chips.
//
// The chips were 74px tall each (135px in the failed state) because they spent
// three body-leading rows on name/size/state beside a 44px button, which at a
// 390x508 keyboard-open viewport is a third of the readable screen for something
// the reader has already seen. They are now two tight rows around a 36px
// thumbnail — measured at 54px ready / 60.67px failed, 65.67px for the whole
// three-chip strip.
//
// What must survive that squeeze, and is asserted here because a future density
// pass would otherwise take it silently:
//   - every state still SAYS which state it is (ready / uploading / the error);
//   - the error is rendered whole, never truncated — it is the only string here
//     that tells the reader what to do next;
//   - Remove (and Retry, where applicable) keep their 44px floor and their
//     accessible names in every state.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingAttachmentStrip } from './SessionChatPage';

type Entry = Parameters<typeof PendingAttachmentStrip>[0]['entries'][number];

function entry(over: Partial<Entry> & Pick<Entry, 'localId' | 'status'>): Entry {
  const file = new File([new Uint8Array([1])], `${over.localId}.png`, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: 482_913 });
  return { file, objectUrl: `blob:${over.localId}`, ...over } as Entry;
}

function render(entries: Entry[]): string {
  return renderToStaticMarkup(<PendingAttachmentStrip entries={entries} onRetry={() => {}} onRemove={() => {}} />);
}

const READY = entry({ localId: 'ready', status: 'ready' });
const UPLOADING = entry({ localId: 'uploading', status: 'uploading' });
const FAILED = entry({
  localId: 'failed',
  status: 'failed',
  error: 'Attachment is no longer available — re-add it',
});

describe('pending attachment chip density', () => {
  test('the thumbnail is the compact 36px box, not the old 48px one', () => {
    const html = render([READY]);
    expect(html).toContain('h-9 w-9');
    expect(html).not.toContain('h-12 w-12');
  });

  test('copy is two rows: name, then size and state together', () => {
    const html = render([READY]);
    // Name is its own row and truncates; size + state share the second.
    expect(html).toContain('ready.png');
    expect(html).toContain('472 KB');
    expect(html).toContain('>ready<');
    expect(html).toContain('leading-tight');
  });

  test('each state still names itself', () => {
    expect(render([READY])).toContain('>ready<');
    expect(render([UPLOADING])).toContain('uploading');
    expect(render([FAILED])).toContain('Attachment is no longer available — re-add it');
  });

  test('the failed chip renders the error whole rather than truncating it', () => {
    const html = render([FAILED]);
    // `truncate` on the error row is what a naive density pass would reach for;
    // the error takes the full second row instead, so it wraps.
    expect(html).toContain('<span class="block text-err">Attachment is no longer available — re-add it</span>');
    expect(html).toContain('role="alert"');
  });

  test('Remove keeps a named 44px target in every state, and Retry joins it on failure', () => {
    for (const [state, one] of [
      ['ready', READY],
      ['uploading', UPLOADING],
      ['failed', FAILED],
    ] as const) {
      const html = render([one]);
      expect(html, state).toContain(`aria-label="Remove ${one.file.name}"`);
      const targets = html.match(/min-h-\[44px\] min-w-\[44px\]/g) ?? [];
      expect(targets.length, state).toBe(state === 'failed' ? 2 : 1);
    }
    expect(render([FAILED])).toContain(`aria-label="Retry ${FAILED.file.name}"`);
  });

  test('the strip itself stays a labelled single-row scroller', () => {
    const html = render([READY, UPLOADING, FAILED]);
    expect(html).toContain('aria-label="Attached images"');
    expect(html).toContain('overflow-x-auto');
  });
});
