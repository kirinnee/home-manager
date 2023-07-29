{
  description = "Home Manager configuration of Ernest Ng";

  inputs = {
    home-manager.url = "github:nix-community/home-manager";
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { home-manager, nixpkgs, ... }:


    let isLinux = input: nixpkgs.lib.strings.hasSuffix "linux" input; in

    let atomi = import (fetchTarball "https://github.com/kirinnee/test-nix-repo/archive/refs/tags/v15.0.0.tar.gz"); in
    let profiles = import ./profiles.nix; in

    # Types of profiles
    let personal = profiles.personal; in
    let mac = profiles.mac; in

    let pkgs = nixpkgs; in
    {
      homeConfigurations = {
        "${personal.user}" = home-manager.lib.homeManagerConfiguration {

          pkgs = nixpkgs.legacyPackages."${personal.system}";
          modules = [
            ./home-template.nix
            {
              home = {
                username = personal.user;
                homeDirectory = "/home/${personal.user}";
                stateVersion = "21.11";
              };
            }
          ];
          extraSpecialArgs = {
            linux = isLinux personal.system;
            userinfo = personal;
            inherit atomi;
          };
        };

        "${mac.user}" = home-manager.lib.homeManagerConfiguration {
          pkgs = nixpkgs.legacyPackages."${mac.system}";
          modules = [
            ./home-template.nix
            {
              home = {
                username = mac.user;
                homeDirectory = "/Users/${mac.user}";
                stateVersion = "21.11";
              };
            }
          ];
          extraSpecialArgs = {
            linux = isLinux mac.system;
            userinfo = mac;
            inherit atomi;
          };

        };
      };
    };
}
