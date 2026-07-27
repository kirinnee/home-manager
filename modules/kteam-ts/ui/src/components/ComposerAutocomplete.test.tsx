import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AUTOCOMPLETE_LIST_MAX_HEIGHT,
  AUTOCOMPLETE_TAP_SLOP_PX,
  ComposerAutocompletePopover,
  autocompleteEmptyCopy,
  createRowPointerHandlers,
  preventAutocompletePointerFocus,
} from './ComposerAutocomplete';
import type {
  ComposerAutocompleteCandidate,
  ComposerAutocompleteController,
  ComposerAutocompleteProvider,
} from './composer-autocomplete-engine';

const provider: ComposerAutocompleteProvider = {
  id: 'skills:test',
  trigger: '/',
  label: 'Skills',
  candidates: () => ({ candidates: [] }),
};

const skill: ComposerAutocompleteCandidate = {
  id: 'skill:summary',
  kind: 'skill',
  label: 'summary',
  detail: 'Give a fast recap',
  replacement: '/summary',
};

function controller(patch: Partial<ComposerAutocompleteController> = {}): ComposerAutocompleteController {
  return {
    open: true,
    status: 'ready',
    provider,
    match: { trigger: '/', query: '', start: 0, end: 1, caret: 1 },
    candidates: [skill],
    activeIndex: 0,
    activeId: 'composer-list-option-0',
    listboxId: 'composer-list',
    blocksRefocus: true,
    syncSelection: () => undefined,
    handleKeyDown: () => false,
    accept: () => undefined,
    close: () => undefined,
    textareaAria: {},
    ...patch,
  } as ComposerAutocompleteController;
}

/** Strip comments so a source assertion tests CODE rather than prose.
 *
 *  These invariants (no focus, no timer, no second accept path, no scroll-jack)
 *  are worth guarding at the source level, but a raw grep cannot tell a call
 *  from the comment explaining why the call was avoided — so documenting the
 *  decision would break the very test that protects it. Two teammates hit
 *  exactly that while running their gates. Strip first, then match. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ComposerAutocompletePopover', () => {
  test('opens above the composer as an active-descendant listbox', () => {
    const html = renderToStaticMarkup(<ComposerAutocompletePopover controller={controller()} />);
    expect(html).toContain('bottom-[calc(100%+var(--gap-xs))]');
    expect(html).toContain('data-composer-autocomplete="skills"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="composer-list"');
    expect(html).toContain('role="option"');
    expect(html).toContain('id="composer-list-option-0"');
    expect(html).toContain('aria-selected="true"');
    // The textarea owns focus; options are not even programmatically tabbed.
    expect(html).not.toContain('tabindex=');
  });

  test('every candidate and every status row has a 44px touch floor', () => {
    const option = renderToStaticMarkup(<ComposerAutocompletePopover controller={controller()} />);
    const loading = renderToStaticMarkup(
      <ComposerAutocompletePopover controller={controller({ status: 'loading', candidates: [], activeIndex: -1 })} />,
    );
    const empty = renderToStaticMarkup(
      <ComposerAutocompletePopover controller={controller({ candidates: [], activeIndex: -1, activeId: undefined })} />,
    );
    expect(option).toContain('min-h-[44px]');
    expect(loading).toContain('min-h-[44px]');
    expect(empty).toContain('min-h-[44px]');
  });

  test('the trigger alone with zero results renders a named zero state', () => {
    const html = renderToStaticMarkup(
      <ComposerAutocompletePopover controller={controller({ candidates: [], activeIndex: -1, activeId: undefined })} />,
    );
    expect(html).toContain('No matching skills');
    expect(html).toContain('role="status"');
    expect(autocompleteEmptyCopy('Files')).toBe('No matching files');
  });

  test('loading, error, refused, and bounded-list states remain explicit', () => {
    const loading = renderToStaticMarkup(
      <ComposerAutocompletePopover controller={controller({ status: 'loading', candidates: [], activeIndex: -1 })} />,
    );
    expect(loading).toContain('Loading skills');

    const error = renderToStaticMarkup(
      <ComposerAutocompletePopover
        controller={controller({ status: 'error', candidates: [], activeIndex: -1, error: 'daemon offline' })}
      />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('daemon offline');

    const refused = renderToStaticMarkup(
      <ComposerAutocompletePopover
        controller={controller({
          provider: { ...provider, trigger: '@', label: 'Files' },
          match: { trigger: '@', query: '', start: 0, end: 1, caret: 1 },
          candidates: [
            {
              id: 'file:.env',
              kind: 'file',
              label: '.env',
              detail: 'secret',
              replacement: '@.env',
              disabled: true,
              disabledReason: 'blocked by the repository secrets policy',
            },
          ],
          activeIndex: -1,
          activeId: undefined,
          notice: '2,000 entries shown — refine this segment.',
        })}
      />,
    );
    expect(refused).toContain('aria-disabled="true"');
    expect(refused).toContain('blocked by the repository secrets policy');
    expect(refused).toContain('2,000 entries shown');
  });

  test('pointer-down prevents focus transfer', () => {
    let prevented = 0;
    preventAutocompletePointerFocus({ preventDefault: () => prevented++ });
    expect(prevented).toBe(1);
  });

  describe('row pointer contract', () => {
    const at = (x: number, y: number, pointerId = 1) => ({ pointerId, clientX: x, clientY: y });

    test('down holds focus and accepts NOTHING; up is what accepts, exactly once', () => {
      const accepted: number[] = [];
      let prevented = 0;
      const row = createRowPointerHandlers(3, index => accepted.push(index));

      row.onPointerDown({ ...at(10, 10), preventDefault: () => prevented++ });
      // The whole point: focus is held on pointerdown, but nothing is chosen
      // yet, so a flick that starts on a row can still become a scroll.
      expect(prevented).toBe(1);
      expect(accepted).toEqual([]);

      row.onPointerUp(at(12, 13));
      expect(accepted).toEqual([3]);

      // There is no onClick to fire afterwards, and a second up has no origin.
      row.onPointerUp(at(12, 13));
      expect(accepted).toEqual([3]);
    });

    test('a scroll gesture selects nothing', () => {
      const accepted: number[] = [];
      const row = createRowPointerHandlers(0, index => accepted.push(index));
      row.onPointerDown({ ...at(10, 10), preventDefault: () => {} });
      row.onPointerUp(at(10, 10 + AUTOCOMPLETE_TAP_SLOP_PX + 1));
      expect(accepted).toEqual([]);
    });

    test('the browser taking the gesture over for a pan cancels the accept', () => {
      const accepted: number[] = [];
      const row = createRowPointerHandlers(0, index => accepted.push(index));
      row.onPointerDown({ ...at(10, 10), preventDefault: () => {} });
      row.onPointerCancel();
      row.onPointerUp(at(10, 10));
      expect(accepted).toEqual([]);
    });

    test('a different finger lifting over this row accepts nothing', () => {
      const accepted: number[] = [];
      const row = createRowPointerHandlers(0, index => accepted.push(index));
      row.onPointerDown({ ...at(10, 10, 1), preventDefault: () => {} });
      row.onPointerUp(at(10, 10, 2));
      expect(accepted).toEqual([]);
    });

    test('an up with no preceding down accepts nothing', () => {
      const accepted: number[] = [];
      createRowPointerHandlers(0, index => accepted.push(index)).onPointerUp(at(10, 10));
      expect(accepted).toEqual([]);
    });
  });

  test('status rows are SIBLINGS of the listbox, never options inside it', () => {
    // A listbox may only own option/group children. When the honest zero state
    // lived inside it, screen readers dropped the one row that exists to say
    // there is nothing to offer.
    for (const patch of [
      { candidates: [], activeIndex: -1, activeId: undefined },
      { status: 'loading' as const, candidates: [], activeIndex: -1, activeId: undefined },
      { status: 'error' as const, candidates: [], activeIndex: -1, activeId: undefined },
    ]) {
      const html = renderToStaticMarkup(<ComposerAutocompletePopover controller={controller(patch)} />);
      expect(html).not.toContain('role="listbox"');
    }
    // With real options the listbox exists and owns only options.
    const withOptions = renderToStaticMarkup(<ComposerAutocompletePopover controller={controller()} />);
    expect(withOptions).toContain('role="listbox"');
    expect(withOptions.slice(withOptions.indexOf('role="listbox"'))).not.toContain('role="status"');
  });

  test('the scroller keeps native vertical panning and indexes its rows', () => {
    const html = renderToStaticMarkup(<ComposerAutocompletePopover controller={controller()} />);
    // Rows preventDefault their pointerdown, so without an explicit
    // touch-action a thumb flick over a row would do nothing at all.
    expect(html).toContain('touch-action:pan-y');
    // The scroll-into-view effect finds rows by index, not by global id.
    expect(html).toContain('data-index="0"');
  });

  test('mobile height follows the visual app viewport and never subtracts the iOS keyboard twice', () => {
    expect(AUTOCOMPLETE_LIST_MAX_HEIGHT).toContain('var(--app-h');
    expect(AUTOCOMPLETE_LIST_MAX_HEIGHT).not.toContain('--kb-h');
    expect(AUTOCOMPLETE_LIST_MAX_HEIGHT).toContain('220px');
  });

  // The integration lives in Composer.tsx, which is contended and edited from a
  // patch document rather than here. These assertions pin the exact surface that
  // patch consumes, so if the controller shape drifts the break shows up in a
  // file the autocomplete owner can actually fix.
  describe('integration contract consumed by Composer.tsx', () => {
    test('the textarea only needs three members, and they type-check as a Pick', () => {
      const full = controller({
        textareaAria: {
          'aria-autocomplete': 'list',
          'aria-controls': 'composer-list',
          'aria-expanded': true,
          'aria-activedescendant': 'composer-list-option-0',
          'aria-haspopup': 'listbox',
        },
      });
      const forTextarea: Pick<ComposerAutocompleteController, 'handleKeyDown' | 'syncSelection' | 'textareaAria'> =
        full;

      // handleKeyDown MUST report whether it consumed the key. Composer relies
      // on the boolean to early-return, or Enter would accept a candidate and
      // send the message in one keystroke.
      const consumed: boolean = forTextarea.handleKeyDown(
        {} as Parameters<ComposerAutocompleteController['handleKeyDown']>[0],
      );
      expect(typeof consumed).toBe('boolean');

      const html = renderToStaticMarkup(<textarea readOnly value="" {...forTextarea.textareaAria} />);
      expect(html).toContain('aria-controls="composer-list"');
      expect(html).toContain('aria-activedescendant="composer-list-option-0"');
      expect(html).toContain('aria-haspopup="listbox"');
    });

    test('a closed controller contributes no aria, so a plain composer stays plain', () => {
      const html = renderToStaticMarkup(
        <textarea readOnly value="" {...controller({ open: false, textareaAria: {} }).textareaAria} />,
      );
      expect(html).not.toContain('aria-');
    });
  });

  test('closed controllers render no empty shell', () => {
    expect(renderToStaticMarkup(<ComposerAutocompletePopover controller={controller({ open: false })} />)).toBe('');
  });

  test('implementation has no focus call, timer, second accept path, or scroll-jack', async () => {
    const [popoverSource, engineSource] = await Promise.all([
      Bun.file(new URL('./ComposerAutocomplete.tsx', import.meta.url)).text(),
      Bun.file(new URL('./composer-autocomplete-engine.ts', import.meta.url)).text(),
    ]);
    const popover = codeOnly(popoverSource);
    const engine = codeOnly(engineSource);

    // Focus: the bug that cost this session four rounds. Moving focus here
    // closes a phone keyboard and destroys a held transcript selection.
    expect(popover).not.toMatch(/\.focus\s*\(/);
    expect(engine).not.toMatch(/\.focus\s*\(/);

    // Timers: a popover that re-renders on a schedule fights the reader typing.
    for (const timer of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
      expect(popover).not.toContain(`${timer}(`);
      expect(engine).not.toContain(`${timer}(`);
    }

    // Accept lives on pointerup. An onClick would be a SECOND accept path on
    // desktop and a silently missing one on the phones that suppress the
    // compatibility click after a prevented pointerdown.
    expect(popover).not.toMatch(/onClick\s*=/);

    // scrollIntoView walks up and scrolls EVERY scrollable ancestor, so
    // arrowing through rows would also drag the transcript behind the popover.
    expect(popover).not.toMatch(/scrollIntoView/);
  });
});
