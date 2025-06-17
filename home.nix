{ config, lib, pkgs, pkgs-240924, pkgs-2505, pkgs-casks, atomi, profile, ... }:

import ./home-template.nix {
  inherit config lib pkgs pkgs-240924 pkgs-2505 pkgs-casks atomi profile;
}
