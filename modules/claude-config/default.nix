{ config, lib, pkgs, ... }:
let
  baseConfig = import ./base-settings.nix;
in
{
  # Personal Claude config (~/.claude)
  home.file.".claude/settings.json".text = builtins.toJSON (lib.recursiveUpdate baseConfig {
    env = {
      ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
      API_TIMEOUT_MS = "3000000";
    };
  });

  home.file.".claude/CLAUDE.md".source = ./CLAUDE.md;

  # Work Claude config (~/.claude-work)
  home.file.".claude-work/settings.json".text = builtins.toJSON (lib.recursiveUpdate baseConfig { });
  home.file.".claude-work/CLAUDE.md".source = ./CLAUDE.md;
}
