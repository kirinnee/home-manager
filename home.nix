{ config, lib, pkgs, pkgs-240924, pkgs-stable, pkgs-unstable, pkgs-casks, atomi, profile, ... }:

import ./home-template.nix {
  inherit config lib pkgs pkgs-240924 pkgs-stable pkgs-unstable pkgs-casks atomi profile;
}
