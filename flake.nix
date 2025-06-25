{
  description = "Home Manager configuration for Ernest";

  inputs = rec {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # Specify the source of Home Manager and Nixpkgs.
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-2505.url = "nixpkgs/nixos-25.05";
    nixpkgs-240924.url = "nixpkgs/babc25a577c3310cce57c72d5bed70f4c3c3843a";

    atomipkgs.url = "github:AtomiCloud/nix-registry/v2";
    mac-app-util.url = "github:hraban/mac-app-util";

    home-manager = {
      url = "github:nix-community/home-manager/release-25.05";
      inputs.nixpkgs.follows = "nixpkgs-2505";
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

    , nixpkgs-unstable
    , nixpkgs-240924
    , nixpkgs-2505
    , atomipkgs
    , home-manager
    , brew-api
    , brew-nix
    , nixcasks
    , mac-app-util
    } @inputs:
    let profiles = import ./profiles.nix; in
    {
      homeConfigurations = builtins.listToAttrs (map
        (profile:
          let
            system = "${profile.arch}-${profile.kernel}";
            pkgs-unstable = import nixpkgs-unstable { inherit system; config.allowUnfree = true; };
            pkgs-2505 = import nixpkgs-2505 {
              inherit system;
              config.allowUnfree = true;
              overlays = [ brew-nix.overlays.default ];
            };
            pkgs-240924 = import nixpkgs-240924 { inherit system; config.allowUnfree = true; };
            pre-commit-lib = pre-commit-hooks.lib.${system};
            atomi = atomipkgs.packages.${system};
            pkgs-casks = (nixcasks.output { osVersion = "sonoma"; }).packages.${system};
          in
          let pkgs = pkgs-2505; in
          {
            name = profile.user;
            value = home-manager.lib.homeManagerConfiguration {
              inherit pkgs;
              modules = [
                mac-app-util.homeManagerModules.default
                ./home.nix
              ];
              extraSpecialArgs = {
                inherit atomi profile pkgs-240924 pkgs-2505 pkgs-unstable pkgs-casks;
              };
            };
          })
        profiles);
    } // (
      flake-utils.lib.eachDefaultSystem
        (system:
        let
          pkgs-unstable = import nixpkgs-unstable { inherit system; config.allowUnfree = true; };
          pkgs-2505 = import nixpkgs-2505 { inherit system; config.allowUnfree = true; };
          pre-commit-lib = pre-commit-hooks.lib.${system};
          atomi = atomipkgs.packages.${system};
          attic = attic.packages.${system};
        in
        let pkgs = pkgs-2505; in
        let
          out = rec {
            pre-commit = import ./nix/pre-commit.nix {
              inherit pre-commit-lib formatter packages;
            };
            formatter = import ./nix/fmt.nix {
              inherit treefmt-nix pkgs;
            };
            packages = import ./nix/packages.nix {
              inherit pkgs atomi pkgs-2505 pkgs-unstable;
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
