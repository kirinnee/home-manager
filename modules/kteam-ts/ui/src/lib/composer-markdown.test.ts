import { describe, expect, test } from 'bun:test';
import { tokenizeMarkdown, type MdToken } from './composer-markdown';

/** The overlay's correctness contract: tokens concatenate to the input. */
function roundTrip(input: string): MdToken[] {
  const tokens = tokenizeMarkdown(input);
  expect(tokens.map(t => t.text).join('')).toBe(input);
  return tokens;
}

function types(tokens: MdToken[]): string[] {
  return tokens.map(t => t.type);
}

function ofType(tokens: MdToken[], type: MdToken['type']): string[] {
  return tokens.filter(t => t.type === type).map(t => t.text);
}

describe('losslessness — the property the overlay lives or dies on', () => {
  const fixtures = [
    '',
    'plain text',
    'multi\nline\n\ntext\n',
    '# heading\n\nbody **bold** and *italic* and `code`',
    '```ts\nconst a = 1;\n```\nafter',
    '```\nunterminated fence\nstill code',
    '~~~\ntilde fence\n~~~',
    '- item one\n- item two\n  - nested\n1. ordered\n2) also ordered',
    '> quoted\n> > nested quote',
    '[label](https://example.com) trailing',
    'a * b * c stays plain',
    'trailing spaces   \nand\ttabs\t',
    '`unclosed inline code',
    '**unclosed bold',
    'mixed ``double `tick`` spans',
    '\\*escaped\\* asterisks',
    '****',
    '***everything***',
    'ends with newline\n',
    '\n\n\n',
  ];
  for (const fixture of fixtures) {
    test(JSON.stringify(fixture.slice(0, 40)), () => {
      roundTrip(fixture);
    });
  }
});

describe('fenced code blocks — the named priority', () => {
  test('a terminated backtick fence: fence / code / fence', () => {
    const tokens = roundTrip('```ts\nconst a = 1;\nlet b;\n```');
    expect(types(tokens)).toEqual(['fence', 'text', 'codeBlock', 'text', 'codeBlock', 'text', 'fence']);
    expect(ofType(tokens, 'fence')).toEqual(['```ts', '```']);
  });

  test('an UNTERMINATED fence runs to the end of the draft as code', () => {
    const tokens = roundTrip('before\n```py\nstill typing');
    expect(ofType(tokens, 'codeBlock')).toEqual(['still typing']);
    // The line before the fence stays prose.
    expect(tokens[0]).toEqual({ type: 'text', text: 'before' });
  });

  test('markdown syntax INSIDE a fence is code, not emphasis', () => {
    const tokens = roundTrip('```\n**not bold** `not inline`\n# not a heading\n```');
    expect(ofType(tokens, 'bold')).toEqual([]);
    expect(ofType(tokens, 'inlineCode')).toEqual([]);
    expect(ofType(tokens, 'heading')).toEqual([]);
    expect(ofType(tokens, 'codeBlock')).toEqual(['**not bold** `not inline`', '# not a heading']);
  });

  test('a longer closing run closes a shorter opener; a shorter one does not', () => {
    const closed = roundTrip('```\ncode\n````');
    expect(types(closed)).toContain('fence');
    expect(ofType(closed, 'fence')).toEqual(['```', '````']);

    const open = roundTrip('````\ncode\n```\nstill code');
    expect(ofType(open, 'codeBlock')).toEqual(['code', '```', 'still code']);
  });

  test('tilde fences do not close backtick fences and vice versa', () => {
    const tokens = roundTrip('```\n~~~\nstill code\n```');
    expect(ofType(tokens, 'codeBlock')).toEqual(['~~~', 'still code']);
    expect(ofType(tokens, 'fence')).toEqual(['```', '```']);
  });

  test('a backtick "fence" with a backtick in its info string is not a fence', () => {
    const tokens = roundTrip('``` `not-a-fence`\nprose');
    expect(ofType(tokens, 'fence')).toEqual([]);
    expect(tokens.some(t => t.type === 'codeBlock')).toBe(false);
  });

  test('a fence line inside a list indent (up to 3 spaces) still opens', () => {
    const tokens = roundTrip('   ```\ncode\n   ```');
    expect(ofType(tokens, 'fence')).toEqual(['   ```', '   ```']);
  });

  test('a tab is not one of the permitted three leading spaces', () => {
    const tokens = roundTrip('\t```ts\nprose');
    expect(ofType(tokens, 'fence')).toEqual([]);
    expect(ofType(tokens, 'codeBlock')).toEqual([]);
  });
});

describe('inline code', () => {
  test('single backticks, backticks included in the token', () => {
    const tokens = roundTrip('run `bun test` now');
    expect(ofType(tokens, 'inlineCode')).toEqual(['`bun test`']);
  });

  test('double-backtick span may contain single backticks', () => {
    const tokens = roundTrip('a ``lit `tick` span`` b');
    expect(ofType(tokens, 'inlineCode')).toEqual(['``lit `tick` span``']);
  });

  test('an unclosed backtick is plain text — mid-typing state', () => {
    const tokens = roundTrip('typing `not done');
    expect(ofType(tokens, 'inlineCode')).toEqual([]);
    expect(types(tokens)).toEqual(['text']);
  });

  test('a backslash is literal and does not escape a closing backtick', () => {
    const tokens = roundTrip('`a \\` b`');
    expect(ofType(tokens, 'inlineCode')).toEqual(['`a \\`']);
  });
});

describe('emphasis', () => {
  test('bold, italic, bold-italic — content and marks are separate tokens', () => {
    expect(types(roundTrip('**b**'))).toEqual(['mark', 'bold', 'mark']);
    expect(types(roundTrip('*i*'))).toEqual(['mark', 'italic', 'mark']);
    expect(types(roundTrip('___bi___'))).toEqual(['mark', 'boldItalic', 'mark']);
  });

  test('spaced asterisks are arithmetic, not emphasis', () => {
    expect(types(roundTrip('a * b * c'))).toEqual(['text']);
  });

  test('escaped delimiters never open a span', () => {
    expect(types(roundTrip('\\*nope\\*'))).toEqual(['text']);
  });

  test('nested code wins over emphasis when it opens first', () => {
    const tokens = roundTrip('`**code**`');
    expect(ofType(tokens, 'inlineCode')).toEqual(['`**code**`']);
  });

  test('inline code also keeps precedence INSIDE emphasis', () => {
    const tokens = roundTrip('**bold `code` tail**');
    expect(ofType(tokens, 'inlineCode')).toEqual(['`code`']);
    expect(ofType(tokens, 'bold')).toEqual(['bold ', ' tail']);
  });

  test('an escaped delimiter cannot close emphasis', () => {
    const tokens = roundTrip('*a \\* b*');
    expect(ofType(tokens, 'italic')).toEqual(['a \\* b']);
  });

  test('underscores inside identifiers are not emphasis delimiters', () => {
    expect(types(roundTrip('foo_bar_baz'))).toEqual(['text']);
    expect(types(roundTrip('alpha__beta__gamma'))).toEqual(['text']);
    expect(types(roundTrip('α_β_γ'))).toEqual(['text']);
  });

  test('underscores at punctuation boundaries still delimit emphasis', () => {
    expect(types(roundTrip('(_ok_)'))).toEqual(['text', 'mark', 'italic', 'mark', 'text']);
  });
});

describe('block-level colouring', () => {
  test('headings take the whole line, hashes included', () => {
    const tokens = roundTrip('# One\n###### Six\n####### seven is not a heading');
    expect(ofType(tokens, 'heading')).toEqual(['# One', '###### Six']);
  });

  test('a hash without a following space is not a heading', () => {
    expect(ofType(roundTrip('#hashtag'), 'heading')).toEqual([]);
  });

  test('list markers: bullets, ordered, indented', () => {
    const tokens = roundTrip('- a\n* b\n+ c\n12. d\n  - indented');
    expect(ofType(tokens, 'listMarker')).toEqual(['- ', '* ', '+ ', '12. ', '  - ']);
  });

  test('a bare dash with no trailing space is not a list yet', () => {
    expect(ofType(roundTrip('-'), 'listMarker')).toEqual([]);
  });

  test('blockquote markers, nested, with inline markdown after', () => {
    const tokens = roundTrip('> > quoted **bold**');
    expect(ofType(tokens, 'quoteMarker')).toEqual(['> > ']);
    expect(ofType(tokens, 'bold')).toEqual(['bold']);
  });

  test('a quoted heading colours both marker and heading', () => {
    const tokens = roundTrip('> # title');
    expect(types(tokens)).toEqual(['quoteMarker', 'heading']);
  });
});

describe('links', () => {
  test('inline link splits into text and url, punctuation included', () => {
    const tokens = roundTrip('see [docs](https://x.dev/a) ok');
    expect(ofType(tokens, 'linkText')).toEqual(['[docs]']);
    expect(ofType(tokens, 'linkUrl')).toEqual(['(https://x.dev/a)']);
  });

  test('half-typed links are plain text', () => {
    expect(types(roundTrip('[label](unclosed'))).toEqual(['text']);
    expect(types(roundTrip('[label only]'))).toEqual(['text']);
  });
});
