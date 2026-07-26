// THE SHELL-PRESERVING BOUNDARY, tested without a DOM.
//
// This file exists because of a measured production-shaped failure, not a
// hypothetical: Stage E's `drill-nocache.json` drove a real tab through four
// deploys, let the fourth prune the tab's generation, and recorded what the app
// did when the chat chunk went missing — `#root.children.length === 0`,
// `document.body.innerText === ""`, `chip: null`. React unmounted the entire
// root because nothing in the tree caught the render-time rethrow of a rejected
// `React.lazy`, and it took the recovery chip down with it. The whole point of
// `ChunkErrorBoundary` is that the shell survives that, so the assertions below
// are about the two facts that make it survive: a healthy child is passed
// through untouched, and a failed one is REPLACED — locally, with an honest
// offer — rather than propagated.
//
// WHY THERE IS NO `render()` INTO A DOCUMENT. This package has no DOM
// implementation and no testing library (see `useDialogFocus.test.ts`,
// `useServiceWorkerUpdate.test.ts` — the same discipline), and adding one is a
// dependency this change is not entitled to take. So the boundary is driven
// through React's own documented error contract instead — `getDerivedStateFromError`,
// then `componentDidCatch`, then a re-render — and the elements it returns are
// inspected as the plain objects they are. That covers everything except the
// one property only a real tree can show: that a caught error leaves SIBLING
// panes mounted. React guarantees it by construction (a boundary replaces its
// own subtree and nothing above it), the per-pane wiring is asserted here via
// `SafePane`, and the end-to-end proof is Stage E gate R4 (`rootChildren > 0`,
// `bodyText != ""` at the failure point).

import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { ChunkErrorBoundary, type ChunkErrorBoundaryProps } from './ChunkErrorBoundary';
import { SafePane } from '../App';

/* ---------- element inspection ---------------------------------------------
   React elements are plain objects (`type` + `props`), so walking one is
   reading React's own data structure rather than reimplementing a renderer.
   -------------------------------------------------------------------------- */

function* walk(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* walk((node.props as { children?: ReactNode }).children);
}

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | null {
  for (const element of walk(node)) if (match(element)) return element;
  return null;
}

function findAll(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement[] {
  return [...walk(node)].filter(match);
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/* ---------- boundary harness -----------------------------------------------
   Builds an instance and drives it the way React does. `state` is assigned
   directly because that is exactly what React does with whatever
   `getDerivedStateFromError` returns — going through `setState` would need a
   reconciler, and asserting against the real static keeps the two halves
   honest about each other.
   -------------------------------------------------------------------------- */

const CHILD = <div data-testid="pane-content">the conversation</div>;

function boundary(children: ReactNode = CHILD) {
  const caught: unknown[] = [];
  const reloads: number[] = [];
  const props: ChunkErrorBoundaryProps = {
    onChunkError: error => void caught.push(error),
    onReload: () => void reloads.push(1),
    children,
  };
  const instance = new ChunkErrorBoundary(props);
  // The class reads `this.props` in both `componentDidCatch` and `render`;
  // React assigns it, the constructor argument alone does not.
  (instance as unknown as { props: ChunkErrorBoundaryProps }).props = props;

  /** One caught error, in React's order: derive state, then report, then
   *  re-render. `console.warn` is captured rather than left to spray the test
   *  output, and returned so "the error is reported" is an assertion. */
  const crash = (error: unknown): { rendered: ReactNode; warnings: unknown[][] } => {
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      instance.state = ChunkErrorBoundary.getDerivedStateFromError();
      instance.componentDidCatch(error, { componentStack: '\n    at SessionChatPage' });
    } finally {
      console.warn = realWarn;
    }
    return { rendered: instance.render(), warnings };
  };

  return { instance, props, caught, reloads, render: () => instance.render(), crash };
}

/** The error the drill actually recorded. It is a TypeError whose message says
 *  nothing about chunks — which is why the boundary must not sniff messages. */
const REAL_DRILL_ERROR = new TypeError("Cannot read properties of undefined (reading 'SessionChatPage')");

/* ---------- U10: a healthy child is untouched ------------------------------ */

describe('a healthy child', () => {
  test('is returned by identity — the boundary adds no wrapper at all', () => {
    const b = boundary();
    // Not "renders something equivalent": the SAME node. A boundary that wraps
    // its child in a div on the happy path changes the pane's flex layout for
    // the entire life of the app in exchange for nothing.
    expect(b.render()).toBe(CHILD);
  });

  test('raises nothing and reloads nothing while it is healthy', () => {
    const b = boundary();
    b.render();
    expect([b.caught.length, b.reloads.length]).toEqual([0, 0]);
  });

  test('starts un-failed, so a fresh pane never opens on the fallback', () => {
    expect(boundary().instance.state).toEqual({ failed: false });
  });
});

/* ---------- U8: a failed child is replaced, locally ------------------------ */

describe('a caught error', () => {
  test('flips the boundary to failed', () => {
    // The state half of React's contract. Return `{ failed: false }` here and
    // the boundary catches the error and then renders the child that threw it.
    expect(ChunkErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  test('raises recovery exactly once, with the error itself', () => {
    const b = boundary();
    b.crash(REAL_DRILL_ERROR);
    expect(b.caught).toEqual([REAL_DRILL_ERROR]);
  });

  test('is reported to the console, not silently swallowed', () => {
    // A boundary that hides a genuine render bug is worse than the crash it
    // prevents, so the error and the component stack still reach dev surfaces.
    const b = boundary();
    const { warnings } = b.crash(REAL_DRILL_ERROR);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(REAL_DRILL_ERROR);
  });

  test('replaces the child with the recovery surface', () => {
    const b = boundary();
    const { rendered } = b.crash(REAL_DRILL_ERROR);
    // The child that threw must be gone — rendering it again re-throws, and
    // React tears the tree down for real the second time.
    expect(find(rendered, el => (el.props as { 'data-testid'?: string })['data-testid'] === 'pane-content')).toBeNull();
    expect(textOf(rendered)).toContain('Reload to recover');
  });

  test('announces itself as an alert, not as progress', () => {
    // `role="status"` is what the loading fallback uses. This is not progress:
    // a screen-reader user who gets "Loading conversation…" and then silence
    // has no way to know the pane is dead.
    const b = boundary();
    const { rendered } = b.crash(REAL_DRILL_ERROR);
    expect(find(rendered, el => (el.props as { role?: string }).role === 'alert')).not.toBeNull();
    expect(find(rendered, el => (el.props as { role?: string }).role === 'status')).toBeNull();
  });

  test('names no cause, because it catches errors that have other causes', () => {
    // The boundary is deliberately catch-all, so "removed by a newer deploy"
    // would be a confident lie whenever the error is an ordinary render bug.
    const b = boundary();
    const copy = textOf(b.crash(REAL_DRILL_ERROR).rendered);
    expect(copy).toContain('This page failed to load');
    expect(copy.toLowerCase()).not.toContain('deploy');
  });
});

/* ---------- the catch-all decision is load-bearing ------------------------- */

describe('what the boundary accepts', () => {
  // THIS IS THE WHOLE REASON MESSAGE-SNIFFING WAS REJECTED. Because
  // `startPreloadErrorWatch` calls preventDefault(), Vite resolves the failed
  // import with `undefined` and the error that reaches React is a TypeError
  // about a property name. A boundary that only caught /dynamically imported/
  // would rethrow the one error it was written for, and the root would unmount
  // exactly as it did in the drill.
  test('catches the TypeError the drill actually produced, whose message never says "chunk"', () => {
    expect(REAL_DRILL_ERROR.message).not.toContain('dynamically imported');
    expect(REAL_DRILL_ERROR.message).not.toContain('chunk');

    const b = boundary();
    const { rendered } = b.crash(REAL_DRILL_ERROR);
    expect(b.caught).toEqual([REAL_DRILL_ERROR]);
    expect(textOf(rendered)).toContain('Reload to recover');
  });

  test('catches a plain render bug too, and still offers the reload', () => {
    const b = boundary();
    const bug = new Error('cannot read properties of null (reading map)');
    const { rendered } = b.crash(bug);
    expect(b.caught).toEqual([bug]);
    expect(find(rendered, el => el.type === 'button')).not.toBeNull();
  });
});

/* ---------- U9: the fallback button reuses the guarded apply path ---------- */

describe('the fallback button', () => {
  function pressed() {
    const b = boundary();
    const { rendered } = b.crash(REAL_DRILL_ERROR);
    const button = find(rendered, el => el.type === 'button');
    return { b, button };
  }

  test('is the ONLY control, and it is a real button', () => {
    const { rendered } = boundary().crash(REAL_DRILL_ERROR);
    expect(findAll(rendered, el => el.type === 'button')).toHaveLength(1);
    // `type="button"` because a bare <button> inside a form submits it.
    expect(find(rendered, el => el.type === 'button')?.props).toMatchObject({ type: 'button' });
  });

  test('calls the injected onReload — it does NOT reload on its own', () => {
    // Identity, not behaviour-alike. `onReload` is the hook's `applyUpdate`,
    // whose no-waiter branch is armed once per press and posts no SKIP_WAITING
    // to a registration that has no waiter (see useServiceWorkerUpdate.test.ts).
    // An inlined `window.location.reload()` here would look identical in a
    // browser and quietly lose the guard, the branch and the reload-loop
    // protection all at once.
    const { b, button } = pressed();
    expect((button?.props as { onClick?: unknown }).onClick).toBe(b.props.onReload);
  });

  test('presses through to exactly one reload per press', () => {
    const { b, button } = pressed();
    const onClick = (button?.props as { onClick: () => void }).onClick;
    onClick();
    expect(b.reloads).toHaveLength(1);
    // Two presses reach `applyUpdate` twice; collapsing them to one action is
    // the armed guard's job, one layer down, where it is already asserted.
    onClick();
    expect(b.reloads).toHaveLength(2);
  });
});

/* ---------- M7: the boundary is actually IN the pane tree ------------------ */

describe('SafePane wiring', () => {
  const MARKER = <div data-testid="pane-child" />;

  function pane() {
    const raised: unknown[] = [];
    const reloads: number[] = [];
    const tree = SafePane({
      active: true,
      onChunkError: error => void raised.push(error),
      onReload: () => void reloads.push(1),
      children: MARKER,
    });
    return { tree, raised, reloads };
  }

  // THE MUTATION GATE (plan M7). Drop `<ChunkErrorBoundary>` out of `SafePane`
  // and this fails immediately: the pane's child becomes the page itself, and
  // the app is back to the drill's blank root.
  test('every pane child is wrapped in a boundary', () => {
    const { tree } = pane();
    const boundaryEl = find(tree, el => el.type === ChunkErrorBoundary);
    expect(boundaryEl).not.toBeNull();
    expect((boundaryEl?.props as { children?: ReactNode }).children).toBe(MARKER);
  });

  test('the boundary sits INSIDE the pane, not around it', () => {
    // Outside the pane, a failure would take the pane's positioning and
    // visibility with it; the fallback would render in the wrong place, or on
    // top of the pane the reader is actually looking at.
    const { tree } = pane();
    expect(tree.type).not.toBe(ChunkErrorBoundary);
    expect((tree.props as { children?: ReactNode }).children).toBe(find(tree, el => el.type === ChunkErrorBoundary));
  });

  test('exactly one boundary per pane', () => {
    expect(findAll(pane().tree, el => el.type === ChunkErrorBoundary)).toHaveLength(1);
  });

  test('threads the recovery raise and the apply path through unchanged', () => {
    const { tree, raised, reloads } = pane();
    const props = find(tree, el => el.type === ChunkErrorBoundary)?.props as ChunkErrorBoundaryProps;
    props.onChunkError(REAL_DRILL_ERROR);
    props.onReload();
    expect([raised, reloads.length]).toEqual([[REAL_DRILL_ERROR], 1]);
  });

  test('passes `active` down so a retained hidden pane stays hidden', () => {
    // The boundary must not disturb the mounted-pane cache: a pane that is
    // mounted-but-inactive is how drafts, scroll and transcripts survive
    // navigation (App.tsx's MAX_MOUNTED_SESSIONS).
    const tree = SafePane({ active: false, onChunkError: () => {}, onReload: () => {}, children: MARKER });
    expect((tree.props as { active?: boolean }).active).toBe(false);
  });
});
