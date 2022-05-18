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
      linux = true;
      apps = false;
    }; in
    let mac = {
      user = "ernest";
      email = "kirinnee97@gmail.com";
      gituser = "kirinnee";
      linux = false;
      apps = true;
    }; in
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
          };
        };
      };
    };
}
