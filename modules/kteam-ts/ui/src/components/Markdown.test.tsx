import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentMentionResolver } from '../lib/agent-mentions';
import { referenceHref, referenceIdentity, type ReferenceResolvers, type ResolvedReference } from '../lib/references';
import { Markdown, referenceHasTrustedOrigin } from './Markdown';

describe('Markdown canonical references', () => {
  const agents: AgentMentionResolver = lookup =>
    lookup.name === 'zelda' || lookup.sessionId === 'ms-zelda' ? { sessionId: 'ms-zelda', name: 'zelda' } : null;

  test('renders proven agent/task/attention tokens through one link shape', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="Ping :zelda about &F12 and !A3; leave &F99, !A8, #F12, ?A3, and @old-agent plain."
        sessionId="session-one"
        agentMentionResolver={agents}
        taskReferenceResolver={id => id === 'F12'}
        attentionReferenceResolver={id => id === 'A3'}
        onTaskOpen={() => undefined}
        onAttentionOpen={() => undefined}
      />,
    );

    expect(html.match(/data-kteam-reference=/gu)).toHaveLength(3);
    expect(html).toContain('data-kteam-reference="agent:ms-zelda"');
    expect(html).toContain('href="/session/ms-zelda"');
    expect(html).toContain('data-kteam-reference="task:F12"');
    expect(html).toContain('data-kteam-reference="attention:A3"');
    expect(html).toContain('&amp;F99');
    expect(html).toContain('!A8');
    expect(html).toContain('#F12');
    expect(html).toContain('?A3');
    expect(html).toContain('@old-agent');
  });

  test('leaves a file token plain until the session filesystem proves it exists', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="Inspect @src/app.ts:12-18, then keep `@src/inline.ts:3` literal."
        sessionId="ms-markdown"
        onCodeReferenceOpen={() => undefined}
      />,
    );
    expect(html).toContain('@src/app.ts:12-18');
    expect(html).toContain('@src/inline.ts:3');
    expect(html).not.toContain('data-kteam-reference');
  });

  test('a proven target without a delivery host stays readable and unlinked', () => {
    const html = renderToStaticMarkup(<Markdown text="Review &F12." taskReferenceResolver={id => id === 'F12'} />);
    expect(html).toContain('Review &amp;F12.');
    expect(html).not.toContain('data-kteam-reference');
    expect(html).not.toContain('href=');
  });

  test('forged unified hrefs and legacy reserved pin links are plain text', () => {
    const forged = referenceHref({ kind: 'task', id: 'F12' });
    const html = renderToStaticMarkup(
      <Markdown
        text={`&F12 [forged](${forged}) [pin: old](#kteam-pin-reference?session=one&id=pin)`}
        taskReferenceResolver={id => id === 'F12'}
        onTaskOpen={() => undefined}
      />,
    );
    expect(html.match(/data-kteam-reference=/gu)).toHaveLength(1);
    expect(html).toContain('forged');
    expect(html).toContain('pin: old');
    expect(html).not.toContain('>forged</a>');
    expect(html).not.toContain('>pin: old</a>');
    expect(html).not.toContain('#kteam-pin-reference');
  });

  test('trusted origin requires both the unified marker and fresh proof', () => {
    const reference: ResolvedReference = { kind: 'task', id: 'F12' };
    const resolvers: ReferenceResolvers = { task: id => id === 'F12' };
    expect(referenceHasTrustedOrigin(undefined, reference, resolvers)).toBeNull();
    expect(
      referenceHasTrustedOrigin(
        { properties: { 'data-kteam-reference': referenceIdentity(reference) } },
        reference,
        resolvers,
      ),
    ).toEqual(reference);
    expect(
      referenceHasTrustedOrigin({ properties: { 'data-kteam-reference': referenceIdentity(reference) } }, reference, {
        task: () => false,
      }),
    ).toBeNull();
  });
});
