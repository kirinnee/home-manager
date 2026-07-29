// Compatibility surface for excluded SidePane owners.
//
// Parsing, resolution, hrefs, and remark transformation moved to references.ts.
// Delete this adapter once SidePane imports its file-open contract there.

import { referenceHref, type CodeReference } from './references';

export { formatCodeReference, type CodeReference, type CodeReferenceOpenRequest } from './references';

/** Compatibility helper for tests and old persisted links. New parsing/hrefs
 * are owned by references.ts and written file tokens never include columns. */
export function codeReferenceHref(reference: CodeReference): string {
  return referenceHref({
    kind: 'file',
    path: reference.path,
    ...(reference.line === undefined ? {} : { line: reference.line }),
    ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
  });
}
