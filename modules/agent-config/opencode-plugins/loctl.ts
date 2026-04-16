// loctl hook-check plugin for OpenCode
// Pipes opencode tool-execute payload as JSON to `loctl hook-check --opencode`
// and blocks the tool call when loctl denies (exit 2 + stderr reason).
//
// Protocol (stdin to loctl):
//   { "hook_event_name": "tool.execute.before", "tool_name": "...", "tool_input": { ... } }
//
// Exit codes:
//   0       allow (pass through, no opinion)
//   2       deny — stderr becomes the block reason surfaced to the model
//   other   treated as allow (non-fatal failure)
import type { Plugin } from '@opencode-ai/plugin';

export const LoctlOpenCodePlugin: Plugin = async ({ $ }) => {
  try {
    await $`which loctl`.quiet();
  } catch {
    console.warn('[loctl] loctl binary not found in PATH — plugin disabled');
    return {};
  }
  return {
    'tool.execute.before': async (input, output) => {
      const tool = String(input?.tool ?? '').toLowerCase();
      if (tool !== 'bash' && tool !== 'shell') return;
      const args = output?.args;
      if (!args || typeof args !== 'object') return;

      const payload = JSON.stringify({
        hook_event_name: 'tool.execute.before',
        tool_name: input.tool,
        tool_input: args,
      });

      const result = await $`echo ${payload} | loctl hook-check --opencode`.quiet().nothrow();

      if (result.exitCode === 2) {
        const reason = String(result.stderr ?? '').trim() || 'loctl: blocked';
        throw new Error(reason);
      }
      // exit 0 or anything else → allow
    },
  };
};
