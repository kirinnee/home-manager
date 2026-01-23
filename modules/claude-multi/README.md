# Claude Multi-Account Module

A Home Manager module for managing multiple Claude Code accounts with **directory-based auto-detection**. Instead of manually invoking different binaries, a single `claude` command automatically switches accounts based on the current working directory.

## Overview

The module solves the problem of managing multiple Claude Code accounts (personal, work, client projects) by:

- Creating a smart `claude` wrapper that detects the current directory
- Matching against configurable directory rules per account (sorted by priority)
- Automatically setting the correct `CLAUDE_CONFIG_DIR`
- Providing explicit access via `claude-<name>` binaries when needed

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      User runs `claude`                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                Get Current Working Directory                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│         Check directory rules (sorted by priority)              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ ~/Workspace/    │  │ ~/Workspace/    │  │ ~ (home)        │  │
│  │   atomi (p=10)  │  │  work (p=50)    │  │  personal(p=1k) │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Set CLAUDE_CONFIG_DIR                       │
│         ~/.claude-atomi, ~/.claude-liftoff, ~/.claude-personal  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Execute claude binary                      │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Import the Module

```nix
# home-template.nix or your flake
{
  imports = [
    ./modules/claude-multi
  ];
}
```

### 2. Basic Configuration

```nix
{ config, lib, pkgs, ... }:
{
  programs.claude-multi = {
    enable = true;
    defaultAccount = "personal";  # Required: must exist in accounts

    accounts = {
      personal = {
        priority = 1000;  # Checked last (catch-all)
        directoryRules = [ "~" ];
        settings = { model = "opus"; };
      };

      work = {
        priority = 50;  # Checked before personal
        directoryRules = [ "~/Workspace/work" ];
        settings = { model = "sonnet"; };
      };
    };
  };
}
```

### 3. Usage

```bash
# Auto-detection (smart wrapper)
cd ~/Workspace/work && claude      # Uses work account
cd ~ && claude                     # Uses personal account

# Explicit access (direct binaries)
claude-personal                    # Force personal account
claude-work                        # Force work account
```

## Configuration Reference

### Top-Level Options

| Option                        | Type    | Default            | Description                                                     |
| ----------------------------- | ------- | ------------------ | --------------------------------------------------------------- |
| `enable`                      | bool    | `false`            | Enable the module                                               |
| `defaultPackage`              | package | `pkgs.claude-code` | Claude Code package to use                                      |
| `defaultAccount`              | string  | (required)         | Default account when CWD doesn't match (must exist in accounts) |
| `smartWrapper.enable`         | bool    | `true`             | Create smart `claude` wrapper                                   |
| `shellIntegration.functions`  | bool    | `false`            | Create `<name>-claude` shell functions                          |
| `shellIntegration.showActive` | bool    | `true`             | Add `_claude_active_account()` for prompts                      |

### Per-Account Options

| Option           | Type            | Default | Description                                      |
| ---------------- | --------------- | ------- | ------------------------------------------------ |
| `enable`         | bool            | `true`  | Whether this account is enabled                  |
| `priority`       | int             | `100`   | Matching priority (lower = checked first)        |
| `configDirName`  | string or null  | `null`  | Override config dir name (default: account name) |
| `directoryRules` | list of string  | `[ ]`   | Paths that trigger this account (supports `~`)   |
| `package`        | package or null | `null`  | Override package for this account                |
| `settings`       | attrs           | `{ }`   | Claude Code `settings.json` content              |
| `mcpServers`     | attrs           | `{ }`   | MCP server configurations                        |
| `memory.text`    | string or null  | `null`  | Inline `CLAUDE.md` content                       |
| `memory.source`  | path or null    | `null`  | `CLAUDE.md` file path to copy                    |
| `rules`          | attrs           | `{ }`   | Inline rule files (name → content)               |
| `rulesDir`       | path or null    | `null`  | Directory of rule files to symlink               |
| `agents`         | attrs           | `{ }`   | Inline agent files (name → content)              |
| `agentsDir`      | path or null    | `null`  | Directory of agent files to symlink              |
| `commands`       | attrs           | `{ }`   | Inline command files (name → content)            |
| `commandsDir`    | path or null    | `null`  | Directory of command files to symlink            |
| `hooks`          | attrs           | `{ }`   | Inline hook scripts (name → content, executable) |
| `hooksDir`       | path or null    | `null`  | Directory of hook files to symlink               |
| `skills`         | attrs           | `{ }`   | Inline skill files/directories (name → content)  |
| `skillsDir`      | path or null    | `null`  | Directory of skill files to symlink              |

## Priority and Directory Rules

Directory rules use **prefix matching** with **path boundary checks**:

- `~` matches your home directory exactly OR any path starting with `~/`
- `~/Workspace/work` matches `~/Workspace/work` exactly OR `~/Workspace/work/project`
- Does NOT match `~/Workspace/worker` (path boundary is respected)

**Priority determines check order** (lower numbers = checked first):

```nix
accounts = {
  # Priority 10: Most specific, checked first
  atomi = {
    priority = 10;
    directoryRules = [ "~/Workspace/atomi" ];
  };

  # Priority 50: Checked second
  liftoff = {
    priority = 50;
    directoryRules = [ "~/Workspace/work" ];
  };

  # Priority 1000: Catch-all, checked last
  personal = {
    priority = 1000;
    directoryRules = [ "~" ];
  };
};
```

## Full Configuration Example

```nix
{ config, lib, pkgs, ... }:
let
  # Import base configurations for reusability
  claudeBaseSettings = import ./modules/claude-config/base-settings.nix;
  claudeBaseMcpServers = import ./modules/claude-config/base-mcp.nix { };
in
{
  programs.claude-multi = {
    enable = true;
    defaultPackage = pkgs-unstable.claude-code;
    defaultAccount = "personal";

    smartWrapper.enable = true;

    shellIntegration = {
      functions = false;
      showActive = true;
    };

    accounts = {
      personal = {
        priority = 1000;  # Catch-all
        directoryRules = [ "~" ];
        settings = lib.recursiveUpdate claudeBaseSettings {
          env = {
            ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
            API_TIMEOUT_MS = "3000000";
          };
        };
        mcpServers = claudeBaseMcpServers;
        memory.source = ./modules/claude-config/CLAUDE.md;
      };

      liftoff = {
        priority = 50;
        directoryRules = [ "~/Workspace/work" ];
        settings = lib.recursiveUpdate claudeBaseSettings { };
        mcpServers = claudeBaseMcpServers;
        memory.source = ./modules/claude-config/CLAUDE.md;
      };

      atomi = {
        priority = 10;
        configDirName = "atomicloud";  # Creates ~/.claude-atomicloud
        directoryRules = [ "~/Workspace/atomi" ];
        settings = lib.recursiveUpdate claudeBaseSettings { };
        mcpServers = claudeBaseMcpServers;
        memory.source = ./modules/claude-config/CLAUDE.md;
      };
    };
  };
}
```

## Prompt Integration

### Zsh

Add to your `~/.p10k.zsh` or `~/.zshrc`:

```zsh
# Show active Claude account in prompt
typeset -g PROMPT_SEGMENTS+=(
  claude
)

# In your prompt segments definition
function prompt_claude() {
  local account=$(_claude_match_account)
  if [[ -n "$account" && "$account" != "personal" ]]; then
    p10k segment -b 1 -f 208 -t "🤖 $account"
  fi
}
```

### Starship

Add to `~/.config/starship.toml`:

```toml
[custom.claude]
description = "Show active Claude account"
when = """ _claude_active_account | grep -q '.' """
command = "_claude_active_account"
style = "bold purple"
format = "[$output]($style) "
```

### Custom Prompt

```zsh
# Simple version - add to your RPROMPT
RPROMPT='$(_claude_active_account)'

# Or use in your existing prompt
PROMPT='%~ $(_claude_active_account) %# '
```

## Generated Artifacts

After running `home-manager switch`, the following are created:

### Per Account

For each account named `<name>`:

- Config directory: `~/.claude-<name>/` (or `~/.claude-<configDirName>/` if set)
- `settings.json` with account-specific settings
- `mcp.json` if MCP servers are configured
- `CLAUDE.md` from `memory.text` or `memory.source`
- Optional `rules/`, `agents/`, `commands/`, `hooks/`, `skills/` directories

### Binaries and Functions

| Type          | Name            | Description                             |
| ------------- | --------------- | --------------------------------------- |
| Smart wrapper | `claude`        | Auto-detects account based on CWD       |
| Direct binary | `claude-<name>` | Force use of specific account           |
| Functions\*   | `<name>-claude` | Shell function for account (if enabled) |

\*Only if `shellIntegration.functions = true`

### Environment Variables

Set automatically by the wrapper:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-<name>"
```

## Migration from claude-config

### Before

```nix
imports = [ ./modules/claude-config ];
```

### After

```nix
imports = [ ./modules/claude-multi ];

let
  claudeBaseSettings = import ./modules/claude-config/base-settings.nix;
  claudeBaseMcpServers = import ./modules/claude-config/base-mcp.nix { };
in

programs.claude-multi = {
  enable = true;
  defaultAccount = "personal";  # Required!
  # ... configuration
};
```

### Environment Variables

Add these to your `home.sessionVariables`:

```nix
home.sessionVariables = {
  ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
  API_TIMEOUT_MS = "3000000";
};
```

### Packages

Remove the direct claude-code from packages:

```nix
# Before
home.packages = [
  pkgs-unstable.claude-code
];

# After - managed by claude-multi
home.packages = [
  # pkgs-unstable.claude-code  # Remove or comment
];
```

## Troubleshooting

### Account Not Switching

Check your current directory and rules:

```bash
pwd
echo $(_claude_match_account)
```

### Verify Configuration

```bash
# Check config files
ls -la ~/.claude*/
cat ~/.claude*/settings.json

# Test explicit account
claude-personal --version
claude-work --version
```

### Debug Mode

Temporarily add to your zshrc:

```zsh
claude-debug() {
  local cwd="$PWD"
  echo "Current: $cwd"
  echo "Matched: $(_claude_match_account)"
}
```

## Commands After Switch

| Command                  | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `claude`                 | Smart wrapper (auto-detects account)             |
| `claude-<name>`          | Direct binary for specific account               |
| `<name>-claude`          | Shell function for account (if enabled)          |
| `_claude_match_account`  | Internal function - returns matched account name |
| `_claude_active_account` | Prompt helper - returns bracketed account name   |

## Tips

1. **Use priority**: Lower numbers are checked first. Put specific directories at low priority numbers, catch-all at high numbers.
2. **Set `defaultAccount`**: This is required and must reference an existing account.
3. **MCP servers**: Configure per-account for different tool access.
4. **Prompt integration**: Use `_claude_active_account` to see which account is active.
5. **Memory files**: Use `memory.source` to share a single `CLAUDE.md` across accounts.
6. **Config dir override**: Use `configDirName` if you want a different directory name than the account name.
