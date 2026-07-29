import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileTree, FileTreeRows } from './FileTree';
import type { TreeEntryRow, TreeRow } from './file-tree-model';

type ElementLike = { type?: unknown; props?: Record<string, unknown> };

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

const noop = () => {};
const rowsProps = (rows: TreeRow[], over: Partial<Parameters<typeof FileTreeRows>[0]> = {}) => ({
  rows,
  onToggle: noop,
  onEnter: noop,
  onOpenFile: noop,
  onRetry: noop,
  ...over,
});

const dirRow = (over: Partial<TreeEntryRow> = {}): TreeRow => ({
  kind: 'dir',
  path: 'src',
  name: 'src',
  depth: 0,
  refusal: null,
  expanded: false,
  selected: false,
  ...over,
});

describe('tree rows markup', () => {
  test('a directory row is a chevron plus a navigation control, both honest about state', () => {
    const html = renderToStaticMarkup(<FileTreeRows {...rowsProps([dirRow()])} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand src"');
    expect(html).toContain('aria-label="Go to folder src"');
    expect(html).toContain('>src/</span>');

    const expanded = renderToStaticMarkup(<FileTreeRows {...rowsProps([dirRow({ expanded: true })])} />);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('aria-label="Collapse src"');
  });

  test('the selected directory is marked as the current location', () => {
    const html = renderToStaticMarkup(<FileTreeRows {...rowsProps([dirRow({ selected: true })])} />);
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-current="location"');
    const plain = renderToStaticMarkup(<FileTreeRows {...rowsProps([dirRow()])} />);
    expect(plain).not.toContain('aria-current');
  });

  test('a file row opens by full path and states its size', () => {
    const html = renderToStaticMarkup(
      <FileTreeRows
        {...rowsProps([
          {
            kind: 'file',
            path: 'src/app.ts',
            name: 'app.ts',
            depth: 1,
            refusal: null,
            expanded: false,
            selected: false,
            size: 2048,
          },
        ])}
      />,
    );
    expect(html).toContain('aria-label="Open file src/app.ts, 2.0 KB"');
    expect(html).toContain('--kt-fs-tree-depth:1');
  });

  test('a refused entry is an inert row that says why — never a button that fails', () => {
    const html = renderToStaticMarkup(
      <FileTreeRows
        {...rowsProps([
          dirRow({ name: 'node_modules', path: 'node_modules', refusal: 'not served — denylisted (secrets policy)' }),
        ])}
      />,
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('data-inert="true"');
    expect(html).toContain('not served — denylisted (secrets policy)');
  });

  test('loading, empty and truncated notes render in place of guessed children', () => {
    const html = renderToStaticMarkup(
      <FileTreeRows
        {...rowsProps([
          { kind: 'note', note: 'loading', dir: 'src', depth: 1 },
          { kind: 'note', note: 'empty', dir: 'lib', depth: 1 },
          { kind: 'note', note: 'truncated', dir: '', depth: 0 },
        ])}
      />,
    );
    expect(html).toContain('Loading…');
    expect(html).toContain('Empty.');
    expect(html).toContain('Listing truncated by the daemon.');
    expect(html).not.toContain('<button');
  });

  test('a failed directory offers retry and the callbacks carry daemon-grammar paths', () => {
    const entered: string[] = [];
    const opened: string[] = [];
    const toggled: string[] = [];
    const retried: string[] = [];
    const tree = FileTreeRows(
      rowsProps(
        [
          dirRow(),
          {
            kind: 'file',
            path: 'src/app.ts',
            name: 'app.ts',
            depth: 1,
            refusal: null,
            expanded: false,
            selected: false,
          },
          { kind: 'note', note: 'error', dir: 'lib', depth: 1, error: 'could not reach the daemon' },
        ],
        {
          onEnter: path => entered.push(path),
          onOpenFile: path => opened.push(path),
          onToggle: path => toggled.push(path),
          onRetry: at => retried.push(at),
        },
      ),
    );
    expect(renderToStaticMarkup(tree)).toContain('Could not list lib: could not reach the daemon');
    const click = (label: string) => {
      const button = visit(tree, element => element.type === 'button' && element.props?.['aria-label'] === label);
      expect(button).toBeDefined();
      (button!.props!.onClick as () => void)();
    };
    click('Expand src');
    click('Go to folder src');
    click('Open file src/app.ts');
    click('Retry listing lib');
    expect(toggled).toEqual(['src']);
    expect(entered).toEqual(['src']);
    expect(opened).toEqual(['src/app.ts']);
    expect(retried).toEqual(['lib']);
  });
});

describe('the tree pane shell', () => {
  test('renders as a labelled navigation region with an honest first paint', () => {
    const html = renderToStaticMarkup(
      <FileTree sessionId="ms2tree-11111111" dir="" onEnter={noop} onOpenFile={noop} />,
    );
    expect(html).toContain('aria-label="Folder tree"');
    expect(html).toContain('kt-fs-tree');
    // No effect has run, no listing exists: the only row is the loading note.
    expect(html).toContain('Loading…');
    expect(html).not.toContain('<button');
  });

  test('hidden keeps the pane mounted but out of the accessibility tree', () => {
    const html = renderToStaticMarkup(
      <FileTree sessionId="ms2tree-11111111" dir="" hidden onEnter={noop} onOpenFile={noop} />,
    );
    expect(html).toContain('hidden=""');
  });
});
