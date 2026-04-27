{ config, lib, pkgs, pkgs-llm, claude-code-pkg, codex-pkg, pkgs-loctl, pkgs-240924, pkgs-stable, pkgs-unstable, pkgs-casks, atomi, profile, ... }:

import ./home-template.nix {
  inherit config lib pkgs pkgs-llm claude-code-pkg codex-pkg pkgs-loctl pkgs-240924 pkgs-stable pkgs-unstable pkgs-casks atomi profile;
}
