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

import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/** Everything focusable we can meet inside an overlay in this app. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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
