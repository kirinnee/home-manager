{ config, pkgs, pkgs-2405, pkgs-240924, atomi, profile, ... }:

import ./home-template.nix {
  inherit config pkgs atomi profile pkgs-2405 pkgs-240924;
}
