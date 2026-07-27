import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowseList, ChangesList, DiffBody, FileBody, FilesTab, entryRefusal, fileRefusal } from './FilesTab';
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

describe('changes list', () => {
  const changes = [
    { path: 'modules/kteam-ts/src/api-server.ts', status: ' M' },
    { path: 'docs/new.md', status: '??' },
    { path: 'src/api.ts', status: 'R ', from: 'src/old-api.ts' },
  ];

  test('every row is a labelled target that states the status in words', () => {
    const html = renderToStaticMarkup(<ChangesList changes={changes} onOpen={() => {}} />);
    expect(html).toContain('aria-label="Modified (unstaged): modules/kteam-ts/src/api-server.ts. Open diff"');
    expect(html).toContain('aria-label="Untracked: docs/new.md. Open diff"');
    expect(html).toContain('from src/old-api.ts');
    // Three rows, three buttons — the whole row is the target, not an icon.
    expect(html.match(/<button/g)).toHaveLength(3);
  });

  test('the colour chip is redundant, not the message', () => {
    const html = renderToStaticMarkup(<ChangesList changes={changes} onOpen={() => {}} />);
    // Every chip is hidden from AT (the row name carries the word) and carries
    // its own letter, so a monochrome or colour-blind read still classifies.
    expect(html.match(/kt-badge[^>]*aria-hidden="true"/g)).toHaveLength(3);
    expect(html).toContain('>M</span>');
    expect(html).toContain('>?</span>');
    expect(html).toContain('>R</span>');
  });

  test('the long-path half that matters is kept — the tail is never truncated away', () => {
    const html = renderToStaticMarkup(<ChangesList changes={changes} onOpen={() => {}} />);
    expect(html).toContain('modules/kteam-ts/src/');
    expect(html).toContain('api-server.ts');
    expect(html).not.toContain('truncate');
  });

  test('a name the daemon cannot address is inert, verbatim, and still listed', () => {
    const hostile = [
      { path: `dir/a${BACKSLASH}b.ts`, status: ' M' },
      { path: `line${NEWLINE}break.ts`, status: '??' },
      { path: 'ok.ts', status: ' M' },
    ];
    const html = renderToStaticMarkup(<ChangesList changes={hostile} onOpen={() => {}} />);
    // Only the addressable row is a control — the other two cannot fire a diff
    // request the daemon would refuse.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html.match(/data-inert="true"/g)).toHaveLength(2);
    expect(html).toContain('name cannot be opened by this viewer');
    // Shown as git named it. The normalised `dir/a/b.ts` is a DIFFERENT file.
    expect(html).toContain(`dir/a${BACKSLASH}b.ts`);
    expect(html).not.toContain('dir/a/b.ts');
    // Not silently dropped: the newline row is present, and so is the good one.
    expect(html).toContain('break.ts');
    expect(html).toContain('aria-label="Modified (unstaged): ok.ts. Open diff"');
  });

  test('an inert change row still announces its status to a screen reader', () => {
    const html = renderToStaticMarkup(
      <ChangesList changes={[{ path: `a${BACKSLASH}b.ts`, status: ' M' }]} onOpen={() => {}} />,
    );
    // The chip is aria-hidden, so the word has to be in the row's text.
    expect(html).toContain('sr-only');
    expect(html).toContain('Modified');
  });

  test('a capped change list admits it, and an uncapped one stays quiet', () => {
    const capped = renderToStaticMarkup(<ChangesList changes={changes} truncated onOpen={() => {}} />);
    expect(capped).toContain('Change list truncated by the daemon');
    // Still a note, not a fourth row pretending to be a file.
    expect(capped.match(/<button/g)).toHaveLength(3);
    const plain = renderToStaticMarkup(<ChangesList changes={changes} onOpen={() => {}} />);
    expect(plain).not.toContain('Change list truncated');
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
    const html = renderToStaticMarkup(
      <FileBody file={file({ binary: true, path: 'logo.png' })} path="logo.png" render="source" />,
    );
    expect(html).toContain('binary');
    expect(html).not.toContain('kt-fs-pre');
  });

  test('source is highlighted through the shared registry and never inserted raw', () => {
    const html = renderToStaticMarkup(
      <FileBody file={file({ content: 'const x: number = 1;', lang: 'typescript' })} path="a.ts" render="source" />,
    );
    expect(html).toContain('hljs language-typescript');
    expect(html).toContain('hljs-keyword');
  });

  test('an unknown language falls back to escaped text', () => {
    const html = renderToStaticMarkup(
      <FileBody
        file={file({ content: '<b>not markup</b>', path: 'notes.unknownext' })}
        path="notes.unknownext"
        render="source"
      />,
    );
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(html).not.toContain('<b>not markup</b>');
  });

  test('markdown renders as prose when asked and as source when not', () => {
    const rendered = renderToStaticMarkup(
      <FileBody
        file={file({ content: '# Title\n\n- a\n- b', path: 'DESIGN.md' })}
        path="DESIGN.md"
        render="rendered"
      />,
    );
    expect(rendered).toContain('<h1>Title</h1>');
    expect(rendered).toContain('<li>a</li>');
    const source = renderToStaticMarkup(
      <FileBody file={file({ content: '# Title', path: 'DESIGN.md' })} path="DESIGN.md" render="source" />,
    );
    expect(source).not.toContain('<h1>');
    expect(source).toContain('# Title');
  });

  test('rendered markdown cannot smuggle raw HTML in', () => {
    const html = renderToStaticMarkup(
      <FileBody
        file={file({ content: 'hello <img src=x onerror=alert(1)>', path: 'README.md' })}
        path="README.md"
        render="rendered"
      />,
    );
    // react-markdown has no rehype-raw here, so the tag is TEXT: it survives as
    // escaped characters and never becomes an element that could fire.
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  test('an empty file says so', () => {
    const html = renderToStaticMarkup(<FileBody file={file({ content: '' })} path="a.ts" render="source" />);
    expect(html).toContain('This file is empty.');
  });

  test('a file over the highlight cap still renders, as plain text, and says why', () => {
    const huge = 'const x = 1;\n'.repeat(6000); // > 60,000 chars
    const html = renderToStaticMarkup(
      <FileBody file={file({ content: huge, lang: 'typescript' })} path="a.ts" render="source" />,
    );
    expect(html).toContain('Syntax highlighting is off above');
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('kt-fs-pre');
  });
});

describe('the tab shell', () => {
  test('opens on Changes, probing, with both sections reachable', () => {
    resetFsProbes();
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-11111111" cwd="/home/kirin/repo" />);
    expect(html).toContain('Loading changes…');
    expect(html).toContain('aria-label="Files section"');
    expect(html).toContain('>Changes</button>');
    expect(html).toContain('>Browse</button>');
    expect(html).toContain('aria-label="Refresh files"');
    // The session's own root is stated, so it is never ambiguous WHICH tree.
    expect(html).toContain('/home/kirin/repo');
  });

  test('the pane is focusable for a keyboard reader without being a tab stop', () => {
    resetFsProbes();
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-11111111" />);
    expect(html).toContain('tabindex="-1"');
  });

  test('a capped changes answer never prints its length as the total', async () => {
    await seedProbe('ms2files-22222222', {
      repo: true,
      branch: 'main',
      changes: [{ path: 'a.ts', status: ' M' }],
      truncated: true,
    });
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-22222222" />);
    expect(html).toContain('First 1 changed file vs HEAD');
    expect(html).toContain('Change list truncated by the daemon');
  });

  test('a cap that swallowed every row does not read as "nothing changed"', async () => {
    await seedProbe('ms2files-33333333', { repo: true, changes: [], truncated: true });
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-33333333" />);
    expect(html).toContain('incomplete, not empty');
    expect(html).not.toContain('No uncommitted changes');
  });

  test('an ordinary empty answer still says the tree matches HEAD', async () => {
    await seedProbe('ms2files-44444444', { repo: true, changes: [] });
    const html = renderToStaticMarkup(<FilesTab sessionId="ms2files-44444444" />);
    expect(html).toContain('No uncommitted changes');
    expect(html).not.toContain('truncated');
  });
});
