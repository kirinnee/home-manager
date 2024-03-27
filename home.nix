{ config, pkgs, atomi, profile, ... }:

import ./home-template.nix {
    inherit config pkgs atomi profile;
}
