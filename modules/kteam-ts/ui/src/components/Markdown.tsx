// Memoized markdown renderer for assistant prose. Heavy to parse, so it is
// wrapped in React.memo keyed on the raw text — a live append elsewhere in the
// transcript never re-parses existing assistant blocks.
//
// FENCES ARE HIGHLIGHTED BY THE SHARED REGISTRY, not by `rehype-highlight`.
// That plugin brings lowlight and its own copy of Highlight.js's common set —
// a second full parser bundle next to the one CodeBlock already loaded, for a
// set of languages this app enumerates exactly (lib/highlight.ts). A `code`
// renderer does the same job against the shared registry, so the parsers are
// downloaded once and only the ones we can actually use.
//
// Unknown or absent fence language ⇒ react-markdown's own escaped text, exactly
// as before. Nothing is auto-detected.

import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { agentSessionHref, type AgentMentionResolver } from '../lib/agent-mentions';
import { useAgentMentionResolver } from '../lib/agent-mention-context';
import {
  findReferences,
  parseReferenceHref,
  referenceHref,
  referenceIdentity,
  remarkReferences,
  revalidateReference,
  type AttentionReferenceResolver,
  type CodeReference,
  type ReferenceResolvers,
  type ResolvedReference,
  type TaskReferenceResolver,
} from '../lib/references';
import { fenceLanguage, highlightToHtml } from '../lib/highlight';
import { useAttentionCache } from '../hooks/useAttention';
import { remarkTableLabels } from '../lib/remark-table-labels';
import { navigate } from '../lib/router';
import { useTaskReferenceResolver } from '../lib/task-reference-context';
import { type PinReferenceLookup, type PinReferenceResolver } from '../lib/pin-links';
import { resolveFsFilePaths } from './files-api';
import { InAppBrowserLink } from './InAppBrowser';

interface ResolvedCodeReferences {
  key: string;
  paths: ReadonlyMap<string, string>;
}

const EMPTY_RESOLVED_PATHS: ReadonlyMap<string, string> = new Map();

interface MarkdownAstLinkNode {
  properties?: Readonly<Record<string, unknown>>;
}

/** @internal Kept exported so the forged-link policy has a focused regression. */
export function referenceHasTrustedOrigin(
  node: MarkdownAstLinkNode | null | undefined,
  reference: ResolvedReference,
  resolvers: ReferenceResolvers,
): ResolvedReference | null {
  if (node?.properties?.['data-kteam-reference'] !== referenceIdentity(reference)) return null;
  return revalidateReference(reference, resolvers);
}

export interface MarkdownProps {
  text: string;
  className?: string;
  /** Session filesystem context. Without it, code-shaped text stays plain. */
  sessionId?: string;
  cwd?: string;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: Parameters<AttentionReferenceResolver>[0], opener?: HTMLElement | null) => void;
  /** Tests/embedders may supply an authoritative fleet resolver. The app-wide
   * provider is used otherwise; without proof, mention-shaped text stays plain. */
  agentMentionResolver?: AgentMentionResolver;
  /** Tests/embedders may supply an authoritative task index. The app-wide
   * provider is used otherwise; syntax alone never paints a task link. */
  taskReferenceResolver?: TaskReferenceResolver;
  attentionReferenceResolver?: AttentionReferenceResolver;
  /** @deprecated Pins are no longer references. Retained only while excluded
   * SidePane owners remove their compatibility props. */
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
  /** @deprecated Pins are no longer references. */
  pinReferenceResolver?: PinReferenceResolver;
}

export const Markdown = memo(function Markdown({
  text,
  className,
  sessionId,
  cwd,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  agentMentionResolver,
  taskReferenceResolver,
  attentionReferenceResolver,
}: MarkdownProps) {
  const fleetAgentMentionResolver = useAgentMentionResolver();
  const resolveAgentMention = agentMentionResolver ?? fleetAgentMentionResolver;
  const fleetTaskReferenceResolver = useTaskReferenceResolver();
  const resolveTaskReference = taskReferenceResolver ?? fleetTaskReferenceResolver;
  const attentionCache = useAttentionCache();
  const attentionSnapshot = sessionId ? attentionCache.sessions[sessionId] : undefined;
  const sessionAttentionResolver = useMemo<AttentionReferenceResolver>(() => {
    const ids = new Set([
      ...(attentionSnapshot?.items.map(item => item.id) ?? []),
      ...(attentionSnapshot?.resolved.map(item => item.id) ?? []),
    ]);
    return id => ids.has(id);
  }, [attentionSnapshot]);
  const resolveAttentionReference = attentionReferenceResolver ?? sessionAttentionResolver;
  const codeReferenceCandidates = useMemo(
    () => [
      ...new Set(
        findReferences(text).flatMap(match => (match.reference.kind === 'file' ? [match.reference.path] : [])),
      ),
    ],
    [text],
  );
  const resolutionKey = JSON.stringify([sessionId ?? null, cwd ?? null, codeReferenceCandidates]);
  const [resolvedCodeReferences, setResolvedCodeReferences] = useState<ResolvedCodeReferences | null>(null);

  useEffect(() => {
    if (!sessionId || !onCodeReferenceOpen || codeReferenceCandidates.length === 0) return undefined;
    const controller = new AbortController();
    void resolveFsFilePaths(sessionId, codeReferenceCandidates, cwd, controller.signal)
      .then(paths => {
        if (!controller.signal.aborted) setResolvedCodeReferences({ key: resolutionKey, paths });
      })
      .catch(() => {
        // Resolution is an enhancement, never a reason prose should fail to
        // render. A missing/offline/older daemon leaves the authored text plain.
        if (!controller.signal.aborted) setResolvedCodeReferences({ key: resolutionKey, paths: EMPTY_RESOLVED_PATHS });
      });
    return () => controller.abort();
  }, [codeReferenceCandidates, cwd, onCodeReferenceOpen, resolutionKey, sessionId]);

  // A response from the previous session/text must never briefly paint a live
  // link in the next one while its own existence checks are still in flight.
  const resolvedPaths =
    resolvedCodeReferences?.key === resolutionKey ? resolvedCodeReferences.paths : EMPTY_RESOLVED_PATHS;
  const resolvedCanonicalPaths = useMemo(() => new Set(resolvedPaths.values()), [resolvedPaths]);
  const transformResolvers: ReferenceResolvers = {
    agent: resolveAgentMention,
    file: path => resolvedPaths.get(path) ?? null,
    task: resolveTaskReference,
    attention: resolveAttentionReference,
  };
  const trustedResolvers: ReferenceResolvers = {
    ...transformResolvers,
    file: path => (resolvedCanonicalPaths.has(path) ? path : null),
  };

  return (
    <div className={`md min-w-0 max-w-full ${className ?? ''}`}>
      <ReactMarkdown
        // remarkTableLabels stamps each body cell with its column header as
        // `data-label`, which the mobile stacked-card layout prints. It must run
        // after remark-gfm has produced the table nodes.
        remarkPlugins={[remarkGfm, remarkTableLabels, [remarkReferences, { resolvers: transformResolvers }]]}
        components={{
          a: ({ node, href, onClick, children, ...rest }) => {
            const parsed = parseReferenceHref(href);
            if (parsed === null) {
              // Old reserved destinations, including pin links, are readable
              // migration text rather than dead links.
              if (href?.startsWith('#kteam-') || href?.includes('#kteam-agent-mention')) return <>{children}</>;
              return (
                <InAppBrowserLink href={href} onClick={onClick} {...rest}>
                  {children}
                </InAppBrowserLink>
              );
            }
            const target = referenceHasTrustedOrigin(node, parsed, trustedResolvers);
            const hasOpener =
              target?.kind === 'agent' ||
              (target?.kind === 'file' && onCodeReferenceOpen !== undefined) ||
              (target?.kind === 'task' && onTaskOpen !== undefined) ||
              (target?.kind === 'attention' && onAttentionOpen !== undefined);
            if (!target || !hasOpener) return <>{children}</>;
            const destination = target.kind === 'agent' ? agentSessionHref(target.sessionId) : referenceHref(target);
            return (
              <a
                href={destination}
                data-kteam-reference={referenceIdentity(target)}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  onClick?.(event);
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  switch (target.kind) {
                    case 'agent':
                      navigate(agentSessionHref(target.sessionId));
                      break;
                    case 'file':
                      onCodeReferenceOpen?.(
                        {
                          path: target.path,
                          ...(target.line === undefined ? {} : { line: target.line }),
                          ...(target.endLine === undefined ? {} : { endLine: target.endLine }),
                        },
                        event.currentTarget,
                      );
                      break;
                    case 'task':
                      onTaskOpen?.(target.id, event.currentTarget);
                      break;
                    case 'attention':
                      onAttentionOpen?.(target.id, event.currentTarget);
                      break;
                  }
                }}
                {...rest}
              >
                {children}
              </a>
            );
          },
          // Tables wrap aggressively to fit the pane and may full-bleed past the
          // prose measure (index.css `.md table` / `.md-table-scroll`). The
          // scroller is the last-resort catch for a table that still cannot
          // shrink, so a wide table scrolls INSIDE itself and never the page.
          //
          // On a phone the layout switches cells to `display:block` stacked
          // cards, which strips the implicit ARIA table semantics. The explicit
          // roles here (plus `scope="col"` on headers) preserve the
          // header-to-cell association for a screen reader across that switch;
          // on desktop they are the elements' implicit roles, so they are inert.
          table: ({ node: _node, ...rest }) => (
            <div className="md-table-scroll scroll-thin">
              <table role="table" {...rest} />
            </div>
          ),
          thead: ({ node: _node, ...rest }) => <thead role="rowgroup" {...rest} />,
          tbody: ({ node: _node, ...rest }) => <tbody role="rowgroup" {...rest} />,
          tr: ({ node: _node, ...rest }) => <tr role="row" {...rest} />,
          th: ({ node: _node, ...rest }) => <th role="columnheader" scope="col" {...rest} />,
          td: ({ node: _node, ...rest }) => <td role="cell" {...rest} />,
          code: ({ node: _node, className, children, ...rest }) => {
            const lang = fenceLanguage(className);
            const source = lang ? String(children).replace(/\n$/, '') : '';
            const html = lang ? highlightToHtml(source, lang) : null;
            // No language (inline code, bare fence) or an unknown one: hand it
            // back to react-markdown, which escapes it. Never raw HTML.
            if (html === null) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={`hljs language-${lang}`}
                // Safe: Highlight.js output over text it escaped itself, and the
                // branch above covers every input it refused.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
