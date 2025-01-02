{ config, pkgs, pkgs-2405, pkgs-240924, atomi, cyanprint, profile, ... }:

import ./home-template.nix {
  inherit config pkgs atomi cyanprint profile pkgs-2405 pkgs-240924;
}
