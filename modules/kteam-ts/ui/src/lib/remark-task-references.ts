// Remark plugin for canonical task references in prose. It transforms only
// ordinary text nodes: existing links, inline/fenced code, and raw HTML remain
// byte-for-byte content so linkification never swallows an unknown construct.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  data?: {
    hProperties?: Record<string, string>;
  };
  children?: MdNode[];
}

const TASK_ID = /^[BFIC][0-9]{1,9}$/iu;
const TASK_REFERENCE = /#([BFIC][0-9]{1,9})/giu;
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);

export interface TaskReferenceMatch {
  id: string;
  raw: string;
  start: number;
  end: number;
}

export type TaskReferenceResolver = (id: string) => boolean;

export interface RemarkTaskReferencesOptions {
  resolveTask?: TaskReferenceResolver;
}

/** A fragment is an inert delivery envelope, not a pretend browser route.
 * `/tasks/:id` has no route in this app; modifier-clicking it used to open the
 * session list, which rendered one failure as a different surface. */
export const TASK_REFERENCE_HREF_PREFIX = '#kteam-task-reference?';

const word = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}_]/u.test(value);

export function taskReferenceHref(id: string): string {
  const normalized = id.toUpperCase();
  if (!TASK_ID.test(normalized)) throw new TypeError('invalid task reference id');
  return `${TASK_REFERENCE_HREF_PREFIX}${new URLSearchParams({ id: normalized })}`;
}

export function parseTaskReferenceHref(href: string | undefined): string | null {
  if (!href?.startsWith(TASK_REFERENCE_HREF_PREFIX)) return null;
  const query = new URLSearchParams(href.slice(TASK_REFERENCE_HREF_PREFIX.length));
  if ([...query.keys()].some(key => key !== 'id')) return null;
  const ids = query.getAll('id');
  if (ids.length !== 1) return null;
  const id = ids[0]!.toUpperCase();
  return TASK_ID.test(id) ? id : null;
}

/** Lexical candidates only. The remark transform below still requires an
 * authoritative resolver before any match becomes a link. */
export function findTaskReferences(value: string): TaskReferenceMatch[] {
  const matches: TaskReferenceMatch[] = [];
  for (const match of value.matchAll(TASK_REFERENCE)) {
    const start = match.index;
    const raw = match[0];
    const id = match[1];
    if (start === undefined || !id || word(value[start - 1]) || word(value[start + raw.length])) continue;
    matches.push({ id: id.toUpperCase(), raw, start, end: start + raw.length });
  }
  return matches;
}

function linkifyText(value: string, resolveTask: TaskReferenceResolver): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const match of findTaskReferences(value)) {
    let resolved = false;
    try {
      resolved = resolveTask(match.id);
    } catch {
      resolved = false;
    }
    if (!resolved) continue;
    if (match.start > cursor) output.push({ type: 'text', value: value.slice(cursor, match.start) });
    output.push({
      type: 'link',
      url: taskReferenceHref(match.id),
      title: `Open task #${match.id}`,
      data: { hProperties: { 'data-task-reference': match.id } },
      children: [{ type: 'text', value: match.raw }],
    });
    cursor = match.end;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

function transform(node: MdNode, resolveTask: TaskReferenceResolver): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      children.push(...(linkifyText(child.value, resolveTask) ?? [child]));
      continue;
    }
    transform(child, resolveTask);
    children.push(child);
  }
  node.children = children;
}

export function remarkTaskReferences(options: RemarkTaskReferencesOptions = {}) {
  return (tree: MdNode): void => {
    if (!options.resolveTask) return;
    transform(tree, options.resolveTask);
  };
}
