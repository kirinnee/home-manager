// RTK (Rust Token Killer) plugin for OpenCode
// Rewrites shell commands to use rtk for token savings.
// Vendored from https://github.com/rtk-ai/rtk/blob/main/hooks/opencode/rtk.ts
import type { Plugin } from '@opencode-ai/plugin';

export const RtkOpenCodePlugin: Plugin = async ({ $ }) => {
  try {
    await $`which rtk`.quiet();
  } catch {
    console.warn('[rtk] rtk binary not found in PATH — plugin disabled');
    return {};
  }
  return {
    'tool.execute.before': async (input, output) => {
      const tool = String(input?.tool ?? '').toLowerCase();
      if (tool !== 'bash' && tool !== 'shell') return;
      const args = output?.args;
      if (!args || typeof args !== 'object') return;
      const command = (args as Record<string, unknown>).command;
      if (typeof command !== 'string' || !command) return;
      try {
        const result = await $`rtk rewrite ${command}`.quiet().nothrow();
        const rewritten = String(result.stdout).trim();
        if (rewritten && rewritten !== command) {
          (args as Record<string, unknown>).command = rewritten;
        }
      } catch {
        /* pass-through on error */
      }
    },
  };
};
