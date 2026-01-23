{ config, lib, pkgs, ... }:

let
  cfg = config.programs.claude-multi;
  jsonFormat = pkgs.formats.json { };

  # Helper to expand ~ in directory rules
  expandHome = path: (
    if lib.hasPrefix "~" path
    then config.home.homeDirectory + lib.substring 1 (lib.stringLength path) path
    else path
  );

  # Sort accounts by priority (lower = higher priority, checked first)
  sortedAccounts = lib.sort
    (a: b: a.value.priority < b.value.priority)
    (lib.mapAttrsToList (name: value: { inherit name value; })
      (lib.filterAttrs (n: v: v.enable) cfg.accounts));

  # Get config directory name for an account
  getConfigDir = name: accountCfg:
    if accountCfg.configDirName != null
    then ".claude-${accountCfg.configDirName}"
    else ".claude-${name}";

  # Transform MCP server config to the format expected by --mcp-config
  # Handles both formats:
  #   1. { transport = { type = "http"; url = "..."; }; disabled = false; }
  #   2. { command = "..."; args = [...]; disabled = false; }
  # Output format:
  #   1. { type = "http"; url = "..."; }
  #   2. { type = "stdio"; command = "..."; args = [...]; }
  transformMcpServer = serverCfg:
    let
      # Check if server is disabled
      isDisabled = serverCfg.disabled or false;
      # Check if it has a transport wrapper (http/sse/websocket)
      hasTransport = serverCfg ? transport;
      # Check if it's a stdio server (has command)
      isStdio = serverCfg ? command;
    in
    if isDisabled then null
    else if hasTransport then
    # Flatten transport wrapper: { transport = { type, url } } -> { type, url }
      serverCfg.transport
    else if isStdio then
    # Stdio server: add type field, keep command/args/env
      {
        type = "stdio";
      } // (lib.filterAttrs (n: v: n != "disabled") serverCfg)
    else
    # Unknown format, pass through (remove disabled field)
      lib.filterAttrs (n: v: n != "disabled") serverCfg;

  # Transform all MCP servers for an account, removing disabled ones
  transformMcpServers = servers:
    lib.filterAttrs (n: v: v != null)
      (lib.mapAttrs (name: transformMcpServer) servers);

  # Create a wrapped claude binary for an account with MCP config
  createWrappedClaude = name: accountCfg:
    let
      basePackage = if accountCfg.package != null then accountCfg.package else cfg.defaultPackage;
      claudeBinary = lib.getExe basePackage;
      # Transform MCP servers to the format expected by --mcp-config
      transformedServers = transformMcpServers accountCfg.mcpServers;
      mcpConfigFile = jsonFormat.generate "claude-${name}-mcp.json" {
        mcpServers = transformedServers;
      };
      hasMcp = transformedServers != { };
      mcpFlags = lib.optionalString hasMcp "--mcp-config ${mcpConfigFile}";
      configDir = getConfigDir name accountCfg;
      # Generate env var exports (supports shell expansion)
      envExports = lib.concatStringsSep "\n" (
        lib.mapAttrsToList (k: v: "export ${k}=${v}") accountCfg.env
      );
    in
    pkgs.writeShellScriptBin "claude-${name}" ''
      export CLAUDE_CONFIG_DIR="$HOME/${configDir}"
      ${envExports}
      exec ${claudeBinary} ${mcpFlags} "$@"
    '';

  # Generate the directory matching shell function (single source of truth)
  generateMatchFunction = ''
    _claude_match_account() {
      local cwd="$PWD"

      ${lib.concatMapStringsSep "\n" ({ name, value }:
        lib.concatMapStringsSep "\n" (rule:
          let expanded = expandHome rule;
          in ''
      # Rule for ${name}: ${rule}
      if [[ "$cwd" == "${expanded}" || "$cwd" == "${expanded}/"* ]]; then
        echo "${name}"
        return 0
      fi''
        ) value.directoryRules
      ) sortedAccounts}

      # Fallback to default account
      echo "${cfg.defaultAccount}"
    }
  '';

in
{
  options.programs.claude-multi = {
    enable = lib.mkEnableOption "Claude Multi-Account manager";

    defaultPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.claude-code;
      description = "Default Claude Code package to use";
    };

    defaultAccount = lib.mkOption {
      type = lib.types.str;
      description = "Default account when CWD doesn't match any rules (must exist in accounts)";
    };

    smartWrapper = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Create smart `claude` wrapper that auto-detects account";
      };
    };

    shellIntegration = {
      functions = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Create `<name>-claude` shell functions for each account";
      };

      showActive = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Add `_claude_active_account()` function for shell prompts";
      };
    };

    accounts = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule ({ name, config, ... }: {
        options = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable this account";
          };

          priority = lib.mkOption {
            type = lib.types.int;
            default = 100;
            description = "Priority for directory rule matching (lower = checked first). Use this to ensure specific directories match before general ones.";
          };

          configDirName = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Override the config directory name. Defaults to account name. Config will be at ~/.claude-<configDirName>";
          };

          directoryRules = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = "Directory patterns that trigger this account (supports ~ for home). More specific paths should be in higher-priority accounts.";
          };

          package = lib.mkOption {
            type = lib.types.nullOr lib.types.package;
            default = null;
            description = "Override package for this account";
          };

          settings = lib.mkOption {
            type = lib.types.attrs;
            default = { };
            description = "Claude Code settings.json content";
          };

          mcpServers = lib.mkOption {
            type = lib.types.attrs;
            default = { };
            description = "MCP server configurations";
          };

          memory = {
            text = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Inline CLAUDE.md content";
            };

            source = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "CLAUDE.md file path to copy";
            };
          };

          rules = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Inline rule files (attrset of filename => content). Extension is preserved as-is.";
          };

          rulesDir = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "Directory of rule files to symlink";
          };

          agents = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Inline agent files (attrset of filename => content). Extension is preserved as-is.";
          };

          agentsDir = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "Directory of agent files to symlink";
          };

          commands = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Inline command files (attrset of filename => content). Extension is preserved as-is.";
          };

          commandsDir = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "Directory of command files to symlink";
          };

          hooks = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Inline hook scripts (attrset of filename => content). Will be made executable.";
          };

          hooksDir = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "Directory of hook files to symlink";
          };

          skills = lib.mkOption {
            type = lib.types.attrs;
            default = { };
            description = "Inline skill files/directories (attrset of path => content or dir)";
          };

          skillsDir = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "Directory of skill files to symlink";
          };

          env = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            description = "Environment variables to export before running claude binary. Supports shell expansion (e.g. ANTHROPIC_AUTH_TOKEN = \"$ZAI_AUTH_TOKEN\")";
          };
        };
      }));
      default = { };
      description = "Per-account configurations";
    };
  };

  config = lib.mkIf cfg.enable (
    let
      enabledAccounts = lib.filterAttrs (n: v: v.enable) cfg.accounts;
      accountNames = lib.attrNames enabledAccounts;

      # Create wrapped packages for each account
      wrappedPackages = lib.mapAttrs createWrappedClaude enabledAccounts;

      # Generate the smart wrapper script
      smartWrapperScript = pkgs.writeShellScriptBin "claude" ''
        # Claude Multi-Account Smart Wrapper
        # Automatically switches accounts based on current working directory

        ${generateMatchFunction}

        # Main execution
        account=$(_claude_match_account)

        # Show which account is being used
        if [[ -n "$account" ]]; then
          echo "🔐 Using Claude account: $account" >&2
        fi

        case "$account" in
          ${lib.concatMapStringsSep "\n" ({ name, value }: ''
          "${name}")
            exec ${lib.getExe wrappedPackages.${name}} "$@"
            ;;''
          ) sortedAccounts}
          *)
            # Ultimate fallback to default account
            exec ${lib.getExe wrappedPackages.${cfg.defaultAccount}} "$@"
            ;;
        esac
      '';

    in
    {
      # Assertions
      assertions = [
        {
          assertion = cfg.defaultAccount != "" && lib.hasAttr cfg.defaultAccount cfg.accounts;
          message = "programs.claude-multi.defaultAccount must reference an existing account. Got '${cfg.defaultAccount}' but available accounts are: ${lib.concatStringsSep ", " accountNames}";
        }
        {
          assertion = accountNames != [ ];
          message = "programs.claude-multi requires at least one account to be defined";
        }
      ];

      # Create config directories and files for each account
      home.file = lib.foldlAttrs
        (acc: name: accountCfg:
          let
            configDir = getConfigDir name accountCfg;
          in
          acc // {
            # Settings.json
            "${configDir}/settings.json".text = builtins.toJSON (
              accountCfg.settings // {
                "$schema" = "https://json.schemastore.org/claude-code-settings.json";
              }
            );

            # CLAUDE.md
          } // lib.optionalAttrs (accountCfg.memory.text != null || accountCfg.memory.source != null) {
            "${configDir}/CLAUDE.md" =
              if accountCfg.memory.text != null then { text = accountCfg.memory.text; }
              else { source = accountCfg.memory.source; };
          }

          # Symlink directories
          // lib.optionalAttrs (accountCfg.rulesDir != null) {
            "${configDir}/rules".source = accountCfg.rulesDir;
          }
          // lib.optionalAttrs (accountCfg.agentsDir != null) {
            "${configDir}/agents".source = accountCfg.agentsDir;
          }
          // lib.optionalAttrs (accountCfg.commandsDir != null) {
            "${configDir}/commands".source = accountCfg.commandsDir;
          }
          // lib.optionalAttrs (accountCfg.hooksDir != null) {
            "${configDir}/hooks".source = accountCfg.hooksDir;
          }
          // lib.optionalAttrs (accountCfg.skillsDir != null) {
            "${configDir}/skills".source = accountCfg.skillsDir;
          }

          # Inline rules (filename preserved as-is)
          // lib.mapAttrs'
            (ruleName: ruleContent: {
              name = "${configDir}/rules/${ruleName}";
              value.text = ruleContent;
            })
            accountCfg.rules

          # Inline agents (filename preserved as-is)
          // lib.mapAttrs'
            (agentName: agentContent: {
              name = "${configDir}/agents/${agentName}";
              value.text = agentContent;
            })
            accountCfg.agents

          # Inline commands (filename preserved as-is)
          // lib.mapAttrs'
            (cmdName: cmdContent: {
              name = "${configDir}/commands/${cmdName}";
              value.text = cmdContent;
            })
            accountCfg.commands

          # Inline hooks (executable)
          // lib.mapAttrs'
            (hookName: hookContent: {
              name = "${configDir}/hooks/${hookName}";
              value = {
                text = hookContent;
                executable = true;
              };
            })
            accountCfg.hooks

          # Inline skills (can be files or directories)
          // lib.mapAttrs'
            (skillName: skillContent:
              if lib.isPath skillContent && lib.pathIsDirectory skillContent then
                { name = "${configDir}/skills/${skillName}"; value.source = skillContent; }
              else if lib.isPath skillContent then
                { name = "${configDir}/skills/${skillName}"; value.source = skillContent; }
              else
                { name = "${configDir}/skills/${skillName}"; value.text = skillContent; }
            )
            accountCfg.skills
        )
        { }
        enabledAccounts;

      # Shell integration: functions and prompt helper
      programs.zsh.initContent = lib.mkIf (config.programs.zsh.enable && (cfg.shellIntegration.functions || cfg.shellIntegration.showActive)) (
        let
          # Shell functions (alternative to aliases)
          functionDefs = lib.optionalString cfg.shellIntegration.functions (
            lib.concatStringsSep "\n" (lib.mapAttrsToList
              (name: accountCfg: ''
                ${name}-claude() {
                  ${lib.getExe wrappedPackages.${name}} "$@"
                }
              '')
              enabledAccounts)
          );

          # Prompt integration function
          activeFunction = lib.optionalString cfg.shellIntegration.showActive ''
            ${generateMatchFunction}

            _claude_active_account() {
              local account=$(_claude_match_account)
              if [[ -n "$account" && "$account" != "${cfg.defaultAccount}" ]]; then
                echo "[$account]"
              fi
            }
          '';
        in
        lib.mkAfter (functionDefs + activeFunction)
      );

      # Add smart wrapper and wrapped packages
      home.packages =
        (lib.optionals cfg.smartWrapper.enable [ smartWrapperScript ]) ++
        (lib.attrValues wrappedPackages);
    }
  );
}
