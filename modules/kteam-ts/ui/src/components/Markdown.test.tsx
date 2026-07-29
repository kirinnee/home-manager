import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentMentionHref, remarkAgentMentions, type AgentMentionResolver } from '../lib/agent-mentions';
import { codeReferenceHref, remarkCodeReferences } from '../lib/code-references';
import { remarkTaskReferences, taskReferenceHref } from '../lib/remark-task-references';
import {
  attentionReferenceHref,
  pinReferenceHref,
  pinReferenceMarkdown,
  remarkSessionReferences,
} from '../lib/remark-session-references';
import {
  attentionReferenceHasTrustedOrigin,
  codeReferenceHasTrustedOrigin,
  Markdown,
  pinReferenceHasTrustedOrigin,
} from './Markdown';

interface TestMdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  data?: {
    hProperties?: Record<string, string>;
  };
  properties?: Record<string, unknown>;
  children?: TestMdNode[];
}

describe('Markdown in-app references', () => {
  const mentions: AgentMentionResolver = lookup => {
    if (lookup.sessionId === 'ms-ottis') return { sessionId: 'ms-ottis', name: 'ottis' };
    if (lookup.sessionId === 'ms-mileena') return { sessionId: 'ms-mileena', name: 'mileena' };
    if (lookup.name?.toLowerCase() === 'ottis') return { sessionId: 'ms-ottis', name: 'ottis' };
    return null;
  };

  test('renders proven bare and canonical agent mentions as session links, using the current callsign', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={`Ping @ottis. Then [@old-name](${agentMentionHref('ms-mileena')}); leave @missing, someone@example.com, and @src/ plain.`}
        agentMentionResolver={mentions}
      />,
    );

    expect(html.match(/data-agent-mention=/g)).toHaveLength(2);
    expect(html).toContain('data-agent-mention="ms-ottis"');
    expect(html).toContain('href="/session/ms-ottis"');
    expect(html).toContain('data-agent-mention="ms-mileena"');
    expect(html).toContain('href="/session/ms-mileena"');
    expect(html).toContain('@mileena');
    expect(html).not.toContain('@old-name');
    expect(html).not.toContain('#kteam-agent-mention');
    expect(html).toContain('@missing,');
    expect(html).toContain('href="mailto:someone@example.com"');
    expect(html).toContain('and @src/ plain');
  });

  test('strips an unresolvable canonical mention destination instead of painting a dead link', () => {
    const html = renderToStaticMarkup(
      <Markdown text={`[@gone](${agentMentionHref('ms-gone')}) and @unknown`} agentMentionResolver={() => null} />,
    );
    expect(html).toContain('@gone and @unknown');
    expect(html).not.toContain('data-agent-mention');
    expect(html).not.toContain('href=');
  });

  test('routes only proven transform-authored tasks and leaves authored reserved hrefs inert', () => {
    const codeHref = codeReferenceHref({ path: 'src/app.ts', line: 12, endLine: 18 });
    const taskHref = taskReferenceHref('F64');
    const html = renderToStaticMarkup(
      <Markdown
        text={`#F64 [forged-task](${taskHref}) [source](${codeHref}) [web](https://example.com/docs)`}
        sessionId="ms4-markdown"
        onTaskOpen={() => undefined}
        onCodeReferenceOpen={() => undefined}
        taskReferenceResolver={id => id === 'F64'}
      />,
    );

    expect(html).toContain('data-task-reference="F64"');
    expect(html).toContain('forged-task');
    expect(html).toContain('source');
    expect(html).not.toContain('data-code-reference');
    expect(html).not.toContain('#kteam-code-reference');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html.match(/data-task-reference=/g)).toHaveLength(1);
  });

  test('leaves code-shaped prose plain until the session filesystem proves it exists', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="Inspect @src/app.ts:12-18, then keep `src/inline.ts:3` literal."
        sessionId="ms4-markdown"
        onCodeReferenceOpen={() => undefined}
      />,
    );

    expect(html).toContain('@src/app.ts:12-18');
    expect(html).toContain('src/inline.ts:3');
    expect(html).not.toContain('data-code-reference');
  });

  test('leaves reserved task delivery hrefs inert when no in-app opener exists', () => {
    const html = renderToStaticMarkup(
      <Markdown text="Review #F64 before shipping." taskReferenceResolver={id => id === 'F64'} />,
    );
    expect(html).toContain('Review #F64 before shipping.');
    expect(html).not.toContain('data-task-reference');
    expect(html).not.toContain('#kteam-task-reference');
  });

  test('renders only resolver-proven attention references with an exact opener', () => {
    const forged = attentionReferenceHref('A3');
    const html = renderToStaticMarkup(
      <Markdown
        text={`Resolve ?A3; leave ?A8 and [forged](${forged}) inert.`}
        sessionId="session-one"
        attentionReferenceResolver={id => id === 'A3'}
        onAttentionOpen={() => undefined}
      />,
    );
    expect(html.match(/data-attention-reference=/g)).toHaveLength(1);
    expect(html).toContain('data-attention-reference="A3"');
    expect(html).toContain('?A8 and forged inert');
  });

  test('renders only canonical, snapshot-proven pins with an exact opener', () => {
    const pin = { sessionId: 'session-one', pinId: 'pin-3', label: 'Release decision' };
    const href = pinReferenceHref(pin);
    const html = renderToStaticMarkup(
      <Markdown
        text={`${pinReferenceMarkdown(pin)} [forged](${href}) [pin: missing](${pinReferenceHref({ sessionId: 'session-one', pinId: 'gone' })})`}
        sessionId="session-one"
        pinReferenceResolver={lookup => (lookup.sessionId === pin.sessionId && lookup.pinId === pin.pinId ? pin : null)}
        onPinOpen={() => undefined}
      />,
    );
    expect(html.match(/data-pin-reference=/g)).toHaveLength(1);
    expect(html).toContain('data-pin-reference="pin-3"');
    expect(html).toContain('data-pin-session="session-one"');
    expect(html).toContain('pin: Release decision');
    expect(html).toContain('forged');
    expect(html).toContain('pin: missing');
    expect(html).not.toContain('>forged</a>');
    expect(html).not.toContain('>pin: missing</a>');
  });

  test('rejects a forged reserved href even when another mention resolves the same path', () => {
    const forgedReference = { path: 'src/app.ts', line: 999 };
    const tree: TestMdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: codeReferenceHref(forgedReference),
              children: [{ type: 'text', value: 'forged' }],
            },
            { type: 'text', value: ' beside src/app.ts:4' },
          ],
        },
      ],
    };

    remarkCodeReferences({ resolvePath: path => (path === 'src/app.ts' ? path : null) })(tree);
    const children = tree.children?.[0]?.children ?? [];
    const authored = children[0];
    const generated = children[2];
    const resolved = new Set(['src/app.ts']);

    expect(authored?.data).toBeUndefined();
    expect(generated?.data).toEqual({ hProperties: { 'data-code-reference': 'src/app.ts' } });
    expect(codeReferenceHasTrustedOrigin(authored, forgedReference, resolved)).toBe(false);
    expect(
      codeReferenceHasTrustedOrigin(
        { properties: generated?.data?.hProperties },
        { path: 'src/app.ts', line: 4 },
        resolved,
      ),
    ).toBe(true);
  });

  test('requires both resolver proof and the attention transform origin marker', () => {
    const resolver = (id: string) => id === 'A3';
    expect(attentionReferenceHasTrustedOrigin(undefined, 'A3', resolver)).toBe(false);
    expect(
      attentionReferenceHasTrustedOrigin({ properties: { 'data-attention-reference': 'A3' } }, 'A3', resolver),
    ).toBe(true);
  });

  test('requires pin transform origin and re-resolves the exact session plus id', () => {
    const reference = { sessionId: 'session-one', pinId: 'pin-3' };
    const resolver = () => ({ ...reference, label: 'Release decision' });
    expect(pinReferenceHasTrustedOrigin(undefined, reference, resolver)).toBeNull();
    expect(
      pinReferenceHasTrustedOrigin(
        { properties: { 'data-pin-reference': 'pin-3', 'data-pin-session': 'session-one' } },
        reference,
        resolver,
      ),
    ).toEqual({ ...reference, label: 'Release decision' });
    expect(
      pinReferenceHasTrustedOrigin(
        { properties: { 'data-pin-reference': 'pin-3', 'data-pin-session': 'another-session' } },
        reference,
        resolver,
      ),
    ).toBeNull();
  });

  test('composes task, attention, pin, agent, and code grammars in one precedence order', () => {
    const pin = { sessionId: 'session-one', pinId: 'pin-3', label: 'Release decision' };
    const tree: TestMdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: '#F44 @ottis src/tasks.ts:44 ?A3 ',
            },
            {
              type: 'link',
              url: pinReferenceHref(pin),
              children: [{ type: 'text', value: 'pin: stale decision' }],
            },
            { type: 'text', value: ' tasks.ts#F44 someone@example.com @src/' },
          ],
        },
      ],
    };

    remarkTaskReferences({ resolveTask: id => id === 'F44' })(tree);
    remarkSessionReferences({
      resolveAttention: id => id === 'A3',
      resolvePin: lookup => (lookup.sessionId === pin.sessionId && lookup.pinId === pin.pinId ? pin : null),
    })(tree);
    remarkAgentMentions({ resolveMention: mentions })(tree);
    remarkCodeReferences({ resolvePath: path => (path === 'src/tasks.ts' ? path : null) })(tree);

    expect(tree.children?.[0]?.children).toEqual([
      {
        type: 'link',
        url: '#kteam-task-reference?id=F44',
        title: 'Open task #F44',
        data: { hProperties: { 'data-task-reference': 'F44' } },
        children: [{ type: 'text', value: '#F44' }],
      },
      { type: 'text', value: ' ' },
      {
        type: 'link',
        url: agentMentionHref('ms-ottis'),
        title: "Open @ottis's session",
        data: { hProperties: { 'data-agent-mention': 'ms-ottis' } },
        children: [{ type: 'text', value: '@ottis' }],
      },
      { type: 'text', value: ' ' },
      {
        type: 'link',
        url: codeReferenceHref({ path: 'src/tasks.ts', line: 44 }),
        title: 'Open src/tasks.ts at line 44',
        data: { hProperties: { 'data-code-reference': 'src/tasks.ts' } },
        children: [{ type: 'text', value: 'src/tasks.ts:44' }],
      },
      { type: 'text', value: ' ' },
      {
        type: 'link',
        url: attentionReferenceHref('A3'),
        title: 'Open attention ?A3',
        data: { hProperties: { 'data-attention-reference': 'A3' } },
        children: [{ type: 'text', value: '?A3' }],
      },
      { type: 'text', value: ' ' },
      {
        type: 'link',
        url: pinReferenceHref(pin),
        title: 'Open pin: Release decision',
        data: { hProperties: { 'data-pin-reference': 'pin-3', 'data-pin-session': 'session-one' } },
        children: [{ type: 'text', value: 'pin: Release decision' }],
      },
      { type: 'text', value: ' tasks.ts#F44 someone@example.com @src/' },
    ]);
  });
});
