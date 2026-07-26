// THE CHIP'S WORDING, which is a correctness property rather than copy.
//
// The chip is ONE of the recovery surfaces — the pane fallback is another, and
// a compact session route on a phone shows its own band instead — so what has
// to hold here is that the chip's own two wordings are true whenever the chip
// is the surface a reader gets. Recovery has several causes that the chip
// cannot tell apart: `startPreloadErrorWatch` is unconditional, so any preload
// or network failure raises it with no deploy involved, and `ChunkErrorBoundary`
// adds one more by catching every render error on purpose. So the recovery
// title has to fit all of them, which means naming none.
//
// Only the strings are asserted here, not the component: `AppBar` calls
// `useFleet()`, so rendering it needs a React tree, and this package has no DOM
// implementation — adding one for a tooltip would be far more machinery than
// the thing it guards. Lifting the two wordings into `UPDATE_CHIP` is what
// makes them checkable at all, and it is also what keeps the JSX from carrying
// a second, drifting copy.

import { describe, expect, test } from 'bun:test';
import { UPDATE_CHIP } from './AppBar';
import type { UpdateReason } from '../hooks/useServiceWorkerUpdate';

/** Words that assert a REASON the app cannot know at chip time. A title
 *  containing one of these is claiming to know why the tab broke. */
const CAUSE_CLAIMS = ['deploy', 'version', 'release', 'update'];

describe('the recovery wording', () => {
  test('names no cause, because recovery is not only raised by a deploy', () => {
    const title = UPDATE_CHIP.recovery.title.toLowerCase();
    for (const claim of CAUSE_CLAIMS) expect(title).not.toContain(claim);
  });

  test('still says what happened and what to do about it', () => {
    // Cause-neutral must not decay into contentless. These two facts hold on
    // every path that raises recovery, and they are the only two the reader
    // needs: this tab is broken, and reloading is the fix.
    expect(UPDATE_CHIP.recovery.title).toBe('This tab could not load part of the app. Reload to recover.');
  });

  test('keeps the visible label', () => {
    // The label is what a reader scans for and what the Stage E drill matches
    // on; the title fix must not move it.
    expect(UPDATE_CHIP.recovery.label).toBe('Reload to recover');
  });
});

describe('the update wording', () => {
  // Untouched, and it SHOULD name a version — that chip really is raised by one
  // specific thing (a newer worker finished installing and is waiting).
  test('is unchanged, cause and all', () => {
    expect(UPDATE_CHIP.update).toEqual({
      label: 'Update ready — reload',
      title: 'A newer version of Kteam is installed and ready. Reload to use it.',
    });
  });
});

describe('the two chips stay two different statements', () => {
  test('every reason has a label and a title, and none are shared', () => {
    // A single wording for both would tell a stuck reader their tab is fine,
    // or tell someone with a routine offer that their tab is broken.
    const reasons: UpdateReason[] = ['update', 'recovery'];
    for (const reason of reasons) {
      expect(UPDATE_CHIP[reason].label.length).toBeGreaterThan(0);
      expect(UPDATE_CHIP[reason].title.length).toBeGreaterThan(0);
    }
    expect(UPDATE_CHIP.update.label).not.toBe(UPDATE_CHIP.recovery.label);
    expect(UPDATE_CHIP.update.title).not.toBe(UPDATE_CHIP.recovery.title);
  });
});
