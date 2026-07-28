// Remark plugin for canonical task references in prose. It transforms only
// ordinary text nodes: existing links, inline/fenced code, and raw HTML remain
// byte-for-byte content so linkification never swallows an unknown construct.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdNode[];
}

const TASK_ID = /^[BFIC][0-9]{1,9}$/iu;
const TASK_REFERENCE = /#([BFIC][0-9]{1,9})/giu;
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);

const word = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}_]/u.test(value);

export function taskReferenceHref(id: string): string {
  return `/tasks/${id.toUpperCase()}`;
}

export function parseTaskReferenceHref(href: string | undefined): string | null {
  if (!href?.startsWith('/tasks/')) return null;
  let id: string;
  try {
    id = decodeURIComponent(href.slice('/tasks/'.length)).toUpperCase();
  } catch {
    return null;
  }
  return TASK_ID.test(id) ? id : null;
}

function linkifyText(value: string): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const match of value.matchAll(TASK_REFERENCE)) {
    const index = match.index;
    const raw = match[0];
    const id = match[1];
    if (index === undefined || !id || word(value[index - 1]) || word(value[index + raw.length])) continue;
    if (index > cursor) output.push({ type: 'text', value: value.slice(cursor, index) });
    output.push({
      type: 'link',
      url: taskReferenceHref(id),
      title: `Open task #${id.toUpperCase()}`,
      children: [{ type: 'text', value: raw }],
    });
    cursor = index + raw.length;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

function transform(node: MdNode): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      children.push(...(linkifyText(child.value) ?? [child]));
      continue;
    }
    transform(child);
    children.push(child);
  }
  node.children = children;
}

export function remarkTaskReferences() {
  return (tree: MdNode): void => transform(tree);
}
