{ config, lib, pkgs, ... }:

let
  claudeConfigDir = ./../../claude-config;
in
{
  # Personal Claude config (~/.claude)
  home.file.".claude/settings.json".source = "${claudeConfigDir}/claude-settings.json";
  home.file.".claude/CLAUDE.md".source = "${claudeConfigDir}/CLAUDE.md";

  # Work Claude config (~/.claude-work)
  home.file.".claude-work/settings.json".source = "${claudeConfigDir}/claude-work-settings.json";
  home.file.".claude-work/CLAUDE.md".source = "${claudeConfigDir}/CLAUDE.md";
}
