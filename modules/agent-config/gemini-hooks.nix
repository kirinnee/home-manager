# Gemini CLI hook config — merged into settings.json under the `hooks` key.
# Gemini uses a different protocol than Claude/Codex:
#   - Event name: BeforeTool (not PreToolUse)
#   - Shell tool: run_shell_command (regex matcher)
#   - Output: top-level {decision, reason} or {decision, hookSpecificOutput}
{
  BeforeTool = [
    {
      matcher = "run_shell_command";
      hooks = [
        {
          type = "command";
          command = "loctl hook-check --gemini";
        }
        {
          type = "command";
          command = "hooks/rtk-rewrite-gemini.sh";
        }
      ];
    }
  ];
}
