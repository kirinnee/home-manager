{
  description = "Home Manager configuration for Ernest";

  inputs = rec {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # Darwin Config - use release-25.11 to match nixpkgs-2511
    darwin.url = "github:lnl7/nix-darwin/nix-darwin-25.11";
    darwin.inputs.nixpkgs.follows = "nixpkgs-2511";
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";

    # Specify the source of Home Manager and Nixpkgs.
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-2511.url = "nixpkgs/nixos-25.11";
    nixpkgs-240924.url = "nixpkgs/babc25a577c3310cce57c72d5bed70f4c3c3843a";

    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
    mac-app-util.url = "github:hraban/mac-app-util";

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs-2511";
    };
  };

  outputs =
    { self

      # utils
    , flake-utils
    , treefmt-nix
    , pre-commit-hooks

    , nixpkgs-unstable
    , nixpkgs-240924
    , nixpkgs-2511
    , atomipkgs
    , home-manager
    , darwin
    , nix-homebrew

    , mac-app-util
    } @inputs:
    let profiles = import ./profiles.nix; in
    {
      homeConfigurations = builtins.listToAttrs (map
        (profile:
          let
            system = "${profile.arch}-${profile.kernel}";
            pkgs-unstable = import nixpkgs-unstable { inherit system; config.allowUnfree = true; };
            pkgs-2511 = import nixpkgs-2511 {
              inherit system;
              config.allowUnfree = true;
            };
            pkgs-240924 = import nixpkgs-240924 { inherit system; config.allowUnfree = true; };
            pre-commit-lib = pre-commit-hooks.lib.${system};
            atomi = atomipkgs.packages.${system};
          in
          let pkgs = pkgs-2511; in
          {
            name = profile.user;
            value = home-manager.lib.homeManagerConfiguration {
              inherit pkgs;
              modules = [
                mac-app-util.homeManagerModules.default
                ./home.nix
              ];
              extraSpecialArgs = {
                inherit atomi profile pkgs-240924 pkgs-2511 pkgs-unstable;
              };
            };
          })
        profiles);

      darwinConfigurations = builtins.listToAttrs (map
        (profile:
          let
            system = "${profile.arch}-${profile.kernel}";
            pkgs-unstable = import nixpkgs-unstable { inherit system; config.allowUnfree = true; };
            pkgs-2511 = import nixpkgs-2511 {
              inherit system;
              config.allowUnfree = true;
            };
            pkgs-240924 = import nixpkgs-240924 { inherit system; config.allowUnfree = true; };
            atomi = atomipkgs.packages.${system};
          in
          let pkgs = pkgs-2511; in
          {
            name = profile.user;
            value = darwin.lib.darwinSystem {
              inherit pkgs system;
              specialArgs = {
                inherit atomi profile pkgs-240924 pkgs-2511 pkgs-unstable self;
              };
              modules = [
                nix-homebrew.darwinModules.nix-homebrew
                {
                  nix-homebrew = {
                    enable = true;
                    enableRosetta = true;
                    user = profile.user;
                  };
                }
                {
                  nixpkgs.config.allowUnfree = true;
                  home-manager.useGlobalPkgs = true;
                  home-manager.users.${profile.user} = import ./home.nix;
                  home-manager.extraSpecialArgs = {
                    inherit atomi profile pkgs-240924 pkgs-2511 pkgs-unstable;
                  };
                }
                home-manager.darwinModules.home-manager
                mac-app-util.darwinModules.default
                ./darwin.nix
              ];
            };
          })
        (builtins.filter (p: p.kernel == "darwin") profiles));
    } // (
      flake-utils.lib.eachDefaultSystem
        (system:
        let
          pkgs-unstable = import nixpkgs-unstable { inherit system; config.allowUnfree = true; };
          pkgs-2511 = import nixpkgs-2511 { inherit system; config.allowUnfree = true; };
          pre-commit-lib = pre-commit-hooks.lib.${system};
          atomi = atomipkgs.packages.${system};
          attic = attic.packages.${system};
        in
        let pkgs = pkgs-2511; in
        let
          out = rec {
            pre-commit = import ./nix/pre-commit.nix {
              inherit pre-commit-lib formatter packages;
            };
            formatter = import ./nix/fmt.nix {
              inherit treefmt-nix pkgs;
            };
            packages = import ./nix/packages.nix {
              inherit pkgs atomi pkgs-2511 pkgs-unstable;
            };
            env = import ./nix/env.nix {
              inherit pkgs packages;
            };
            devShells = import ./nix/shells.nix {
              inherit pkgs env packages;
              shellHook = checks.pre-commit-check.shellHook;
            };
            checks = {
              pre-commit-check = pre-commit;
              format = formatter;
            };
          };
        in
        with out;
        {
          inherit checks formatter packages devShells;
        }
        )

    );
}
