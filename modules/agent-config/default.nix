let baseSettings = import ./base-settings.nix; in
let baseMcp = import ./base-mcp.nix; in
let baseHooks = import ./base-hooks.nix; in
let autoHooks = import ./auto-hooks.nix; in
let codexSettings = import ./codex-settings.nix; in
let codexHooksConfig = import ./codex-hooks.nix; in
let codexAutoHooksConfig = import ./codex-auto-hooks.nix; in
let codexHooksDir = ./hooks; in
let geminiSettings = import ./gemini-settings.nix; in
let geminiHooks = import ./gemini-hooks.nix; in
let opencodeSettings = import ./opencode-settings.nix; in
let opencodePluginsDir = ./opencode-plugins; in
let auth = import ./auth.nix; in
let baseEnv = import ./base-env.nix; in
let rtk = builtins.readFile ./RTK.md; in
let sharedMemory = builtins.readFile ./CLAUDE.md + "\n" + rtk; in
let autoMemory = builtins.readFile ./CLAUDE-autonomous.md + "\n" + rtk; in
let sharedSkills = ./skills; in
# Skills as an attrset (name => path) so consumers can materialize them via
  # home.file symlinks instead of an imperative activation script.
let
  sharedSkillsAttrs =
    let entries = builtins.readDir sharedSkills; in
    builtins.listToAttrs (map
      (name: { inherit name; value = sharedSkills + "/${name}"; })
      (builtins.filter (n: entries.${n} == "directory") (builtins.attrNames entries)));
in

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

  # manualAuth = true: inject no proxy auth env, so the account logs in
  # manually via `claude /login` (real Anthropic OAuth / subscription).
  mkClaudeAccount = { provider ? "zai", opus ? null, sonnet ? null, haiku ? null, manualAuth ? false, ... }@attrs:
    claudeUserConfig // {
      env = claudeUserConfig.env // (if manualAuth then { } else auth.mkClaudeEnv provider { inherit opus sonnet haiku; });
    } // (removeAttrs attrs [ "provider" "opus" "sonnet" "haiku" "manualAuth" ]);

  mkAutoClaudeAccount = { provider ? "zai", opus ? null, sonnet ? null, haiku ? null, manualAuth ? false, ... }@attrs:
    claudeAutoConfig // {
      env = claudeAutoConfig.env // (if manualAuth then { } else auth.mkClaudeEnv provider { inherit opus sonnet haiku; });
    } // (removeAttrs attrs [ "provider" "opus" "sonnet" "haiku" "manualAuth" ]);

  # --- Codex ---
  codexAutoSettings = builtins.removeAttrs codexSettings [ "service_tier" ];

  # Proxy/API-key variants authenticate via the local proxy and cannot use the
  # ChatGPT-only apps connectors. Disable `apps` to avoid the codex_apps MCP
  # startup failure (and the wasted per-home plugin downloads). The ChatGPT
  # OAuth accounts keep apps enabled via codexChatGPTSettings below.
  codexProxySettings = codexSettings // { features = codexSettings.features // { apps = false; }; };
  codexProxyAutoSettings = codexAutoSettings // { features = codexAutoSettings.features // { apps = false; }; };

  codexUserConfig = {
    settings = codexProxySettings;
    mcpServers = baseMcp;
    memory.text = sharedMemory;
    # `skills` (attrset) routes through home.file symlinks; `skillsDir` would use
    # an activation script. Keep these activation-free.
    skills = sharedSkillsAttrs;
    env = baseEnv;
    hooksConfig = codexHooksConfig;
    hooksDir = codexHooksDir;
  };

  codexAutoConfig = {
    settings = codexProxyAutoSettings;
    mcpServers = baseMcp;
    memory.text = autoMemory;
    skills = sharedSkillsAttrs;
    env = baseEnv;
    hooksConfig = codexAutoHooksConfig;
    hooksDir = codexHooksDir;
  };

  mkCodexAccount = { provider ? "openai", model ? null, settings ? { }, ... }@attrs:
    codexUserConfig // {
      env = codexUserConfig.env // (auth.mkCodexEnv provider);
    } // (removeAttrs attrs [ "provider" "model" "settings" ])
    // (if model != null || settings != { } then {
      settings = codexProxySettings // settings // (if model != null then { inherit model; } else { });
    } else { });

  mkCodexAutoAccount = { provider ? "openai", model ? null, settings ? { }, ... }@attrs:
    codexAutoConfig // {
      env = codexAutoConfig.env // (auth.mkCodexEnv provider);
    } // (removeAttrs attrs [ "provider" "model" "settings" ])
    // (if model != null || settings != { } then {
      settings = codexProxyAutoSettings // settings // (if model != null then { inherit model; } else { });
    } else { });

  # ChatGPT OAuth login variant (no proxy, no forced API key)
  codexChatGPTSettings = builtins.removeAttrs codexSettings [ "forced_login_method" "model_provider" "model_providers" ];
  codexChatGPTAutoSettings = builtins.removeAttrs codexChatGPTSettings [ "service_tier" ];

  mkCodexChatGPTAccount = { ... }@attrs:
    codexUserConfig // {
      settings = codexChatGPTSettings;
      env = baseEnv;
    } // (removeAttrs attrs [ ]);

  mkCodexChatGPTAutoAccount = { ... }@attrs:
    codexAutoConfig // {
      settings = codexChatGPTAutoSettings;
      env = baseEnv;
    } // (removeAttrs attrs [ ]);

  # --- Gemini ---
  geminiUserConfig = {
    settings = geminiSettings;
    mcpServers = baseMcp;
    memory.text = sharedMemory;
    context.text = sharedMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
    hooks = geminiHooks;
    hooksDir = codexHooksDir; # shared hooks/ dir with rtk-rewrite-gemini.sh
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
    pluginsDir = opencodePluginsDir;
  };

  opencodeAutoConfig = {
    settings = opencodeSettings;
    mcpServers = baseMcp;
    memory.text = autoMemory;
    skillsDir = sharedSkills;
    env = baseEnv;
    pluginsDir = opencodePluginsDir; # RTK always; loctl could be filtered for auto
  };

  mkOpencodeAccount = { provider ? "openai", ... }@attrs:
    opencodeUserConfig // {
      env = opencodeUserConfig.env // (auth.mkOpencodeEnv provider);
    } // (removeAttrs attrs [ "provider" ]);

  mkOpencodeAutoAccount = { provider ? "openai", ... }@attrs:
    opencodeAutoConfig // {
      env = opencodeAutoConfig.env // (auth.mkOpencodeEnv provider);
    } // (removeAttrs attrs [ "provider" ]);

  # --- Per-provider account generators (Claude) ---
  # Weakening rule: sonnet = models[max(i, 1)], haiku = models[max(i, 2)]
  # Per-model overrides: set sonnet/haiku on the model entry to skip the index rule.
  mkProviderClaudeAccounts = provider:
    let
      p = auth.providers.${provider};
      len = builtins.length p.models;
      resolve = i: if i < len then i else (len - 1);
    in
    builtins.listToAttrs (builtins.genList
      (i:
        let
          m = { sonnet = null; haiku = null; } // (builtins.elemAt p.models i);
          defaultSonnet = (builtins.elemAt p.models (resolve (if i >= 1 then i else 1))).id;
          defaultHaiku = (builtins.elemAt p.models (resolve (if i >= 2 then i else 2))).id;
        in
        {
          name = m.name;
          value = mkClaudeAccount {
            inherit provider;
            opus = m.id;
            sonnet = if m.sonnet != null then m.sonnet else defaultSonnet;
            haiku = if m.haiku != null then m.haiku else defaultHaiku;
          };
        }
      )
      len);

  mkProviderAutoClaudeAccounts = provider:
    let
      p = auth.providers.${provider};
      len = builtins.length p.models;
      resolve = i: if i < len then i else (len - 1);
    in
    builtins.listToAttrs (builtins.genList
      (i:
        let
          m = { sonnet = null; haiku = null; } // (builtins.elemAt p.models i);
          defaultSonnet = (builtins.elemAt p.models (resolve (if i >= 1 then i else 1))).id;
          defaultHaiku = (builtins.elemAt p.models (resolve (if i >= 2 then i else 2))).id;
        in
        {
          name = "auto-" + m.name;
          value = mkAutoClaudeAccount {
            inherit provider;
            opus = m.id;
            sonnet = if m.sonnet != null then m.sonnet else defaultSonnet;
            haiku = if m.haiku != null then m.haiku else defaultHaiku;
          };
        }
      )
      len);

  mkAllProviderClaudeAccounts = providerList:
    builtins.foldl'
      (acc: provider:
        acc // mkProviderClaudeAccounts provider // mkProviderAutoClaudeAccounts provider
      )
      { }
      providerList;

  # --- Per-provider account generators (Codex — single model) ---
  mkProviderCodexAccounts = provider:
    let p = auth.providers.${provider};
    in builtins.listToAttrs (builtins.genList
      (i:
        let m = builtins.elemAt p.models i;
        in {
          name = m.name;
          value = mkCodexAccount {
            inherit provider;
            model = m.id;
            settings = m.codexSettings or { };
          };
        }
      )
      (builtins.length p.models));

  mkProviderCodexAutoAccounts = provider:
    let p = auth.providers.${provider};
    in builtins.listToAttrs (builtins.genList
      (i:
        let m = builtins.elemAt p.models i;
        in {
          name = "auto-" + m.name;
          value = mkCodexAutoAccount {
            inherit provider;
            model = m.id;
            settings = m.codexSettings or { };
          };
        }
      )
      (builtins.length p.models));

  mkAllProviderCodexAccounts = providerList:
    builtins.foldl'
      (acc: provider:
        acc // mkProviderCodexAccounts provider // mkProviderCodexAutoAccounts provider
      )
      { }
      providerList;

  # --- Per-provider account generators (OpenCode — single model) ---
  mkProviderOpencodeAccounts = provider:
    let p = auth.providers.${provider};
    in builtins.listToAttrs (builtins.genList
      (i:
        let m = builtins.elemAt p.models i;
        in {
          name = m.name;
          value = mkOpencodeAccount { inherit provider; };
        }
      )
      (builtins.length p.models));

  mkProviderOpencodeAutoAccounts = provider:
    let p = auth.providers.${provider};
    in builtins.listToAttrs (builtins.genList
      (i:
        let m = builtins.elemAt p.models i;
        in {
          name = "auto-" + m.name;
          value = mkOpencodeAutoAccount { inherit provider; };
        }
      )
      (builtins.length p.models));

  mkAllProviderOpencodeAccounts = providerList:
    builtins.foldl'
      (acc: provider:
        acc // mkProviderOpencodeAccounts provider // mkProviderOpencodeAutoAccounts provider
      )
      { }
      providerList;

in

builtins.warn "modules/agent-config/default.nix is deprecated. Manage agent accounts with ~/.kfleet/config.yaml and run `kfleet apply`; this file remains only for legacy imports while migration finishes." {
  inherit claudeUserConfig claudeAutoConfig auth;
  inherit codexUserConfig codexAutoConfig geminiUserConfig opencodeUserConfig opencodeAutoConfig;
  inherit mkClaudeAccount mkAutoClaudeAccount;
  inherit mkCodexAccount mkCodexAutoAccount mkCodexChatGPTAccount mkCodexChatGPTAutoAccount mkGeminiAccount mkOpencodeAccount mkOpencodeAutoAccount;
  inherit mkProviderClaudeAccounts mkProviderAutoClaudeAccounts mkAllProviderClaudeAccounts;
  inherit mkProviderCodexAccounts mkProviderCodexAutoAccounts mkAllProviderCodexAccounts;
  inherit mkProviderOpencodeAccounts mkProviderOpencodeAutoAccounts mkAllProviderOpencodeAccounts;
}
