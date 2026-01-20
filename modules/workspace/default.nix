{ lib, config, pkgs, ... }:

let
  cfg = config.workspace;
in
{
  options.workspace = {
    enable = lib.mkEnableOption "workspace directory setup";
  };

  config = lib.mkIf cfg.enable {
    # Create workspace directories via activation script
    home.activation.setupWorkspaceDirectories = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p ~/Workspace/work
      mkdir -p ~/Workspace/atomi
      mkdir -p ~/Workspace/personal
    '';

    # Create .envrc for work directory
    home.file."Workspace/work/.envrc".text = ''
      export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
      unset ANTHROPIC_AUTH_TOKEN
    '';
  };
}
