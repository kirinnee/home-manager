{
  description = "Home Manager configuration for Ernest";

  inputs = rec {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # Specify the source of Home Manager and Nixpkgs.
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-2411.url = "nixpkgs/nixos-24.11";
    nixpkgs-240924.url = "nixpkgs/babc25a577c3310cce57c72d5bed70f4c3c3843a";

    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    brew-api = {
      url = "github:BatteredBunny/brew-api";
      flake = false;
    };
    brew-nix = {
      url = "github:BatteredBunny/brew-nix";
      inputs.brew-api.follows = "brew-api";
    };
    nixcasks.url = "github:jacekszymanski/nixcasks";
  };

  outputs =
    { self

      # utils
    , flake-utils
    , treefmt-nix
    , pre-commit-hooks

    , nixpkgs
    , nixpkgs-240924
    , nixpkgs-2411
    , atomipkgs
    , home-manager
    , brew-api
    , brew-nix
    , nixcasks
    } @inputs:
    let profiles = import ./profiles.nix; in
    {
      homeConfigurations = builtins.listToAttrs (map
        (profile:
          let
            system = "${profile.arch}-${profile.kernel}";
            pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
            pkgs-2411 = import nixpkgs-2411 {
              inherit system;
              config.allowUnfree = true;
              overlays = [ brew-nix.overlays.default ];
            };
            pkgs-240924 = import nixpkgs-240924 { inherit system; config.allowUnfree = true; };
            pre-commit-lib = pre-commit-hooks.lib.${system};
            atomi = atomipkgs.packages.${system};
            pkgs-casks = (nixcasks.output {
              osVersion = "sonoma";
            }).packages.${system};
          in
          {
            name = profile.user;
            value = home-manager.lib.homeManagerConfiguration {
              inherit pkgs;
              modules = [ ./home.nix ];
              extraSpecialArgs = {
                inherit atomi profile pkgs-240924 pkgs-2411 pkgs-casks;
              };
            };
          })
        profiles);
    } // (
      flake-utils.lib.eachDefaultSystem
        (system:
        let
          pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
          pkgs-2411 = import nixpkgs-2411 { inherit system; config.allowUnfree = true; };
          pre-commit-lib = pre-commit-hooks.lib.${system};
          atomi = atomipkgs.packages.${system};
        in
        let
          out = rec {
            pre-commit = import ./nix/pre-commit.nix {
              inherit pre-commit-lib formatter packages;
            };
            formatter = import ./nix/fmt.nix {
              inherit treefmt-nix pkgs;
            };
            packages = import ./nix/packages.nix {
              inherit pkgs atomi pkgs-2411;
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
