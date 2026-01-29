let baseSettings = import ./base-settings.nix; in
let baseMcp = import ./base-mcp.nix; in
let baseHooks = import ./base-hooks.nix; in
let auth = import ./auth.nix; in

let
  userConfig = {
    settings = baseSettings // { hooks = baseHooks; };
    mcpServers = baseMcp;
    memory.source = ./CLAUDE.md;
    skillsDir = ./skills;
  };
in
let
  implConfig = {
    settings = baseSettings;
    directoryRules = [ ];
    mcpServers = { };
    memory.source = ./CLAUDE.md;
    skillsDir = ./skills;
  };
in
let
  revConfig = {
    settings = baseSettings;
    directoryRules = [ ];
    mcpServers = { };
    memory.source = ./CLAUDE-reviewer.md;
    skillsDir = ./skills;
  };
in

{
  inherit userConfig implConfig revConfig auth;
}
