{
  description = "Home Manager configuration for GoTrade";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # Specify the source of Home Manager and Nixpkgs.
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-2305.url = "nixpkgs/nixos-23.05";
    nixpkgs-2405.url = "nixpkgs/nixos-24.05";
    nixpkgs-feb-05-24.url = "nixpkgs/057f9aecfb71c4437d2b27d3323df7f93c010b7e";

    atomipkgs.url = "github:kirinnee/test-nix-repo/v25.1.0";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self

      # utils
    , flake-utils
    , treefmt-nix
    , pre-commit-hooks

    , nixpkgs
    , nixpkgs-2305
    , nixpkgs-2405
    , nixpkgs-feb-05-24
    , atomipkgs
    , home-manager
    } @inputs:
    let profiles = import ./profiles.nix; in
    {
      homeConfigurations = builtins.listToAttrs(map (profile:
        let
            system = "${profile.arch}-${profile.kernel}";
            pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
            pkgs-2305 = import nixpkgs-2305 { inherit system; config.allowUnfree = true; };
            pkgs-2405 = import nixpkgs-2405 { inherit system; config.allowUnfree = true; };
            pkgs-feb-05-24 = import nixpkgs-feb-05-24 { inherit system; config.allowUnfree = true; };
            pre-commit-lib = pre-commit-hooks.lib.${system};
            atomi = atomipkgs.packages.${system}; in
        {
            name = profile.user;
            value = home-manager.lib.homeManagerConfiguration {
                inherit pkgs;
                modules = [ ./home.nix ];
                extraSpecialArgs = {
                    inherit atomi profile pkgs-2405;
                };
            };
        }) profiles );
    } // (
      flake-utils.lib.eachDefaultSystem
        (system:
        let
            pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
            pkgs-2305 = import nixpkgs-2305 { inherit system; config.allowUnfree = true; };
            pkgs-2405 = import nixpkgs-2405 { inherit system; config.allowUnfree = true; };
            pkgs-feb-05-24 = import nixpkgs-feb-05-24 { inherit system; config.allowUnfree = true; };
            pre-commit-lib = pre-commit-hooks.lib.${system};
            atomi = atomipkgs.packages.${system}; in
        let
          out = rec {
            pre-commit = import ./nix/pre-commit.nix {
              inherit pre-commit-lib formatter packages;
            };
            formatter = import ./nix/fmt.nix {
              inherit treefmt-nix pkgs;
            };
            packages = import ./nix/packages.nix {
              inherit pkgs atomi pkgs-2305 pkgs-feb-05-24;
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
