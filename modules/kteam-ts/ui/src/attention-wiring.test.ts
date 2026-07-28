import { describe, expect, test } from 'bun:test';

describe('Attention UI composition', () => {
  test('the session header exposes Attention through side-pane and hostless-sheet paths', async () => {
    const source = await Bun.file(new URL('./components/SessionHeader.tsx', import.meta.url)).text();
    expect(source).toContain('<AttentionTrigger');
    expect(source).toContain("sidePane.toggle('attention', opener)");
    expect(source).toContain('<AttentionSheet');
    expect(source).toContain('{attentionTrigger}');
  });

  test('skill taps append to the live SessionChatPage draft', async () => {
    const source = await Bun.file(new URL('./pages/SessionChatPage.tsx', import.meta.url)).text();
    expect(source).toContain(
      'onInsertSkill={invocation => setDraft(current => appendSkillInvocation(current, invocation))}',
    );
  });

  test('the sidebar reads the Attention count and no legacy NeedsYou modules remain', async () => {
    const sidebar = await Bun.file(new URL('./components/AgentSidebar.tsx', import.meta.url)).text();
    expect(sidebar).toContain("from '../hooks/useAttention'");
    expect(sidebar).not.toContain('useNeedsYouCount');
    for (const legacy of [
      './components/NeedsYouPanel.tsx',
      './components/NeedsYouPanel.test.tsx',
      './hooks/useNeedsYou.ts',
    ]) {
      expect(await Bun.file(new URL(legacy, import.meta.url)).exists()).toBe(false);
    }
  });
});
