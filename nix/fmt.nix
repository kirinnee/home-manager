{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    # enable or disable formatters, see https://github.com/numtide/treefmt-nix#supported-programs
    programs = {
      nixpkgs-fmt.enable = true;
      prettier.enable = true;
      shfmt.enable = true;
      actionlint.enable = true;
    };

    # kautopilot-ts owns its own formatting via biome (tabs + double quotes),
    # which conflicts with prettier (2-space + single quotes). Let biome own it
    # so `bun run check` stays green and commits don't reformat it back.
    settings.formatter.prettier.excludes = [
      "modules/kautopilot-ts/**"
    ];
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
