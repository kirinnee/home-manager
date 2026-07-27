import { describe, expect, test } from 'bun:test';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { cellText, remarkTableLabels } from './remark-table-labels';

/** Parse markdown to the mdast the plugin sees at runtime (parse + gfm run),
 *  matching the pipeline react-markdown builds internally. */
function toTree(md: string) {
  const processor = unified().use(remarkParse).use(remarkGfm);
  return processor.runSync(processor.parse(md)) as any;
}

function firstTable(tree: any): any {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n.type === 'table') out.push(n);
    (n.children ?? []).forEach(walk);
  };
  walk(tree);
  return out[0];
}

const labelsOf = (row: any) => (row.children ?? []).map((c: any) => c.data?.hProperties?.['data-label']);

describe('cellText', () => {
  test('reads plain text', () => {
    expect(cellText({ type: 'text', value: 'Path' })).toBe('Path');
  });

  test('flattens formatted header content (bold, code)', () => {
    const node = {
      type: 'tableCell',
      children: [
        { type: 'text', value: 'exit ' },
        { type: 'inlineCode', value: 'code' },
      ],
    };
    expect(cellText(node)).toBe('exit code');
  });
});

describe('remarkTableLabels', () => {
  test('stamps body cells with their column header', () => {
    const tree = toTree(['| Path | Note | N |', '|---|---|--:|', '| /a/b | hi | 3 |', '| /c/d | yo | 4 |'].join('\n'));
    remarkTableLabels()(tree);
    const table = firstTable(tree);
    // Header row is untouched; body rows carry labels.
    expect(labelsOf(table.children[0])).toEqual([undefined, undefined, undefined]);
    expect(labelsOf(table.children[1])).toEqual(['Path', 'Note', 'N']);
    expect(labelsOf(table.children[2])).toEqual(['Path', 'Note', 'N']);
  });

  test('label collapses whitespace of a multi-part header', () => {
    const tree = toTree(['| Full   Name | X |', '|---|---|', '| Ann | 1 |'].join('\n'));
    remarkTableLabels()(tree);
    const table = firstTable(tree);
    expect(labelsOf(table.children[1])).toEqual(['Full Name', 'X']);
  });

  test('a header-only table produces no crash and no body labels', () => {
    const tree = toTree(['| A | B |', '|---|---|'].join('\n'));
    expect(() => remarkTableLabels()(tree)).not.toThrow();
    const table = firstTable(tree);
    expect(table.children).toHaveLength(1);
  });

  test('leaves non-table documents untouched', () => {
    const tree = toTree('Just a paragraph with `code` and **bold**.');
    expect(() => remarkTableLabels()(tree)).not.toThrow();
    expect(firstTable(tree)).toBeUndefined();
  });

  test('does not clobber an existing data-label', () => {
    const tree = toTree(['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'));
    const table = firstTable(tree);
    const cell = table.children[1].children[0];
    cell.data = { hProperties: { 'data-label': 'preset' } };
    remarkTableLabels()(tree);
    expect(cell.data.hProperties['data-label']).toBe('preset');
  });
});
