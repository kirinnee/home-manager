let baseSettings = import ./base-settings.nix; in
let baseMcp = import ./base-mcp.nix; in
let baseHooks = import ./base-hooks.nix; in
let autoHooks = import ./auto-hooks.nix; in
let auth = import ./auth.nix; in
let baseEnv = import ./base-env.nix; in
let rtk = builtins.readFile ./RTK.md; in
let
  userConfig = {
    settings = baseSettings // { hooks = baseHooks; };
    mcpServers = baseMcp;
    memory.text = builtins.readFile ./CLAUDE.md + "\n" + rtk;
    skillsDir = ./skills;
    env = baseEnv;
  };
in
let
  autoConfig = {
    settings = baseSettings // { hooks = autoHooks; };
    mcpServers = baseMcp;
    memory.text = builtins.readFile ./CLAUDE-autonomous.md + "\n" + rtk;
    skillsDir = ./skills;
    env = baseEnv;
  };
in

{
  inherit userConfig autoConfig auth;
}
