{
  description = "Home Manager configuration for Ernest";

  inputs = {
    # util
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

    # Darwin Config - use release-26.05 to match nixpkgs-2605
    darwin.url = "github:lnl7/nix-darwin/nix-darwin-26.05";
    darwin.inputs.nixpkgs.follows = "nixpkgs-stable";
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";

    # Specify the source of Home Manager and Nixpkgs.
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-stable.url = "github:nixos/nixpkgs/nixos-26.05";

    atomipkgs.url = "github:AtomiCloud/nix-registry/v3";

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs-stable";
    };

    home-manager-modules.url = "github:kirinnee/home-manager-modules";
    llm-agents.url = "github:numtide/llm-agents.nix";
    claude-code.url = "github:sadjow/claude-code-nix";
    codex-cli.url = "github:sadjow/codex-cli-nix";
  };

  outputs =
    { self
    , # utils
      flake-utils
    , treefmt-nix
    , pre-commit-hooks
    , nixpkgs-unstable
    , nixpkgs-stable
    , atomipkgs
    , home-manager
    , darwin
    , nix-homebrew
    , home-manager-modules
    , llm-agents
    , claude-code
    , codex-cli
    ,
    }:
    let
      profiles = import ./profiles.nix;
    in
    {
      homeConfigurations = builtins.listToAttrs (
        map
          (
            profile:
            let
              system = "${profile.arch}-${profile.kernel}";
              pkgs-unstable = import nixpkgs-unstable {
                inherit system;
                config.allowUnfree = true;
              };
              pkgs-stable = import nixpkgs-stable {
                inherit system;
                config.allowUnfree = true;
              };
              atomi = atomipkgs.packages.${system};
              pkgs-llm = llm-agents.packages.${system};
              claude-code-pkg = claude-code.packages.${system}.claude-code;
              codex-pkg = codex-cli.packages.${system}.default;
            in
            let
              pkgs = pkgs-stable;
            in
            {
              name = profile.user;
              value = home-manager.lib.homeManagerConfiguration {
                inherit pkgs;
                modules = [
                  home-manager-modules.homeManagerModules.multi-claude
                  home-manager-modules.homeManagerModules.multi-codex
                  home-manager-modules.homeManagerModules.multi-gemini
                  home-manager-modules.homeManagerModules.multi-opencode
                  home-manager-modules.homeManagerModules.multi-gh
                  home-manager-modules.homeManagerModules.multi-gws
                  ./home.nix
                ];
                extraSpecialArgs = {
                  inherit
                    atomi
                    pkgs-llm
                    claude-code-pkg
                    codex-pkg
                    profile
                    pkgs-stable
                    pkgs-unstable
                    ;
                };
              };
            }
          )
          profiles
      );

      darwinConfigurations = builtins.listToAttrs (
        map
          (
            profile:
            let
              system = "${profile.arch}-${profile.kernel}";
              pkgs-unstable = import nixpkgs-unstable {
                inherit system;
                config.allowUnfree = true;
              };
              pkgs-stable = import nixpkgs-stable {
                inherit system;
                config.allowUnfree = true;
              };
              atomi = atomipkgs.packages.${system};
              pkgs-llm = llm-agents.packages.${system};
              claude-code-pkg = claude-code.packages.${system}.claude-code;
              codex-pkg = codex-cli.packages.${system}.default;
            in
            let
              pkgs = pkgs-stable;
            in
            {
              name = profile.user;
              value = darwin.lib.darwinSystem {
                inherit pkgs system;
                specialArgs = {
                  inherit
                    atomi
                    profile
                    pkgs-stable
                    pkgs-unstable
                    self
                    ;
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
                      inherit
                        atomi
                        pkgs-llm
                        claude-code-pkg
                        codex-pkg
                        profile
                        pkgs-stable
                        pkgs-unstable
                        ;
                    };
                    home-manager.sharedModules = [
                      home-manager-modules.homeManagerModules.multi-claude
                      home-manager-modules.homeManagerModules.multi-codex
                      home-manager-modules.homeManagerModules.multi-gemini
                      home-manager-modules.homeManagerModules.multi-opencode
                      home-manager-modules.homeManagerModules.multi-gh
                      home-manager-modules.homeManagerModules.multi-gws
                    ];
                  }
                  home-manager.darwinModules.home-manager
                  ./darwin.nix
                ];
              };
            }
          )
          (builtins.filter (p: p.kernel == "darwin") profiles)
      );
    }
    // (flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs-unstable = import nixpkgs-unstable {
          inherit system;
          config.allowUnfree = true;
        };
        pkgs-stable = import nixpkgs-stable {
          inherit system;
          config.allowUnfree = true;
        };
        pre-commit-lib = pre-commit-hooks.lib.${system};
        atomi = atomipkgs.packages.${system};
      in
      let
        pkgs = pkgs-stable;
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
            inherit
              pkgs
              atomi
              pkgs-stable
              pkgs-unstable
              ;
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
        inherit
          checks
          formatter
          packages
          devShells
          ;
      }
    )

    );
}
