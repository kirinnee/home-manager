import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BrowseList,
  ChangeIndicator,
  DiffBody,
  FileBody,
  FilesTab,
  OpenFileTabs,
  SourceLines,
  changeDescription,
  entryRefusal,
  fileRefusal,
  readFilesTabState,
  resetFilesTabStates,
  scrollFileLineIntoView,
} from './FilesTab';
import { loadFsChanges, resetFsProbes } from './files-api';
import type { FsChanges, FsEntry, FsFile } from './files-api';
import { parseUnifiedDiff } from './files-model';

const realFetch = globalThis.fetch;

/** Seed the shared probe cache with one `fs/changes` answer, so the tab can be
 *  rendered against a REAL snapshot instead of a hand-built prop. */
async function seedProbe(sessionId: string, body: FsChanges): Promise<void> {
  resetFsProbes();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  await loadFsChanges(sessionId, true);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetFsProbes();
  resetFilesTabStates();
});

const entry = (over: Partial<FsEntry> & { name: string }): FsEntry => ({ type: 'file', ...over });

/** Built at runtime: a literal backslash or control byte in a source file does
 *  not survive editors and formatters reliably, and these bytes ARE the test. */
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

type ElementLike = { type?: unknown; props?: Record<string, unknown> };
type Effect = { deps: readonly unknown[] | undefined; create: () => void | (() => void); cleanup?: () => void };

function visit(node: unknown, predicate: (element: ElementLike) => boolean): ElementLike | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = visit(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const element = node as ElementLike;
  if (predicate(element)) return element;
  return visit(element.props?.children, predicate);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

const reactInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** The UI suite deliberately has no DOM dependency. This is the same small
 *  hook harness used by the browser/terminal lifecycle suites: it mounts the
 *  shipping FilesTab function, runs effects, and lets the test drive the real
 *  callbacks while async fetches resolve in controlled order. */
class HookHarness {
  private slots: unknown[] = [];
  private effects = new Map<number, Effect>();
  private pendingEffects: number[] = [];
  private index = 0;
  private queued = false;
  private tree: unknown;
  private renderComponent: (() => unknown) | null = null;

  constructor(private readonly assignRefs: (tree: unknown) => void) {}

  useState<T>(initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
    const index = this.index++;
    if (!(index in this.slots)) this.slots[index] = initial;
    const setState: React.Dispatch<React.SetStateAction<T>> = value => {
      const current = this.slots[index] as T;
      this.slots[index] = typeof value === 'function' ? (value as (previous: T) => T)(current) : value;
      this.schedule();
    };
    return [this.slots[index] as T, setState];
  }

  useRef<T>(initial: T): React.RefObject<T> {
    const index = this.index++;
    if (!(index in this.slots)) this.slots[index] = { current: initial };
    return this.slots[index] as React.RefObject<T>;
  }

  useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
    const index = this.index++;
    const previous = this.slots[index] as { value: T; deps: readonly unknown[] } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => value === previous.deps[i]))
      return previous.value;
    const value = factory();
    this.slots[index] = { value, deps };
    return value;
  }

  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T {
    return this.useMemo(() => callback, deps);
  }

  useEffect(create: () => void | (() => void), deps: readonly unknown[] | undefined): void {
    const index = this.index++;
    const previous = this.effects.get(index);
    const changed =
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => value !== previous.deps?.[i]);
    this.effects.set(index, { deps, create, cleanup: previous?.cleanup });
    if (changed) this.pendingEffects.push(index);
  }

  useSyncExternalStore<T>(getSnapshot: () => T): T {
    this.index += 1;
    const snapshot = getSnapshot();
    // Exercise the keyboard-focus policy without inventing a viewport. This is
    // the input-modality store's distinctive snapshot shape; fs-probe snapshots
    // pass through unchanged.
    if (snapshot && typeof snapshot === 'object' && 'touchAffected' in snapshot)
      return { ...(snapshot as object), touchAffected: false } as T;
    return snapshot;
  }

  render(renderComponent: () => unknown): void {
    this.renderComponent = renderComponent;
    this.index = 0;
    this.pendingEffects = [];
    const previousDispatcher = reactInternals.H;
    reactInternals.H = {
      useState: <T,>(initial: T) => this.useState(initial),
      useRef: <T,>(initial: T) => this.useRef(initial),
      useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => this.useMemo(factory, deps),
      useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
        this.useCallback(callback, deps),
      useEffect: (create: () => void | (() => void), deps?: readonly unknown[]) => this.useEffect(create, deps),
      useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => this.useSyncExternalStore(getSnapshot),
    };
    try {
      this.tree = renderComponent();
    } finally {
      reactInternals.H = previousDispatcher;
    }
    this.assignRefs(this.tree);
    for (const index of this.pendingEffects) {
      const effect = this.effects.get(index)!;
      effect.cleanup?.();
      effect.cleanup = effect.create() || undefined;
    }
  }

  get output(): unknown {
    return this.tree;
  }

  unmount(): void {
    this.renderComponent = null;
    for (const effect of this.effects.values()) effect.cleanup?.();
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.renderComponent) this.render(this.renderComponent);
    });
  }
}

describe('change indicators', () => {
  test('a dot plus exact green/red counts replaces the separate changes row', () => {
    const change = { path: 'src/app.ts', status: ' M', additions: 12, deletions: 3 };
    const html = renderToStaticMarkup(<ChangeIndicator change={change} />);
    expect(html).toContain('kt-fs-change-dot');
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain('>+12</span>');
    expect(html).toContain('>−3</span>');
    expect(html).toContain('aria-label="Modified (unstaged) · +12 · −3"');
    expect(changeDescription(change)).toBe('Modified (unstaged) · +12 · −3');
  });

  test('untracked files keep an honest plus without inventing an unavailable count', () => {
    const html = renderToStaticMarkup(<ChangeIndicator change={{ path: 'new.txt', status: '??' }} />);
    expect(html).toContain('aria-label="Untracked"');
    expect(html).toContain('data-kind="add"');
    expect(html).toContain('>+</span>');
    expect(html).not.toContain('+0');
  });
});

describe('browse list', () => {
  const listing = {
    entries: [
      entry({ name: 'README.md', size: 2048 }),
      entry({ name: 'src', type: 'dir' }),
      entry({ name: '.env', denied: true }),
      entry({ name: 'node_modules', type: 'dir', denied: true }),
      entry({ name: 'dist', type: 'dir', ignored: true }),
      entry({ name: 'outside', type: 'symlink', escapes: true }),
      entry({ name: 'inside-link', type: 'symlink' }),
    ],
  };

  test('directories sort first and files carry their size', () => {
    const html = renderToStaticMarkup(<BrowseList listing={listing} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
    expect(html.indexOf('src/')).toBeLessThan(html.indexOf('README.md'));
    expect(html).toContain('2.0 KB');
  });

  test('change counts sit on the filename and opening still means opening the file', () => {
    const changes = new Map([['README.md', { path: 'README.md', status: ' M', additions: 4, deletions: 2 }]]);
    const html = renderToStaticMarkup(
      <BrowseList listing={listing} dir="" changes={changes} onEnter={() => {}} onOpenFile={() => {}} />,
    );
    expect(html).toContain('kt-fs-name-line');
    expect(html).toContain('>+4</span>');
    expect(html).toContain('>−2</span>');
    expect(html).toContain('aria-label="Open file README.md, 2.0 KB, Modified (unstaged) · +4 · −2"');
    expect(html).not.toContain('Open diff');
  });

  test('a refused entry is an inert row that says why — never a button that fails', () => {
    const html = renderToStaticMarkup(<BrowseList listing={listing} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
    expect(html).toContain('not served — denylisted (secrets policy)');
    expect(html).toContain('symlink leaves this session’s folder — not served');
    expect(html).toContain('gitignored — content is not served');
    expect(html).toContain('symlink — listed only, not served');
    // README.md + src/ are the only openable entries.
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/data-inert="true"/g)).toHaveLength(5);
  });

  test('a denied or ignored DIRECTORY cannot be descended into either', () => {
    const html = renderToStaticMarkup(<BrowseList listing={listing} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
    expect(html).not.toContain('aria-label="Open folder node_modules"');
    expect(html).not.toContain('aria-label="Open folder dist"');
    expect(html).toContain('aria-label="Open folder src"');
  });

  test('a subdirectory offers the parent, the root does not', () => {
    const nested = renderToStaticMarkup(
      <BrowseList listing={listing} dir="a/b" onEnter={() => {}} onOpenFile={() => {}} />,
    );
    expect(nested).toContain('aria-label="Up to a"');
    const root = renderToStaticMarkup(<BrowseList listing={listing} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
    expect(root).not.toContain('Up to');
  });

  test('an empty folder says so at any depth', () => {
    const deep = renderToStaticMarkup(
      <BrowseList listing={{ entries: [] }} dir="a/b" onEnter={() => {}} onOpenFile={() => {}} />,
    );
    expect(deep).toContain('This folder is empty.');
    expect(deep).toContain('aria-label="Up to a"');
  });

  test('a truncated listing admits it', () => {
    const html = renderToStaticMarkup(
      <BrowseList listing={{ entries: [], truncated: true }} dir="" onEnter={() => {}} onOpenFile={() => {}} />,
    );
    expect(html).toContain('Listing truncated by the daemon');
  });

  test('an entry name outside the daemon’s grammar is inert, not a broken button', () => {
    const hostile = {
      entries: [
        entry({ name: `a${BACKSLASH}b.ts`, size: 10 }),
        entry({ name: `line${NEWLINE}break.ts` }),
        entry({ name: 'weird', type: 'dir' as const }),
        entry({ name: 'fine.ts' }),
      ],
    };
    const html = renderToStaticMarkup(
      <BrowseList listing={hostile} dir="src" onEnter={() => {}} onOpenFile={() => {}} />,
    );
    // `weird/`, `fine.ts` and the `..` row are the only controls.
    expect(html.match(/data-inert="true"/g)).toHaveLength(2);
    expect(html.match(/name cannot be opened by this viewer/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Open file fine.ts"');
    // The name is printed as the daemon listed it, never as `a/b.ts`.
    expect(html).toContain(`a${BACKSLASH}b.ts`);
    expect(html).not.toContain('aria-label="Open file a');
  });

  test('refusal precedence: the strongest reason wins', () => {
    expect(entryRefusal(entry({ name: 'x', denied: true, ignored: true }))).toContain('denylisted');
    // A secret keeps its own reason; anything else unaddressable gets the name
    // reason before the softer symlink/gitignore ones.
    expect(entryRefusal(entry({ name: `.env${BACKSLASH}x`, denied: true }))).toContain('denylisted');
    expect(entryRefusal(entry({ name: `a${BACKSLASH}b`, ignored: true }))).toContain('cannot be opened');
    expect(entryRefusal(entry({ name: `l${NEWLINE}n`, type: 'symlink' }))).toContain('cannot be opened');
    expect(entryRefusal(entry({ name: '..' }))).toContain('cannot be opened');
    expect(entryRefusal(entry({ name: 'x', type: 'symlink', escapes: true }))).toContain('leaves');
    expect(entryRefusal(entry({ name: 'x', type: 'symlink' }))).toContain('listed only');
    expect(entryRefusal(entry({ name: 'x' }))).toBeNull();
    expect(entryRefusal(entry({ name: 'x', type: 'dir' }))).toBeNull();
  });
});

describe('diff view', () => {
  const diff = [
    '@@ -1,3 +1,3 @@',
    ' keep me',
    '-const secret = "<script>alert(1)</script>";',
    '+const secret = "redacted";',
  ].join('\n');

  test('added and removed lines carry a glyph as well as a tint', () => {
    const html = renderToStaticMarkup(<DiffBody parsed={parseUnifiedDiff(diff)} />);
    expect(html).toContain('data-kind="add"');
    expect(html).toContain('data-kind="del"');
    expect(html).toContain('>+</span>');
    expect(html).toContain('>-</span>');
    expect(html).toContain('data-kind="hunk"');
  });

  test('gutters are decoration for AT and carry both sides for the eye', () => {
    const html = renderToStaticMarkup(<DiffBody parsed={parseUnifiedDiff(diff)} />);
    expect(html.match(/kt-fs-gutter/g)!.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('aria-hidden="true"');
  });

  test('diff content is escaped — a repo cannot inject markup through its own source', () => {
    const html = renderToStaticMarkup(<DiffBody parsed={parseUnifiedDiff(diff)} />);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('git plumbing headers are parsed but not printed — a phone screen is 4 lines shorter', () => {
    const withHeaders = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const html = renderToStaticMarkup(<DiffBody parsed={parseUnifiedDiff(withHeaders)} />);
    expect(html).not.toContain('diff --git');
    expect(html).not.toContain('index 1111111');
    expect(html).not.toContain('+++ b/src/app.ts');
    expect(html).toContain('@@ -1 +1 @@');
    expect(html).toContain('new');
  });

  test('meta that carries real information is kept', () => {
    const rename = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 96%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    const html = renderToStaticMarkup(<DiffBody parsed={parseUnifiedDiff(rename)} />);
    expect(html).toContain('rename from old.ts');
    expect(html).toContain('rename to new.ts');
    expect(html).toContain('similarity index 96%');
    expect(html).not.toContain('diff --git');
  });

  test('the diff scrolls inside its own container', () => {
    const html = renderToStaticMarkup(<DiffBody parsed={parseUnifiedDiff(diff)} />);
    expect(html).toContain('kt-fs-code');
  });
});

describe('file view', () => {
  const file = (over: Partial<FsFile>): FsFile => ({ path: 'a.ts', ...over });

  test('each daemon refusal is explained, in precedence order', () => {
    expect(fileRefusal(file({ denied: true }))).toContain('denylist');
    expect(fileRefusal(file({ ignored: true }))).toContain('gitignored');
    expect(fileRefusal(file({ tooLarge: true, size: 2_200_000 }))).toContain('2.1 MB');
    expect(fileRefusal(file({ binary: true }))).toContain('binary');
    expect(fileRefusal(file({ content: 'ok' }))).toBeNull();
    // An ignored file the daemon DID serve (it may relax the gate) is shown.
    expect(fileRefusal(file({ ignored: true, content: 'x' }))).toBeNull();
  });

  test('a refusal renders as a note, never as an empty viewer', () => {
    const html = renderToStaticMarkup(<FileBody file={file({ binary: true, path: 'logo.png' })} path="logo.png" />);
    expect(html).toContain('binary');
    expect(html).not.toContain('kt-fs-pre');
  });

  test('source is highlighted through the shared registry and never inserted raw', () => {
    const html = renderToStaticMarkup(
      <FileBody file={file({ content: 'const x: number = 1;', lang: 'typescript' })} path="a.ts" />,
    );
    expect(html).toContain('hljs language-typescript');
    expect(html).toContain('hljs-keyword');

    const raw = renderToStaticMarkup(
      <FileBody file={file({ content: 'const x: number = 1;', lang: 'typescript' })} path="a.ts" raw />,
    );
    expect(raw).toContain('const x: number = 1;');
    expect(raw).not.toContain('hljs-keyword');
  });

  test('an unknown language falls back to escaped text', () => {
    const html = renderToStaticMarkup(
      <FileBody file={file({ content: '<b>not markup</b>', path: 'notes.unknownext' })} path="notes.unknownext" />,
    );
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(html).not.toContain('<b>not markup</b>');
  });

  test('markdown renders as prose by default and raw bytes only when asked', () => {
    const rendered = renderToStaticMarkup(
      <FileBody file={file({ content: '# Title\n\n- a\n- b', path: 'DESIGN.md' })} path="DESIGN.md" />,
    );
    expect(rendered).toContain('<h1>Title</h1>');
    expect(rendered).toContain('<li>a</li>');
    const source = renderToStaticMarkup(
      <FileBody file={file({ content: '# Title', path: 'DESIGN.md' })} path="DESIGN.md" raw />,
    );
    expect(source).not.toContain('<h1>');
    expect(source).toContain('# Title');
  });

  test('rendered markdown cannot smuggle raw HTML in', () => {
    const html = renderToStaticMarkup(
      <FileBody file={file({ content: 'hello <img src=x onerror=alert(1)>', path: 'README.md' })} path="README.md" />,
    );
    // react-markdown has no rehype-raw here, so the tag is TEXT: it survives as
    // escaped characters and never becomes an element that could fire.
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  test('an empty file says so', () => {
    const html = renderToStaticMarkup(<FileBody file={file({ content: '' })} path="a.ts" />);
    expect(html).toContain('This file is empty.');
  });

  test('a file over the highlight cap still renders, as plain text, and says why', () => {
    const huge = 'const x = 1;\n'.repeat(6000); // > 60,000 chars
    const html = renderToStaticMarkup(<FileBody file={file({ content: huge, lang: 'typescript' })} path="a.ts" />);
    expect(html).toContain('Syntax highlighting is off above');
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('kt-fs-pre');
  });

  test('a source reference renders persistent addressable line and range highlights', () => {
    const html = renderToStaticMarkup(
      <FileBody
        file={file({ content: 'const one = 1;\nconst two = 2;\nconst three = 3;\n', lang: 'typescript' })}
        path="src/app.ts"
        selection={{ line: 2, endLine: 3 }}
      />,
    );
    expect(html).toContain('Lines 2–3 highlighted.');
    expect(html).toContain('data-line="2" data-highlighted="true" aria-current="location"');
    expect(html).toContain('data-line="3" data-highlighted="true"');
    expect(html).not.toContain('data-line="1" data-highlighted="true"');
    expect(html.match(/data-highlighted="true"/g)).toHaveLength(2);
  });

  test('a Markdown line jump shows exact source instead of an unmappable prose rendering', () => {
    const html = renderToStaticMarkup(
      <FileBody
        file={file({ content: '# Heading\n\nBody', path: 'README.md' })}
        path="README.md"
        selection={{ line: 1 }}
      />,
    );
    expect(html).toContain('Line 1 highlighted.');
    expect(html).toContain('data-line="1"');
    expect(html).not.toContain('<h1>');
  });

  test('an out-of-bounds reference is honest and does not tint a different line', () => {
    const html = renderToStaticMarkup(
      <FileBody file={file({ content: 'one\ntwo' })} path="notes.txt" selection={{ line: 9 }} />,
    );
    expect(html).toContain('Line 9 does not exist; this file has 2 lines.');
    expect(html).not.toContain('data-highlighted="true"');
  });

  test('balanced highlighted fragments remain independently renderable per row', () => {
    const html = renderToStaticMarkup(
      <SourceLines
        content={'/* first\nsecond */'}
        html={'<span class="hljs-comment">/* first\nsecond */</span>'}
        lang="typescript"
        selection={{ line: 2 }}
      />,
    );
    expect(html).toContain('<span class="hljs-comment">/* first</span>');
    expect(html).toContain('<span class="hljs-comment">second */</span>');
  });

  test('scoped line scrolling places the target one-third into the Files pane', () => {
    const pane = {
      clientHeight: 300,
      scrollTop: 200,
      getBoundingClientRect: () => ({ top: 120 }),
    };
    scrollFileLineIntoView(
      pane as HTMLDivElement,
      {
        getBoundingClientRect: () => ({ top: 460 }),
      } as HTMLSpanElement,
    );
    expect(pane.scrollTop).toBe(440);
    scrollFileLineIntoView(
      pane as HTMLDivElement,
      {
        getBoundingClientRect: () => ({ top: -340 }),
      } as HTMLSpanElement,
    );
    expect(pane.scrollTop).toBe(0);
  });
});

describe('the tab shell', () => {
  test('opens directly on the normal directory browser with no section picker', () => {
    resetFsProbes();
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-11111111" cwd="/home/kirin/repo" />);
    expect(html).toContain('Loading the session root…');
    expect(html).not.toContain('aria-label="Files section"');
    expect(html).not.toContain('>Changes</button>');
    expect(html).not.toContain('>Browse</button>');
    expect(html).toContain('aria-label="Refresh files"');
    // The session's own root is stated, so it is never ambiguous WHICH tree.
    expect(html).toContain('/home/kirin/repo');
  });

  test('the pane is focusable for a keyboard reader without being a tab stop', () => {
    resetFsProbes();
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-11111111" />);
    expect(html).toContain('tabindex="-1"');
  });

  test('a capped changes answer admits that some inline dots may be missing', async () => {
    await seedProbe('ms2files-22222222', {
      repo: true,
      branch: 'main',
      changes: [{ path: 'a.ts', status: ' M' }],
      truncated: true,
    });
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-22222222" />);
    expect(html).toContain('Some change dots may be missing');
    expect(html).not.toContain('changed file vs HEAD');
  });

  test('a cap that swallowed every status row stays honest', async () => {
    await seedProbe('ms2files-33333333', { repo: true, changes: [], truncated: true });
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-33333333" />);
    expect(html).toContain('Some change dots may be missing');
    expect(html).not.toContain('working tree matches HEAD');
  });

  test('an ordinary empty status answer adds no ceremony above the browser', async () => {
    await seedProbe('ms2files-44444444', { repo: true, changes: [] });
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-44444444" />);
    expect(html).toContain('Loading the session root…');
    expect(html).not.toContain('working tree matches HEAD');
    expect(html).not.toContain('truncated');
  });

  test('same-basename files stay compact but have unambiguous path-based controls', () => {
    const html = renderToStaticMarkup(
      <OpenFileTabs
        tabs={[
          { path: 'src/index.ts', view: 'normal' },
          { path: 'test/index.ts', view: 'raw' },
        ]}
        activePath="src/index.ts"
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Open files"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Show src/index.ts"');
    expect(html).toContain('aria-label="Show test/index.ts"');
    expect(html).toContain('aria-label="Close src/index.ts"');
    expect(html).toContain('aria-label="Close test/index.ts"');
    // One activation + one close target per file.
    expect(html.match(/<button/g)).toHaveLength(4);
  });

  test('mounted tab state survives stale reads, view switches, activation, and both close positions', async () => {
    const sessionId = 'ms2files-55555555';
    await seedProbe(sessionId, { repo: true, changes: [] });

    type PendingResponse = ReturnType<typeof deferred<Response>>;
    const fileRequests = new Map<string, PendingResponse[]>();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    globalThis.fetch = (async input => {
      const url = new URL(String(input), 'https://kteam.test');
      if (url.pathname.endsWith('/fs/file')) {
        const path = url.searchParams.get('path') ?? '';
        const request = deferred<Response>();
        fileRequests.set(path, [...(fileRequests.get(path) ?? []), request]);
        return request.promise;
      }
      if (url.pathname.endsWith('/fs/diff')) {
        return new Response('@@ -1 +1 @@\n-old\n+new\n', { headers: { 'content-type': 'text/plain' } });
      }
      if (url.pathname.endsWith('/fs')) {
        return json({
          entries: [
            { name: 'src', type: 'dir' },
            { name: 'test', type: 'dir' },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    }) as typeof fetch;

    let focusCalls = 0;
    const pane = { focus: () => void (focusCalls += 1) };
    const harness = new HookHarness(tree => {
      const scroller = visit(tree, element => element.props?.tabIndex === -1);
      const ref = scroller?.props?.ref as { current: unknown } | undefined;
      if (ref) ref.current = pane;
    });
    const render = () => FilesTab({ sessionId, cwd: '/repo' });
    const component = <P,>(type: unknown): P => {
      const element = visit(harness.output, candidate => candidate.type === type);
      expect(element).toBeDefined();
      return element!.props as P;
    };
    const click = (label: string) => {
      const button = visit(
        harness.output,
        element => element.type === 'button' && element.props?.['aria-label'] === label,
      );
      expect(button).toBeDefined();
      (button!.props!.onClick as () => void)();
    };
    const resolveFile = (path: string, index: number, content: string) => {
      const request = fileRequests.get(path)?.[index];
      expect(request).toBeDefined();
      request!.resolve(json({ path, content, lang: 'typescript' }));
    };

    try {
      harness.render(render);
      await flush();

      component<{ onOpenFile: (path: string) => void }>(BrowseList).onOpenFile('src/index.ts');
      await flush();
      expect(focusCalls).toBe(1);

      click('Back to the file list');
      await flush();
      component<{ onOpenFile: (path: string) => void }>(BrowseList).onOpenFile('test/index.ts');
      await flush();
      expect(focusCalls).toBe(2);

      // The first file was superseded by the second. Resolving it late must not
      // paint its bytes under the second file's title.
      resolveFile('src/index.ts', 0, 'const stale = true;');
      await flush();
      expect(visit(harness.output, element => element.type === FileBody)).toBeUndefined();

      resolveFile('test/index.ts', 0, 'const current = true;');
      await flush();
      expect(component<{ path: string }>(FileBody).path).toBe('test/index.ts');

      click('Show raw bytes for test/index.ts');
      await flush();
      expect(
        component<{ tabs: Array<{ path: string; view: string }> }>(OpenFileTabs).tabs.find(
          tab => tab.path === 'test/index.ts',
        )?.view,
      ).toBe('raw');

      click('Show git diff for test/index.ts');
      await flush();
      expect(
        component<{ tabs: Array<{ path: string; view: string }> }>(OpenFileTabs).tabs.find(
          tab => tab.path === 'test/index.ts',
        )?.view,
      ).toBe('diff');

      const tabs = component<{
        onActivate: (path: string) => void;
        onClose: (path: string) => void;
      }>(OpenFileTabs);
      tabs.onActivate('src/index.ts');
      await flush();
      // Switching an existing tab preserves the reader's focus.
      expect(focusCalls).toBe(2);
      resolveFile('src/index.ts', 1, 'const fresh = true;');
      await flush();
      expect(component<{ path: string }>(FileBody).path).toBe('src/index.ts');

      // Close the non-active, second-position tab: the active first tab stays.
      component<{ onClose: (path: string) => void }>(OpenFileTabs).onClose('test/index.ts');
      await flush();
      expect(component<{ activePath: string; tabs: unknown[] }>(OpenFileTabs)).toMatchObject({
        activePath: 'src/index.ts',
        tabs: [{ path: 'src/index.ts' }],
      });
      expect(focusCalls).toBe(2);

      // Re-open the second position, then close the active second and active
      // first positions in turn. Each close affects only that file tab.
      click('Back to the file list');
      await flush();
      component<{ onOpenFile: (path: string) => void }>(BrowseList).onOpenFile('test/index.ts');
      await flush();
      resolveFile('test/index.ts', 1, 'const reopened = true;');
      await flush();
      component<{ onClose: (path: string) => void }>(OpenFileTabs).onClose('test/index.ts');
      await flush();
      expect(component<{ activePath: string; tabs: unknown[] }>(OpenFileTabs)).toMatchObject({
        activePath: 'src/index.ts',
        tabs: [{ path: 'src/index.ts' }],
      });
      component<{ onClose: (path: string) => void }>(OpenFileTabs).onClose('src/index.ts');
      await flush();
      expect(visit(harness.output, element => element.type === OpenFileTabs)).toBeUndefined();
    } finally {
      harness.unmount();
    }
  });

  test('a programmatic jump survives remount and preserves the file the reader had open', async () => {
    const sessionId = 'ms2files-66666666';
    await seedProbe(sessionId, { repo: true, changes: [] });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async input => {
      const url = new URL(String(input), 'https://kteam.test');
      if (url.pathname.endsWith('/fs/file')) {
        const path = url.searchParams.get('path') ?? '';
        return json({ path, content: 'one\ntwo\nthree\nfour', lang: 'typescript' });
      }
      if (url.pathname.endsWith('/fs')) {
        return json({
          entries: [
            { name: 'old.ts', type: 'file' },
            { name: 'jump.ts', type: 'file' },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    }) as typeof fetch;

    const first = new HookHarness(() => undefined);
    const firstRender = () => FilesTab({ sessionId, cwd: '/repo' });
    first.render(firstRender);
    await flush();
    const browse = visit(first.output, candidate => candidate.type === BrowseList);
    expect(browse).toBeDefined();
    (browse!.props!.onOpenFile as (path: string) => void)('old.ts');
    await flush();
    expect(readFilesTabState(sessionId)).toMatchObject({ activePath: 'old.ts', tabs: [{ path: 'old.ts' }] });
    first.unmount();

    const handled: number[] = [];
    const second = new HookHarness(() => undefined);
    const request = { sequence: 7, reference: { path: 'jump.ts', line: 2, endLine: 4 } };
    const secondRender = () =>
      FilesTab({
        sessionId,
        cwd: '/repo',
        requestedReference: request,
        onRequestedReferenceHandled: sequence => handled.push(sequence),
      });
    try {
      second.render(secondRender);
      await flush();
      const tabs = visit(second.output, candidate => candidate.type === OpenFileTabs);
      expect(tabs?.props).toMatchObject({
        activePath: 'jump.ts',
        tabs: [
          { path: 'old.ts', view: 'normal' },
          { path: 'jump.ts', view: 'normal', selection: { line: 2, endLine: 4 } },
        ],
      });
      const body = visit(second.output, candidate => candidate.type === FileBody);
      expect(body?.props).toMatchObject({ path: 'jump.ts', selection: { line: 2, endLine: 4 } });
      expect(handled).toEqual([7]);
    } finally {
      second.unmount();
    }
  });

  test('an in-place session switch restores only the target session tabs', async () => {
    const sessionA = 'ms2files-77777777';
    const sessionB = 'ms2files-88888888';
    const fileRequests: Array<{ sessionId: string; path: string }> = [];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async input => {
      const url = new URL(String(input), 'https://kteam.test');
      const match = /\/v1\/sessions\/([^/]+)\/fs(?:\/|$)/u.exec(url.pathname);
      const requestedSession = decodeURIComponent(match?.[1] ?? '');
      if (url.pathname.endsWith('/fs/changes')) return json({ repo: false, changes: [] });
      if (url.pathname.endsWith('/fs/file')) {
        const path = url.searchParams.get('path') ?? '';
        fileRequests.push({ sessionId: requestedSession, path });
        return json({ path, content: `${requestedSession}:${path}` });
      }
      if (url.pathname.endsWith('/fs')) {
        return json({
          entries: [{ name: requestedSession === sessionA ? 'a.ts' : 'b.ts', type: 'file' }],
        });
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    }) as typeof fetch;

    const seedB = new HookHarness(() => undefined);
    seedB.render(() => FilesTab({ sessionId: sessionB, cwd: '/repo-b' }));
    await flush();
    const browseB = visit(seedB.output, candidate => candidate.type === BrowseList);
    expect(browseB).toBeDefined();
    (browseB!.props!.onOpenFile as (path: string) => void)('b.ts');
    await flush();
    seedB.unmount();

    let activeSession = sessionA;
    const switching = new HookHarness(() => undefined);
    const render = () =>
      FilesTab({ sessionId: activeSession, cwd: activeSession === sessionA ? '/repo-a' : '/repo-b' });
    try {
      switching.render(render);
      await flush();
      const browseA = visit(switching.output, candidate => candidate.type === BrowseList);
      expect(browseA).toBeDefined();
      (browseA!.props!.onOpenFile as (path: string) => void)('a.ts');
      await flush();
      expect(readFilesTabState(sessionA)).toMatchObject({ activePath: 'a.ts', tabs: [{ path: 'a.ts' }] });

      activeSession = sessionB;
      switching.render(render);
      await flush();
      const tabs = visit(switching.output, candidate => candidate.type === OpenFileTabs);
      expect(tabs?.props).toMatchObject({ activePath: 'b.ts', tabs: [{ path: 'b.ts' }] });
      expect(readFilesTabState(sessionA)).toMatchObject({ activePath: 'a.ts', tabs: [{ path: 'a.ts' }] });
      expect(readFilesTabState(sessionB)).toMatchObject({ activePath: 'b.ts', tabs: [{ path: 'b.ts' }] });
      expect(fileRequests).not.toContainEqual({ sessionId: sessionB, path: 'a.ts' });
    } finally {
      switching.unmount();
    }
  });
});
