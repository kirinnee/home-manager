{
  description = "Home Manager configuration of Ernest Ng";

  inputs = {
    home-manager.url = "github:nix-community/home-manager";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { home-manager, ... }:
    let atomi = import (fetchTarball "https://github.com/kirinnee/test-nix-repo/archive/refs/tags/v9.1.0.tar.gz"); in
    let types = import ./types.nix; in
    let personal = types.personal; in
    let mac = types.mac; in
    let macx64 = types.macx64; in
    {
      homeConfigurations = {
        kirin = home-manager.lib.homeManagerConfiguration {
          # Specify the path to your home configuration here
          configuration = import ./home-template.nix;
          system = "x86_64-linux";
          username = personal.user;
          homeDirectory = "/home/${personal.user}";
          stateVersion = "21.11";
          extraSpecialArgs = {
            userinfo = personal;
            inherit atomi;
          };
        };

        ernest = home-manager.lib.homeManagerConfiguration {
          # Specify the path to your home configuration here
          configuration = import ./home-template.nix;

          system = "aarch64-darwin";
          username = mac.user;
          homeDirectory = "/Users/${mac.user}";
          stateVersion = "21.11";
          extraSpecialArgs = {
            userinfo = mac;
            inherit atomi;
          };
        };

        "e.ng.3" = home-manager.lib.homeManagerConfiguration {
          # Specify the path to your home configuration here
          configuration = import ./home-template.nix;

          system = "x86_64-darwin";
          username = macx64.user;
          homeDirectory = "/Users/${macx64.user}";
          stateVersion = "21.11";
          extraSpecialArgs = {
            userinfo = macx64;
            inherit atomi;
          };
        };
      };
    };
}
