let baseSettings = import ./base-settings.nix; in
let baseMcp = import ./base-mcp.nix; in
let baseHooks = import ./base-hooks.nix; in
let auth = import ./auth.nix; in
let baseEnv = import ./base-env.nix; in
let
  userConfig = {
    settings = baseSettings // { hooks = baseHooks; };
    mcpServers = baseMcp;
    memory.source = ./CLAUDE.md;
    skillsDir = ./skills;
    env = baseEnv;
  };
in
let
  implConfig = {
    settings = baseSettings;
    directoryRules = [ ];
    mcpServers = { };
    memory.source = ./CLAUDE-implementer.md;
    skillsDir = ./skills;
    env = baseEnv;
  };
in
let
  revConfig = {
    settings = baseSettings;
    directoryRules = [ ];
    mcpServers = { };
    memory.source = ./CLAUDE-reviewer.md;
    skillsDir = ./skills;
    env = baseEnv;
  };
in

{
  inherit userConfig implConfig revConfig auth;
}
