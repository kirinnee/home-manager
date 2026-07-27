// remark plugin: stamp every body cell of a GFM table with `data-label`, the
// text of its column's header.
//
// WHY THIS EXISTS. On a phone a 4-5 column markdown table cannot show its header
// row and its cells side by side without squashing every column into an
// unreadable sliver. The mobile layout (index.css) breaks each row into a
// stacked card, and each cell then needs to name its own column — otherwise a
// bare value ("3", "/etc/hosts") is meaningless once the header row is out of
// sight. `content: attr(data-label)` in the stacked layout prints that name.
//
// The label is derived here, at parse time, from the header row itself, so it
// always matches the real header text (including when a header is renamed) and
// the sighted-user label can never drift from the screen-reader header. It is
// applied via `data.hProperties`, the mdast->hast contract mdast-util-to-hast
// honours, so the attribute lands on the rendered <td> with no DOM walking.
//
// Header association for assistive tech does NOT depend on this attribute — that
// is carried by the real <th scope="col"> plus the explicit ARIA roles the
// Markdown renderers set, which survive the `display:block` the stacked layout
// applies. `data-label` is the VISUAL echo for sighted phone users only.

// Minimal structural types — we read only what a GFM table node exposes and
// never import the full mdast typings (they are transitive here, not a direct
// dependency).
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** Concatenate the visible text of an inline subtree (text + inlineCode carry a
 *  `value`; everything else is a wrapper we recurse through). Whitespace is
 *  collapsed so a wrapped header still yields a single clean label. */
export function cellText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  const kids = node.children ?? [];
  return kids.map(cellText).join('');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Depth-first walk collecting every `table` node. Tables never nest, but they
 *  can sit at any depth (inside a list item, a blockquote), so a full walk is
 *  the honest way to find them all. */
function collectTables(node: MdNode, out: MdNode[]): void {
  if (node.type === 'table') out.push(node);
  for (const child of node.children ?? []) collectTables(child, out);
}

/** The plugin. First `tableRow` is the header; every later row's cells inherit
 *  the header text at their column index as `data-label`. */
export function remarkTableLabels() {
  return (tree: MdNode): void => {
    const tables: MdNode[] = [];
    collectTables(tree, tables);
    for (const table of tables) {
      const rows = table.children ?? [];
      const [header, ...body] = rows;
      if (!header) continue;
      const labels = (header.children ?? []).map(cell => normalize(cellText(cell)));
      for (const row of body) {
        (row.children ?? []).forEach((cell, col) => {
          const label = labels[col];
          if (!label) return;
          const data = (cell.data ??= {});
          const props = (data.hProperties ??= {});
          // Never clobber an author-set attribute; markdown can't set one today,
          // but the guard keeps this composable.
          if (props['data-label'] == null) props['data-label'] = label;
        });
      }
    }
  };
}
