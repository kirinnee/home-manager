# Example configuration for Claude Multi-Account Module
# This demonstrates a typical setup with personal, work, and client accounts

{ config, lib, pkgs, ... }:

let
  # Import base configurations for reusability
  # These provide common settings and MCP servers that can be extended per-account
  claudeBaseSettings = import ./modules/claude-config/base-settings.nix;
  claudeBaseMcpServers = import ./modules/claude-config/base-mcp.nix { };
in
{
  # Import the claude-multi module
  imports = [ ./modules/claude-multi ];

  programs.claude-multi = {
    enable = true;

    # Use the unstable version of claude-code
    # Ensure pkgs-unstable is defined in your home-manager config
    defaultPackage = pkgs.claude-code;

    # Default account when no directory rules match (REQUIRED, must exist in accounts)
    defaultAccount = "personal";

    # Enable the smart wrapper that auto-detects based on CWD
    smartWrapper.enable = true;

    # Shell integration options
    shellIntegration = {
      # Create personal-claude, liftoff-claude functions
      functions = false;

      # Add _claude_active_account() function for use in prompts
      showActive = true;
    };

    # Per-account configurations
    # Use 'priority' to control matching order (lower = checked first)
    accounts = {
      # Personal account - default fallback (highest priority number = checked last)
      personal = {
        priority = 1000; # Checked last (catch-all)

        directoryRules = [
          "~" # Matches home directory and all subdirs
        ];

        # Extend base settings with personal-specific overrides
        settings = lib.recursiveUpdate claudeBaseSettings {
          env = {
            ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
            API_TIMEOUT_MS = "3000000";
          };
        };

        # Use all base MCP servers
        mcpServers = claudeBaseMcpServers;

        # Share CLAUDE.md from the claude-config module
        memory.source = ./modules/claude-config/CLAUDE.md;
      };

      # Work account (Liftoff)
      liftoff = {
        priority = 50; # Checked before personal

        # Trigger for work-related directories
        directoryRules = [
          "~/Workspace/work" # Matches all work subdirectories
        ];

        settings = lib.recursiveUpdate claudeBaseSettings {
          # Work-specific settings overrides go here
          # For example, different model or settings
        };

        mcpServers = claudeBaseMcpServers;

        # Share the same CLAUDE.md
        memory.source = ./modules/claude-config/CLAUDE.md;
      };

      # Client account (AtomiCloud)
      atomi = {
        priority = 10; # Checked first (most specific)

        # Optional: override config directory name
        # configDirName = "atomicloud";  # Would create ~/.claude-atomicloud

        directoryRules = [
          "~/Workspace/atomi" # AtomiCloud projects
        ];

        settings = lib.recursiveUpdate claudeBaseSettings {
          # Atomi-specific settings
        };

        mcpServers = claudeBaseMcpServers;

        memory.source = ./modules/claude-config/CLAUDE.md;
      };
    };
  };

  # Global environment variables for Claude
  # These are shared across all accounts
  home.sessionVariables = {
    ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    API_TIMEOUT_MS = "3000000";
  };
}
