// The keyboard contract every overlay in this app owes the reader.
//
// Extracted from SessionDetails, which had the only correct implementation, so
// the fleet drawer stops having a different (and thinner) one. Three things,
// none of them optional once a container claims `aria-modal="true"`:
//
//   ESCAPE   — closes from anywhere inside, including from a focused control.
//   FOCUS IN — moving focus into the dialog on open, so a reader who opened it
//              from the keyboard is inside it rather than behind it.
//   FOCUS BACK — returning focus to whatever opened it on close. A dialog you
//              can open with the keyboard and then not escape from is worse
//              than no dialog.
//   TRAP     — Tab cycles within the dialog. `aria-modal` claims the rest of the
//              page is unreachable; a claim the reader can disprove with one
//              keystroke is worse than not making it.
//
// The trap is returned as an `onKeyDown` for the dialog element rather than
// installed globally: it must only apply while focus is genuinely inside.
//
// ESCAPE IS A STACK, NOT A BROADCAST (see ESCAPE_LAYERS below). Overlays in this
// app can genuinely be open at the same time — the session details sheet with
// the command palette summoned over it is the ordinary case — and every open
// dialog listening on `document` means one Escape closes all of them at once.

import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/** Everything focusable we can meet inside an overlay in this app. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** OPEN OVERLAYS, OLDEST FIRST. Exactly one of them — the last — owns Escape.
 *
 *  Why a stack and not `stopImmediatePropagation()`: `document` listeners run in
 *  REGISTRATION order, and registration order is OPEN order. The sheet that has
 *  been open for a minute registered before the palette you just summoned, so it
 *  would run first and stop the palette's handler — closing the layer underneath
 *  and leaving the top one on screen, which is precisely backwards. Order of
 *  arrival is the only thing that decides who is on top, so that is what this
 *  models directly.
 *
 *  `stopPropagation()` is still called by the winner, for the listeners BELOW
 *  document that would otherwise also see the key. */
const ESCAPE_LAYERS: object[] = [];

/** Push a layer and return its removal. Removal is by identity and is safe to
 *  call twice (React may run a cleanup after the layer already left).
 *
 *  Exported for the unit test, and for any future overlay that needs the same
 *  ordering without wanting the rest of this hook. */
export function pushEscapeLayer(token: object): () => void {
  ESCAPE_LAYERS.push(token);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    // `lastIndexOf`, not `indexOf`: identity is unique in practice, but a layer
    // that somehow appears twice must lose its most recent entry, not its first.
    const at = ESCAPE_LAYERS.lastIndexOf(token);
    if (at !== -1) ESCAPE_LAYERS.splice(at, 1);
  };
}

/** True only for the top layer. A layer that is not on the stack at all is not
 *  the top one, even when the stack is empty — a closed dialog owns nothing. */
export function isTopEscapeLayer(token: object): boolean {
  return ESCAPE_LAYERS.length > 0 && ESCAPE_LAYERS[ESCAPE_LAYERS.length - 1] === token;
}

/** Test-only: the current depth. Never read this to make a rendering decision —
 *  it is module state and does not notify React. */
export function escapeLayerCount(): number {
  return ESCAPE_LAYERS.length;
}

export interface DialogFocus {
  /** Spread onto the dialog element: implements the Tab trap. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useDialogFocus(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { autoFocus?: boolean } = {},
): DialogFocus {
  const { autoFocus = true } = options;
  const restoreTo = useRef<HTMLElement | null>(null);

  // `onClose` is read through a ref so the effect below can depend on `open`
  // ALONE. That is not a tidiness preference — it is what keeps the stack
  // honest. Most callers pass an inline arrow (`onClose={() => setOpen(false)}`),
  // so an `onClose` dependency would tear down and re-register on every render
  // of the owning component, and each re-registration would push that dialog
  // back to the TOP of the stack. A sheet that merely re-rendered would then
  // steal Escape from the palette summoned over it — the exact bug the stack
  // exists to prevent, reintroduced by a dependency array.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /** This hook instance's identity on the stack. Stable for its whole life, so
   *  StrictMode's setup/cleanup/setup double-invoke re-pushes the same layer
   *  rather than inventing a second one. */
  const layer = useRef<object>({});

  useEffect(() => {
    if (!open) return;
    const token = layer.current;
    const release = pushEscapeLayer(token);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // ONE LAYER PER ESCAPE. Every open dialog has a listener on `document`;
      // only the topmost one may act on the key, and the others must leave it
      // completely alone — not even `stopPropagation`, or the top layer's own
      // handler could be starved depending on who registered first.
      if (!isTopEscapeLayer(token)) return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      release();
    };
  }, [open]);

  // Capture the opener before descendant passive effects run. The fleet drawer
  // deliberately focuses its search input in a child useEffect; capturing in a
  // parent passive effect races behind that focus and would restore to the
  // drawer's soon-to-be-removed input instead of to the trigger.
  useLayoutEffect(() => {
    if (open) {
      restoreTo.current = document.activeElement as HTMLElement | null;
      if (autoFocus) {
        // The container itself, not its first control: landing on "Close" is a
        // trap of a different kind (one stray Enter and the dialog is gone).
        // Containers carry tabIndex={-1} for exactly this.
        ref.current?.focus();
      }
      return;
    }
    const previous = restoreTo.current;
    restoreTo.current = null;
    if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
  }, [open, autoFocus, ref]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        el => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [ref],
  );

  return { onKeyDown };
}
