# Codex auto hooks.json format (no loctl hook-check)
{
  PreToolUse = [
    {
      matcher = "Bash";
      hooks = [
        {
          type = "command";
          command = "hooks/rtk-rewrite.sh";
        }
      ];
    }
  ];
}
