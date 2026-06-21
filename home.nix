{ lib, pkgs, pkgs-llm, claude-code-pkg, codex-pkg, pkgs-unstable, atomi, profile, ... }:

import ./home-template.nix {
  inherit lib pkgs pkgs-llm claude-code-pkg codex-pkg pkgs-unstable atomi profile;
}
