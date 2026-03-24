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
  autoConfig = {
    settings = baseSettings;
    mcpServers = baseMcp;
    memory.source = ./CLAUDE-autonomous.md;
    skillsDir = ./skills;
    env = baseEnv;
  };
in

{
  inherit userConfig autoConfig auth;
}
