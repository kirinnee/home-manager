{
  description = "Home Manager configuration of Ernest Ng";

  inputs = {
    home-manager.url = "github:nix-community/home-manager";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { home-manager, ... }:
    let personal = {
      user = "kirin";
      email = "kirinnee97@gmail.com";
      gituser = "kirinnee";
    }; in
    let gotrade = {
      user = "ernest";
      email = "ernest@tr8.io";
      gituser = "ernest";
    }; in
      let
      {
      homeConfigurations = {
        kirin = home-manager.lib.homeManagerConfiguration {
          # Specify the path to your home configuration here
          configuration = import ./home.nix;

          system = "x86_64-linux";
          username = personal.user;
          homeDirectory = "/home/${personal.user}";
          stateVersion = "21.11";
          extraSpecialArgs = {
            userinfo = personal;
          };
        };

        ernest = home-manager.lib.homeManagerConfiguration {
          # Specify the path to your home configuration here
          configuration = import ./home.nix;

          system = "x86_64-linux";
          username = gotrade.user;
          homeDirectory = "/home/${gotrade.user}";
          stateVersion = "21.11";
          extraSpecialArgs = {
            userinfo = gotrade;
          };
        };
      };
      };
}
