import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BrowseList,
  ChangeIndicator,
  DiffBody,
  FileBody,
  FilesTab,
  OpenFileTabs,
  changeDescription,
  entryRefusal,
  fileRefusal,
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
});

const entry = (over: Partial<FsEntry> & { name: string }): FsEntry => ({ type: 'file', ...over });

/** Built at runtime: a literal backslash or control byte in a source file does
 *  not survive editors and formatters reliably, and these bytes ARE the test. */
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

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

  test('multiple open files are compact, independently closable tabs', () => {
    const html = renderToStaticMarkup(
      <OpenFileTabs
        tabs={[
          { path: 'src/app.ts', view: 'normal' },
          { path: 'README.md', view: 'raw' },
        ]}
        activePath="src/app.ts"
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Open files"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Close app.ts"');
    expect(html).toContain('aria-label="Close README.md"');
    // One activation + one close target per file.
    expect(html.match(/<button/g)).toHaveLength(4);
  });
});
