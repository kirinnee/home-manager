import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentMentionHref, remarkAgentMentions, type AgentMentionResolver } from '../lib/agent-mentions';
import { codeReferenceHref, remarkCodeReferences } from '../lib/code-references';
import { remarkTaskReferences, taskReferenceHref } from '../lib/remark-task-references';
import { codeReferenceHasTrustedOrigin, Markdown } from './Markdown';

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

  test('routes task hrefs but leaves an unproved authored code href inert', () => {
    const codeHref = codeReferenceHref({ path: 'src/app.ts', line: 12, endLine: 18 });
    const taskHref = taskReferenceHref('F64');
    const html = renderToStaticMarkup(
      <Markdown
        text={`[task](${taskHref}) [source](${codeHref}) [web](https://example.com/docs)`}
        sessionId="ms4-markdown"
        onTaskOpen={() => undefined}
        onCodeReferenceOpen={() => undefined}
      />,
    );

    expect(html).toContain('data-task-reference="F64"');
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
    const html = renderToStaticMarkup(<Markdown text="Review #F64 before shipping." />);
    expect(html).toContain('Review #F64 before shipping.');
    expect(html).not.toContain('data-task-reference');
    expect(html).not.toContain('href="/tasks/F64"');
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

  test('composes task, agent, and code grammars in precedence order without stealing email or paths', () => {
    const tree: TestMdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: '#F44 @ottis src/tasks.ts:44 tasks.ts#F44 someone@example.com @src/',
            },
          ],
        },
      ],
    };

    remarkTaskReferences()(tree);
    remarkAgentMentions({ resolveMention: mentions })(tree);
    remarkCodeReferences({ resolvePath: path => (path === 'src/tasks.ts' ? path : null) })(tree);

    expect(tree.children?.[0]?.children).toEqual([
      {
        type: 'link',
        url: '/tasks/F44',
        title: 'Open task #F44',
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
      { type: 'text', value: ' tasks.ts#F44 someone@example.com @src/' },
    ]);
  });
});
