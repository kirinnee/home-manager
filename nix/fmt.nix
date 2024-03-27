{ treefmt-nix, pkgs, ... }:
let
  fmt = {
    projectRootFile = "flake.nix";

    # enable or disable formatters, see https://github.com/numtide/treefmt-nix#supported-programs
    programs = {
      nixpkgs-fmt = {
        enable = true;
      };
      prettier = {
        enable = true;
      };
      shfmt = {
        enable = true;
      };
    };


  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
