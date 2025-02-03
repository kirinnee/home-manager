{ config, pkgs, pkgs-240924, pkgs-2411, atomi, profile, ... }:

import ./home-template.nix {
  inherit config pkgs pkgs-240924 pkgs-2411 atomi profile;
}
