# Base Claude Code settings for multi-account configuration
# See: https://docs.anthropic.com/en/docs/claude-code/hooks
{
  PreToolUse = [
    {
      matcher = "Bash";
      hooks = [
        {
          type = "command";
          command = "$HOME/.claude/hooks/rtk-rewrite.sh";
        }
      ];
    }
  ];
}
