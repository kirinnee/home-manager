# Codex hooks.json format
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
