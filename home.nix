{ config, pkgs, pkgs-2405, atomi, profile, ... }:

import ./home-template.nix {
    inherit config pkgs atomi profile pkgs-2405;
}
