// QUOTE A TRANSCRIPT SELECTION INTO THE COMPOSER.
//
// The reader highlights transcript text and picks "Quote"; the selection is
// wrapped as a markdown blockquote and dropped into the composer as the start of
// a reply. Two halves, deliberately split so the fiddly half is testable without
// a DOM (this package renders tests with react-dom/server and has no DOM impl):
//
//   PURE   — toBlockquote / composeQuotedDraft: turn selected text into the exact
//            new draft string. Asserted with plain data in quote.test.ts.
//   DOM    — insertQuoteIntoComposer: find the foreground composer's textarea and
//            drive its EXISTING onChange path with the composed value.
//
// WHY DRIVE onChange INSTEAD OF WRITING THE TEXTAREA'S value. The composer is a
// controlled React input owned by SessionChatPage (`value={draft}` /
// `onChange={e => onDraftChange(e.target.value)}`), which this feature does not
// own and must not edit. Assigning `el.value` directly is invisible to React —
// its own value tracker would overwrite it on the next render. So we use the
// prototype value setter (which React's tracker watches) and dispatch a bubbling
// `input` event: React sees a genuine user edit, calls the composer's onChange,
// and the page's draft state, its per-session persistence and everything
// downstream update exactly as if the reader had typed. No composer edit needed.
//
// THE SELECTION IS READ BY THE CALLER, BEFORE THIS RUNS. Focusing the composer
// (below) collapses any live selection, so the caller captures the text at the
// moment the menu opens and passes it in here — this function never reads the
// selection itself.

/** Wrap text as a markdown blockquote: every line (including blank ones, so the
 *  quote reads as one block) gets a `> ` prefix. Trailing whitespace on the
 *  whole selection is trimmed first; interior blank lines are preserved. Returns
 *  '' for empty/whitespace-only input, so a caller can cheaply skip a no-op. */
export function toBlockquote(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.trim().length === 0) return '';
  return trimmed
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/** The new composer value after quoting `selection` into an existing `draft`.
 *
 *  A blockquote followed by a blank line, so the reader's reply starts on a
 *  fresh line below it. When the composer already holds a draft, the quote is
 *  appended after a blank-line separator rather than clobbering it — quoting is
 *  additive. Returns the draft unchanged when the selection is empty. */
export function composeQuotedDraft(draft: string, selection: string): string {
  const quote = toBlockquote(selection);
  if (!quote) return draft;
  const block = `${quote}\n\n`;
  if (draft.trim().length === 0) return block;
  // Keep the existing draft, ensure a blank-line gap, then the quote block.
  const base = draft.replace(/\s*$/, '');
  return `${base}\n\n${block}`;
}

/** The foreground pane's composer textarea, or null when none is mounted (the
 *  reader is on the Terminal tab, a structured question replaced the composer, or
 *  the origin is read-only). Retained background panes stay in the DOM but are
 *  `aria-hidden` (App.tsx), so — exactly like the pin bridge — the one textarea
 *  NOT inside an `[aria-hidden="true"]` ancestor is the interactable one. */
export function foregroundComposerTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  const candidates = document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  for (const el of candidates) {
    if (!el.closest('[aria-hidden="true"]')) return el;
  }
  return null;
}

/** Drive the foreground composer's real onChange with the quoted draft, then
 *  focus it and put the caret at the end so the reader types straight after the
 *  quote. Returns false (a no-op) when there is no live composer to quote into.
 *
 *  `selection` is the text the caller captured BEFORE opening the menu — this
 *  function focuses the composer, which would have collapsed a live selection. */
export function insertQuoteIntoComposer(selection: string): boolean {
  const el = foregroundComposerTextarea();
  if (!el) return false;
  const next = composeQuotedDraft(el.value, selection);
  if (next === el.value) return false;
  // The prototype setter is the one React's value tracker is patched onto;
  // going through it (not `el.value =`) is what makes the dispatched input event
  // register as a real edit instead of being reverted on the next render.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  const end = next.length;
  try {
    el.setSelectionRange(end, end);
  } catch {
    // A detached or hidden textarea can refuse selection; the value still landed.
  }
  return true;
}
