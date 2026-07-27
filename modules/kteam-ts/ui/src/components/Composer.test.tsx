import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Composer,
  ComposerTextarea,
  clipboardImageFiles,
  composerCanSubmit,
  composerEnterDecision,
  composerStatusCopy,
  restoreComposerSelection,
  selectComposerKeyboardSubmit,
  shouldRefocusComposer,
} from './Composer';

function renderComposer(
  props: Partial<{
    draft: string;
    disabled: boolean;
    busy: boolean;
    sending: boolean;
    onInterruptAndSend: () => void;
    compact: boolean;
    context: { model: string };
    onFiles: (files: File[]) => void;
    attachmentSlot: string;
    hasAttachments: boolean;
    attachmentsPending: boolean;
  }> = {},
): string {
  return renderToStaticMarkup(<Composer draft="message" onDraftChange={() => {}} onSubmit={() => {}} {...props} />);
}

function renderComposerWithMicrophone(props: Parameters<typeof renderComposer>[0] = {}): string {
  const root = globalThis as typeof globalThis & { navigator: Navigator };
  const previous = root.navigator;
  const capable = Object.create(previous) as Navigator;
  Object.defineProperty(capable, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.reject(new Error('not called during render')) },
  });
  root.navigator = capable;
  try {
    return renderComposer(props);
  } finally {
    root.navigator = previous;
  }
}

function buttonWithLabel(html: string, label: string): string {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const button = buttons.find(candidate => candidate.includes(`aria-label="${label}"`));
  if (!button) throw new Error(`missing button labelled ${label}\n${html}`);
  return button;
}

function expectTouchTarget(button: string) {
  expect(button).toContain('min-h-[44px]');
  expect(button).toContain('min-w-[44px]');
  const openingTag = button.slice(0, button.indexOf('>'));
  expect(openingTag).not.toMatch(/(?:^|\s)hidden(?:=|\s|$)/);
}

function ancestorsOfLabelledButton(html: string, label: string): string[] {
  const stack: Array<{ name: string; openingTag: string }> = [];
  const tags = html.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi);
  for (const match of tags) {
    const tag = match[0];
    const name = match[1]!.toLowerCase();
    if (tag.startsWith('</')) {
      let index = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.name === name) {
          index = i;
          break;
        }
      }
      if (index >= 0) stack.splice(index);
      continue;
    }
    if (name === 'button' && tag.includes(`aria-label="${label}"`)) {
      return stack.map(entry => entry.openingTag);
    }
    if (!['input', 'meta', 'link', 'img', 'br', 'hr'].includes(name)) stack.push({ name, openingTag: tag });
  }
  throw new Error(`missing button labelled ${label}`);
}

describe('Composer keyboard safety matrix', () => {
  test('only confident desktop bare Enter with a submittable draft mutates', () => {
    let rows = 0;
    for (const enterSends of [false, true]) {
      for (const shiftKey of [false, true]) {
        for (const isComposing of [false, true]) {
          for (const sending of [false, true]) {
            for (const disabled of [false, true]) {
              const canSubmit = composerCanSubmit({ draft: 'ready', disabled, sending });
              const decision = composerEnterDecision({
                key: 'Enter',
                shiftKey,
                isComposing,
                enterSends,
                canSubmit,
              });
              const eligibleKey = enterSends && !shiftKey && !isComposing;

              expect(decision, JSON.stringify({ enterSends, shiftKey, isComposing, sending, disabled })).toEqual({
                preventDefault: eligibleKey,
                submit: eligibleKey && !sending && !disabled,
              });
              rows += 1;
            }
          }
        }
      }
    }
    expect(rows).toBe(32);
  });

  test('touch bare Enter and Shift+Enter both fall through as newlines', () => {
    for (const shiftKey of [false, true]) {
      expect(
        composerEnterDecision({
          key: 'Enter',
          shiftKey,
          isComposing: false,
          enterSends: false,
          canSubmit: true,
        }),
      ).toEqual({ preventDefault: false, submit: false });
    }
  });

  test('IME Enter never prevents composition or submits', () => {
    expect(
      composerEnterDecision({
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
        enterSends: true,
        canSubmit: true,
      }),
    ).toEqual({ preventDefault: false, submit: false });
  });

  test('the rendered textarea reads modality inside every keystroke', () => {
    let enterSends = true;
    let reads = 0;
    let prevents = 0;
    let submits = 0;
    const textarea = ComposerTextarea({
      inputRef: { current: null },
      draft: 'ready',
      onDraftChange: () => {},
      onSubmit: () => submits++,
      canSubmit: true,
      readModality: () => {
        reads += 1;
        return { touchAffected: !enterSends, enterSends };
      },
    });
    const onKeyDown = (
      textarea.props as {
        onKeyDown(event: {
          key: string;
          shiftKey: boolean;
          nativeEvent: { isComposing: boolean };
          preventDefault(): void;
        }): void;
      }
    ).onKeyDown;
    const pressEnter = () =>
      onKeyDown({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => prevents++,
      });

    pressEnter(); // fine + hover desktop
    expect({ reads, prevents, submits }).toEqual({ reads: 1, prevents: 1, submits: 1 });

    enterSends = false; // synchronous result of a touch pointerdown
    pressEnter();
    expect({ reads, prevents, submits }).toEqual({ reads: 2, prevents: 1, submits: 1 });

    enterSends = true; // genuine mouse pointerdown restores desktop mode
    pressEnter();
    expect({ reads, prevents, submits }).toEqual({ reads: 3, prevents: 2, submits: 2 });
  });

  test('the rendered textarea maps Shift and native IME state into the policy', () => {
    let submits = 0;
    let prevents = 0;
    const textarea = ComposerTextarea({
      inputRef: { current: null },
      draft: 'ready',
      onDraftChange: () => {},
      onSubmit: () => submits++,
      canSubmit: true,
      readModality: () => ({ touchAffected: false, enterSends: true }),
    });
    const onKeyDown = (textarea.props as { onKeyDown(event: any): void }).onKeyDown;

    onKeyDown({
      key: 'Enter',
      shiftKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: () => prevents++,
    });
    onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: true },
      preventDefault: () => prevents++,
    });

    expect({ prevents, submits }).toEqual({ prevents: 0, submits: 0 });
  });

  test('busy keyboard delivery exposes only the safe queue callback, never interrupt', () => {
    let queued = 0;
    let interrupted = 0;
    const safePath = () => queued++;
    const interruptPath = () => interrupted++;
    const keyboardSubmit = selectComposerKeyboardSubmit({
      busy: true,
      onSubmit: safePath,
      onInterruptAndSend: interruptPath,
    });
    expect(keyboardSubmit).toBe(safePath);
    const textarea = ComposerTextarea({
      inputRef: { current: null },
      draft: 'ready',
      onDraftChange: () => {},
      onSubmit: keyboardSubmit,
      canSubmit: true,
      readModality: () => ({ touchAffected: false, enterSends: true }),
    });
    const onKeyDown = (textarea.props as { onKeyDown(event: any): void }).onKeyDown;
    onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    });

    // There is deliberately no interrupt callback in the textarea contract.
    expect({ queued, interrupted }).toEqual({ queued: 1, interrupted: 0 });
  });

  test('empty and whitespace-only drafts cannot mutate', () => {
    for (const draft of ['', ' \n\t ']) {
      const canSubmit = composerCanSubmit({ draft });
      expect(canSubmit).toBe(false);
      expect(
        composerEnterDecision({
          key: 'Enter',
          shiftKey: false,
          isComposing: false,
          enterSends: true,
          canSubmit,
        }),
      ).toEqual({ preventDefault: true, submit: false });
    }
  });

  test('a ready image makes an empty draft submittable, but an upload in flight does not', () => {
    expect(composerCanSubmit({ draft: '', hasAttachments: true })).toBe(true);
    expect(composerCanSubmit({ draft: '', hasAttachments: true, attachmentsPending: true })).toBe(false);
    expect(composerCanSubmit({ draft: 'caption', attachmentsPending: true })).toBe(false);
    expect(composerCanSubmit({ draft: '', hasAttachments: true, disabled: true })).toBe(false);
  });

  test('non-Enter keys remain native textarea input', () => {
    expect(
      composerEnterDecision({
        key: 'a',
        shiftKey: false,
        isComposing: false,
        enterSends: true,
        canSubmit: true,
      }),
    ).toEqual({ preventDefault: false, submit: false });
  });
});

describe('Composer image capture', () => {
  test('clipboard capture consumes only image file items', () => {
    const image = new File(['png'], 'paste.png', { type: 'image/png' });
    const text = new File(['text'], 'note.txt', { type: 'text/plain' });
    const files = clipboardImageFiles([
      { kind: 'string', type: 'text/plain', getAsFile: () => text },
      { kind: 'file', type: 'text/plain', getAsFile: () => text },
      { kind: 'file', type: 'image/png', getAsFile: () => image },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => null },
    ]);
    expect(files).toEqual([image]);
  });

  test('picker is multi-image-only and its paperclip is a labelled 44px target', () => {
    const html = renderComposer({ onFiles: () => {} });
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
    expect(html).toContain('multiple=""');
    expectTouchTarget(buttonWithLabel(html, 'Attach images'));
  });

  test('the page-owned attachment slot sits before the textarea', () => {
    const html = renderComposer({ onFiles: () => {}, attachmentSlot: 'READY IMAGE' });
    expect(html.indexOf('READY IMAGE')).toBeGreaterThan(-1);
    expect(html.indexOf('READY IMAGE')).toBeLessThan(html.indexOf('<textarea'));
  });

  test('uploading blocks send with a real reason without hiding the attachment control', () => {
    const html = renderComposer({ onFiles: () => {}, attachmentsPending: true });
    const send = buttonWithLabel(html, 'Send this message');
    expect(send).toContain('disabled=""');
    expect(html).toContain('Wait for images to finish uploading.');
    expectTouchTarget(buttonWithLabel(html, 'Attach images'));
  });
});

describe('Composer self-refocus policy', () => {
  test('never summons a text field in touch-affected mode', () => {
    expect(
      shouldRefocusComposer({ touchAffected: true, activeElementIsBody: true, disabled: false, sending: false }),
    ).toBe(false);
  });

  test('desktop refocuses only from body while available', () => {
    expect(
      shouldRefocusComposer({ touchAffected: false, activeElementIsBody: true, disabled: false, sending: false }),
    ).toBe(true);
    expect(
      shouldRefocusComposer({ touchAffected: false, activeElementIsBody: false, disabled: false, sending: false }),
    ).toBe(false);
    expect(
      shouldRefocusComposer({ touchAffected: false, activeElementIsBody: true, disabled: true, sending: false }),
    ).toBe(false);
    expect(
      shouldRefocusComposer({ touchAffected: false, activeElementIsBody: true, disabled: false, sending: true }),
    ).toBe(false);
  });
});

describe('Composer dictation integration', () => {
  test('keeps the microphone absent when this page has no mediaDevices API', () => {
    const html = renderComposer({ onFiles: () => {} });
    expect(html).not.toContain('Dictate a message');
    expect(html).not.toContain('data-dictation-phase');
  });

  test('mounts a labelled 44px mic dialog-trigger beside Attach, collapsed at rest', () => {
    const html = renderComposerWithMicrophone({ compact: true, onFiles: () => {} });
    const attachAt = html.indexOf('aria-label="Attach images"');
    const dictateAt = html.indexOf('aria-label="Dictate a message"');
    expect(attachAt).toBeGreaterThan(-1);
    expect(dictateAt).toBeGreaterThan(attachAt);
    expectTouchTarget(buttonWithLabel(html, 'Dictate a message'));
    // The mic opens the modal — a dialog trigger, closed until tapped, with no
    // dialog markup or inline status band painted at rest.
    expect(buttonWithLabel(html, 'Dictate a message')).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('data-dictation-phase');
    expect(html).not.toContain('role="dialog"');
    expect(html.toLowerCase()).not.toContain('autofocus');
  });

  test('restores a dictated caret without requiring or invoking focus', () => {
    const selections: Array<[number, number]> = [];
    const input = {
      value: 'typed dictated tail',
      setSelectionRange(start: number, end: number) {
        selections.push([start, end]);
      },
    };
    expect(restoreComposerSelection(input, input.value, 15)).toBe(true);
    expect(selections).toEqual([[15, 15]]);
    expect(restoreComposerSelection(input, 'a stale draft', 2)).toBe(false);
    expect(selections).toEqual([[15, 15]]);
  });
});

describe('modality-specific hint copy', () => {
  test('touch and ambiguous states mention neither Enter nor Shift+Enter', () => {
    for (const state of [
      composerStatusCopy({ enterSends: false }),
      composerStatusCopy({ enterSends: false, busy: true }),
      composerStatusCopy({ enterSends: false, sending: true }),
    ]) {
      expect(`${state.liveText}${state.keyboardHint}`).not.toContain('Enter');
      expect(state.keyboardHint).toBe('');
    }
  });

  test('desktop keeps the send, queue, and Shift+Enter contracts', () => {
    expect(composerStatusCopy({ enterSends: true })).toEqual({
      liveText: 'Enter sends',
      keyboardHint: ' · Shift+Enter newline',
    });
    expect(composerStatusCopy({ enterSends: true, busy: true })).toEqual({
      liveText: 'Enter queues for the next turn',
      keyboardHint: ' · Shift+Enter newline',
    });
  });
});

describe('the mandatory touch send cluster', () => {
  const cases: Array<{
    name: string;
    props: Parameters<typeof renderComposer>[0];
    label: string;
    disabled: boolean;
    reason?: string;
  }> = [
    {
      name: 'empty',
      props: { draft: '' },
      label: 'Send this message',
      disabled: true,
      reason: 'Message is empty.',
    },
    {
      name: 'whitespace-only',
      props: { draft: '  \n ' },
      label: 'Send this message',
      disabled: true,
      reason: 'Message is empty.',
    },
    {
      name: 'structured-question disabled',
      props: { disabled: true },
      label: 'Send this message',
      disabled: true,
      reason: 'Answer the question above first.',
    },
    {
      name: 'sending in flight',
      props: { sending: true },
      label: 'Send this message',
      disabled: true,
      reason: 'Sending…',
    },
    {
      name: 'idle with text',
      props: {},
      label: 'Send this message',
      disabled: false,
    },
    {
      name: 'busy queue',
      props: { busy: true },
      label: 'Queue this message for the next turn',
      disabled: false,
    },
    {
      name: 'busy interrupt',
      props: { busy: true, onInterruptAndSend: () => {} },
      label: 'Interrupt the current turn and send this message now',
      disabled: false,
    },
    {
      name: 'busy while sending',
      props: { busy: true, sending: true, onInterruptAndSend: () => {} },
      label: 'Queue this message for the next turn',
      disabled: true,
      reason: 'Sending…',
    },
    {
      name: 'busy while disabled',
      props: { busy: true, disabled: true, onInterruptAndSend: () => {} },
      label: 'Queue this message for the next turn',
      disabled: true,
      reason: 'Answer the question above first.',
    },
  ];

  for (const row of cases) {
    test(`${row.name} has a visible labelled 44px control`, () => {
      const html = renderComposer(row.props);
      const button = buttonWithLabel(html, row.label);
      expectTouchTarget(button);
      expect(button.includes('disabled=""')).toBe(row.disabled);
      expect(button.includes('aria-disabled="true"')).toBe(row.disabled);
      expect(html).not.toContain('data-kb-hide');
      if (row.reason) {
        const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
        expect(describedBy).toBeDefined();
        expect(html).toContain(`id="${describedBy}"`);
        expect(html).toContain(row.reason);
      }
    });
  }

  // ICON-ONLY ON TOUCH (item 6). The rendered environment here is DOM-less, so
  // useInputModality resolves to the conservative touch state — every button
  // below is the touch form. Icon-only means VISUALLY icon-only: the word is
  // moved to `sr-only`, never removed, so `aria-label` + the hidden word keep
  // the control named in every state. A nameless icon button is a regression.
  test('touch Send is icon-only but keeps its accessible name', () => {
    const button = buttonWithLabel(renderComposer(), 'Send this message');
    expect(button).toContain('<span class="sr-only">Send</span>');
    expect(button).not.toContain('<span>Send</span>'); // no visible word on touch
    expect(button).toContain('<svg'); // the glyph carries the meaning
  });

  test('touch Queue is icon-only but keeps its accessible name', () => {
    const button = buttonWithLabel(renderComposer({ busy: true }), 'Queue this message for the next turn');
    expect(button).toContain('<span class="sr-only">Queue</span>');
    expect(button).not.toContain('<span>Queue</span>');
    expect(button).toContain('<svg');
  });

  test('Send and Queue use distinct glyphs so a phone reader can tell them apart', () => {
    const send = buttonWithLabel(renderComposer(), 'Send this message');
    const queue = buttonWithLabel(renderComposer({ busy: true }), 'Queue this message for the next turn');
    const glyphOf = (button: string) => button.match(/class="lucide[^"]*"/)?.[0];
    expect(glyphOf(send)).toBeDefined();
    expect(glyphOf(queue)).toBeDefined();
    expect(glyphOf(send)).not.toBe(glyphOf(queue));
  });

  test('touch Interrupt & send is icon-only but keeps its name and a distinguishing danger tone', () => {
    const html = renderComposer({ busy: true, onInterruptAndSend: () => {} });
    const button = buttonWithLabel(html, 'Interrupt the current turn and send this message now');
    // Icon-only on touch, like Send/Queue: the word is sr-only, never dropped.
    expect(button).toContain('<span class="sr-only">Interrupt &amp; send</span>');
    expect(button).not.toContain('<span>Interrupt &amp; send</span>');
    // Distinct from the safe Queue by tone AND glyph — the two phone signals.
    expect(button).toContain('data-variant="danger"');
    const queue = buttonWithLabel(html, 'Queue this message for the next turn');
    const glyphOf = (b: string) => b.match(/class="lucide[^"]*"/)?.[0];
    expect(glyphOf(button)).toBeDefined();
    expect(glyphOf(button)).not.toBe(glyphOf(queue));
  });

  test('busy touch controls stack vertically as icons', () => {
    const html = renderComposer({ compact: true, busy: true, onInterruptAndSend: () => {}, context: { model: 'm' } });
    // The container flanking the textarea is a column, not a row.
    expect(html).toContain('flex shrink-0 flex-col items-end');
  });

  test('busy interrupt preserves Queue as the safe Enter-equivalent action', () => {
    const html = renderComposer({ busy: true, onInterruptAndSend: () => {} });
    expectTouchTarget(buttonWithLabel(html, 'Interrupt the current turn and send this message now'));
    expectTouchTarget(buttonWithLabel(html, 'Queue this message for the next turn'));
  });

  test('attach and mic stack vertically on the touch dock', () => {
    const html = renderComposerWithMicrophone({ compact: true, onFiles: () => {}, context: { model: 'm' } });
    // Both controls share a flex-COLUMN container — the same stack as
    // Interrupt/Queue — instead of the old side-by-side row.
    const attachAncestors = ancestorsOfLabelledButton(html, 'Attach images');
    const micAncestors = ancestorsOfLabelledButton(html, 'Dictate a message');
    expect(attachAncestors.some(tag => tag.includes('flex-col') && tag.includes('items-end'))).toBe(true);
    expect(micAncestors.some(tag => tag.includes('flex-col') && tag.includes('items-end'))).toBe(true);
  });

  test('the touch dock reserves the interrupt row even when idle, so height cannot jump', () => {
    const openTag = (button: string) => button.slice(0, button.indexOf('>'));
    const label = 'Interrupt the current turn and send this message now';

    // Idle but interrupt-capable: the interrupt button IS present so its height
    // is reserved, but it is invisible, disabled and out of the a11y tree —
    // there is nothing to interrupt yet, and the box must not jump when there is.
    const idle = renderComposer({
      compact: true,
      onFiles: () => {},
      onInterruptAndSend: () => {},
      context: { model: 'm' },
    });
    const reserved = buttonWithLabel(idle, label);
    expect(openTag(reserved)).toContain('invisible');
    expect(openTag(reserved)).toContain('aria-hidden="true"');
    expect(openTag(reserved)).toContain('disabled=""');
    // Same 44px footprint as the active control, so the reserved box matches it
    // exactly in every theme (no magic pixel value, no separate spacer).
    expectTouchTarget(reserved);

    // Busy: the SAME row now carries the live, visible, interactive control.
    const busy = renderComposer({
      compact: true,
      busy: true,
      onFiles: () => {},
      onInterruptAndSend: () => {},
      context: { model: 'm' },
    });
    const active = buttonWithLabel(busy, label);
    expect(openTag(active)).not.toContain('invisible');
    expect(openTag(active)).not.toContain('aria-hidden');
    expect(openTag(active)).not.toContain('disabled=""');
  });

  test('a composer with no interrupt callback reserves no interrupt row', () => {
    // Reservation is scoped to composers that can actually interrupt; one that
    // never can renders no interrupt button at all, active or reserved.
    const html = renderComposer({ compact: true, onFiles: () => {}, context: { model: 'm' } });
    expect(html).not.toContain('Interrupt the current turn and send this message now');
  });

  test('touch-rendered copy contains no keyboard shortcut hint', () => {
    const html = renderComposer({ compact: true, context: { model: 'model' } });
    expect(html).not.toContain('Shift+Enter');
    expect(html).not.toContain('Enter sends');
    expect(html).toContain('data-kb-hide');
    const ancestors = ancestorsOfLabelledButton(html, 'Send this message');
    expect(ancestors.some(tag => tag.includes('data-kb-hide'))).toBe(false);
  });
});
