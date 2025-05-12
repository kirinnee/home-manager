{ config, pkgs, pkgs-240924, pkgs-2411, pkgs-casks, atomi, profile, ... }:

import ./home-template.nix {
  inherit config pkgs pkgs-240924 pkgs-2411 pkgs-casks atomi profile;
}
