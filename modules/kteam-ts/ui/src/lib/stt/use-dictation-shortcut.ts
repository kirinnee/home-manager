// Browser wiring for the pure shortcut policy in `dictation-shortcut.ts`.
// One instance is mounted beside each retained Composer; only the textarea in
// the visible (not aria-hidden) pane is eligible, so the app's two-pane LRU
// cannot start two microphones from one physical key press.

import { useEffect, useRef } from 'react';
import type { DictationPhase } from '../../hooks/useDictation';
import {
  DictationShortcutGesture,
  dictationShortcutCaptureActive,
  matchesDictationShortcut,
  sameDictationShortcutTrigger,
  type DictationShortcutAction,
  type DictationShortcutBinding,
} from './dictation-shortcut';

export interface ShortcutDictationHandle {
  phase: DictationPhase;
  start(): void;
  stop(): void;
}

export interface DictationShortcutOptions {
  binding: DictationShortcutBinding;
  handle: ShortcutDictationHandle;
  composerRef: { current: HTMLElement | null };
  disabled?: boolean;
}

type ClosestLike = {
  isConnected?: boolean;
  closest?(selector: string): unknown;
};

/** Retained chat panes are marked aria-hidden and invisible by App.Pane. */
export function isActiveShortcutComposer(element: ClosestLike | null): boolean {
  if (!element || element.isConnected === false) return false;
  if (typeof element.closest !== 'function') return true;
  return element.closest('[aria-hidden="true"], [inert]') === null;
}

/** Do not make a shortcut configured for dictation steal a Settings/palette
 * key capture or another text field. The active composer itself is allowed. */
export function shortcutTargetAllowed(target: unknown, composer: HTMLElement | null): boolean {
  if (!target || typeof target !== 'object') return true;
  if (target === composer) return true;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?(selector: string): unknown;
  };
  if (typeof element.closest === 'function') {
    if (element.closest('[role="dialog"], [aria-modal="true"], [data-settings-scroller]')) return false;
    if (element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return false;
  }
  const tag = element.tagName?.toLocaleLowerCase();
  return tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !element.isContentEditable;
}

function recording(phase: DictationPhase): boolean {
  return phase === 'requesting' || phase === 'recording';
}

function eventNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function runAction(action: DictationShortcutAction, handle: ShortcutDictationHandle): void {
  if (action === 'start') handle.start();
  else if (action === 'stop') handle.stop();
}

export function useDictationShortcut({ binding, handle, composerRef, disabled }: DictationShortcutOptions): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const gestureRef = useRef(new DictationShortcutGesture());

  // A stop from the visible panel (or completion/error) must not leave the
  // shortcut thinking its earlier tap is still latched.
  useEffect(() => {
    if (handle.phase === 'idle' || handle.phase === 'transcribing' || handle.phase === 'error') {
      gestureRef.current.reset();
    }
  }, [handle.phase]);

  useEffect(() => {
    if (disabled || typeof window === 'undefined') return;
    const gesture = gestureRef.current;

    const eligible = (target: EventTarget | null): boolean => {
      const composer = composerRef.current;
      return isActiveShortcutComposer(composer) && shortcutTargetAllowed(target, composer);
    };

    const prevent = (event: KeyboardEvent): void => {
      // In particular, prevent bare Alt from toggling a browser menu after the
      // page has positively matched and claimed it.
      event.preventDefault();
      event.stopPropagation();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (dictationShortcutCaptureActive() || event.isComposing || event.keyCode === 229) return;
      if (!eligible(event.target) || !matchesDictationShortcut(binding, event)) return;
      prevent(event);
      if (event.repeat) return;
      const current = handleRef.current;
      runAction(gesture.keyDown(eventNow(), recording(current.phase)), current);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (dictationShortcutCaptureActive() || !eligible(event.target)) return;
      // Modifier flags can already be false on their own keyup, so the matching
      // keydown owns the gesture and keyup needs only the same physical trigger.
      if (!sameDictationShortcutTrigger(binding, event)) return;
      prevent(event);
      const current = handleRef.current;
      runAction(gesture.keyUp(eventNow()), current);
    };

    const release = (): void => {
      const current = handleRef.current;
      runAction(gesture.blur(recording(current.phase)), current);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') release();
    };

    // Capture before composer/autocomplete/browser-panel handlers. A matched
    // shortcut is an app command; an unmatched key continues untouched.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, [binding, composerRef, disabled]);
}
