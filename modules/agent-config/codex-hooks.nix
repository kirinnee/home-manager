# Codex hooks.json format
# Codex PreToolUse protocol is a strict subset of Claude's: it supports ONLY
# `permissionDecision: "deny"` — rejects `allow`, `ask`, `updatedInput`,
# `additionalContext`. So no RTK rewrite hook (prompt-based via AGENTS.md
# instead); only loctl runs here, and loctl must emit deny-only decisions.
{
  PreToolUse = [
    {
      matcher = "^Bash$";
      hooks = [
        {
          type = "command";
          command = "loctl hook-check --codex";
        }
      ];
    }
  ];
}
