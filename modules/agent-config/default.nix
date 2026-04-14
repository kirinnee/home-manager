let baseSettings = import ./base-settings.nix; in
let baseMcp = import ./base-mcp.nix; in
let baseHooks = import ./base-hooks.nix; in
let autoHooks = import ./auto-hooks.nix; in
let codexSettings = import ./codex-settings.nix; in
let codexHooksConfig = import ./codex-hooks.nix; in
let codexAutoHooksConfig = import ./codex-auto-hooks.nix; in
let geminiSettings = import ./gemini-settings.nix; in
let opencodeSettings = import ./opencode-settings.nix; in
let auth = import ./auth.nix; in
let baseEnv = import ./base-env.nix; in
let rtk = builtins.readFile ./RTK.md; in
let sharedMemory = builtins.readFile ./CLAUDE.md + "\n" + rtk; in
let autoMemory = builtins.readFile ./CLAUDE-autonomous.md + "\n" + rtk; in
let sharedSkills = ./skills; in

let
  # --- Claude ---
  claudeUserConfig = {
    settings = baseSettings // { hooks = baseHooks; };
    mcpServers = baseMcp;
    memory.text = sharedMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
  };

  claudeAutoConfig = {
    settings = baseSettings // { hooks = autoHooks; };
    mcpServers = baseMcp;
    memory.text = autoMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
  };

  mkClaudeAccount = { provider ? "zai", ... }@attrs:
    claudeUserConfig // {
      env = claudeUserConfig.env // (auth.mkClaudeEnv provider);
    } // (removeAttrs attrs [ "provider" ]);

  mkAutoClaudeAccount = { provider ? "zai", ... }@attrs:
    claudeAutoConfig // {
      env = claudeAutoConfig.env // (auth.mkClaudeEnv provider);
    } // (removeAttrs attrs [ "provider" ]);

  # --- Codex ---
  codexUserConfig = {
    settings = codexSettings;
    mcpServers = baseMcp;
    memory.text = sharedMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
    hooksConfig = codexHooksConfig;
  };

  codexAutoConfig = {
    settings = codexSettings;
    mcpServers = baseMcp;
    memory.text = autoMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
    hooksConfig = codexAutoHooksConfig;
  };

  mkCodexAccount = { provider ? "openai", model ? null, ... }@attrs:
    codexUserConfig // {
      env = codexUserConfig.env // (auth.mkCodexEnv provider);
    } // (removeAttrs attrs [ "provider" "model" ])
    // (if model != null then { settings = codexSettings // { inherit model; }; } else { });

  mkCodexAutoAccount = { provider ? "openai", model ? null, ... }@attrs:
    codexAutoConfig // {
      env = codexAutoConfig.env // (auth.mkCodexEnv provider);
    } // (removeAttrs attrs [ "provider" "model" ])
    // (if model != null then { settings = codexSettings // { inherit model; }; } else { });

  # --- Gemini ---
  geminiUserConfig = {
    settings = geminiSettings;
    mcpServers = baseMcp;
    memory.text = sharedMemory;
    context.text = sharedMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
  };

  mkGeminiAccount = { ... }@attrs:
    geminiUserConfig // {
      env = geminiUserConfig.env // (auth.mkGeminiEnv "personal");
    } // (removeAttrs attrs [ "provider" ]);

  # --- OpenCode ---
  opencodeUserConfig = {
    settings = opencodeSettings;
    mcpServers = baseMcp;
    memory.text = sharedMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
  };

  opencodeAutoConfig = {
    settings = opencodeSettings;
    mcpServers = baseMcp;
    memory.text = autoMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
  };

  mkOpencodeAccount = { provider ? "openai", ... }@attrs:
    opencodeUserConfig // {
      env = opencodeUserConfig.env // (auth.mkOpencodeEnv provider);
    } // (removeAttrs attrs [ "provider" ]);

  mkOpencodeAutoAccount = { provider ? "openai", ... }@attrs:
    opencodeAutoConfig // {
      env = opencodeAutoConfig.env // (auth.mkOpencodeEnv provider);
    } // (removeAttrs attrs [ "provider" ]);

in

{
  inherit claudeUserConfig claudeAutoConfig auth;
  inherit codexUserConfig codexAutoConfig geminiUserConfig opencodeUserConfig opencodeAutoConfig;
  inherit mkClaudeAccount mkAutoClaudeAccount;
  inherit mkCodexAccount mkCodexAutoAccount mkGeminiAccount mkOpencodeAccount mkOpencodeAutoAccount;
}
